import languages from '@cospired/i18n-iso-languages';
import en from '@cospired/i18n-iso-languages/langs/en.json' with { type: 'json' };
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { LocalSubtitlesService } from './LocalSubtitlesService.ts';

vi.mock('../../util/logging/LoggerFactory.ts', () => ({
  LoggerFactory: { child: () => ({ debug: vi.fn() }) },
}));

beforeAll(() => {
  languages.registerLocale(en);
});

describe('LocalSubtitlesService', () => {
  test('parse basic', () => {
    const subs = LocalSubtitlesService.parseSubtitleFilePath(
      '/a/b/c/The Player (1992) {imdb-tt0105151}.mkv',
      '/a/b/c/The Player (1992) {imdb-tt0105151}.en.hi.srt',
    );
    expect(subs?.language).toEqual('eng');
    expect(subs?.sdh).toBeTruthy();
  });

  test('parse en-us', () => {
    const subs = LocalSubtitlesService.parseSubtitleFilePath(
      "/a/b/c/Blahblah's Mystery Circus.mkv",
      "/a/b/c/Blahblah's Mystery Circus.en-us.cc.srt",
    );

    expect(subs?.language).toEqual('eng');
    expect(subs?.sdh).toBeTruthy();
  });

  test('parse en_US', () => {
    const subs = LocalSubtitlesService.parseSubtitleFilePath(
      "/a/b/c/Blahblah's Mystery Circus.mkv",
      "/a/b/c/Blahblah's Mystery Circus.en_US.cc.srt",
    );

    expect(subs?.language).toEqual('eng');
    expect(subs?.sdh).toBeTruthy();
  });

  test('parse title with dot in name', () => {
    const subs = LocalSubtitlesService.parseSubtitleFilePath(
      '/a/b/c/Mrs. Sureice (1080p).mkv',
      '/a/b/c/Mrs. Sureice (1080p).en-us.cc.srt',
    );

    expect(subs?.language).toEqual('eng');
    expect(subs?.sdh).toBeTruthy();
  });

  test.each([
    ['eng.forced.srt', 'eng', true, false, 'subrip'],
    ['en.SDH.VTT', 'eng', false, true, 'webvtt'],
    ['eng_sdh.srt', 'eng', false, true, 'subrip'],
    ['forced.en.srt', 'eng', true, false, 'subrip'],
    ['hi.srt', 'hin', false, false, 'subrip'],
    ['hi.forced.srt', 'hin', true, false, 'subrip'],
    ['hi-IN.forced.srt', 'hin', true, false, 'subrip'],
    ['en.hi.srt', 'eng', false, true, 'subrip'],
    ['en.cc.srt', 'eng', false, true, 'subrip'],
    ['cc.srt', '', false, true, 'subrip'],
    ['German.srt', 'deu', false, false, 'subrip'],
    ['fre.srt', 'fra', false, false, 'subrip'],
    ['pt-BR.srt', 'por', false, false, 'subrip'],
    ['qaa.forced.srt', 'qaa', true, false, 'subrip'],
    ['en.default.srt', 'eng', false, false, 'subrip'],
    ['default.eng.forced.ass', 'eng', true, false, 'ass'],
    ['default.ssa', '', false, false, 'ass'],
    ['hi.en.srt', 'eng', false, true, 'subrip'],
    ['en-US.srt', 'eng', false, false, 'subrip'],
    ['en-US.sdh.srt', 'eng', false, true, 'subrip'],
    ['zh-Hant.srt', 'zho', false, false, 'subrip'],
    ['fin.srt', 'fin', false, false, 'subrip'],
  ])('parses %s', (suffix, language, forced, sdh, codec) => {
    const subtitlePath = `/a/b/c/The Danish Girl.${suffix}`;
    expect(
      LocalSubtitlesService.parseSubtitleFilePath(
        '/a/b/c/The Danish Girl.mkv',
        subtitlePath,
      ),
    ).toMatchObject({
      language,
      forced,
      sdh,
      codec,
      default: false,
      path: subtitlePath,
    });
  });

  test('does not interpret the video title as subtitle metadata', () => {
    expect(
      LocalSubtitlesService.parseSubtitleFilePath(
        '/a/b/c/The Danish Girl.mkv',
        '/a/b/c/The Danish Girl.srt',
      ),
    ).toMatchObject({ language: '', forced: false, sdh: false });
  });

  test.each([
    'Episode2.eng.srt',
    'Another Episode.eng.srt',
    'Episode.eng.nfo',
    // Sibling titles whose names extend this video's basename.
    'Episode 2.eng.srt',
    'Episode-2.eng.srt',
    'Episode.2.eng.srt',
    'Episode Part 2.eng.srt',
    "Episode.Director's.Cut.eng.srt",
    'Episode.eng.fre.srt',
  ])('does not associate %s as a subtitle', (filename) => {
    expect(
      LocalSubtitlesService.parseSubtitleFilePath(
        '/a/b/c/Episode.mkv',
        `/a/b/c/${filename}`,
      ),
    ).toBeNull();
  });

  test('does not associate an edition-suffixed sibling as a subtitle', () => {
    expect(
      LocalSubtitlesService.parseSubtitleFilePath(
        '/a/b/c/Movie (2010).mkv',
        "/a/b/c/Movie (2010) {edition-Director's Cut}.en.srt",
      ),
    ).toBeNull();
  });

  describe('directory discovery', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tunarr-sidecars-'));
    });

    afterEach(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    test('discovers all supported formats with complete paths and metadata', async () => {
      const video = path.join(directory, 'Mrs. Sureice.mkv');
      const expected = [
        {
          path: path.join(directory, 'Mrs. Sureice.eng.forced.srt'),
          codec: 'subrip',
          language: 'eng',
          forced: true,
          sdh: false,
          default: false,
        },
        {
          path: path.join(directory, 'Mrs. Sureice.en.sdh.VTT'),
          codec: 'webvtt',
          language: 'eng',
          forced: false,
          sdh: true,
          default: false,
        },
        {
          path: path.join(directory, 'Mrs. Sureice.fre.cc.ass'),
          codec: 'ass',
          language: 'fra',
          forced: false,
          sdh: true,
          default: false,
        },
        {
          path: path.join(directory, 'Mrs. Sureice.de.default.SSA'),
          codec: 'ass',
          language: 'deu',
          forced: false,
          sdh: false,
          default: false,
        },
        {
          path: path.join(directory, 'Mrs. Sureice.default.srt'),
          codec: 'subrip',
          language: '',
          forced: false,
          sdh: false,
          default: false,
        },
      ];
      await Promise.all(
        [
          video,
          ...expected.map((subtitle) => subtitle.path),
          path.join(directory, 'Mrs. Sureice2.eng.srt'),
          path.join(directory, 'Mrs. Sureice 2.eng.srt'),
          path.join(directory, 'Unrelated.eng.srt'),
          path.join(directory, 'Mrs. Sureice.eng.nfo'),
        ].map((file) => fs.writeFile(file, '')),
      );
      await fs.mkdir(path.join(directory, 'Mrs. Sureice.eng.srt'));

      const subtitles = await new LocalSubtitlesService().findExternalSubtitles(
        video,
      );

      expect(subtitles).toHaveLength(expected.length);
      expect(subtitles).toEqual(
        expect.arrayContaining(
          expected.map((subtitle) =>
            expect.objectContaining({ ...subtitle, subtitleType: 'sidecar' }),
          ),
        ),
      );
    });
  });
});
