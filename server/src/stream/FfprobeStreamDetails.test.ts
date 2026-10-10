import type { FfmpegInfo } from '@/ffmpeg/ffmpegInfo.ts';
import { ProgramDaoMinter } from '@/db/converters/ProgramMinter.ts';
import { FileSystemScanner } from '@/services/scanner/FileSystemScanner.ts';
import { FfprobeMediaInfoSchema } from '@/types/ffmpeg.ts';
import { Result } from '@/types/result.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  FfprobeStreamDetails,
  readMatroskaStatisticsBitrate,
} from './FfprobeStreamDetails.ts';

class MetadataScanner extends FileSystemScanner {
  scanPath() {
    return Promise.resolve(Result.success(undefined));
  }

  readMetadata(path: string) {
    return this.getMediaItem(path);
  }
}

describe('Matroska statistics bitrates', () => {
  it.each(['BPS', 'BPS-eng', 'BPS-jpn', 'bps-eng'])(
    'reads %s in bits/second',
    (tag) => {
      expect(readMatroskaStatisticsBitrate({ [tag]: '1234567' })).toBe(1234567);
    },
  );

  it.each(['0', '-1', '', 'N/A', 'Infinity', '123kbps'])(
    'does not use an invalid rate: %s',
    (rate) => {
      expect(readMatroskaStatisticsBitrate({ BPS: rate })).toBeUndefined();
    },
  );

  it('prefers the unqualified tag and ignores unrelated statistics', () => {
    expect(
      readMatroskaStatisticsBitrate({
        'BPS-eng': '1234567',
        BPS: '2345678',
        NUMBER_OF_BYTES: '999999999',
      }),
    ).toBe(2345678);
    expect(
      readMatroskaStatisticsBitrate({ NUMBER_OF_BYTES: '999999999' }),
    ).toBeUndefined();
  });
});

describe('ffprobe scan metadata carry-through', () => {
  it('retains source and track facts through scanning and minting without selecting a cover', async () => {
    const probe = FfprobeMediaInfoSchema.parse({
      format: {
        nb_streams: 4,
        format_name: 'matroska,webm',
        duration: '360.5',
        size: '112500000',
        bit_rate: '2500000',
      },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          index: 0,
          width: 300,
          height: 300,
          coded_width: 300,
          coded_height: 300,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'h264',
          index: 1,
          width: 1920,
          height: 1080,
          coded_width: 1920,
          coded_height: 1080,
          bit_rate: '2000000',
          tags: { 'BPS-eng': '2100000' },
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          index: 2,
          bit_rate: '128000',
          tags: { BPS: '125000' },
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          index: 3,
          tags: { 'BPS-jpn': '96000' },
        },
      ],
    });
    const probeFile = vi.fn().mockResolvedValue(probe);
    const details = new FfprobeStreamDetails({
      probeFile,
    } as unknown as FfmpegInfo);
    const scanner = new MetadataScanner(
      details,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const result = await scanner.readMetadata('/media/original.mkv');
    expect(result.isSuccess()).toBe(true);
    const { mediaItem } = result.get();
    expect(mediaItem.resolution).toEqual({ widthPx: 1920, heightPx: 1080 });
    expect(mediaItem.bitrate).toBe(2500000);
    expect(mediaItem.locations[0]).toMatchObject({
      sizeBytes: 112500000,
      duration: 360500,
    });

    const [version] = new ProgramDaoMinter().mintVersions('program-id', {
      type: 'movie',
      mediaItem,
    } as never);
    expect(version).toMatchObject({
      bitrate: 2500000,
      container: 'matroska,webm',
      duration: 360500,
      width: 1920,
      height: 1080,
    });
    expect(version?.mediaFiles?.[0]).toMatchObject({
      sizeBytes: 112500000,
      duration: 360500,
    });
    expect(version?.mediaStreams).toEqual([
      expect.objectContaining({ index: 0, hasAttachedPicture: true }),
      expect.objectContaining({
        index: 1,
        hasAttachedPicture: false,
        bitrate: 2000000,
        statisticsBitrate: 2100000,
      }),
      expect.objectContaining({
        index: 2,
        bitrate: 128000,
        statisticsBitrate: 125000,
      }),
      expect.objectContaining({ index: 3, statisticsBitrate: 96000 }),
    ]);
  });
});
