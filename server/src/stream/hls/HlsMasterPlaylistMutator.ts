import { isDefined } from '../../util/index.ts';
import type {
  AudioRenditionInfo,
  DirectSubtitleRenditionInfo,
  SubtitleRenditionInfo,
} from '../types.ts';
export type { SubtitleRenditionInfo };

type RewriteOptions = {
  streamBaseUrl: string;
  streamNameFormat: string;
};

type InjectOptions = {
  streamBaseUrl: string;
  subtitleStreamNameFormat: string;
  autoSelect?: boolean;
};

export class HlsMasterPlaylistMutator {
  private static readonly _variantPlaylistTag = '#EXT-X-STREAM-INF:';
  private static readonly _mediaTag = '#EXT-X-MEDIA:';
  private static readonly _sdhCharacteristics: readonly string[] = [
    'public.accessibility.transcribes-spoken-dialog',
    'public.accessibility.describes-music-and-sound',
  ];

  static rewriteVariantPlaylistUrls(
    content: string,
    rendition: SubtitleRenditionInfo | undefined,
    options: RewriteOptions,
  ): string[] {
    const { streamBaseUrl, streamNameFormat } = options;
    const variantAbsUrl = `${streamBaseUrl}${streamNameFormat}`;
    return content.split('\n').map((line) => {
      if (line.trim() === streamNameFormat) return variantAbsUrl;

      // Rewrite relative URIs in EXT-X-MEDIA tags to absolute URLs
      // so clients can resolve them regardless of the playlist's base URL.
      if (line.startsWith(this._mediaTag)) {
        return line.replace(
          /URI="([^"]+)"/,
          (_match, uri: string) =>
            `URI="${uri.startsWith('/') || uri.startsWith('http') ? uri : streamBaseUrl + uri}"`,
        );
      }

      const hasSubtitlesAndIsMissingReference =
        rendition &&
        line.startsWith(this._variantPlaylistTag) &&
        !line.includes('SUBTITLES=');
      return hasSubtitlesAndIsMissingReference
        ? line + ',SUBTITLES="subs"'
        : line;
    });
  }

  static injectSubtitleMediaTag(
    lines: string[],
    rendition: SubtitleRenditionInfo,
    options: InjectOptions,
  ): void {
    const { streamBaseUrl, subtitleStreamNameFormat } = options;
    const subsUrl = `${streamBaseUrl}${subtitleStreamNameFormat}`;
    const langName = rendition.languageName ?? rendition.language;
    const title = rendition.title ?? langName;
    const characteristics =
      rendition.sdh === true
        ? `,CHARACTERISTICS="${this._sdhCharacteristics.join(',')}"`
        : '';
    const mediaTag = `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${rendition.language}",NAME="${title}",DEFAULT=${this.getYesNo(rendition.default)},AUTOSELECT=${this.getYesNo(options.autoSelect ?? (rendition.default || rendition.sdh === true))},FORCED=${this.getYesNo(rendition.forced)}${characteristics},URI="${subsUrl}"`;
    const insertBefore = lines.findIndex((l) =>
      l.startsWith(this._variantPlaylistTag),
    );
    if (insertBefore >= 0) lines.splice(insertBefore, 0, mediaTag);
  }

  /**
   * Publish the channel's fixed text subtitle slots on FFmpeg's existing AV
   * master. Every slot has a producer output, including empty periods. Labels
   * describe the channel choices rather than a programme's source filenames.
   */
  static replaceDirectSubtitleMediaTags(
    lines: string[],
    renditions: readonly DirectSubtitleRenditionInfo[],
    options: Pick<RewriteOptions, 'streamBaseUrl'>,
  ): void {
    this.removeSubtitleMediaTag(lines);
    if (renditions.length === 0) return;
    const variantIndex = lines.findIndex((line) =>
      line.startsWith(this._variantPlaylistTag),
    );
    if (variantIndex < 0) return;

    for (const rendition of renditions) {
      this.injectSubtitleMediaTag(
        lines,
        {
          ...rendition,
          // HLS quoted-string values cannot contain quotes or line breaks.
          // Subtitle labels are metadata, never playlist syntax.
          title: (
            rendition.title ??
            rendition.languageName ??
            rendition.language
          )
            .replace(/[\r\n]/g, '')
            .replaceAll('"', "'"),
        },
        {
          streamBaseUrl: options.streamBaseUrl,
          subtitleStreamNameFormat: rendition.playlistName,
          autoSelect: rendition.autoSelect,
        },
      );
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (
        line?.startsWith(this._variantPlaylistTag) &&
        !line.includes('SUBTITLES=')
      ) {
        lines[index] = line + ',SUBTITLES="subs"';
      }
    }
  }

  static injectAudioMediaTags(
    lines: string[],
    audioRenditions: AudioRenditionInfo[],
    options: Pick<RewriteOptions, 'streamBaseUrl'>,
  ): void {
    if (audioRenditions.length === 0) return;

    const insertBefore = lines.findIndex((l) =>
      l.startsWith(this._variantPlaylistTag),
    );
    if (insertBefore < 0) return;

    const mediaTags: string[] = [];
    for (let i = 0; i < audioRenditions.length; i++) {
      const rendition = audioRenditions[i]!;
      const isDefault = rendition.default;
      const langName = rendition.languageName ?? rendition.language;
      const title = rendition.title ?? langName;
      // The default rendition is muxed with video, so no URI is needed.
      // Alternate renditions reference the same variant because passthrough
      // interleaves every audio track in the same TS output.
      const uriPart = isDefault
        ? ''
        : `,URI="${options.streamBaseUrl}stream.m3u8"`;
      const channelsPart = isDefined(rendition.channels)
        ? `,CHANNELS="${rendition.channels}"`
        : '';
      mediaTags.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${rendition.language}",NAME="${title}",DEFAULT=${this.getYesNo(isDefault)},AUTOSELECT=${this.getYesNo(isDefault)}${channelsPart}${uriPart}`,
      );
    }

    lines.splice(insertBefore, 0, ...mediaTags);

    // Add AUDIO group reference to the variant stream-inf line
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i]!.startsWith(this._variantPlaylistTag) &&
        !lines[i]!.includes('AUDIO=')
      ) {
        lines[i] = lines[i] + ',AUDIO="audio"';
      }
    }
  }

  static removeSubtitleMediaTag(lines: string[]): void {
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (line === undefined) continue;
      if (line.startsWith(this._mediaTag)) {
        const attributes = this.mediaAttributes(line);
        if (
          attributes.get('TYPE') === 'SUBTITLES' &&
          attributes.get('GROUP-ID') === '"subs"'
        ) {
          lines.splice(index, 1);
        }
      } else if (line.startsWith(this._variantPlaylistTag)) {
        lines[index] = line.replace(
          /(,?)SUBTITLES="subs"(,?)/g,
          (_match, before: string, after: string) =>
            before && after ? ',' : '',
        );
      }
    }
  }

  private static getYesNo(v: boolean) {
    return v ? 'YES' : 'NO';
  }

  private static mediaAttributes(line: string): Map<string, string> {
    const attributes = new Map<string, string>();
    for (const match of line
      .slice(this._mediaTag.length)
      .matchAll(/(^|,)([A-Z0-9-]+)=("[^"]*"|[^,\r\n]*)/g)) {
      const key = match[2];
      const value = match[3];
      if (key !== undefined && value !== undefined) {
        attributes.set(key, value);
      }
    }
    return attributes;
  }
}
