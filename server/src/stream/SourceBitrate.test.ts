import dayjs from '@/util/dayjs.js';
import { describe, expect, it } from 'vitest';
import { bitrateFromSize, estimateSourceBitrate } from './SourceBitrate.ts';
import type { StreamDetails, VideoStreamDetails } from './types.ts';

const video = (values: Partial<VideoStreamDetails>): VideoStreamDetails => ({
  codec: 'h264',
  profile: undefined,
  width: 1280,
  height: 720,
  framerate: 25,
  pixelFormat: undefined,
  bitDepth: undefined,
  streamIndex: 0,
  displayAspectRatio: '16:9',
  anamorphic: false,
  bitrate: undefined,
  isAttachedPic: false,
  colorRange: undefined,
  colorSpace: undefined,
  colorTransfer: undefined,
  colorPrimaries: undefined,
  ...values,
});
const details = (values: Partial<StreamDetails>): StreamDetails => ({
  duration: dayjs.duration(10, 'seconds'),
  ...values,
});

describe('source bitrate estimate', () => {
  it('does not add audio again to a supplied source total', () => {
    expect(
      estimateSourceBitrate(
        details({
          bitrate: 1_646_365,
          videoDetails: [video({ bitrate: 1_646_365 })],
          audioDetails: [{ index: 1, bitrate: 192_000 }],
        }),
      ),
    ).toBe(1_646_365);
  });
  it('counts every mapped audio and eligible video track, using statistics when needed', () => {
    expect(
      estimateSourceBitrate(
        details({
          videoDetails: [
            video({ statisticsBitrate: 1_467_721 }),
            video({ isAttachedPic: true, bitrate: 9_000_000 }),
          ],
          audioDetails: [
            { index: 1, statisticsBitrate: 175_975 },
            { index: 2, bitrate: 128_000 },
          ],
        }),
      ),
    ).toBe(1_771_696);
  });
  it('uses full file duration rather than a scheduled playback slice', () => {
    expect(
      estimateSourceBitrate(
        details({
          sourceSizeBytes: 15_343_893,
          sourceFileDurationMs: 77_026,
          videoDetails: [video({ bitrate: 1_000_000 })],
          audioDetails: [{ index: 1 }],
        }),
      ),
    ).toBe(1_593_633);
  });
  it('does not label a partial track sum as a complete output estimate', () => {
    expect(
      estimateSourceBitrate(
        details({
          videoDetails: [video({ bitrate: 1_000_000 })],
          audioDetails: [{ index: 1 }],
        }),
      ),
    ).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity])(
    'rejects invalid measurement inputs (%s)',
    (invalid) => {
      expect(bitrateFromSize(invalid, 1_000)).toBeUndefined();
      expect(bitrateFromSize(1_000, invalid)).toBeUndefined();
    },
  );
});
