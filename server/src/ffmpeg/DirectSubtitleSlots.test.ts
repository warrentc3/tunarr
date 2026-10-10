import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleStreamDetails } from '../stream/types.ts';
import type { DirectSubtitleRendition } from './DirectSubtitleRenditions.ts';
import {
  createDirectSubtitleSlots,
  directSubtitleLanguage,
  fillDirectSubtitleSlots,
  normalizeDirectSubtitleLanguage,
} from './DirectSubtitleSlots.ts';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('../util/logging/LoggerFactory.ts', () => ({
  LoggerFactory: { child: () => ({ warn: loggerWarn, debug: vi.fn() }) },
}));

function source(
  overrides: Partial<SubtitleStreamDetails> = {},
): SubtitleStreamDetails {
  return {
    type: 'embedded',
    codec: 'subrip',
    index: 2,
    default: false,
    forced: false,
    sdh: false,
    languageCodeISO6392: 'eng',
    ...overrides,
  };
}

function available(
  overrides: Partial<SubtitleStreamDetails> = {},
): DirectSubtitleRendition {
  const subtitle = source(overrides);
  if (subtitle.type === 'external') {
    if (subtitle.path === undefined)
      throw new Error('External test candidate requires path');
    return {
      source: subtitle,
      stream: { ...subtitle, type: 'external', index: 0, path: subtitle.path },
    };
  }
  return {
    source: subtitle,
    stream: {
      ...subtitle,
      type: 'embedded',
      index: subtitle.index ?? 2,
      path: undefined,
    },
  };
}

const englishSlots = createDirectSubtitleSlots(['eng']);

describe('Direct subtitle channel catalogue', () => {
  it('creates three slots for each filtered language in preference order even with no programme subtitles', () => {
    const slots = createDirectSubtitleSlots(['ger', 'eng', 'deu']);
    expect(slots.map(({ id }) => id)).toEqual([
      'deu_regular',
      'deu_sdh',
      'deu_forced',
      'eng_regular',
      'eng_sdh',
      'eng_forced',
    ]);
    expect(
      slots.filter(({ default: isDefault }) => isDefault).map(({ id }) => id),
    ).toEqual(['deu_forced']);
    expect(
      slots.filter(({ autoSelect }) => autoSelect).map(({ id }) => id),
    ).toEqual(['deu_forced']);
    expect(slots.map(({ title }) => title)).toEqual([
      'German Regular',
      'German SDH',
      'German Forced',
      'English Regular',
      'English SDH',
      'English Forced',
    ]);
    expect(new Set(slots.map(({ playlistName }) => playlistName)).size).toBe(6);
  });

  it('returns no slots for an empty language filter', () => {
    expect(createDirectSubtitleSlots([])).toEqual([]);
  });

  describe('language preferences the table can hold', () => {
    beforeEach(() => loggerWarn.mockClear());

    it('skips and logs an unresolvable preference instead of failing the session', () => {
      expect(createDirectSubtitleSlots(['invalid-language'])).toEqual([]);
      expect(loggerWarn).toHaveBeenCalledOnce();
      expect(loggerWarn.mock.calls[0]?.[1]).toBe('invalid-language');
    });

    it('keeps the other preferences when one is unresolvable or empty', () => {
      expect(
        createDirectSubtitleSlots(['', 'invalid-language', 'eng']).map(
          ({ id }) => id,
        ),
      ).toEqual(['eng_regular', 'eng_sdh', 'eng_forced']);
      expect(loggerWarn).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['en-US', 'eng'],
      ['pt_BR', 'por'],
      ['EN', 'eng'],
      ['English', 'eng'],
      ['ger', 'deu'],
    ])('resolves %s to %s', (preference, expected) => {
      expect(
        createDirectSubtitleSlots([preference]).map(({ language }) => language),
      ).toEqual([expected, expected, expected]);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('keeps ISO 639-2 private-use codes as their own identity', () => {
      const slots = createDirectSubtitleSlots(['qaa']);
      expect(slots.map(({ id }) => id)).toEqual([
        'qaa_regular',
        'qaa_sdh',
        'qaa_forced',
      ]);
      expect(slots[0]?.title).toBe('qaa Regular');
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('collapses a script subtag to the base language (known catalogue limit)', () => {
      expect(
        createDirectSubtitleSlots(['zh-Hant', 'zh-Hans']).map(({ id }) => id),
      ).toEqual(['zho_regular', 'zho_sdh', 'zho_forced']);
    });

    it('matches region-tagged tracks to the base-language slot', () => {
      expect(directSubtitleLanguage(source({ language: 'en-US' }))).toBe('eng');
      expect(
        directSubtitleLanguage(
          source({ languageCodeISO6392: undefined, languageCodeISO6391: 'pt' }),
        ),
      ).toBe('por');
      expect(normalizeDirectSubtitleLanguage('  ')).toBeUndefined();
      expect(normalizeDirectSubtitleLanguage('x-unknown')).toBeUndefined();
    });
  });
});
describe('Direct subtitle programme filling', () => {
  it('fills regular, SDH and forced from their own categories across one inventory', () => {
    const regular = available({ index: 7 });
    const sdh = available({ index: 8, sdh: true });
    const forced = available({ index: 9, forced: true, default: true });
    expect(
      fillDirectSubtitleSlots(englishSlots, [forced, sdh, regular]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([regular, sdh, forced]);
  });

  it('copies the regular track into SDH when no SDH track exists and leaves forced empty', () => {
    const regular = available({ default: true });
    expect(
      fillDirectSubtitleSlots(englishSlots, [regular]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([regular, regular, undefined]);
  });

  it('uses an SDH track for regular only when no plain full track exists', () => {
    const sdh = available({ sdh: true });
    const regular = available({ index: 3 });
    expect(
      fillDirectSubtitleSlots(englishSlots, [sdh]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([sdh, sdh, undefined]);
    expect(
      fillDirectSubtitleSlots(englishSlots, [sdh, regular]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([regular, sdh, undefined]);
  });

  it('never fills regular or SDH from a forced track, including a forced SDH track', () => {
    const forced = available({ forced: true, sdh: true, default: true });
    expect(
      fillDirectSubtitleSlots(englishSlots, [forced]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([undefined, undefined, forced]);
  });

  it('uses embedded stream index order regardless of row order or container default', () => {
    const first = available({ index: 3, default: false });
    const second = available({ index: 9, default: true });
    expect(
      fillDirectSubtitleSlots(englishSlots, [first, second])[0]?.rendition,
    ).toBe(first);
    expect(
      fillDirectSubtitleSlots(englishSlots, [second, first])[0]?.rendition,
    ).toBe(first);
  });

  it('uses code-point path order for sidecars regardless of row order or default', () => {
    const first = available({
      type: 'external',
      path: '/media/A.srt',
      default: false,
    });
    const second = available({
      type: 'external',
      path: '/media/B.srt',
      default: true,
    });
    expect(
      fillDirectSubtitleSlots(englishSlots, [second, first])[0]?.rendition,
    ).toBe(first);
    expect(
      fillDirectSubtitleSlots(englishSlots, [first, second])[0]?.rendition,
    ).toBe(first);
  });

  it('puts embedded candidates before sidecars for the same category', () => {
    const sidecar = available({
      type: 'external',
      path: '/media/A.srt',
      default: true,
    });
    const embedded = available({ index: 9 });
    expect(
      fillDirectSubtitleSlots(englishSlots, [sidecar, embedded])[0]?.rendition,
    ).toBe(embedded);
  });

  it('uses Unicode code-point path order without a system locale', () => {
    const first = available({ type: 'external', path: '/media/\uE000.srt' });
    const second = available({
      type: 'external',
      path: '/media/\u{10000}.srt',
    });
    expect(
      fillDirectSubtitleSlots(englishSlots, [second, first])[0]?.rendition,
    ).toBe(first);
  });

  it('allows same-path records with different category flags to fill their own slots', () => {
    const regular = available({ type: 'external', path: '/media/shared.srt' });
    const forced = available({
      type: 'external',
      path: '/media/shared.srt',
      forced: true,
    });
    expect(
      fillDirectSubtitleSlots(englishSlots, [forced, regular]).map(
        ({ rendition }) => rendition,
      ),
    ).toEqual([regular, regular, forced]);
  });

  it('does not fill a configured language from an untagged or different-language track', () => {
    const wrong = available({ languageCodeISO6392: 'spa' });
    const unknown = available({ languageCodeISO6392: undefined });
    expect(
      fillDirectSubtitleSlots(englishSlots, [wrong, unknown]).every(
        ({ rendition }) => rendition === undefined,
      ),
    ).toBe(true);
  });

  it('does not admit image subtitles even when their language and category match', () => {
    expect(
      fillDirectSubtitleSlots(englishSlots, [
        available({ codec: 'dvb_subtitle' }),
      ]).every(({ rendition }) => rendition === undefined),
    ).toBe(true);
  });

  it('preserves every channel slot and its metadata through a no-subtitle programme', () => {
    const filled = fillDirectSubtitleSlots(englishSlots, []);
    expect(filled.map(({ slot }) => slot)).toEqual(englishSlots);
    expect(filled.every(({ rendition }) => rendition === undefined)).toBe(true);
    expect(filled[2]?.slot).toMatchObject({
      id: 'eng_forced',
      default: true,
      autoSelect: true,
      forced: true,
    });
  });
});
