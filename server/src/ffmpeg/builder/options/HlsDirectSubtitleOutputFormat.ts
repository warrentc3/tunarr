import path from 'node:path';
import { HlsDirectOutputFormat } from './HlsDirectOutputFormat.ts';
import { HlsVariantStreamMap } from './HlsVariantStreamMap.ts';
import { OutputOption } from './OutputOption.ts';

export type HlsDirectSubtitleRendition = {
  /** Stable, filename-safe rendition identity, supplied by the HLS session. */
  id: string;
  language?: string;
  default: boolean;
  /** Per-type output ordinal among uniquely mapped subtitle streams. */
  subtitleOutputIndex: number;
};

/**
 * One encoded output feeds native HLS muxers in the same FFmpeg process.
 * FFmpeg 7 supports one WebVTT stream per HLS variant. The primary child
 * publishes the sole A/V variant; each subtitle child uses those same A/V
 * packets as its segment clock, discarding the duplicate transport stream.
 */
export class HlsDirectSubtitleOutputFormat extends OutputOption {
  /**
   * Interleaving happens in the parent tee context, not in the children, so
   * the children's own bound does not apply there. An empty subtitle slot is a
   * mapped stream that never produces a packet, and libavformat's default
   * bound of ten seconds then holds every A/V packet for ten seconds of media
   * before writing: measured as ~9.4 s of extra publication latency on every
   * realtime producer, and a ~20 s publication hole at each programme
   * handover. One second covers the A/V interleave skew of normally muxed
   * media; a source interleaved wider than this logs non-monotonic DTS.
   */
  public static ParentInterleaveDeltaMicros = 1_000_000;

  constructor(
    private playlistPath: string,
    private segmentTemplate: string,
    private baseStreamUrl: string,
    private hasAudio: boolean,
    private renditions: readonly HlsDirectSubtitleRendition[],
    private isFirstTranscode: boolean,
    private emitEndList: boolean,
    private platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  options(): string[] {
    if (
      this.renditions.length === 0 ||
      this.renditions.some(({ id }) => !/^[A-Za-z0-9_-]+$/u.test(id)) ||
      new Set(this.renditions.map(({ id }) => id)).size !==
        this.renditions.length
    ) {
      throw new Error(
        'Direct HLS requires distinct filename-safe rendition IDs',
      );
    }
    if (
      this.renditions.some(
        ({ subtitleOutputIndex }) =>
          !Number.isSafeInteger(subtitleOutputIndex) || subtitleOutputIndex < 0,
      )
    ) {
      throw new Error('Invalid Direct HLS subtitle output index');
    }

    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const directory = paths.dirname(this.playlistPath);
    const avIndexes = this.hasAudio ? [0, 1] : [0];
    // New programme processes start before the previous programme has aired.
    // Do not advertise their process start times as the media's wall clock.
    const flags = ['independent_segments', 'append_list'];
    if (!this.emitEndList) flags.push('omit_endlist');
    if (!this.isFirstTranscode) flags.push('discont_start');

    const common: Record<string, string> = {
      onfail: 'abort',
      f: 'hls',
      // Packets reach each child already interleaved by the parent output
      // (see ParentInterleaveDeltaMicros). A sparse subtitle must not make a
      // child queue more AV before publishing; one microsecond bounds the hold.
      max_interleave_delta: '1',
      hls_time: `${HlsDirectOutputFormat.SegmentSeconds}`,
      hls_list_size: `${HlsDirectOutputFormat.PlaylistSize}`,
      hls_segment_type: 'mpegts',
      hls_base_url: this.baseStreamUrl,
      hls_flags: flags.join('+'),
    };
    if (!this.isFirstTranscode) {
      common.hls_segment_options = 'mpegts_flags=+initial_discontinuity';
    }

    const children = [
      this.child(
        {
          ...common,
          select: avIndexes.join(','),
          hls_segment_filename: this.segmentTemplate,
          master_pl_name: 'playlist.m3u8',
        },
        this.playlistPath,
      ),
    ];

    for (const rendition of this.renditions) {
      children.push(
        this.child(
          {
            ...common,
            select: [
              ...avIndexes,
              avIndexes.length + rendition.subtitleOutputIndex,
            ].join(','),
            // strftime accepts a constant filename. Never enable temp_file,
            // delete_segments or second-level filename flags on this device.
            hls_segment_filename:
              this.platform === 'win32' ? '\\\\.\\nul' : '/dev/null',
            strftime: '1',
            // Fixed slots retain their private AV playlist across programmes,
            // so native append_list chooses the same sequence as primary AV.
            // The serving bridge repairs FFmpeg 7's lost VTT URI/discontinuity
            // metadata without constructing a separate subtitle timeline.
            var_stream_map: new HlsVariantStreamMap({
              videoOutputIndexes: [0],
              audioOutputIndexes: this.hasAudio ? [0] : [],
              subtitleOutputIndex: 0,
              group: 'subs',
              language: rendition.language,
              default: rendition.default,
            }).toString(),
            hls_subtitle_path: paths.join(
              directory,
              `subtitle_${rendition.id}.m3u8`,
            ),
          },
          // Native VTT filenames derive from this AV playlist's stem. This
          // discard-side AV playlist is never linked in the served master.
          paths.join(directory, `subtitle_${rendition.id}_av_.m3u8`),
        ),
      );
    }

    // Leave every HLS child's timestamp policy at its shared default. A
    // subtitle-only avoid_negative_ts override would change its A/V relation.
    return [
      '-copyts',
      '-max_interleave_delta',
      `${HlsDirectSubtitleOutputFormat.ParentInterleaveDeltaMicros}`,
      '-f',
      'tee',
      children.join('|'),
    ];
  }

  private child(options: Record<string, string>, filename: string): string {
    const fields = Object.entries(options).map(([key, value]) => {
      // tee parses both its child list and each child's option dictionary.
      const dictionaryValue = value.replace(/[\\':[\]]/gu, '\\$&');
      return `${key}=${this.quote(dictionaryValue)}`;
    });
    return `[${fields.join(':')}]${this.quote(filename)}`;
  }

  private quote(value: string): string {
    return `'${value.replace(/'/gu, "'\\''")}'`;
  }
}
