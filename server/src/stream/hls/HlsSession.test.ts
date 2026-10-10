import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { StopOptions } from '@/stream/Session.js';
import { Result } from '@/types/result.js';
import dayjs from '@/util/dayjs.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProgramStream } from '../ProgramStream.ts';
import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { FeatureFlagService } from '@/services/FeatureFlagService.js';
import { createDirectSubtitleSlots } from '../../ffmpeg/DirectSubtitleSlots.ts';
import { HlsSession } from './HlsSession.js';

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
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

vi.mock('@/stream/ConnectionTracker.ts', () => {
  return {
    ConnectionTracker: class {
      on = vi.fn();
      recordHeartbeat = vi.fn();
      cancelCleanup = vi.fn();
      removeStaleConnections = vi.fn(() => []);
    },
  };
});

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeSession(
  transcodeDirectory: string,
  streamMode: 'hls' | 'hls_direct_v2' = 'hls',
): HlsSession {
  const channel = {
    uuid: channelUuid,
    transcodeConfig: {},
  } as ChannelOrmWithTranscodeConfig;

  const options = {
    streamMode,
    initialSegmentCount: 2,
    transcodeDirectory,
  };

  return new HlsSession(
    channel,
    options,
    {} as StreamProgramCalculator,
    {} as ISettingsDB,
    {} as OnDemandChannelService,
    (() => ({}) as unknown as ProgramStream) as (
      ctx: PlayerContext,
      fmt: OutputFormat,
    ) => ProgramStream,
  );
}

function makeNativeRetentionSession(transcodeDirectory: string): HlsSession {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const channel = {
    uuid: channelUuid,
    transcodeConfig: {},
    subtitlesEnabled: true,
  } as ChannelOrmWithTranscodeConfig;
  const transcodeSession = {
    streamDuration: dayjs.duration(60, 'seconds'),
  } as FfmpegTranscodeSession;
  class RetentionSession extends HlsSession {
    protected override async waitForStreamReady() {
      await started.promise;
      return Result.success(undefined);
    }
    protected override async stopInternal() {
      this.state = 'stopped';
      finished.resolve();
    }
  }
  return new RetentionSession(
    channel,
    {
      streamMode: 'hls_direct_v2',
      initialSegmentCount: 2,
      transcodeDirectory,
    },
    {
      getCurrentLineupItem: vi.fn(async () =>
        Result.success({
          lineupItem: {
            type: 'offline',
            duration: 60000,
            streamDuration: 60000,
            programBeginMs: 0,
          },
          channelContext: channel,
          sourceChannel: channel,
        }),
      ),
    } as unknown as StreamProgramCalculator,
    {} as ISettingsDB,
    {
      getLiveTimestamp: vi.fn(async () => 0),
    } as unknown as OnDemandChannelService,
    () =>
      ({
        on: vi.fn(),
        setup: vi.fn(async () => Result.success(transcodeSession)),
        start: vi.fn(async () => started.resolve()),
        wait: () => finished.promise,
        transcodeSession,
      }) as unknown as ProgramStream,
    {
      getChannelSubtitlePreferences: vi.fn(async () => [
        { languageCode: 'eng' },
      ]),
    } as unknown as IChannelDB,
    { get: () => true } as unknown as FeatureFlagService,
  );
}

describe('HlsSession', () => {
  describe.each(['video', 'master'] as const)(
    '%s playlist replacement',
    (kind) => {
      let directory: tmp.DirResult;
      let session: HlsSession;
      const content = '#EXTM3U\n#EXT-X-VERSION:3\n';
      const read = async () =>
        kind === 'video'
          ? (await session.getPlaylist())?.join('\n')
          : (await session.getMasterPlaylist()).get();

      beforeEach(() => {
        directory = tmp.dirSync({ unsafeCleanup: true });
        session = makeSession(directory.name, 'hls_direct_v2');
      });
      afterEach(() => {
        vi.restoreAllMocks();
        directory.removeCallback();
      });

      test('serves the replacement after transient ENOENT without a stat/read race', async () => {
        const absent = Object.assign(new Error('replacement in progress'), {
          code: 'ENOENT',
        });
        const stat = vi.spyOn(fs, 'stat');
        const file = vi
          .spyOn(fs, 'readFile')
          .mockRejectedValueOnce(absent)
          .mockRejectedValueOnce(absent)
          .mockResolvedValue(content);
        expect(await read()).toBe(content);
        expect(file).toHaveBeenCalledTimes(3);
        expect(stat).not.toHaveBeenCalled();
      });

      test('leaves a persistently missing playlist absent after bounded retries', async () => {
        const file = vi
          .spyOn(fs, 'readFile')
          .mockRejectedValue(
            Object.assign(new Error('absent'), { code: 'ENOENT' }),
          );
        expect(await read()).toBeUndefined();
        expect(file).toHaveBeenCalledTimes(5);
      });

      test('propagates other I/O errors without retrying', async () => {
        const file = vi
          .spyOn(fs, 'readFile')
          .mockRejectedValue(
            Object.assign(new Error('permission denied'), { code: 'EACCES' }),
          );
        await expect(read()).rejects.toMatchObject(
          kind === 'master'
            ? { cause: { code: 'EACCES', message: 'permission denied' } }
            : { code: 'EACCES', message: 'permission denied' },
        );
        expect(file).toHaveBeenCalledTimes(1);
      });

      test('preserves immediate missing-file behavior for legacy HLS', async () => {
        session = makeSession(directory.name);
        const file = vi
          .spyOn(fs, 'readFile')
          .mockRejectedValue(
            Object.assign(new Error('absent'), { code: 'ENOENT' }),
          );
        expect(await read()).toBeUndefined();
        expect(file).toHaveBeenCalledTimes(1);
      });
    },
  );

  test.each([
    { subtitlesEnabled: false, sidecarEnabled: true },
    { subtitlesEnabled: true, sidecarEnabled: false },
    { subtitlesEnabled: true, sidecarEnabled: true },
  ])(
    'applies tuned-channel subtitle gates before passing slots to the first producer: %o',
    async ({ subtitlesEnabled, sidecarEnabled }) => {
      const directory = tmp.dirSync({ unsafeCleanup: true });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const channel = {
        uuid: channelUuid,
        transcodeConfig: {},
        subtitlesEnabled,
      } as ChannelOrmWithTranscodeConfig;
      const preferences = vi.fn(async () => [{ languageCode: 'eng' }]);
      let receivedPlan: unknown;
      const transcodeSession = {
        streamDuration: dayjs.duration(60, 'seconds'),
      } as FfmpegTranscodeSession;
      class GatedSession extends HlsSession {
        protected override async waitForStreamReady() {
          await started.promise;
          return Result.success(undefined);
        }
        protected override async stopInternal() {
          this.state = 'stopped';
          finished.resolve();
        }
      }
      const session = new GatedSession(
        channel,
        {
          streamMode: 'hls_direct_v2',
          initialSegmentCount: 2,
          transcodeDirectory: directory.name,
        },
        {
          getCurrentLineupItem: vi.fn(async () =>
            Result.success({
              lineupItem: {
                type: 'offline',
                duration: 60000,
                streamDuration: 60000,
                programBeginMs: 0,
              },
              channelContext: channel,
              sourceChannel: channel,
            }),
          ),
        } as unknown as StreamProgramCalculator,
        {} as ISettingsDB,
        {
          getLiveTimestamp: vi.fn(async () => 0),
        } as unknown as OnDemandChannelService,
        (_context, _format, options) => {
          receivedPlan = options?.directSubtitleSlots;
          return {
            on: vi.fn(),
            setup: vi.fn(async () => Result.success(transcodeSession)),
            start: vi.fn(async () => started.resolve()),
            wait: () => finished.promise,
            transcodeSession,
          } as unknown as ProgramStream;
        },
        { getChannelSubtitlePreferences: preferences } as unknown as IChannelDB,
        { get: () => sidecarEnabled } as unknown as FeatureFlagService,
      );
      session.on('error', () => {});
      try {
        await session.start();
        expect(session.state).toBe('started');
        if (subtitlesEnabled && sidecarEnabled) {
          expect(preferences).toHaveBeenCalledOnce();
          expect(receivedPlan).toEqual(createDirectSubtitleSlots(['eng']));
        } else {
          expect(preferences).not.toHaveBeenCalled();
          expect(receivedPlan).toEqual([]);
        }
      } finally {
        await session.stop();
        directory.removeCallback();
      }
    },
  );
  test('freezes filtered slots before the first producer and serves the native windows across populated, empty and returned output', async () => {
    const directory = tmp.dirSync({ unsafeCleanup: true });
    const started = Array.from({ length: 3 }, () =>
      Promise.withResolvers<void>(),
    );
    const finished = Array.from({ length: 3 }, () =>
      Promise.withResolvers<void>(),
    );
    const channel = {
      uuid: channelUuid,
      transcodeConfig: {},
      subtitlesEnabled: true,
    } as ChannelOrmWithTranscodeConfig;
    const slots = createDirectSubtitleSlots(['eng']);
    const preferences = vi.fn(async () => [
      { languageCode: 'eng', priority: 0 },
    ]);
    const receivedPlans: unknown[] = [];
    let producerIndex = 0;
    class FixedSession extends HlsSession {
      requiredFiles() {
        return this.getAdditionalRequiredFiles();
      }
      protected override async waitForStreamReady() {
        await started[0]!.promise;
        return Result.success(undefined);
      }
      protected override async stopInternal() {
        this.state = 'stopped';
        for (const producer of finished) producer.resolve();
      }
    }
    const session = new FixedSession(
      channel,
      {
        streamMode: 'hls_direct_v2',
        initialSegmentCount: 2,
        transcodeDirectory: directory.name,
      },
      {
        getCurrentLineupItem: vi.fn(async () =>
          Result.success({
            lineupItem: {
              type: 'offline',
              duration: 60000,
              streamDuration: 60000,
              programBeginMs: 0,
            },
            channelContext: channel,
            sourceChannel: channel,
          }),
        ),
      } as unknown as StreamProgramCalculator,
      {} as ISettingsDB,
      {
        getLiveTimestamp: vi.fn(async () => 0),
      } as unknown as OnDemandChannelService,
      (_context, _format, options) => {
        const index = producerIndex++;
        receivedPlans.push(options?.directSubtitleSlots);
        const transcodeSession = {
          streamDuration: dayjs.duration(index === 2 ? 60 : 0, 'seconds'),
          wait: () => finished[index]!.promise,
        } as unknown as FfmpegTranscodeSession;
        return {
          on: vi.fn(),
          setup: vi.fn(async () => Result.success(transcodeSession)),
          start: vi.fn(async () => {
            await options?.beforeProducerStart?.(transcodeSession, {
              audio: [],
              subtitles: [...slots],
            });
            started[index]!.resolve();
          }),
          wait: () => finished[index]!.promise,
          transcodeSession,
          renditions: { audio: [], subtitles: [...slots] },
        } as unknown as ProgramStream;
      },
      { getChannelSubtitlePreferences: preferences } as unknown as IChannelDB,
      { get: () => true } as unknown as FeatureFlagService,
    );
    session.on('error', () => {});
    const write = (name: string, contents: string) =>
      fs.writeFile(path.join(session.workingDirectory, name), contents);
    const snapshot = (name: string, run: number) =>
      fs.readFile(
        new URL(
          `./fixtures/ffmpeg7-native-hls/${name}.run${run}.txt`,
          import.meta.url,
        ),
        'utf8',
      );
    try {
      await session.start();
      await write(
        'playlist.m3u8',
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nstream.m3u8',
      );
      let originalMaster: string | undefined;
      for (let run = 0; run < 3; run++) {
        await write('stream.m3u8', await snapshot('stream.m3u8', run));
        for (const slot of slots)
          await write(
            slot.playlistName,
            await snapshot(slot.playlistName, run),
          );
        const master = (await session.getMasterPlaylist()).get();
        if (run === 0) originalMaster = master;
        expect(master).toBe(originalMaster);
        expect(master?.match(/TYPE=SUBTITLES/g)).toHaveLength(3);
        // Slot playlists are best-effort outputs (their tee children run
        // with onfail=ignore), so startup readiness must not wait for them.
        expect(session.requiredFiles()).toEqual([]);
        expect(
          session.isSubtitlePlaylist('subtitle_eng_regular_av_.m3u8'),
        ).toBe(false);
        expect(session.isSubtitlePlaylist('../subtitle_eng_regular.m3u8')).toBe(
          false,
        );
        const subtitles = (
          await session.trimSubtitlePlaylist(undefined, slots[0]!.playlistName)
        ).get();
        expect(subtitles?.segmentCount).toBe(run === 0 ? 10 : 20);
        expect(subtitles?.sequence).toBe(run === 2 ? 10 : 0);
        expect(subtitles?.playlist).not.toContain('/.');
        expect(subtitles?.playlist).not.toContain('#EXT-X-ENDLIST');
        if (run < 2) {
          finished[run]!.resolve();
          await started[run + 1]!.promise;
        }
      }
      expect(preferences).toHaveBeenCalledTimes(1);
      expect(receivedPlans).toEqual([slots, slots, slots]);
      // Never-selected slots were snapshotted before each append restart too.
      for (const slot of slots.slice(1)) {
        const subtitle = (
          await session.trimSubtitlePlaylist(undefined, slot.playlistName)
        ).get();
        expect(subtitle?.segmentCount).toBe(20);
        expect(subtitle?.playlist).not.toContain('/.');
        expect(subtitle?.playlist).toContain('#EXT-X-DISCONTINUITY');
      }
    } finally {
      await session.stop();
      directory.removeCallback();
    }
  });
  test('serializes Direct v2 directory cleanup with an in-flight native playlist read', async () => {
    const directory = tmp.dirSync({ unsafeCleanup: true });
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    let cleanupStarted = false;
    class CleanupSession extends HlsSession {
      activate() {
        this.state = 'started';
      }
      protected override async stopInternal(options: StopOptions) {
        stopping.resolve();
        await super.stopInternal(options);
      }
      protected override async cleanupDirectory() {
        cleanupStarted = true;
        await super.cleanupDirectory();
      }
    }
    const session = new CleanupSession(
      {
        uuid: channelUuid,
        transcodeConfig: {},
      } as ChannelOrmWithTranscodeConfig,
      {
        streamMode: 'hls_direct_v2',
        initialSegmentCount: 2,
        transcodeDirectory: directory.name,
      },
      {} as StreamProgramCalculator,
      {} as ISettingsDB,
      {} as OnDemandChannelService,
      () => ({}) as ProgramStream,
    );
    await fs.mkdir(session.workingDirectory, { recursive: true });
    await fs.writeFile(
      path.join(session.workingDirectory, 'stream.m3u8'),
      '#EXTM3U\n',
    );
    session.activate();
    const readFile = vi
      .spyOn(fs, 'readFile')
      .mockImplementationOnce(async () => {
        reading.resolve();
        await releaseRead.promise;
        return '#EXTM3U\n';
      });
    try {
      const subtitleRead = session.trimPlaylist();
      await reading.promise;
      const stop = session.stop();
      await stopping.promise;
      expect(cleanupStarted).toBe(false);
      releaseRead.resolve();
      expect((await subtitleRead).isSuccess()).toBe(true);
      await stop;
      expect(cleanupStarted).toBe(true);
    } finally {
      releaseRead.resolve();
      readFile.mockRestore();
      directory.removeCallback();
    }
  });
  test('starts the Direct v2 producer while startup holds the lifecycle lock', async () => {
    const directory = tmp.dirSync({ unsafeCleanup: true });
    const producerStarted = Promise.withResolvers<void>();
    const producerFinished = Promise.withResolvers<void>();
    const channel = {
      uuid: channelUuid,
      transcodeConfig: {},
    } as ChannelOrmWithTranscodeConfig;
    const transcodeSession = {
      streamDuration: dayjs.duration(60, 'seconds'),
      wait: () => producerFinished.promise,
    } as unknown as FfmpegTranscodeSession;
    const startProducer = vi.fn(async () => producerStarted.resolve());
    const programStream = {
      on: vi.fn(),
      setup: vi.fn(async () => Result.success(transcodeSession)),
      start: startProducer,
      wait: () => producerFinished.promise,
      transcodeSession,
      renditions: {
        audio: [],
        nativeSubtitleOutput: true,
        subtitle: {
          language: 'eng',
          default: false,
          forced: false,
        },
      },
    } as unknown as ProgramStream;
    class StartupSession extends HlsSession {
      protected override async waitForStreamReady() {
        return Result.attemptAsync(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              producerStarted.promise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Producer blocked during startup')),
                  1000,
                );
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        });
      }
      protected override async stopInternal() {
        this.state = 'stopped';
        producerFinished.resolve();
      }
    }
    const session = new StartupSession(
      channel,
      {
        streamMode: 'hls_direct_v2',
        initialSegmentCount: 2,
        transcodeDirectory: directory.name,
      },
      {
        getCurrentLineupItem: vi.fn(async () =>
          Result.success({
            lineupItem: {
              type: 'offline',
              duration: 60000,
              streamDuration: 60000,
              programBeginMs: 0,
            },
            channelContext: channel,
            sourceChannel: channel,
          }),
        ),
      } as unknown as StreamProgramCalculator,
      {} as ISettingsDB,
      {
        getLiveTimestamp: vi.fn(async () => 0),
      } as unknown as OnDemandChannelService,
      () => programStream,
    );
    session.on('error', () => {});
    try {
      await session.start();
      expect(session.state).toBe('started');
      expect(startProducer).toHaveBeenCalledTimes(1);

      const videoLines = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:7',
        '#EXT-X-MEDIA-SEQUENCE:40',
      ];
      for (let index = 40; index < 60; index++) {
        videoLines.push(
          '#EXTINF:4.12,',
          `data${String(index).padStart(6, '0')}.ts`,
        );
      }
      await fs.writeFile(
        path.join(session.workingDirectory, 'stream.m3u8'),
        videoLines.join('\n'),
      );
      for (const number of [39, 40, 60])
        await fs.writeFile(
          path.join(
            session.workingDirectory,
            `data${String(number).padStart(6, '0')}.ts`,
          ),
          '',
        );
      session.onSegmentRequested('client', 'data000030.ts');
      const native = (await session.trimPlaylist()).get();
      expect(native?.sequence).toBe(40);
      expect(native?.playlist).toContain('#EXT-X-TARGETDURATION:7');
      expect(native?.playlist?.match(/#EXTINF:4.12,/g)).toHaveLength(20);
      expect(native?.playlist).toContain('data000040.ts');
      expect(native?.playlist).toContain('data000059.ts');
      const files = await fs.readdir(session.workingDirectory);
      expect(files).toContain('data000039.ts');
      expect(files).toContain('data000040.ts');
      expect(files).toContain('data000060.ts');
    } finally {
      await session.stop();
      directory.removeCallback();
    }
  });

  describe('native segment retention', () => {
    const retiredAt = new Date('2026-01-01T00:00:00Z').getTime();
    let directory: tmp.DirResult;
    let session: HlsSession;
    const [slot] = createDirectSubtitleSlots(['eng']);
    if (slot === undefined)
      throw new Error('Expected an English subtitle slot');

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(retiredAt);
      directory = tmp.dirSync({ unsafeCleanup: true });
      session = makeNativeRetentionSession(directory.name);
      await session.start();
    });

    afterEach(async () => {
      await session.stop();
      directory.removeCallback();
      vi.useRealTimers();
    });

    const videoName = (number: number) =>
      `data${String(number).padStart(6, '0')}.ts`;
    const subtitleName = (number: number) =>
      `${slot.segmentPrefix}${number}.vtt`;

    async function writePlaylist(
      name: string,
      sequence: number,
      count: number,
      segmentName: (number: number) => string,
    ) {
      const lines = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
      ];
      for (let index = sequence; index < sequence + count; index++)
        lines.push('#EXTINF:4,', `/stream/${segmentName(index)}`);
      await fs.writeFile(
        path.join(session.workingDirectory, name),
        lines.join('\n'),
      );
    }

    async function prune(sequence: number, elapsedSeconds: number) {
      vi.setSystemTime(retiredAt + elapsedSeconds * 1000);
      await (
        session as unknown as {
          pruneNativeSegments(videoSequence: number): Promise<void>;
        }
      ).pruneNativeSegments(sequence);
    }

    test.each(['video', 'subtitle'])(
      'retains retired TS and VTT for the longest served %s window plus segment duration',
      async (longestWindow) => {
        await writePlaylist(
          'stream.m3u8',
          0,
          longestWindow === 'video' ? 20 : 2,
          videoName,
        );
        await writePlaylist(
          slot.playlistName,
          0,
          longestWindow === 'subtitle' ? 20 : 2,
          subtitleName,
        );
        for (const name of [
          videoName(0),
          videoName(1),
          videoName(100),
          subtitleName(0),
          subtitleName(1),
          subtitleName(100),
          'subtitle_unregistered_av_0.vtt',
        ]) {
          const filename = path.join(session.workingDirectory, name);
          await fs.writeFile(filename, 'segment');
          // Age before production is not the time it left the served window.
          await fs.utimes(filename, new Date(0), new Date(0));
        }
        if (longestWindow === 'video') {
          expect((await session.trimPlaylist()).get()?.segmentCount).toBe(20);
        } else {
          expect(
            (
              await session.trimSubtitlePlaylist(undefined, slot.playlistName)
            ).get()?.segmentCount,
          ).toBe(20);
        }

        // Later short windows must not shrink the already advertised grace.
        await writePlaylist('stream.m3u8', 1, 2, videoName);
        await writePlaylist(slot.playlistName, 1, 2, subtitleName);
        expect((await session.trimPlaylist()).get()?.sequence).toBe(1);
        await prune(1, 0);
        for (const seconds of [10, 83]) {
          await prune(1, seconds);
          for (const name of [videoName(0), subtitleName(0)])
            expect(
              await fs.readFile(
                path.join(session.workingDirectory, name),
                'utf8',
              ),
            ).toBe('segment');
        }
        await prune(1, 84);
        const files = await fs.readdir(session.workingDirectory);
        expect(files).not.toContain(videoName(0));
        expect(files).not.toContain(subtitleName(0));
        for (const name of [
          videoName(1),
          videoName(100),
          subtitleName(1),
          subtitleName(100),
          'subtitle_unregistered_av_0.vtt',
        ])
          expect(files).toContain(name);
      },
    );

    test('keeps segments a client is still reading even after FFmpeg rolled them out', async () => {
      await writePlaylist('stream.m3u8', 10, 2, videoName);
      await writePlaylist(slot.playlistName, 10, 2, subtitleName);
      for (const name of [
        videoName(3),
        videoName(5),
        subtitleName(3),
        subtitleName(5),
      ]) {
        await fs.writeFile(
          path.join(session.workingDirectory, name),
          'segment',
        );
      }
      // A paused or slow client whose last requests were segment 5.
      session.onSegmentRequested('10.0.0.9', videoName(5));
      session.onSegmentRequested('10.0.0.9', subtitleName(5));

      await prune(10, 0);
      await prune(10, 600);
      const files = await fs.readdir(session.workingDirectory);
      expect(files).toContain(videoName(5));
      expect(files).toContain(subtitleName(5));
      expect(files).not.toContain(videoName(3));
      expect(files).not.toContain(subtitleName(3));
    });

    test('releases a rendition floor once the client kept playing without it', async () => {
      await writePlaylist('stream.m3u8', 10, 2, videoName);
      await writePlaylist(slot.playlistName, 10, 2, subtitleName);
      for (const name of [videoName(5), subtitleName(5), subtitleName(11)]) {
        await fs.writeFile(
          path.join(session.workingDirectory, name),
          'segment',
        );
      }
      session.onSegmentRequested('10.0.0.9', videoName(5));
      session.onSegmentRequested('10.0.0.9', subtitleName(5));
      await prune(10, 0);

      // The client switched tracks: it keeps fetching video and never asks
      // for this rendition again, so its old floor must not pin the
      // rendition's segments for the life of the connection.
      vi.setSystemTime(retiredAt + 61_000);
      session.onSegmentRequested('10.0.0.9', videoName(11));
      await prune(10, 61);
      await prune(10, 700);
      const files = await fs.readdir(session.workingDirectory);
      expect(files).not.toContain(subtitleName(5));
      expect(files).toContain(subtitleName(11));
    });

    test('restarts retirement when a previously retired URI is served again', async () => {
      await writePlaylist('stream.m3u8', 0, 20, videoName);
      const filename = path.join(session.workingDirectory, videoName(0));
      await fs.writeFile(filename, 'segment');
      await session.trimPlaylist();
      await writePlaylist('stream.m3u8', 1, 2, videoName);
      await prune(1, 0);

      vi.setSystemTime(retiredAt + 50_000);
      await writePlaylist('stream.m3u8', 0, 2, videoName);
      expect((await session.trimPlaylist()).get()?.sequence).toBe(0);
      await writePlaylist('stream.m3u8', 1, 2, videoName);
      await prune(1, 60);
      await prune(1, 84);
      expect(await fs.readFile(filename, 'utf8')).toBe('segment');
      await prune(1, 144);
      expect(await fs.readdir(session.workingDirectory)).not.toContain(
        videoName(0),
      );
    });
  });

  describe('getMasterPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when playlist.m3u8 does not exist', async () => {
      // Working directory will be created by initDirectories, but we skip that here.
      // The file simply won't exist.
      const session = makeSession(dir.name);
      const result = await session.getMasterPlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });
  });

  describe('trimSubtitlePlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when subs.m3u8 does not exist', async () => {
      const session = makeSession(dir.name);
      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });

    test('derives a non-zero media sequence from segment file numbers on disk', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 20; i < 25; i++) {
        lines.push('#EXTINF:4.000000,', `sub${String(i).padStart(6, '0')}.vtt`);
      }
      await fs.writeFile(path.join(workingDir, 'subs.m3u8'), lines.join('\n'));

      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      const trimResult = result.get();
      expect(trimResult).toBeDefined();
      expect(trimResult!.sequence).toBe(20);
      expect(trimResult!.playlist).toContain('#EXT-X-MEDIA-SEQUENCE:20');
    });

    test('a client that has only ever requested an old video segment does not drag down the subtitle floor', async () => {
      // Regression test for the "media sequence changed unexpectedly: 24 ->
      // 13" bug: before BaseHlsSession tracked video/subtitle segment
      // numbers independently, the default trim floor
      // (`minSegmentRequested`) was a single per-IP value shared across
      // both numbering spaces. A client that connected but has so far only
      // fetched an old, low-numbered video segment would report that low
      // number as its "last requested segment" — which then incorrectly
      // became part of the *subtitle* trim's floor too, even though it has
      // nothing to do with subtitle segment numbers, dragging the reported
      // sequence back down on the next poll.
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 0; i < 60; i++) {
        lines.push('#EXTINF:4.000000,', `sub${String(i).padStart(6, '0')}.vtt`);
      }
      await fs.writeFile(path.join(workingDir, 'subs.m3u8'), lines.join('\n'));

      // Client A has been following subtitles and is caught up.
      session.onSegmentRequested('192.168.1.1', 'sub000050.vtt');
      // Client B is lagging behind on video and hasn't touched subtitles.
      session.onSegmentRequested('192.168.1.2', 'data000015.ts');

      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      const trimResult = result.get();
      expect(trimResult).toBeDefined();
      // Floor should come from client A's subtitle position (50), not
      // client B's unrelated low video number (15).
      expect(trimResult!.sequence).toBe(40);
    });
  });

  describe('trimPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('never lists a segment below the pruning floor', async () => {
      const session = makeSession(dir.name);

      // startInternal() sets the playlist start that trimPlaylist() needs.
      // The mocked transcode loop bails on its first call.
      await (
        session as unknown as { startInternal(): Promise<void> }
      ).startInternal();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      // ffmpeg writes three lines per segment. A two-line fixture parses to
      // zero segments.
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 0; i < 60; i++) {
        const name = `data${String(i).padStart(6, '0')}.ts`;
        lines.push(
          '#EXTINF:4.000000,',
          '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000+0000',
          name,
        );
        await fs.writeFile(path.join(workingDir, name), '');
      }
      await fs.writeFile(
        path.join(workingDir, 'stream.m3u8'),
        lines.join('\n'),
      );

      session.onSegmentRequested('10.0.0.1', 'data000050.ts');
      expect((await session.trimPlaylist()).get()?.sequence).toBe(40);

      // Let the prune finish removing everything below 40.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const onDisk = (await fs.readdir(workingDir))
        .filter((f) => f.startsWith('data'))
        .sort();
      expect(onDisk[0]).toBe('data000040.ts');

      // The client rewinds into the range pruning just deleted.
      session.onSegmentRequested('10.0.0.1', 'data000020.ts');
      const playlist = (await session.trimPlaylist()).get()?.playlist ?? '';
      const listed = [...playlist.matchAll(/data\d{6}\.ts/g)]
        .map((m) => m[0])
        .sort();
      expect(listed.length).toBeGreaterThan(0);
      expect(listed[0]).toBe('data000040.ts');
      for (const file of listed) {
        expect(onDisk).toContain(file);
      }
    });
  });

  describe('getLastSubtitleSegmentNumber (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns 0 when no .vtt segments exist', async () => {
      const session = makeSession(dir.name);
      await fs.mkdir(session.workingDirectory, { recursive: true });

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(0);
    });

    test('returns one past the highest existing .vtt segment number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(5);
    });
  });

  describe('deleteOldSegmentFiles (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    async function callDeleteOldSegmentFiles(
      session: HlsSession,
      sequenceNum: number,
      extensions: string[],
    ) {
      return (
        session as unknown as {
          deleteOldSegmentFiles(
            sequenceNum: number,
            extensions: string[],
          ): Promise<void>;
        }
      ).deleteOldSegmentFiles(sequenceNum, extensions);
    }

    test('deletes .ts/.mp4 segments below the sequence number (regression)', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `data${String(n).padStart(6, '0')}.ts`),
          '',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.ts', '.mp4']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000003.ts', 'data000004.ts']);
    });

    test('deletes .vtt segments below the sequence number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['sub000003.vtt', 'sub000004.vtt']);
    });

    test('extensions filter is respected — .vtt deletion leaves .ts files untouched', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      await fs.writeFile(path.join(workingDir, 'data000000.ts'), '');
      await fs.writeFile(path.join(workingDir, 'sub000000.vtt'), 'WEBVTT\n');

      await callDeleteOldSegmentFiles(session, 5, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000000.ts']);
    });
  });
});
