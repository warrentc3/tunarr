import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../db/schema/TranscodeConfig.ts';
import { createDirectSubtitleSlots } from '../ffmpeg/DirectSubtitleSlots.ts';
import type { FFmpegAssistedFactory } from '../ffmpeg/FFmpegModule.ts';
import type { FfmpegStreamFactory } from '../ffmpeg/FfmpegStreamFactory.ts';
import type { FfmpegTranscodeSession } from '../ffmpeg/FfmpegTrancodeSession.ts';
import {
  HlsDirectOutputFormat,
  HlsOutputFormat,
  defaultHlsOptions,
} from '../ffmpeg/builder/constants.ts';
import type {
  PlaceholderSessionOpts,
  TranscodeSessionResult,
} from '../ffmpeg/types.ts';
import type { CacheImageService } from '../services/cacheImageService.ts';
import dayjs from '../util/dayjs.ts';
import { PlayerContext } from './PlayerStreamContext.ts';
import { ProgramStream } from './ProgramStream.ts';
import type { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';
import type { DirectSubtitleSlot } from './types.ts';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { ChannelOrmWithTranscodeConfig } from '../db/schema/derivedTypes.ts';
import type { FeatureFlagService } from '../services/FeatureFlagService.ts';
import type { OnDemandChannelService } from '../services/OnDemandChannelService.ts';
import type { StreamProgramCalculator } from './StreamProgramCalculator.ts';
import { HlsSession } from './hls/HlsSession.ts';
import { Result } from '../types/result.ts';
import { streamApi } from '../api/streamApi.ts';

vi.mock('../container.js', () => ({ container: { get: vi.fn() } }));
vi.mock('@/stream/VideoStream.js', () => ({ VideoStream: class {} }));

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
    isInitialized: true,
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      bindings: vi.fn(() => ({})),
      setBindings: vi.fn(),
    }),
  },
}));

vi.mock('@/stream/ConnectionTracker.ts', () => ({
  ConnectionTracker: class {
    on = vi.fn();
    recordHeartbeat = vi.fn();
    cancelCleanup = vi.fn();
    removeStaleConnections = vi.fn(() => []);
  },
}));

const slots = createDirectSubtitleSlots(['eng']);

function makeStream(
  kind: 'offline' | 'error',
  directSubtitleSlots: readonly DirectSubtitleSlot[] = slots,
) {
  const eventSession = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    start: vi.fn(() => new PassThrough()),
    streamEndTime: dayjs().add(30, 'seconds'),
    exited: Promise.resolve(),
  });
  const session = eventSession as unknown as FfmpegTranscodeSession;
  const createPlaceholderSession = vi
    .fn<(opts: PlaceholderSessionOpts) => Promise<TranscodeSessionResult>>()
    .mockResolvedValue({
      session,
      renditions: { audio: [], subtitles: [...directSubtitleSlots] },
    });
  const ffmpegFactory: FFmpegAssistedFactory = () =>
    ({ createPlaceholderSession }) as unknown as FfmpegStreamFactory;
  const channel = { uuid: 'channel' } as ChannelOrm;
  const baseItem = {
    duration: 30_000,
    streamDuration: 30_000,
    programBeginMs: 0,
  };
  const context = new PlayerContext(
    kind === 'offline'
      ? { ...baseItem, type: kind }
      : { ...baseItem, type: kind, error: 'Fixture error' },
    channel,
    channel,
    {} as TranscodeConfigOrm,
    { audioOnly: false, realtime: true, streamMode: 'hls_direct_v2' },
  );
  const stream = new ProgramStream(
    {} as ISettingsDB,
    {} as CacheImageService,
    ffmpegFactory,
    {} as MediaSourceDB,
    {} as ProgramStreamDetailsFetcher,
    [],
    context,
    HlsDirectOutputFormat(defaultHlsOptions),
    { directSubtitleSlots, ptsOffset: 90000, realtime: true },
  );
  return { stream, eventSession, createPlaceholderSession };
}

describe('ProgramStream fixed subtitle catalogue propagation', () => {
  it('checkpoints an unpolled finalized subtitle tail before runtime error append rewrites its URIs', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tunarr-native-replacement-'),
    );
    const { stream, eventSession, createPlaceholderSession } =
      makeStream('offline');
    const firstStarted = Promise.withResolvers<void>();
    const failedExited = Promise.withResolvers<void>();
    eventSession.exited = failedExited.promise;
    Object.assign(eventSession, {
      streamDuration: dayjs.duration(60, 'seconds'),
    });
    const replacementStarted = Promise.withResolvers<void>();
    const replacementExited = Promise.withResolvers<void>();
    const channel = {
      uuid: 'a0000000-0000-4000-a000-000000000001',
      transcodeConfig: {},
      subtitlesEnabled: true,
    } as ChannelOrmWithTranscodeConfig;
    const calculate = vi.fn(async () =>
      Result.success({
        lineupItem: {
          type: 'offline' as const,
          duration: 60000,
          streamDuration: 60000,
          programBeginMs: 0,
        },
        channelContext: channel,
        sourceChannel: channel,
      }),
    );
    class ReadySession extends HlsSession {
      protected override async waitForStreamReady() {
        await firstStarted.promise;
        return Result.success(undefined);
      }
    }
    const hls = new ReadySession(
      channel,
      {
        streamMode: 'hls_direct_v2',
        initialSegmentCount: 2,
        transcodeDirectory: directory,
      },
      { getCurrentLineupItem: calculate } as unknown as StreamProgramCalculator,
      {} as ISettingsDB,
      {
        getLiveTimestamp: vi.fn(async () => 0),
      } as unknown as OnDemandChannelService,
      (_context, _format, options) => {
        stream.opts = { ...stream.opts, ...options };
        return stream;
      },
      {
        getChannelSubtitlePreferences: async () => [{ languageCode: 'eng' }],
      } as unknown as IChannelDB,
      { get: () => true } as unknown as FeatureFlagService,
    );
    hls.on('error', () => {});
    const app = Fastify()
      .setValidatorCompiler(validatorCompiler)
      .setSerializerCompiler(serializerCompiler)
      .withTypeProvider<ZodTypeProvider>();
    app.decorateRequest('serverCtx', null);
    app.addHook('onRequest', (request, _reply, done) => {
      (request as unknown as { serverCtx: unknown }).serverCtx = {
        sessionManager: { getHlsSession: () => hls },
      };
      done();
    });
    vi.spyOn(hls, 'isKnownConnection').mockReturnValue(true);
    await app.register(streamApi);
    await app.ready();
    const writeNative = (count: number, lostBefore = 0) => {
      const video = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let index = 0; index < count; index++) {
        if (lostBefore > 0 && index === lostBefore)
          video.push('#EXT-X-DISCONTINUITY');
        video.push(
          '#EXTINF:4.000000,',
          `data${String(index).padStart(6, '0')}.ts`,
        );
        writeFileSync(
          path.join(
            hls.workingDirectory,
            `data${String(index).padStart(6, '0')}.ts`,
          ),
          '',
        );
      }
      writeFileSync(
        path.join(hls.workingDirectory, 'stream.m3u8'),
        video.join('\n'),
      );
      for (const slot of slots) {
        const subtitles = [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-MEDIA-SEQUENCE:0',
        ];
        for (let index = 0; index < count; index++) {
          const filename = `${slot.segmentPrefix}${index}.vtt`;
          subtitles.push(
            '#EXTINF:4.000000,',
            index < lostBefore ? '.' : filename,
          );
          writeFileSync(path.join(hls.workingDirectory, filename), 'WEBVTT\n');
        }
        subtitles.push('#EXT-X-ENDLIST');
        writeFileSync(
          path.join(hls.workingDirectory, slot.playlistName),
          subtitles.join('\n'),
        );
      }
    };
    eventSession.start.mockImplementation(() => {
      writeNative(1);
      firstStarted.resolve();
      return new PassThrough();
    });
    const replacement = Object.assign(new EventEmitter(), {
      start: vi.fn(() => {
        writeNative(4, 3);
        replacementStarted.resolve();
        return new PassThrough();
      }),
      kill: vi.fn(() => replacementExited.resolve()),
      exited: replacementExited.promise,
    }) as unknown as FfmpegTranscodeSession;
    try {
      await hls.start();
      expect(
        (
          await hls.trimSubtitlePlaylist(undefined, slots[0]!.playlistName)
        ).get()?.segmentCount,
      ).toBe(1);
      createPlaceholderSession.mockResolvedValue({
        session: replacement,
        renditions: { audio: [], subtitles: [...slots] },
      });
      eventSession.emit('error');
      await Promise.resolve();
      expect(replacement.start).not.toHaveBeenCalled();
      // The failed producer closes two more segments after its last client
      // poll. They must be captured after exit, including unselected slots.
      writeNative(3);
      failedExited.resolve();
      await replacementStarted.promise;
      for (const slot of slots) {
        const response = await app.inject({
          method: 'GET',
          url: `/stream/channels/${channel.uuid}/hls_direct_v2/${slot.playlistName}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body.match(/#EXTINF:/g)).toHaveLength(4);
        expect(response.body).toContain(`${slot.segmentPrefix}2.vtt`);
        expect(response.body).toContain(
          `#EXT-X-DISCONTINUITY\n#EXTINF:4.000000,\n${slot.segmentPrefix}3.vtt`,
        );
        expect(response.body).not.toMatch(/\n\.\n/);
        for (let index = 0; index < 4; index++) {
          const segment = await app.inject({
            method: 'GET',
            url: `/stream/channels/${channel.uuid}/hls_direct_v2/${slot.segmentPrefix}${index}.vtt`,
          });
          expect(segment.statusCode).toBe(200);
          expect(segment.body).toContain('WEBVTT\nX-TIMESTAMP-MAP=');
        }
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/stream/channels/${channel.uuid}/hls_direct_v2/stream.m3u8`,
          })
        ).statusCode,
      ).toBe(200);
      expect(calculate).toHaveBeenCalledTimes(1);
      await hls.stop();
      expect(replacement.kill).toHaveBeenCalledTimes(1);
    } finally {
      failedExited.resolve();
      replacementExited.resolve();
      await hls.stop();
      await app.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('waits for the failed writer and the checkpoint, then keeps waiting for the replacement', async () => {
    const { stream, eventSession, createPlaceholderSession } =
      makeStream('offline');
    const failedExited = Promise.withResolvers<void>();
    eventSession.exited = failedExited.promise;
    const replacementExited = Promise.withResolvers<void>();
    const checkpointEntered = Promise.withResolvers<void>();
    const checkpointReleased = Promise.withResolvers<void>();
    const replacement = Object.assign(new EventEmitter(), {
      start: vi.fn(() => new PassThrough()),
      kill: vi.fn(() => replacementExited.resolve()),
      exited: replacementExited.promise,
    }) as unknown as FfmpegTranscodeSession;
    let checkpointCount = 0;
    stream.opts = {
      ...stream.opts,
      beforeProducerStart: async () => {
        if (++checkpointCount === 2) {
          checkpointEntered.resolve();
          await checkpointReleased.promise;
        }
        return true;
      },
    };
    await stream.start();
    createPlaceholderSession.mockResolvedValue({
      session: replacement,
      renditions: { audio: [], subtitles: [...slots] },
    });
    eventSession.emit('error');
    let finished = false;
    const waiting = stream.wait().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(checkpointCount).toBe(1);
    expect(createPlaceholderSession).toHaveBeenCalledTimes(1);
    failedExited.resolve();
    await checkpointEntered.promise;
    expect(replacement.start).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    checkpointReleased.resolve();
    await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    replacementExited.resolve();
    await waiting;
    expect(finished).toBe(true);
  });

  it('cancels a replacement if shutdown arrives during its checkpoint', async () => {
    const { stream, eventSession, createPlaceholderSession } =
      makeStream('offline');
    const checkpointEntered = Promise.withResolvers<void>();
    const checkpointReleased = Promise.withResolvers<void>();
    const replacement = Object.assign(new EventEmitter(), {
      start: vi.fn(() => new PassThrough()),
      kill: vi.fn(),
      exited: Promise.resolve(),
    }) as unknown as FfmpegTranscodeSession;
    await stream.start();
    stream.opts = {
      ...stream.opts,
      beforeProducerStart: async () => {
        checkpointEntered.resolve();
        await checkpointReleased.promise;
        return true;
      },
    };
    createPlaceholderSession.mockResolvedValue({
      session: replacement,
      renditions: { audio: [], subtitles: [...slots] },
    });
    eventSession.emit('error');
    await checkpointEntered.promise;
    stream.shutdown();
    checkpointReleased.resolve();
    await stream.wait();
    expect(replacement.kill).toHaveBeenCalledTimes(1);
    expect(replacement.start).not.toHaveBeenCalled();
  });
  it.each(['offline', 'error'] as const)(
    'passes the frozen catalogue through %s lineup setup',
    async (kind) => {
      const { stream, createPlaceholderSession } = makeStream(kind);

      expect((await stream.setup()).isSuccess()).toBe(true);
      expect(createPlaceholderSession).toHaveBeenCalledOnce();
      expect(
        createPlaceholderSession.mock.calls[0]?.[0].directSubtitleSlots,
      ).toBe(slots);
      expect(stream.renditions?.subtitles).toEqual(slots);
    },
  );

  it('retains the same catalogue when a running producer is replaced by an error stream', async () => {
    const { stream, eventSession, createPlaceholderSession } =
      makeStream('offline');
    await stream.setup();

    eventSession.emit('error');

    await vi.waitFor(() =>
      expect(createPlaceholderSession).toHaveBeenCalledTimes(2),
    );
    expect(createPlaceholderSession.mock.calls[1]?.[0]).toMatchObject({
      kind: 'error',
      title: 'Playback Error',
    });
    expect(
      createPlaceholderSession.mock.calls[1]?.[0].directSubtitleSlots,
    ).toBe(slots);
  });

  it('preserves an empty no-filter catalogue through a placeholder', async () => {
    const noSlots: DirectSubtitleSlot[] = [];
    const { stream, createPlaceholderSession } = makeStream('offline', noSlots);

    await stream.setup();

    expect(
      createPlaceholderSession.mock.calls[0]?.[0].directSubtitleSlots,
    ).toBe(noSlots);
    expect(stream.renditions?.subtitles).toEqual([]);
  });
});

class ThrowingProgramStream extends ProgramStream {
  protected override setupInternal(): Promise<Result<TranscodeSessionResult>> {
    return Promise.reject(
      new Error('Streams with no video are not currently supported.'),
    );
  }
}

describe('ProgramStream', () => {
  it('turns a setup throw into a failed result', async () => {
    const stream = new ThrowingProgramStream(
      {} as ISettingsDB,
      {} as CacheImageService,
      {} as FFmpegAssistedFactory,
      {} as MediaSourceDB,
      {} as ProgramStreamDetailsFetcher,
      [],
      {} as PlayerContext,
      HlsOutputFormat(defaultHlsOptions),
    );

    const result = await stream.setup();

    expect(result.isFailure()).toBe(true);
    expect(stream.isInitialized()).toBe(false);
  });
});
