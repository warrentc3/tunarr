import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { StreamOptions } from '../ffmpeg/types.ts';
import type { PlayerContext } from './PlayerStreamContext.js';
import type { ProgramStream } from './ProgramStream.ts';
import type { FfmpegTranscodeSession } from '../ffmpeg/FfmpegTrancodeSession.ts';
import type { StreamRenditions } from './types.ts';

export type ProgramStreamOptions = Partial<StreamOptions> & {
  /** Runs after the previous writer exits and before every new producer starts. */
  beforeProducerStart?: (
    session: FfmpegTranscodeSession,
    renditions: StreamRenditions | undefined,
  ) => Promise<boolean>;
};

export type ProgramStreamFactory = (
  context: PlayerContext,
  outputFormat: OutputFormat,
  opts?: ProgramStreamOptions,
) => ProgramStream;
