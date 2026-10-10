import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { SubtitleStreamDetails } from '../stream/types.ts';
import { isNonEmptyString } from '../util/index.ts';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import { SubtitleStreamPicker } from './SubtitleStreamPicker.ts';

// FFmpeg's AV_CODEC_PROP_TEXT_SUB descriptors, including the SRT/SSA aliases,
// restricted to codecs the pinned FFmpeg 7.1.1 can decode to WebVTT. The
// single Direct v2 process aborts on any subtitle input it cannot decode, so a
// text codec without a decoder must not fill a slot: `ttml` has an encoder but
// no decoder or demuxer, and `hdmv_text_subtitle` has neither. A .sub
// extension alone cannot distinguish a text file from bitmap subtitles.
// https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavcodec/codec_desc.c
const textSubtitleCodecs = new Set([
  'text',
  'ssa',
  'mov_text',
  'srt',
  'microdvd',
  'eia_608',
  'jacosub',
  'sami',
  'realtext',
  'stl',
  'subviewer1',
  'subviewer',
  'subrip',
  'webvtt',
  'vtt', // Emby's WebVTT codec name.
  'mpl2',
  'vplayer',
  'pjs',
  'ass',
]);

export function isDirectTextSubtitleCodec(codec: string): boolean {
  return textSubtitleCodecs.has(codec.toLowerCase());
}

/** Source candidates have a stable order independent of database row order. */
export function compareDirectSubtitleSources(
  left: SubtitleStreamDetails,
  right: SubtitleStreamDetails,
): number {
  if (left.type !== right.type) return left.type === 'embedded' ? -1 : 1;
  if (left.type === 'embedded') {
    const leftIndex =
      Number.isInteger(left.index) && (left.index ?? -1) >= 0
        ? left.index
        : undefined;
    const rightIndex =
      Number.isInteger(right.index) && (right.index ?? -1) >= 0
        ? right.index
        : undefined;
    if (leftIndex !== rightIndex) {
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    }
  }
  // Do not use localeCompare: locale/platform settings must not choose a track.
  // Compare the reported resolved path before canonicalizing symlink aliases.
  const leftPath = Array.from(
    left.path ?? '',
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPath = Array.from(
    right.path ?? '',
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < length; index++) {
    const leftPoint = leftPath[index];
    const rightPoint = rightPath[index];
    if (
      leftPoint !== undefined &&
      rightPoint !== undefined &&
      leftPoint !== rightPoint
    )
      return leftPoint - rightPoint;
  }
  return leftPath.length - rightPath.length;
}

export type DirectSubtitleRendition = {
  /** Original inventory record; eligibility applies before input conversion. */
  source: SubtitleStreamDetails;
  stream: SubtitleStreamDetails &
    (
      | { type: 'external'; index: 0; path: string }
      | { type: 'embedded'; index: number; path?: undefined }
    );
};

export type CollectDirectSubtitleRenditionsRequest = {
  lineupItem: ContentBackedStreamLineupItem;
  subtitleStreams: readonly SubtitleStreamDetails[];
};

/**
 * Direct v2 publishes eligible text subtitles as selectable renditions.
 * Channel language filtering and regular/SDH/forced filling happen against the
 * fixed slot catalogue, not transcoding's ranked subtitle preference rules.
 * A cached extraction can supply an embedded track, but is not required: FFmpeg
 * can convert the original input stream inline. External files must already be
 * local. This function never extracts or downloads anything at playback time.
 */
export async function collectDirectSubtitleRenditions({
  lineupItem,
  subtitleStreams,
}: CollectDirectSubtitleRenditionsRequest): Promise<DirectSubtitleRendition[]> {
  const logger = LoggerFactory.child({ className: 'DirectSubtitleRenditions' });
  const renditions: DirectSubtitleRendition[] = [];
  const seenEmbeddedIndexes = new Set<number>();
  const orderedSources = [...subtitleStreams].sort(
    compareDirectSubtitleSources,
  );

  for (const inventorySource of orderedSources) {
    // The inventory can contain both the container stream and its extracted
    // representation. Prefer the latter's title/SDH metadata for that same
    // source index, without moving the track or merging separate sidecar files.
    const source =
      inventorySource.type === 'embedded' &&
      inventorySource.index !== undefined &&
      !isNonEmptyString(inventorySource.path)
        ? (orderedSources.find(
            (candidate) =>
              candidate.type === 'embedded' &&
              candidate.index === inventorySource.index &&
              isNonEmptyString(candidate.path),
          ) ?? inventorySource)
        : inventorySource;
    if (!isDirectTextSubtitleCodec(source.codec)) continue;

    const embeddedIndex =
      source.type === 'embedded' &&
      source.index !== undefined &&
      Number.isInteger(source.index) &&
      source.index >= 0
        ? source.index
        : undefined;
    if (embeddedIndex !== undefined && seenEmbeddedIndexes.has(embeddedIndex)) {
      continue;
    }

    let stream: DirectSubtitleRendition['stream'] | undefined;
    if (isNonEmptyString(source.path)) {
      stream = await resolveLocalFile(source);
    }
    if (stream === undefined && source.type === 'embedded') {
      try {
        const extracted =
          await SubtitleStreamPicker.getSubtitleDetailsWithExtractedPath(
            lineupItem,
            source,
          );
        if (extracted !== undefined) stream = await resolveLocalFile(extracted);
      } catch (error) {
        logger.debug(error, 'Could not resolve cached Direct v2 subtitle');
      }
      if (stream === undefined && embeddedIndex !== undefined) {
        stream = {
          ...source,
          type: 'embedded',
          index: embeddedIndex,
          path: undefined,
        };
      }
    }
    if (stream === undefined) {
      logger.debug(
        'Skipping Direct v2 subtitle at index %s: no usable input',
        source.index ?? '<external>',
      );
      continue;
    }

    if (embeddedIndex !== undefined) seenEmbeddedIndexes.add(embeddedIndex);
    // Sidecar records may intentionally share a file while carrying different
    // category flags. Keep them all; the factory deduplicates encoded inputs.
    renditions.push({ source, stream });
  }

  return renditions;

  async function resolveLocalFile(
    source: SubtitleStreamDetails,
  ): Promise<DirectSubtitleRendition['stream'] | undefined> {
    if (!isNonEmptyString(source.path) || !isAbsolute(source.path)) return;
    try {
      const canonicalPath = await realpath(source.path);
      if ((await stat(canonicalPath)).isFile()) {
        return { ...source, type: 'external', index: 0, path: canonicalPath };
      }
    } catch (error) {
      // Unavailable external files cannot be fetched here. For embedded text,
      // the original container remains usable when its cache file disappears.
      logger.debug(
        error,
        'Unavailable Direct v2 subtitle file %s',
        source.path,
      );
    }
    return;
  }
}
