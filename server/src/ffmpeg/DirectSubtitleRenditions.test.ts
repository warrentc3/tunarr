import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { SubtitleStreamDetails } from '../stream/types.ts';
import {
  collectDirectSubtitleRenditions,
  isDirectTextSubtitleCodec,
} from './DirectSubtitleRenditions.ts';
import {
  createDirectSubtitleSlots,
  fillDirectSubtitleSlots,
} from './DirectSubtitleSlots.ts';
import { SubtitleStreamPicker } from './SubtitleStreamPicker.ts';

const { loggerDebug } = vi.hoisted(() => ({ loggerDebug: vi.fn() }));
vi.mock('../util/logging/LoggerFactory.ts', () => ({
  LoggerFactory: { child: () => ({ debug: loggerDebug }) },
}));
vi.mock('./SubtitleStreamPicker.ts', () => ({
  SubtitleStreamPicker: { getSubtitleDetailsWithExtractedPath: vi.fn() },
}));

const resolveExtraction = vi.mocked(
  SubtitleStreamPicker.getSubtitleDetailsWithExtractedPath,
);
const lineupItem = {
  type: 'program',
  program: { uuid: 'programme' },
} as ContentBackedStreamLineupItem;

describe('Direct subtitle renditions', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'direct-subtitles-'));
    vi.clearAllMocks();
    resolveExtraction.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function sidecar(
    name: string,
    overrides: Partial<SubtitleStreamDetails> = {},
  ): Promise<SubtitleStreamDetails> {
    const path = join(directory, name);
    await writeFile(path, '1\n00:00:01,000 --> 00:00:02,000\nCaption\n');
    return {
      type: 'external',
      codec: 'subrip',
      default: false,
      forced: false,
      sdh: false,
      languageCodeISO6392: 'eng',
      path,
      ...overrides,
    };
  }

  function collect(subtitleStreams: SubtitleStreamDetails[]) {
    return collectDirectSubtitleRenditions({ lineupItem, subtitleStreams });
  }

  it.each(['webvtt', 'vtt', 'VTT'])(
    'fills channel slots from a cached WebVTT sidecar with codec %s',
    async (codec) => {
      const path = join(directory, 'movie.eng.vtt');
      await writeFile(
        path,
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCaption\n',
      );
      const subtitle: SubtitleStreamDetails = {
        type: 'external',
        codec,
        default: false,
        forced: false,
        sdh: false,
        languageCodeISO6392: 'eng',
        path,
      };

      const available = await collect([subtitle]);
      expect(available).toHaveLength(1);
      expect(available[0]?.stream).toMatchObject({
        type: 'external',
        codec,
        index: 0,
        path,
      });
      const filled = fillDirectSubtitleSlots(
        createDirectSubtitleSlots(['eng']),
        available,
      );
      expect(filled.map(({ rendition }) => rendition?.source)).toEqual([
        subtitle,
        subtitle,
        undefined,
      ]);
      expect(resolveExtraction).not.toHaveBeenCalled();
    },
  );

  it('retains separate sidecar files with identical language and flags', async () => {
    const srt = await sidecar('movie.eng.srt');
    const vtt = await sidecar('movie.eng.vtt', { codec: 'webvtt' });
    const otherLanguage = await sidecar('movie.spa.ass', {
      codec: 'ass',
      languageCodeISO6392: 'spa',
    });

    const result = await collect([srt, vtt, otherLanguage]);

    expect(result.map(({ source }) => source)).toEqual([
      srt,
      vtt,
      otherLanguage,
    ]);
    expect(result.map(({ stream }) => stream.index)).toEqual([0, 0, 0]);
    expect(resolveExtraction).not.toHaveBeenCalled();
  });

  it('uses an existing extraction at index zero when it is available', async () => {
    const localCopy = await sidecar('cache.srt');
    const embedded: SubtitleStreamDetails = {
      ...localCopy,
      type: 'embedded',
      index: 7,
      path: undefined,
    };
    resolveExtraction.mockResolvedValue({ ...localCopy, index: 0 });

    const result = await collect([embedded]);

    expect(resolveExtraction).toHaveBeenCalledWith(lineupItem, embedded);
    expect(result[0]?.source).toBe(embedded);
    expect(result[0]?.stream).toMatchObject({
      type: 'external',
      index: 0,
      path: localCopy.path,
    });
  });

  it('retains raw embedded text and available sidecars together without extraction', async () => {
    const available = await sidecar('available.srt');
    const unextracted: SubtitleStreamDetails = {
      ...available,
      type: 'embedded',
      index: 4,
      path: undefined,
      default: true,
    };

    const result = await collect([unextracted, available]);

    expect(result.map(({ source }) => source)).toEqual([
      unextracted,
      available,
    ]);
    expect(result[0]?.stream).toMatchObject({ type: 'embedded', index: 4 });
    expect(result[0]?.stream.path).toBeUndefined();
    expect(result[1]?.stream).toMatchObject({
      type: 'external',
      index: 0,
      path: available.path,
    });
  });

  it('deduplicates raw and cached representations of the same embedded index', async () => {
    const extracted = await sidecar('cache.srt', {
      type: 'embedded',
      index: 5,
      sdh: true,
      title: 'English SDH',
    });
    const raw = { ...extracted, path: undefined, sdh: false, title: undefined };
    const other = await sidecar('other.srt');
    resolveExtraction.mockResolvedValue({
      ...extracted,
      type: 'external',
      index: 0,
    });

    const result = await collect([raw, other, extracted]);

    expect(result.map(({ source }) => source)).toEqual([extracted, other]);
    expect(result[0]?.stream).toMatchObject({
      sdh: true,
      title: 'English SDH',
    });
    expect(resolveExtraction).not.toHaveBeenCalled();
  });

  it('retains sidecar aliases as candidates and sorts by reported path before canonicalization', async () => {
    const first = await sidecar('first.srt');
    const second = await sidecar('second.srt');
    const alias = join(directory, 'alias.srt');
    await symlink(join(directory, 'first.srt'), alias);

    const result = await collect([first, { ...first, path: alias }, second]);

    expect(result.map(({ source }) => source.path)).toEqual([
      alias,
      first.path,
      second.path,
    ]);
    expect(result.map(({ stream }) => stream.path)).toEqual([
      first.path,
      first.path,
      second.path,
    ]);
  });

  it('excludes all image codecs, unknown codecs and ambiguous extensions', async () => {
    const codecs = [
      'hdmv_pgs_subtitle',
      'dvd_subtitle',
      'dvdsub',
      'vobsub',
      'pgssub',
      'pgs',
      'dvbsub',
      'dvb_subtitle',
      'xsub',
      'sub',
      'unknown',
    ];
    const unsupported = await Promise.all(
      codecs.map((codec) => sidecar(`${codec}.sub`, { codec })),
    );
    const text = await sidecar('microdvd.sub', { codec: 'microdvd' });
    const upperCase = await sidecar('upper.srt', { codec: 'SRT' });

    const result = await collect([...unsupported, text, upperCase]);

    expect(result.map(({ source }) => source)).toEqual([text, upperCase]);
    expect(resolveExtraction).not.toHaveBeenCalled();
  });

  it('skips missing files and directories without masking later usable text', async () => {
    const available = await sidecar('available.srt');
    const directoryPath = join(directory, 'not-a-file.srt');
    await mkdir(directoryPath);

    const result = await collect([
      { ...available, path: join(directory, 'deleted.srt') },
      { ...available, path: directoryPath },
      { ...available, path: undefined },
      available,
    ]);

    expect(result.map(({ source }) => source)).toEqual([available]);
    expect(loggerDebug).toHaveBeenCalled();
  });

  it('falls back to the embedded stream after a failed cache lookup', async () => {
    const available = await sidecar('available.srt');
    resolveExtraction.mockRejectedValue(new Error('cache mount unavailable'));

    const result = await collect([
      { ...available, type: 'embedded', index: 3, path: undefined },
      available,
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.stream).toMatchObject({ type: 'embedded', index: 3 });
    expect(result[0]?.stream.path).toBeUndefined();
    expect(result[1]?.source).toBe(available);
    expect(resolveExtraction).toHaveBeenCalledTimes(1);
    expect(loggerDebug).toHaveBeenCalledTimes(1);
  });

  it('rejects provider URLs and relative names instead of accessing a server at playback', async () => {
    const available = await sidecar('available.srt');

    const result = await collect([
      { ...available, path: 'https://media.example/Subtitle/Stream.srt' },
      { ...available, path: 'relative.srt' },
      available,
    ]);

    expect(result.map(({ source }) => source)).toEqual([available]);
    expect(resolveExtraction).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalledTimes(2);
  });

  it('falls back to the original embedded index when a recorded extraction has disappeared', async () => {
    const external = await sidecar('external.srt');
    const raw: SubtitleStreamDetails = {
      ...external,
      type: 'embedded',
      index: 9,
      path: undefined,
    };
    const stale = {
      ...raw,
      path: join(directory, 'deleted-cache.srt'),
      title: 'English SDH',
      sdh: true,
    };

    const result = await collect([raw, external, stale]);

    expect(result).toHaveLength(2);
    expect(result[0]?.source).toBe(stale);
    expect(result[0]?.stream).toMatchObject({
      type: 'embedded',
      index: 9,
      sdh: true,
      title: 'English SDH',
    });
    expect(result[0]?.stream.path).toBeUndefined();
    expect(result[1]?.source).toBe(external);
  });

  it('keeps separate embedded text indices even when language and flags match', async () => {
    const file = await sidecar('unused.srt');
    const first: SubtitleStreamDetails = {
      ...file,
      type: 'embedded',
      index: 3,
      path: undefined,
    };
    const second: SubtitleStreamDetails = { ...first, index: 4 };

    const result = await collect([first, { ...first }, second]);

    expect(result.map(({ stream }) => stream.index)).toEqual([3, 4]);
    expect(result.every(({ stream }) => stream.type === 'embedded')).toBe(true);
  });

  it('requires a valid source index before mapping an unextracted embedded stream', async () => {
    const file = await sidecar('unused.srt');
    const invalid = [
      undefined,
      -1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ].map((index) => ({
      ...file,
      type: 'embedded' as const,
      index,
      path: undefined,
    }));

    expect(await collect(invalid)).toEqual([]);
  });

  it('keeps a sidecar candidate distinct from an embedded extraction of the same file', async () => {
    const file = await sidecar('shared.srt');
    const embedded: SubtitleStreamDetails = {
      ...file,
      type: 'embedded',
      index: 7,
    };

    const result = await collect([embedded, file]);

    expect(result).toHaveLength(2);
    expect(result[0]?.source).toBe(embedded);
    expect(result[1]?.source).toBe(file);
    expect(result[0]?.stream).toMatchObject({
      type: 'external',
      index: 0,
      path: file.path,
    });
  });

  it('orders embedded indices then sidecar paths regardless of database row order or defaults', async () => {
    const sidecarB = await sidecar('B.srt', { default: true });
    const sidecarA = await sidecar('A.srt');
    const embedded3: SubtitleStreamDetails = {
      ...sidecarA,
      type: 'embedded',
      index: 3,
      path: undefined,
    };
    const embedded9: SubtitleStreamDetails = {
      ...embedded3,
      index: 9,
      default: true,
    };
    const input = [sidecarB, embedded9, sidecarA, embedded3];
    expect((await collect(input)).map(({ source }) => source)).toEqual([
      embedded3,
      embedded9,
      sidecarA,
      sidecarB,
    ]);
    expect(
      (await collect([...input].reverse())).map(({ source }) => source),
    ).toEqual([embedded3, embedded9, sidecarA, sidecarB]);
  });

  it('does not discard forced or regular candidates that share a canonical file', async () => {
    const regular = await sidecar('shared.srt');
    const forced = { ...regular, forced: true };
    const result = await collect([regular, forced, { ...regular }]);
    expect(result).toHaveLength(3);
    expect(result.map(({ source }) => source.forced)).toEqual([
      false,
      true,
      false,
    ]);
    expect(new Set(result.map(({ stream }) => stream.path)).size).toBe(1);
  });
});

describe('Direct text subtitle codec eligibility', () => {
  it.each(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text'])(
    'accepts %s, which FFmpeg 7.1.1 can decode to WebVTT',
    (codec) => {
      expect(isDirectTextSubtitleCodec(codec)).toBe(true);
    },
  );

  it.each(['ttml', 'hdmv_text_subtitle', 'TTML'])(
    'rejects %s, which is text but has no decoder in FFmpeg 7.1.1',
    (codec) => {
      expect(isDirectTextSubtitleCodec(codec)).toBe(false);
    },
  );

  it.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])(
    'rejects image subtitle codec %s',
    (codec) => {
      expect(isDirectTextSubtitleCodec(codec)).toBe(false);
    },
  );
});
