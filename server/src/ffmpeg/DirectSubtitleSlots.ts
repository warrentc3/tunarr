import languages from '@cospired/i18n-iso-languages';
import { LanguageService } from '../services/LanguageService.ts';
import type {
  DirectSubtitleSlot,
  SubtitleStreamDetails,
} from '../stream/types.ts';
import type { DirectSubtitleRendition } from './DirectSubtitleRenditions.ts';
import {
  compareDirectSubtitleSources,
  isDirectTextSubtitleCodec,
} from './DirectSubtitleRenditions.ts';

export function directSubtitleLanguage(source: SubtitleStreamDetails): string {
  return (
    LanguageService.normalizeToAlpha3T(source.languageCodeISO6392 ?? '') ??
    LanguageService.normalizeToAlpha3T(source.languageCodeISO6391 ?? '') ??
    LanguageService.normalizeToAlpha3T(source.language ?? '') ??
    'und'
  );
}

/** The ordered channel language filter defines its lifetime subtitle catalogue. */
export function createDirectSubtitleSlots(
  languagePreferences: readonly string[],
): DirectSubtitleSlot[] {
  // Only configured languages create slots. There is no implied language or
  // catalogue derived from the programme that happens to be on air.
  const languageCodes = [
    ...new Set(
      languagePreferences.map((language) => {
        const normalized = LanguageService.normalizeToAlpha3T(language);
        if (normalized === undefined)
          throw new RangeError(
            `Invalid subtitle language preference: ${language}`,
          );
        return normalized;
      }),
    ),
  ];
  return languageCodes.flatMap((language, languageIndex) => {
    const languageName = languages.getName(language, 'en') ?? language;
    const kinds: DirectSubtitleSlot['kind'][] = ['regular', 'sdh', 'forced'];
    return kinds.map((kind) => {
      const id = `${language}_${kind}`;
      const label =
        kind === 'sdh' ? 'SDH' : kind === 'forced' ? 'Forced' : 'Regular';
      const isDefault = languageIndex === 0 && kind === 'forced';
      return {
        id,
        kind,
        language,
        languageName,
        title: `${languageName} ${label}`,
        playlistName: `subtitle_${id}.m3u8`,
        segmentPrefix: `subtitle_${id}_av_`,
        default: isDefault,
        autoSelect: isDefault,
        forced: kind === 'forced',
        sdh: kind === 'sdh',
        nativeHls: true,
      };
    });
  });
}
export type DirectSubtitleSlotFill = {
  slot: DirectSubtitleSlot;
  /** Undefined means this fixed slot must publish empty WebVTT. */
  rendition?: DirectSubtitleRendition;
};

export function fillDirectSubtitleSlots(
  slots: readonly DirectSubtitleSlot[],
  available: readonly DirectSubtitleRendition[],
): DirectSubtitleSlotFill[] {
  const ordered = [...available].sort((left, right) =>
    compareDirectSubtitleSources(left.source, right.source),
  );
  return slots.map((slot) => {
    const matching = ordered.filter(
      ({ source }) =>
        isDirectTextSubtitleCodec(source.codec) &&
        directSubtitleLanguage(source) === slot.language,
    );
    // First match: embedded stream index, then sidecar path. Defaults never define a
    // category, win a tie, or cause a full track to fill the forced slot.
    const regular = matching.find(
      ({ source }) => !source.forced && !source.sdh,
    );
    const sdh = matching.find(({ source }) => !source.forced && source.sdh);
    const forced = matching.find(({ source }) => source.forced);
    return {
      slot,
      rendition:
        slot.kind === 'forced'
          ? forced
          : slot.kind === 'sdh'
            ? (sdh ?? regular)
            : (regular ?? sdh),
    };
  });
}
