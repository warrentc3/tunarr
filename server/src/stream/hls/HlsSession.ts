import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { GetLastPtsDurationTask } from '@/ffmpeg/GetLastPtsDuration.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import {
  HlsDirectOutputFormat,
  HlsOutputFormat,
} from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type { StopOptions } from '@/stream/Session.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import type { HlsSlowerSession } from '@/stream/hls/HlsSlowerSession.js';
import type {
  AudioRenditionInfo,
  DirectSubtitleRenditionInfo,
  DirectSubtitleSlot,
  SubtitleRenditionInfo,
} from '@/stream/types.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import { isNodeError, wait } from '@/util/index.js';
import { seq } from '@tunarr/shared/util';
import { Mutex } from 'async-mutex';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { filter, isEmpty, last, maxBy, sortBy } from 'lodash-es';
import fs from 'node:fs/promises';
import path, { basename, dirname, extname } from 'node:path';
import type { DeepRequired } from 'ts-essentials';
import type { ProgramStreamFactory } from '../ProgramStreamFactory.ts';
import type { ProgramStream } from '../ProgramStream.ts';
import type { BaseHlsSessionOptions } from './BaseHlsSession.js';
import { BaseHlsSession, SegmentNameRegex } from './BaseHlsSession.js';
import { HlsMasterPlaylistMutator } from './HlsMasterPlaylistMutator.js';
import type {
  FilterBeforeSegmentNumber,
  HlsPlaylistFilterOptions,
} from './HlsPlaylistMutator.js';
import { HlsPlaylistMutator } from './HlsPlaylistMutator.js';
import { HlsNativePlaylistBridge } from './HlsNativePlaylistBridge.ts';
import { createDirectSubtitleSlots } from '../../ffmpeg/DirectSubtitleSlots.ts';
import type { FeatureFlagService } from '../../services/FeatureFlagService.ts';

export type HlsSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: HlsSessionOptions,
) => HlsSession;

export type HlsSlowerSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: BaseHlsSessionOptions,
) => HlsSlowerSession;

export interface HlsSessionOptions extends BaseHlsSessionOptions {
  streamMode: 'hls' | 'hls_direct_v2';
}

/**
 * Initializes an ffmpeg process that concatenates via the /playlist
 * endpoint and outputs an HLS format + segments
 */
export class HlsSession extends BaseHlsSession<HlsSessionOptions> {
  #playlistStart?: Dayjs;
  #hlsPlaylistMutator: HlsPlaylistMutator = new HlsPlaylistMutator();
  #currentSession: Maybe<FfmpegTranscodeSession>;
  #currentProgramStream: ProgramStream | undefined;
  #lastDelete: Dayjs = dayjs().subtract(1, 'year');
  #lastSubtitleDelete: Dayjs = dayjs().subtract(1, 'year');
  // Legacy HLS retains an append-only source playlist and needs a pruning
  // floor. Direct v2 serves FFmpeg's native rolling media window instead.
  #segmentFloor = 0;
  #isFirstTranscode = true;
  #lastDiscontinuitySequence: number | undefined;
  #currentSubtitleRendition: SubtitleRenditionInfo | undefined;
  #currentDirectSubtitleRenditions: DirectSubtitleRenditionInfo[] | undefined;
  #currentAudioRenditions: AudioRenditionInfo[] = [];
  // Startup holds the lifecycle lock until FFmpeg has output. Native restart
  // metadata is captured before launching that producer under a separate lock.
  #subtitlePlaylistLock = new Mutex();
  #directSubtitleSlots: readonly DirectSubtitleSlot[] = [];
  #nativePlaylistBridge = new HlsNativePlaylistBridge([]);
  #nativeMaxPlaylistDurationMs = 0;
  #nativeMaxSegmentDurationMs = 0;
  #nativeSegmentRetiredAt = new Map<string, number>();

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
    private programCalculator: StreamProgramCalculator,
    private settingsDB: ISettingsDB,
    private onDemandService: OnDemandChannelService,
    private programStreamFactory: ProgramStreamFactory,
    private channelDB?: IChannelDB,
    private featureFlagService?: FeatureFlagService,
  ) {
    super(channel, options);
  }

  public get sessionType(): HlsSessionOptions['streamMode'] {
    return this.sessionOptions.streamMode;
  }

  async getPlaylist() {
    return this.readPlaylist();
  }

  async getMasterPlaylist(): Promise<Result<string | undefined>> {
    return Result.attemptAsync(async () => {
      const content = await this.readPlaylistContents(this._masterPlaylistPath);
      if (content === undefined) return undefined;
      const rendition = this.#currentSubtitleRendition;
      const hlsOptions = this.getHlsOptions();
      const lines = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        hlsOptions,
      );
      if (this.#currentDirectSubtitleRenditions !== undefined) {
        HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
          lines,
          this.#currentDirectSubtitleRenditions,
          hlsOptions,
        );
      } else if (rendition) {
        HlsMasterPlaylistMutator.injectSubtitleMediaTag(
          lines,
          rendition,
          hlsOptions,
        );
      }
      if (this.#currentAudioRenditions.length > 0) {
        HlsMasterPlaylistMutator.injectAudioMediaTags(
          lines,
          this.#currentAudioRenditions,
          hlsOptions,
        );
      }
      return lines.join('\n');
    });
  }

  async trimPlaylist(filterOpts?: HlsPlaylistFilterOptions) {
    if (this.sessionType === 'hls_direct_v2') {
      return this.readNativeVideoPlaylist();
    }
    return Result.attemptAsync(async () => {
      return await this.lock.runExclusive(async () => {
        const playlistLines = await this.readPlaylist();
        if (playlistLines) {
          const trimResult = this.selectVideoPlaylist(
            playlistLines,
            filterOpts,
          );
          this.#lastDiscontinuitySequence = trimResult.discontinuitySequence;
          const now = dayjs();
          if (now.isAfter(this.#lastDelete.add(30, 'seconds'))) {
            this.logger.debug(
              'Deleting old segments from stream (channel id = %s, number = %d)',
              this.channel.uuid,
              this.channel.number,
            );

            // A playlist of 20 or fewer entries skips the filter, so its
            // sequence can fall below the floor.
            this.#segmentFloor = Math.max(
              this.#segmentFloor,
              trimResult.sequence,
            );
            this.deleteOldSegmentFiles(trimResult.sequence, [
              '.ts',
              '.mp4',
            ]).catch((e) => this.logger.error(e));
            this.#lastDelete = now;
          }

          return trimResult;
        }

        this.logger.trace(
          'No playlist for HLS sessions at %s',
          this._m3u8PlaylistPath,
        );
        return;
      });
    });
  }

  private selectVideoPlaylist(
    playlistLines: string[],
    filterOpts: HlsPlaylistFilterOptions = {
      type: 'before_segment_number',
      segmentNumber: this.minSegmentRequested,
      segmentsToKeepBefore: 10,
      segmentFloor: this.#segmentFloor,
    },
  ) {
    const playlistStart = this.#playlistStart;
    if (playlistStart === undefined) {
      throw new Error('HLS playlist start is not initialized');
    }
    const targetDuration = this.getHlsOptions().hlsTime;
    return this.#hlsPlaylistMutator.trimPlaylist(
      playlistStart,
      filterOpts,
      playlistLines,
      {
        maxSegmentsToKeep: 20,
        targetDuration,
        previousDiscontinuitySequence: this.#lastDiscontinuitySequence,
        endWithDiscontinuity: false,
      },
    );
  }

  isSubtitlePlaylist(filename: string): boolean {
    return this.sessionType === 'hls_direct_v2'
      ? this.#directSubtitleSlots.some((slot) => slot.playlistName === filename)
      : filename === this.getHlsOptions().subtitleStreamNameFormat;
  }

  override onSegmentRequested(clientIp: string, filename: string) {
    const file = basename(filename);
    const slot = file.endsWith('.vtt')
      ? this.#directSubtitleSlots.find(
          (candidate) =>
            file.startsWith(candidate.segmentPrefix) &&
            /^\d+\.vtt$/.test(file.slice(candidate.segmentPrefix.length)),
        )
      : undefined;
    super.onSegmentRequested(clientIp, filename, slot?.id);
  }

  async trimSubtitlePlaylist(
    filterOpts?: FilterBeforeSegmentNumber,
    filename = this.getHlsOptions().subtitleStreamNameFormat,
  ) {
    if (this.sessionType === 'hls_direct_v2') {
      return Result.attemptAsync(() =>
        this.#subtitlePlaylistLock.runExclusive(async () => {
          if (!this.isSubtitlePlaylist(filename)) return;
          const video = await this.readPlaylist();
          if (video) this.#nativePlaylistBridge.repairVideo(video);
          const subtitle = await this.readSubtitlePlaylist(filename);
          if (!subtitle) return;
          return this.nativePlaylistResult(
            this.#nativePlaylistBridge.repairSubtitles(filename, subtitle),
          );
        }),
      );
    }
    filterOpts ??= {
      type: 'before_segment_number',
      segmentNumber: this.minSubtitleSegmentRequested,
      segmentsToKeepBefore: 10,
    };
    return Result.attemptAsync(() =>
      this.lock.runExclusive(async () => {
        const lines = await this.readSubtitlePlaylist(filename);
        if (!lines) return;
        const result = this.#hlsPlaylistMutator.trimSubtitlePlaylist(
          lines,
          filterOpts,
          { maxSegmentsToKeep: 20 },
        );
        const now = dayjs();
        if (now.isAfter(this.#lastSubtitleDelete.add(30, 'seconds'))) {
          this.deleteOldSegmentFiles(result.sequence, ['.vtt']).catch((error) =>
            this.logger.error(error),
          );
          this.#lastSubtitleDelete = now;
        }
        return result;
      }),
    );
  }

  private nativePlaylistResult(lines: string[]) {
    let playlistDurationMs = 0;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        const durationMs = Number(line.slice(8).split(',')[0]) * 1000;
        if (Number.isFinite(durationMs) && durationMs > 0) {
          playlistDurationMs += durationMs;
          this.#nativeMaxSegmentDurationMs = Math.max(
            this.#nativeMaxSegmentDurationMs,
            durationMs,
          );
        }
      } else if (line.trim() && !line.startsWith('#')) {
        this.#nativeSegmentRetiredAt.delete(basename(line.trim()));
      }
    }
    this.#nativeMaxPlaylistDurationMs = Math.max(
      this.#nativeMaxPlaylistDurationMs,
      playlistDurationMs,
    );
    return {
      playlist: lines.join('\n'),
      sequence: Number(
        lines
          .find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
          ?.split(':')[1] ?? 0,
      ),
      segmentCount: lines.filter((line) => line.startsWith('#EXTINF:')).length,
      discontinuitySequence: Number(
        lines
          .find((line) => line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))
          ?.split(':')[1] ?? 0,
      ),
    };
  }

  private async readNativeVideoPlaylist() {
    return Result.attemptAsync(() =>
      this.#subtitlePlaylistLock.runExclusive(async () => {
        const video = await this.readPlaylist();
        if (!video) return;
        const result = this.nativePlaylistResult(
          this.#nativePlaylistBridge.repairVideo(video),
        );
        const now = dayjs();
        if (now.isAfter(this.#lastDelete.add(30, 'seconds'))) {
          // The video playlist is already repaired. Pruning touches every
          // slot playlist and the directory; its failure must not turn a
          // valid variant playlist into a 500, nor repeat on every request.
          this.#lastDelete = now;
          try {
            await this.pruneNativeSegments(result.sequence);
          } catch (error) {
            this.logger.error(error, 'Native segment pruning failed');
          }
        }
        return result;
      }),
    );
  }

  private async pruneNativeSegments(videoSequence: number) {
    // FFmpeg's rolling window retires a segment on its own schedule. A
    // client that is still reading an older segment (paused, buffering, on a
    // slow link) must keep it, as legacy HLS does through its request floor.
    const requestedVideo = this.minSegmentRequested;
    const videoFloor =
      requestedVideo > 0
        ? Math.min(videoSequence, requestedVideo)
        : videoSequence;
    const floors = new Map<string, number>();
    for (const slot of this.#directSubtitleSlots) {
      const lines = await this.readSubtitlePlaylist(slot.playlistName);
      if (!lines) continue;
      const repaired = this.nativePlaylistResult(
        this.#nativePlaylistBridge.repairSubtitles(slot.playlistName, lines),
      );
      const requested = this.minSubtitleSegmentRequestedFor(slot.id);
      floors.set(
        slot.segmentPrefix,
        requested > 0
          ? Math.min(repaired.sequence, requested)
          : repaired.sequence,
      );
    }
    const files = await fs.readdir(this._workingDirectory);
    const now = Date.now();
    // RFC 8216 6.2.2 retains a removed segment for its duration plus the
    // longest distributed playlist containing it. Session-wide maxima are
    // conservative; file mtime cannot tell when a URI left a served window.
    const retentionMs =
      this.#nativeMaxPlaylistDurationMs + this.#nativeMaxSegmentDurationMs;
    for (const filename of files) {
      const video = /^data(\d+)\.(ts|mp4)$/.exec(filename);
      let expired = video !== null && Number(video[1]) < videoFloor;
      if (!expired && filename.endsWith('.vtt')) {
        for (const [prefix, floor] of floors) {
          const suffix = filename.startsWith(prefix)
            ? filename.slice(prefix.length)
            : '';
          if (
            /^\d+\.vtt$/.test(suffix) &&
            Number.parseInt(suffix, 10) < floor
          ) {
            expired = true;
            break;
          }
        }
      }
      if (!expired) {
        this.#nativeSegmentRetiredAt.delete(filename);
        continue;
      }
      const retiredAt = this.#nativeSegmentRetiredAt.get(filename);
      if (retiredAt === undefined) {
        this.#nativeSegmentRetiredAt.set(filename, now);
      } else if (now - retiredAt >= retentionMs) {
        try {
          await fs.unlink(path.join(this._workingDirectory, filename));
          this.#nativeSegmentRetiredAt.delete(filename);
        } catch (error) {
          this.logger.error(error);
        }
      }
    }
  }

  protected async startInternal() {
    if (this.state === 'started') {
      return;
    }

    await this.initDirectories();

    if (this.sessionType === 'hls_direct_v2') {
      const enabled =
        this.channel.subtitlesEnabled &&
        this.featureFlagService?.get('webvttSidecarEnabled');
      const preferences = enabled
        ? ((await this.channelDB?.getChannelSubtitlePreferences(
            this.channel.uuid,
          )) ?? [])
        : [];
      this.#directSubtitleSlots = createDirectSubtitleSlots(
        preferences.map((preference) => preference.languageCode),
      );
      this.#currentDirectSubtitleRenditions = [...this.#directSubtitleSlots];
      this.#nativePlaylistBridge = new HlsNativePlaylistBridge(
        this.#directSubtitleSlots,
      );
    }

    this.state = 'started';
    this.#playlistStart = this.transcodedUntil = dayjs();
    // Fire-and-forget
    this.run().catch((e) => this.logger.error(e));
  }

  private async run() {
    while (this.state === 'started') {
      const transcodeBuffer = dayjs
        .duration(dayjs(this.transcodedUntil).diff())
        .asSeconds();

      if (transcodeBuffer <= 60) {
        const realtime = transcodeBuffer >= 30;
        this.logger.trace(
          'Transcode buffer is %d. Starting next transcode (realtime = %s)',
          transcodeBuffer,
          realtime,
        );
        await this.transcode(realtime);
        this.#isFirstTranscode = false;
      } else {
        // trim and delete
        // await this.trimPlaylistAndDeleteSegments();
        await wait(dayjs.duration({ seconds: 5 }));
      }
    }

    this.logger.debug('HLS worker ended main loop with state = %s', this.state);

    // Only schedule cleanup if the session wasn't already explicitly stopped
    // (e.g. via endSession). If the session is already stopped, its cleanup
    // has been handled and scheduling another timer would risk deleting a
    // replacement session that now occupies the same map key.
    if (!this.stoppingOrStopped) {
      this.scheduleCleanup();
    }
  }

  protected async stopInternal(options: StopOptions): Promise<void> {
    try {
      await this.stopStream(options);
    } catch (e) {
      this.logger.error(e, 'Error while shutting down session');
    }
  }

  private async transcode(realtime: boolean) {
    // Keep one channel clock even when the next programme is stream-copied.
    // Discontinuities still signal decoder changes; they need not reset PTS.
    const ptsOffset = this.#isFirstTranscode ? 0 : await this.getPtsOffset();
    // Native Direct outputs continue their own FFmpeg append lists. Only the
    // legacy segment-muxer output needs an explicit subtitle start number.
    const subtitleSegmentStartNumber =
      this.sessionType === 'hls_direct_v2'
        ? undefined
        : await this.getLastSubtitleSegmentNumber();

    const lineupItemResult = await this.programCalculator.getCurrentLineupItem({
      allowSkip: true,
      channelId: this.channel.uuid,
      startTime: await this.onDemandService.getLiveTimestamp(
        this.channel.uuid,
        +(this.transcodedUntil ?? dayjs()),
      ),
    });

    const transcodeResult = await lineupItemResult.mapAsync(async (result) => {
      this.logger.debug(
        'About to play lineup item: %s',
        JSON.stringify(result.lineupItem, undefined, 4),
      );
      const context = new PlayerContext(
        result.lineupItem,
        result.channelContext,
        result.sourceChannel,
        this.channel.transcodeConfig,
        {
          audioOnly: false,
          realtime,
          streamMode: this.sessionType,
        },
      );

      let programStream = this.getProgramStream(
        context,
        ptsOffset,
        subtitleSegmentStartNumber,
      );
      this.#currentProgramStream = programStream;

      let transcodeSessionResult = await programStream.setup();

      if (transcodeSessionResult.isFailure()) {
        this.logger.error(
          transcodeSessionResult.error,
          'Error while starting program stream. Attempting to subtitute with error stream',
        );

        programStream = this.getProgramStream(
          PlayerContext.error(
            result.lineupItem.streamDuration ?? result.lineupItem.duration,
            transcodeSessionResult.error,
            result.channelContext,
            this.channel,
            realtime,
            this.channel.transcodeConfig,
            this.sessionType,
          ),
          ptsOffset,
          subtitleSegmentStartNumber,
        );
        this.#currentProgramStream = programStream;

        transcodeSessionResult = await programStream.setup();

        if (transcodeSessionResult.isFailure()) {
          this.state = 'error';
          this.error = transcodeSessionResult.error;
          this.emit('error', this.error);
        }
      }

      // A stop that landed during setup has already killed the previous
      // transcode. Starting this one would leave an ffmpeg nothing kills.
      if (this.state !== 'started') {
        return;
      }

      transcodeSessionResult.forEach((transcodeSession) => {
        this.transcodedUntil = (this.transcodedUntil ?? dayjs()).add(
          transcodeSession.streamDuration,
        );
        this.#currentSession = transcodeSession;
        this.#currentSubtitleRendition = programStream.renditions?.subtitle;
        this.#currentDirectSubtitleRenditions =
          this.sessionType === 'hls_direct_v2'
            ? [...this.#directSubtitleSlots]
            : undefined;
        this.#currentAudioRenditions = programStream.renditions?.audio ?? [];
      });

      if (this.sessionOptions.streamMode === 'hls') {
        // await this.trimPlaylistAndDeleteSegments();
      }
      await programStream.start();
      return programStream.wait();
    });

    if (transcodeResult.isFailure()) {
      this.logger.error(
        transcodeResult.error,
        'Error while transcoding program stream.',
      );
    }

    this.logger.debug('Stream ended.');
  }

  protected override getAdditionalRequiredFiles(): string[] {
    if (this.#currentDirectSubtitleRenditions !== undefined) {
      return this.#currentDirectSubtitleRenditions.map(
        (rendition) => rendition.playlistName,
      );
    }
    return this.#currentSubtitleRendition
      ? [this.getHlsOptions().subtitleStreamNameFormat]
      : [];
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: BaseHlsSession.SegmentNameFormat,
      segmentBaseDirectory: dirname(this.workingDirectory),
      streamBasePath: basename(this.workingDirectory),
      streamBaseUrl: `/stream/channels/${this.channel.uuid}/${this.sessionType}/`,
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  private getProgramStream(
    context: PlayerContext,
    ptsOffset: Maybe<number>,
    subtitleSegmentStartNumber: Maybe<number>,
  ) {
    const hlsOptions = this.getHlsOptions();

    const outputFormat =
      this.sessionType === 'hls_direct_v2'
        ? HlsDirectOutputFormat(hlsOptions)
        : HlsOutputFormat(hlsOptions);

    const stream = this.programStreamFactory(context, outputFormat, {
      ptsOffset,
      isFirstTranscode: this.#isFirstTranscode,
      subtitleSegmentStartNumber,
      directSubtitleSlots:
        this.sessionType === 'hls_direct_v2'
          ? this.#directSubtitleSlots
          : undefined,
      beforeProducerStart:
        this.sessionType === 'hls_direct_v2'
          ? async (session, renditions) => {
              return this.#subtitlePlaylistLock.runExclusive(async () => {
                if (this.state !== 'started') return false;
                // Every producer, including an error replacement, snapshots
                // the finalized native playlists before FFmpeg's append reader
                // rewrites inherited subtitle URIs. The bridge can derive a
                // lost URI without the snapshot, so a read failure here must
                // not reject the start and silently drop the programme while
                // the channel clock has already advanced past it.
                try {
                  const previousVideo = await this.readPlaylist();
                  if (previousVideo) {
                    this.#nativePlaylistBridge.repairVideo(previousVideo);
                    for (const slot of this.#directSubtitleSlots) {
                      const previous = await this.readSubtitlePlaylist(
                        slot.playlistName,
                      );
                      if (previous)
                        this.#nativePlaylistBridge.repairSubtitles(
                          slot.playlistName,
                          previous,
                        );
                    }
                    this.#nativePlaylistBridge.beginProgram(
                      this.#nativePlaylistBridge.nextSequence(previousVideo),
                    );
                  }
                } catch (error) {
                  this.logger.error(
                    error,
                    'Could not snapshot native playlists before the next producer',
                  );
                }
                if (this.state !== 'started') return false;
                this.#currentSession = session;
                this.#currentAudioRenditions = renditions?.audio ?? [];
                return true;
              });
            }
          : undefined,
    });
    stream.on('error', () => {
      this.state = 'error';
      this.error = new Error(
        'Unrecoverable error in underlying FFMPEG process',
      );
      this.emit('error', this.error);
    });
    return stream;
  }

  private async getPtsOffset() {
    const lastSegment = await this.getLastSegment();

    if (!lastSegment) {
      if (!this.#isFirstTranscode) {
        this.logger.debug('No last segment found. Starting with PTS offset 0.');
      }
      return 0;
    }

    const result = await new GetLastPtsDurationTask(this.settingsDB).run(
      lastSegment,
    );

    if (result.isFailure()) {
      this.logger.error(result.error);
      return 0;
    }

    const { pts, duration } = result.get();

    return pts + duration + 1;
  }

  private async getLastSegment() {
    const workingDirectoryFiles = await Result.attemptAsync(() =>
      fs.readdir(this._workingDirectory),
    );

    if (workingDirectoryFiles.isFailure()) {
      this.logger.error(workingDirectoryFiles.error);
      return;
    }

    if (workingDirectoryFiles.get().length === 0) {
      return;
    }

    const p = last(
      sortBy(
        filter(
          workingDirectoryFiles.get(),
          (f) => extname(f) === '.ts' || extname(f) === '.mp4',
        ),
      ),
    );

    if (p) {
      return path.join(this._workingDirectory, p);
    }

    return;
  }

  private async getLastSubtitleSegmentNumber(): Promise<number> {
    const workingDirectoryFiles = await Result.attemptAsync(() =>
      fs.readdir(this._workingDirectory),
    );

    if (workingDirectoryFiles.isFailure()) {
      this.logger.error(workingDirectoryFiles.error);
      return 0;
    }

    const numbers = seq.collect(
      filter(workingDirectoryFiles.get(), (f) => extname(f) === '.vtt'),
      (file) => {
        const matches = file.match(SegmentNameRegex);
        if (!matches || matches.length < 2) {
          return;
        }
        const n = parseInt(matches[1]!);
        return isNaN(n) ? undefined : n;
      },
    );

    if (isEmpty(numbers)) {
      return 0;
    }

    return Math.max(...numbers) + 1;
  }

  isStale(): boolean {
    const remainingConnections = this.removeStaleConnections();
    return isEmpty(remainingConnections);
  }

  private async readPlaylist() {
    return (await this.readPlaylistContents(this._m3u8PlaylistPath))?.split(
      '\n',
    );
  }

  private async readSubtitlePlaylist(
    filename = this.getHlsOptions().subtitleStreamNameFormat,
  ) {
    const playlistPath = path.join(this._workingDirectory, filename);
    return (await this.readPlaylistContents(playlistPath))?.split('\n');
  }

  private async readPlaylistContents(filename: string) {
    // FFmpeg replaces live playlists through a temporary file. Some mounted
    // filesystems expose a short ENOENT window even after a successful stat.
    // Read directly and allow Direct v2 up to 100 ms for that replacement;
    // persistent absence stays absent, and other I/O errors still propagate.
    const retries = this.sessionType === 'hls_direct_v2' ? 4 : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fs.readFile(filename, 'utf-8');
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
        if (attempt >= retries) return undefined;
        await wait(25);
      }
    }
  }

  private async deleteOldSegmentFiles(
    sequenceNum: number,
    extensions: string[],
  ) {
    const workingDirectoryFiles = await fs.readdir(this._workingDirectory);
    const segments = filter(
      seq.collect(
        filter(workingDirectoryFiles, (f) => extensions.includes(extname(f))),
        (file) => {
          const matches = file.match(SegmentNameRegex);
          if (!matches || matches.length < 2) {
            return;
          }
          const n = parseInt(matches[1]!);
          if (isNaN(n)) {
            return;
          }
          return {
            file,
            seq: n,
          };
        },
      ),
      ({ seq }) => seq < sequenceNum,
    );

    if (segments.length > 0) {
      this.logger.trace(
        'Deleting %d segments. Max segment number: %d',
        segments.length,
        maxBy(segments, (seg) => seg.seq)?.seq ?? 0,
      );
    }

    for (const { file } of segments) {
      try {
        await fs.unlink(path.join(this._workingDirectory, file));
      } catch (e) {
        this.logger.error(e);
      }
    }
  }

  protected async stopStream(options: StopOptions): Promise<void> {
    const current =
      this.#currentProgramStream?.transcodeSession ?? this.#currentSession;
    if (this.#currentProgramStream) this.#currentProgramStream.shutdown();
    else current?.kill();
    if (current) {
      await this.waitForExit(current, options);
    }

    this.logger.debug(
      `Cleaning out stream path for session: %s`,
      this._workingDirectory,
    );

    if (this.sessionOptions.streamMode === 'hls_direct_v2') {
      return await this.#subtitlePlaylistLock.runExclusive(() =>
        this.cleanupDirectory(),
      );
    }
    return await this.cleanupDirectory();
  }
}
