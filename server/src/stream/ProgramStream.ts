import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import {
  OutputFormatTypes,
  type OutputFormat,
} from '@/ffmpeg/builder/constants.js';
import type { TranscodeSessionResult } from '@/ffmpeg/types.js';
import { CacheImageService } from '@/services/cacheImageService.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import { resolveIconUrl } from '@/util/iconUtil.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import { makeLocalUrl } from '@/util/serverUtil.js';
import type { Watermark } from '@tunarr/types';
import dayjs from 'dayjs';
import { isUndefined } from 'lodash-es';
import events from 'node:events';
import { PassThrough } from 'node:stream';
import { match, P } from 'ts-pattern';
import type {
  ContentBackedStreamLineupItem,
  ErrorStreamLineupItem,
  OfflineStreamLineupItem,
} from '../db/derived_types/StreamLineup.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { FFmpegAssistedFactory } from '../ffmpeg/FFmpegModule.ts';
import type { ProgramStreamOptions } from './ProgramStreamFactory.ts';
import { KEYS } from '../types/inject.ts';
import { assisted, injected, multiInjected } from '../util/assistedInject.ts';
import {
  attempt,
  caughtErrorToError,
  isDefined,
  isNonEmptyString,
  isSuccess,
} from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { PlayerContext } from './PlayerStreamContext.ts';
import { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';
import type { ProgramStreamPlugin } from './plugins/ProgramStreamPlugin.ts';
import type { StreamRenditions } from './types.ts';

type ProgramStreamEvents = {
  // Emitted when the stream has reached a fatal error point
  // This means that both the program and error stream have failed to play.
  error: [];
};

/**
 * Implements the functionality of managing an output stream
 * for a given program. This class is essentially a lineup item + transcode session
 */
export class ProgramStream extends events.EventEmitter<ProgramStreamEvents> {
  @InjectLogger() declare private readonly logger: Logger;

  private outStream?: PassThrough;
  private hadError: boolean = false;
  private _transcodeSession: Maybe<FfmpegTranscodeSession>;
  private _renditions?: StreamRenditions;
  private stopped = false;
  private replacementPending?: Promise<void>;

  constructor(
    @injected(KEYS.SettingsDB) protected settingsDB: ISettingsDB,
    @injected(CacheImageService) private cacheImageService: CacheImageService,
    @injected(KEYS.FFmpegFactory)
    protected ffmpegFactory: FFmpegAssistedFactory,
    @injected(MediaSourceDB) private mediaSourceDB: MediaSourceDB,
    @injected(ProgramStreamDetailsFetcher)
    private programStreamDetails: ProgramStreamDetailsFetcher,
    @multiInjected(KEYS.ProgramStreamPlugin)
    private streamPlugins: ProgramStreamPlugin[],
    @assisted public context: PlayerContext,
    @assisted protected outputFormat: OutputFormat,
    @assisted public opts?: ProgramStreamOptions,
  ) {
    super();
  }

  async setup(): Promise<Result<FfmpegTranscodeSession>> {
    if (this.isInitialized()) {
      return Result.success(this._transcodeSession!);
    }

    // A throw here would skip the caller's error-stream fallback, and the
    // session would retry the same item in a tight loop.
    const result = await this.setupInternal().catch((e: unknown) =>
      Result.forError<TranscodeSessionResult>(caughtErrorToError(e)),
    );

    result.forEach((value) => {
      this.transcodeSession = value.session;
      this._renditions = value.renditions;
    });

    return result.map((r) => r.session);
  }

  protected async setupInternal(): Promise<Result<TranscodeSessionResult>> {
    const { lineupItem } = this.context;
    return match(lineupItem)
      .with({ type: P.union('program', 'commercial', 'fallback') }, (item) =>
        this.setupContentItem(item),
      )
      .with({ type: 'offline' }, (item) => this.setupOfflineItem(item))
      .with({ type: 'error' }, (item) => this.setupErrorItem(item))
      .with({ type: 'redirect' }, (item) =>
        Result.failure<TranscodeSessionResult>(
          `ProgramStream cannot direct play a direct item: ${JSON.stringify(item)}`,
        ),
      )
      .exhaustive();
  }

  private async setupContentItem(
    lineupItem: ContentBackedStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const server = await this.mediaSourceDB.getById(
      lineupItem.program.mediaSourceId,
    );
    if (!server) {
      return Result.forError(
        new Error(
          `Unable to find server "${lineupItem.program.mediaSourceId}" specified by program.`,
        ),
      );
    }

    const streamDetailsResult = await this.programStreamDetails.getStream({
      server,
      lineupItem: lineupItem.program,
      requireBitrate: this.outputFormat.type === OutputFormatTypes.HlsDirectV2,
    });

    if (streamDetailsResult.isFailure()) {
      return streamDetailsResult.recast();
    }

    const watermark = await this.getWatermark();
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.sourceChannel,
    );

    // TODO: check if this was killed before actually starting.

    const { streamDetails, streamSource } = streamDetailsResult.get();
    streamDetails.duration = dayjs.duration(lineupItem.streamDuration);

    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    const resolvedOptions = {
      startTime: start,
      duration: dayjs.duration(lineupItem.streamDuration),
      watermark,
      realtime: this.context.realtime,
      outputFormat: this.outputFormat,
      streamMode: this.context.streamMode,
      encoding: this.context.encoding,
      ...(this.opts ?? {}),
    };
    const sessionResult = await ffmpeg.createStreamSession({
      stream: {
        source: streamSource,
        details: streamDetails,
      },
      options: resolvedOptions,
      lineupItem,
    });

    if (!sessionResult) {
      return Result.forError(new Error('Unable to create ffmpeg process'));
    }

    for (const plugin of this.streamPlugins) {
      try {
        await plugin.run({
          opts: resolvedOptions,
          outputFormat: this.outputFormat,
          playerContext: this.context,
          transcodeSession: sessionResult,
        });
      } catch (e) {
        this.logger.error(
          e,
          'Error firing stream plugin %s',
          plugin.constructor.name,
        );
      }
    }

    return Result.success(sessionResult);
  }

  private async setupOfflineItem(
    lineupItem: OfflineStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.targetChannel,
    );

    let duration = dayjs.duration(lineupItem.streamDuration);
    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    if (+duration > +start) {
      duration = duration.subtract(start);
    }

    this.logger.debug(
      'starting offline session of %d ms',
      duration.asMilliseconds(),
    );

    const result = await ffmpeg.createPlaceholderSession({
      kind: 'offline',
      duration,
      outputFormat: this.outputFormat,
      ptsOffset: this.opts?.ptsOffset,
      realtime: this.opts?.realtime,
      directSubtitleSlots: this.opts?.directSubtitleSlots,
    });

    if (isUndefined(result)) {
      throw new Error('Unable to start ffmpeg transcode session');
    }

    return Result.success(result);
  }

  private async setupErrorItem(
    lineupItem: ErrorStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.targetChannel,
    );

    let duration = dayjs.duration(lineupItem.streamDuration);
    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    if (+duration > +start) {
      duration = duration.subtract(start);
    }

    this.logger.debug(
      'starting offline session of %d ms',
      duration.asMilliseconds(),
    );

    const result = await ffmpeg.createPlaceholderSession({
      kind: 'error',
      title: 'Error',
      duration,
      outputFormat: this.outputFormat,
      realtime: this.opts?.realtime,
      ptsOffset: this.opts?.ptsOffset,
      directSubtitleSlots: this.opts?.directSubtitleSlots,
    });

    if (isUndefined(result)) {
      throw new Error('Unable to start ffmpeg transcode session');
    }

    return Result.success(result);
  }

  isInitialized(): boolean {
    return isDefined(this._transcodeSession);
  }

  async start(sink?: PassThrough) {
    if (this.stopped) return;
    if (!this.isInitialized()) {
      await this.setup();
    }

    const session = this._transcodeSession;
    if (!session) return;
    return (this.outStream = await this.startProducer(session, sink));
  }

  private async startProducer(
    session: FfmpegTranscodeSession,
    sink?: PassThrough,
  ) {
    if (this.stopped) return;
    if (
      this.opts?.beforeProducerStart &&
      !(await this.opts.beforeProducerStart(session, this._renditions))
    )
      return;
    // Shutdown can arrive while the checkpoint is reading completed playlists.
    if (this.stopped) return;
    return session.start(sink);
  }

  /** Wait for the entire programme, including its runtime error replacement. */
  async wait(): Promise<void> {
    while (this._transcodeSession) {
      const session = this._transcodeSession;
      await session.exited;
      await this.replacementPending;
      if (session === this._transcodeSession) return;
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.isInitialized()) {
      this.transcodeSession!.kill();
    }
    this.shutdownInternal();
  }

  protected shutdownInternal(): void {}

  get renditions(): StreamRenditions | undefined {
    return this._renditions;
  }

  get transcodeSession(): Maybe<FfmpegTranscodeSession> {
    return this._transcodeSession;
  }

  set transcodeSession(session: FfmpegTranscodeSession) {
    this._transcodeSession = session;
    this._transcodeSession.on('end', () => this.shutdownInternal());
    this._transcodeSession.on('error', () => {
      if (this.stopped || this._transcodeSession !== session) return;
      if (this.hadError) {
        // We're streaming the error and something went wrong with that..
        // time to just bail.
        this.shutdown();
        this.emit('error');
      } else {
        this.hadError = true;
        const failedStream = this._transcodeSession;
        failedStream?.kill();
        if (!this.opts?.disableErrorStream) {
          this.replacementPending = this.tryReplaceWithErrorStream(
            session,
            this.outStream,
          ).catch((e) => {
            this.logger.error(e, 'Error while setting up ');
            if (!this.stopped) this.emit('error');
          });
        }
      }
    });
  }

  private async tryReplaceWithErrorStream(
    failed: FfmpegTranscodeSession,
    sink?: PassThrough,
  ) {
    const out = sink ?? new PassThrough();
    try {
      // Finalize the failed writer before snapshotting its playlists or
      // starting another append-mode producer in the same directory.
      await failed.exited;
      if (this.stopped) return;
      const errorResult = await this.getErrorStream(this.context);

      if (isUndefined(errorResult)) {
        out.push(null);
        return;
      }

      if (this.stopped) return;
      this.transcodeSession = errorResult.session;
      this._renditions = errorResult.renditions;
      await this.startProducer(errorResult.session, out);

      this.transcodeSession.on('end', () => {
        out.push(null);
      });
    } catch (e) {
      this.logger.error(e, 'Error while trying to spawn error stream! YIKES');
      throw e;
    }
  }

  private getErrorStream(context: PlayerContext) {
    const ffmpeg = this.ffmpegFactory(
      context.transcodeConfig,
      context.sourceChannel,
    );

    const duration = dayjs.duration(
      dayjs(this.transcodeSession?.streamEndTime).diff(),
    );

    return ffmpeg.createPlaceholderSession({
      kind: 'error',
      title: 'Playback Error',
      subtitle: 'Check server logs for details',
      duration,
      outputFormat: this.outputFormat,
      realtime: true,
      directSubtitleSlots: this.opts?.directSubtitleSlots,
    });
  }

  protected async getWatermark(): Promise<Maybe<Watermark>> {
    const channel = this.context.targetChannel;

    if (this.context.transcodeConfig.disableChannelOverlay) {
      return;
    }

    if (
      this.context.lineupItem.type === 'commercial' &&
      this.context.targetChannel.disableFillerOverlay
    ) {
      return;
    }

    if (channel.watermark?.enabled) {
      const watermark = { ...channel.watermark };
      let icon: string;
      // Capture this so it can't change asynchronously.
      const watermarkUrl = watermark.url;
      if (isNonEmptyString(watermarkUrl) && URL.canParse(watermarkUrl)) {
        const parsed = new URL(watermarkUrl);
        if (parsed.host.includes('localhost')) {
          icon = watermarkUrl;
        } else {
          const cachedWatermarkUrl = await attempt(() =>
            this.cacheImageService.getOrDownloadImageUrl(watermarkUrl),
          );

          if (
            isSuccess(cachedWatermarkUrl) &&
            isNonEmptyString(cachedWatermarkUrl?.path)
          ) {
            icon = cachedWatermarkUrl.path;
          } else {
            icon = makeLocalUrl('/images/tunarr.png');
          }
        }
      } else {
        const resolvedIcon = resolveIconUrl(
          channel.icon,
          makeLocalUrl('/images/tunarr.png'),
        );
        if (!resolvedIcon) {
          return;
        }
        icon = resolvedIcon;
      }

      return {
        ...watermark,
        enabled: true,
        url: icon,
      };
    }

    return;
  }
}
