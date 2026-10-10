/** Mapped output ordinals, counted separately for video, audio and subtitles. */
export type HlsSubtitleVariant = {
  videoOutputIndexes: readonly number[];
  audioOutputIndexes: readonly number[];
  subtitleOutputIndex: number;
  /** Omitted for cue-free periods, which must not advertise a rendition. */
  group?: string;
  language?: string;
  default: boolean;
};

/** FFmpeg 7 native mapping for one copied A/V variant and selected WebVTT. */
export class HlsVariantStreamMap {
  constructor(private readonly variant: HlsSubtitleVariant) {}

  toString(): string {
    const variant = this.variant;
    if (variant.videoOutputIndexes.length === 0) {
      throw new Error('A native HLS subtitle rendition requires mapped video');
    }
    const fields = [
      ...this.streamFields('v', variant.videoOutputIndexes),
      ...this.streamFields('a', variant.audioOutputIndexes),
      ...this.streamFields('s', [variant.subtitleOutputIndex]),
    ];
    if (variant.group !== undefined)
      fields.push(`sgroup:${this.token(variant.group)}`);
    fields.push(`default:${variant.default ? 'yes' : 'no'}`);
    if (variant.language !== undefined)
      fields.push(`language:${this.token(variant.language)}`);
    // FFmpeg 8 sname stays deferred. FFmpeg 7's generated name is augmented
    // in the served master while its native URI and group are retained.
    return fields.join(',');
  }

  private streamFields(kind: string, indexes: readonly number[]): string[] {
    if (
      indexes.some((index) => !Number.isSafeInteger(index) || index < 0) ||
      new Set(indexes).size !== indexes.length
    ) {
      throw new Error(`Invalid or repeated HLS ${kind} output ordinal`);
    }
    return indexes.map((index) => `${kind}:${index}`);
  }

  private token(value: string): string {
    // FFmpeg does not interpret quotes as escaping in var_stream_map.
    if (value.length === 0 || /[\s,:"]/u.test(value)) {
      throw new Error('Invalid HLS variant mapping token');
    }
    return value;
  }
}
