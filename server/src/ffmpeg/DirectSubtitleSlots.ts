import languages from '@cospired/i18n-iso-languages';
import { LanguageService } from '../services/LanguageService.ts';
import type {
  DirectSubtitleSlot,
  SubtitleStreamDetails,
} from '../stream/types.ts';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import type { DirectSubtitleRendition } from './DirectSubtitleRenditions.ts';
import {
  compareDirectSubtitleSources,
  isDirectTextSubtitleCodec,
} from './DirectSubtitleRenditions.ts';

/**
 * Resolves a configured or reported language identifier to the ISO 639-2/T
 * code the slot catalogue is keyed on. Accepts ISO 639-1/2 codes and English
 * names through LanguageService, BCP 47 tags with region or script subtags by
 * their primary language subtag, and ISO 639-2 private-use codes (qaa-qtz)
 * verbatim, which LanguageService.codesMatch tolerates the same way.
 *
 * Script subtags collapse to the base language: this alpha-3 identity cannot
 * tell zh-Hans from zh-Hant. That is a limit of the slot catalogue, not of
 * FFmpeg or HLS, which both carry BCP 47 tags as they are.
 */
export function normalizeDirectSubtitleLanguage(
  code: string,
): string | undefined {
  const trimmed = code.trim();
  if (trimmed.length === 0) return undefined;
  const direct = LanguageService.normalizeToAlpha3T(trimmed);
  if (direct !== undefined) return direct;
  const primary = trimmed.split(/[-_]/, 1)[0] ?? '';
  if (primary.length > 0 && primary !== trimmed) {
    const fromPrimary = LanguageService.normalizeToAlpha3T(primary);
    if (fromPrimary !== undefined) return fromPrimary;
  }
  if (/^q[a-t][a-z]$/i.test(trimmed)) return trimmed.toLowerCase();
  return undefined;
}

export function directSubtitleLanguage(source: SubtitleStreamDetails): string {
  return (
    normalizeDirectSubtitleLanguage(source.languageCodeISO6392 ?? '') ??
    normalizeDirectSubtitleLanguage(source.languageCodeISO6391 ?? '') ??
    normalizeDirectSubtitleLanguage(source.language ?? '') ??
    'und'
  );
}

/** The ordered channel language filter defines its lifetime subtitle catalogue. */
export function createDirectSubtitleSlots(
  languagePreferences: readonly string[],
): DirectSubtitleSlot[] {
  const logger = LoggerFactory.child({ className: 'DirectSubtitleSlots' });
  // Only configured languages create slots. There is no implied language or
  // catalogue derived from the programme that happens to be on air.
  const languageCodes: string[] = [];
  for (const language of languagePreferences) {
    const normalized = normalizeDirectSubtitleLanguage(language);
    if (normalized === undefined) {
      // The preference table accepts any string. A row this build cannot
      // resolve loses its renditions; it must not stop the channel from
      // starting, which is what a throw here did from Session.start.
      logger.warn(
        'Ignoring subtitle language preference "%s": not a recognised language code',
        language,
      );
      continue;
    }
    if (!languageCodes.includes(normalized)) languageCodes.push(normalized);
  }
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
