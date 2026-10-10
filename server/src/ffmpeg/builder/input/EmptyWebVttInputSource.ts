import { FileStreamSource } from '@/stream/types.js';
import { ExternalSubtitleStream, SubtitleMethods } from '../MediaStream.ts';
import { SubtitlesInputSource } from './SubtitlesInputSource.ts';

/** Cue-free native output during Direct v2 periods without a text rendition. */
export class EmptyWebVttInputSource extends SubtitlesInputSource {
  constructor() {
    super(
      new FileStreamSource('data:text/vtt;base64,V0VCVlRUCgo='),
      [new ExternalSubtitleStream('webvtt', SubtitleMethods.Convert)],
      SubtitleMethods.Convert,
    );
  }

  override getInputOptions(): string[] {
    return ['-f', 'webvtt', ...super.getInputOptions()];
  }
}
