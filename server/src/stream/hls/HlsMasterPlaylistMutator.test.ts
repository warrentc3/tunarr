import { describe, expect, test } from 'vitest';
import { HlsMasterPlaylistMutator } from './HlsMasterPlaylistMutator.js';
import type { SubtitleRenditionInfo } from './HlsMasterPlaylistMutator.js';
import type { DirectSubtitleRenditionInfo } from '../types.ts';

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const streamBaseUrl = `/stream/channels/${channelUuid}/hls/`;
const streamNameFormat = 'stream.m3u8';
const subtitleStreamNameFormat = 'subs.m3u8';

describe('HlsMasterPlaylistMutator', () => {
  describe('replaceDirectSubtitleMediaTags', () => {
    const renditions: DirectSubtitleRenditionInfo[] = [
      {
        id: 'a12',
        playlistName: 'subs_a12.m3u8',
        segmentPrefix: 'sub_a12_',
        language: 'eng',
        title: 'English',
        default: true,
        forced: false,
        nativeHls: true,
      },
      {
        id: 'b34',
        playlistName: 'subs_b34.m3u8',
        segmentPrefix: 'sub_b34_',
        language: 'fra',
        title: 'French forced',
        default: false,
        forced: true,
        nativeHls: true,
      },
    ];

    test('publishes each current producer rendition on the one existing AV variant', () => {
      const variant = '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs"';
      const lines = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="old",URI="subs.m3u8"',
        variant,
        `${streamBaseUrl}stream.m3u8`,
      ];
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
        lines,
        renditions,
        { streamBaseUrl },
      );
      expect(
        lines.filter((line) => line.includes('TYPE=SUBTITLES')),
      ).toHaveLength(2);
      expect(
        lines.filter((line) => line.startsWith('#EXT-X-STREAM-INF:')),
      ).toEqual([variant]);
      expect(lines.join('\n')).toContain(`URI="${streamBaseUrl}subs_a12.m3u8"`);
      expect(lines.join('\n')).toContain(`URI="${streamBaseUrl}subs_b34.m3u8"`);
      expect(lines.join('\n')).not.toContain('NAME="old"');
      const first = [...lines];
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
        lines,
        renditions,
        { streamBaseUrl },
      );
      expect(lines).toEqual(first);
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(lines, [], {
        streamBaseUrl,
      });
      expect(lines).toEqual([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        `${streamBaseUrl}stream.m3u8`,
      ]);
    });

    test('does not fabricate an AV variant when FFmpeg has not published one', () => {
      const lines = ['#EXTM3U'];
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
        lines,
        renditions,
        { streamBaseUrl },
      );
      expect(lines).toEqual(['#EXTM3U']);
    });

    test('keeps quotes and line breaks in sidecar labels out of playlist syntax', () => {
      const lines = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'stream.m3u8'];
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
        lines,
        [{ ...renditions[0]!, title: 'English"\r\n#EXT-X-ENDLIST' }],
        { streamBaseUrl },
      );
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain('NAME="English\'#EXT-X-ENDLIST"');
      expect(lines[1]).not.toContain('\n');
      expect(lines[1]).not.toContain('\r');
    });

    test('honors the fixed slot autoselect flag even for an SDH rendition', () => {
      const lines = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'stream.m3u8'];
      HlsMasterPlaylistMutator.replaceDirectSubtitleMediaTags(
        lines,
        [{ ...renditions[0]!, default: false, sdh: true, autoSelect: false }],
        { streamBaseUrl },
      );
      expect(lines[1]).toContain('DEFAULT=NO,AUTOSELECT=NO');
      expect(lines[1]).toContain(
        'public.accessibility.transcribes-spoken-dialog',
      );
    });
  });
  test('removes the prior native subtitle group when the next programme has none', () => {
    const lines = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",URI="subs.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs",AUDIO="audio"',
      'stream.m3u8',
    ];
    HlsMasterPlaylistMutator.removeSubtitleMediaTag(lines);
    expect(lines).toEqual([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="audio"',
      'stream.m3u8',
    ]);
  });
  describe('rewriteVariantPlaylistUrls', () => {
    test('does not invent a subtitle group when a native master has no entry', () => {
      const lines = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nstream.m3u8',
        { language: 'eng', default: false, forced: false, nativeHls: true },
        { streamBaseUrl, streamNameFormat },
      );
      expect(lines.join('\n')).not.toContain('SUBTITLES=');
    });
    test('rewrites stream.m3u8 line to absolute variant URL', () => {
      const content = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"',
        'stream.m3u8',
      ].join('\n');

      const result = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        undefined,
        { streamBaseUrl, streamNameFormat },
      );

      const joined = result.join('\n');
      expect(joined).toContain(
        `/stream/channels/${channelUuid}/hls/stream.m3u8`,
      );
      expect(joined).not.toMatch(/\nstream\.m3u8/);
    });

    test('preserves non-URI lines unchanged', () => {
      const content = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"',
        'stream.m3u8',
      ].join('\n');

      const result = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        undefined,
        { streamBaseUrl, streamNameFormat },
      );

      const joined = result.join('\n');
      expect(joined).toContain('#EXTM3U');
      expect(joined).toContain('#EXT-X-VERSION:3');
      expect(joined).toContain(
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"',
      );
    });

    test('appends SUBTITLES attribute to #EXT-X-STREAM-INF when rendition is present', () => {
      const content = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ].join('\n');

      const rendition: SubtitleRenditionInfo = {
        language: 'en',
        default: true,
        forced: false,
      };

      const result = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        { streamBaseUrl, streamNameFormat },
      );

      expect(result.join('\n')).toContain(
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs"',
      );
    });

    test('does not duplicate SUBTITLES attribute if already present', () => {
      const content = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs"',
        'stream.m3u8',
      ].join('\n');

      const rendition: SubtitleRenditionInfo = {
        language: 'en',
        default: true,
        forced: false,
      };

      const result = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        { streamBaseUrl, streamNameFormat },
      );

      const matches = result.join('\n').match(/SUBTITLES=/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('injectSubtitleMediaTag', () => {
    test('inserts #EXT-X-MEDIA tag before the first #EXT-X-STREAM-INF line', () => {
      const lines = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ];

      const rendition: SubtitleRenditionInfo = {
        language: 'en',
        languageName: 'English',
        default: true,
        forced: false,
        title: 'English',
      };

      HlsMasterPlaylistMutator.injectSubtitleMediaTag(lines, rendition, {
        streamBaseUrl,
        subtitleStreamNameFormat,
      });

      const streamInfIndex = lines.findIndex((l) =>
        l.startsWith('#EXT-X-STREAM-INF:'),
      );
      expect(lines[streamInfIndex - 1]).toMatch(/^#EXT-X-MEDIA:TYPE=SUBTITLES/);
      expect(lines[streamInfIndex - 1]).toContain('LANGUAGE="en"');
      expect(lines[streamInfIndex - 1]).toContain('NAME="English"');
      expect(lines[streamInfIndex - 1]).toContain('DEFAULT=YES');
      expect(lines[streamInfIndex - 1]).toContain('FORCED=NO');
      expect(lines[streamInfIndex - 1]).toContain(
        `URI="${streamBaseUrl}${subtitleStreamNameFormat}"`,
      );
    });

    test('uses language as name when title and languageName are absent', () => {
      const lines = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ];

      const rendition: SubtitleRenditionInfo = {
        language: 'fr',
        default: false,
        forced: false,
      };

      HlsMasterPlaylistMutator.injectSubtitleMediaTag(lines, rendition, {
        streamBaseUrl,
        subtitleStreamNameFormat,
      });

      expect(lines.some((l) => l.includes('NAME="fr"'))).toBe(true);
    });

    test('keeps the separate-output URI and existing non-SDH selection semantics', () => {
      const lines = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ];
      HlsMasterPlaylistMutator.injectSubtitleMediaTag(
        lines,
        {
          language: 'fra',
          title: 'French forced',
          default: false,
          forced: true,
        },
        { streamBaseUrl, subtitleStreamNameFormat },
      );

      expect(lines[1]).toBe(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fra",NAME="French forced",DEFAULT=NO,AUTOSELECT=NO,FORCED=YES,URI="${streamBaseUrl}subs.m3u8"`,
      );
      expect(lines).toHaveLength(4);
    });

    test('advertises SDH accessibility and autoselection on the separate-output entry', () => {
      const lines = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ];
      HlsMasterPlaylistMutator.injectSubtitleMediaTag(
        lines,
        {
          language: 'eng',
          title: 'English SDH',
          default: false,
          forced: false,
          sdh: true,
        },
        { streamBaseUrl, subtitleStreamNameFormat },
      );

      expect(lines[1]).toContain('DEFAULT=NO,AUTOSELECT=YES,FORCED=NO');
      expect(lines[1]).toContain(
        'CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"',
      );
      expect(lines[1]).toContain(`URI="${streamBaseUrl}subs.m3u8"`);
    });
  });

  describe('augmentNativeSubtitleMediaTag', () => {
    test('updates the native entry without changing its group, URI, stream line or entry count', () => {
      const streamInfo =
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"';
      const lines = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",DEFAULT=YES,LANGUAGE="eng",URI="subs.m3u8",X-TEST="left,right"',
        streamInfo,
        'stream.m3u8',
      ];

      expect(
        HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, {
          language: 'fra',
          title: 'French forced',
          default: false,
          forced: true,
        }),
      ).toBe(true);

      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain('GROUP-ID="subs"');
      expect(lines[1]).toContain('URI="subs.m3u8",X-TEST="left,right"');
      expect(lines[1]).toContain('NAME="French forced"');
      expect(lines[1]).toContain('LANGUAGE="fra"');
      expect(lines[1]).toContain('DEFAULT=NO');
      expect(lines[1]).toContain('AUTOSELECT=NO,FORCED=YES');
      expect(lines[2]).toBe(streamInfo);
      expect(lines[3]).toBe('stream.m3u8');
    });

    const nameCases: {
      rendition: SubtitleRenditionInfo;
      expectedName: string;
    }[] = [
      {
        rendition: {
          language: 'eng',
          languageName: 'English',
          default: true,
          forced: false,
        },
        expectedName: 'English',
      },
      {
        rendition: { language: 'fra', default: false, forced: false },
        expectedName: 'fra',
      },
    ];
    test.each(nameCases)(
      'uses the current name fallback: $expectedName',
      ({ rendition, expectedName }) => {
        const lines = [
          '#EXT-X-MEDIA:GROUP-ID="subs",TYPE=SUBTITLES,NAME="subtitle_0",URI="subs.m3u8"',
        ];
        HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(
          lines,
          rendition,
        );

        expect(lines[0]).toContain(`NAME="${expectedName}"`);
        expect(lines[0]).toContain(`LANGUAGE="${rendition.language}"`);
        expect(lines[0]).toContain(
          `DEFAULT=${rendition.default ? 'YES' : 'NO'}`,
        );
        expect(lines[0]).toContain(
          `AUTOSELECT=${rendition.default ? 'YES' : 'NO'}`,
        );
        expect(lines[0]).toContain('FORCED=NO');
      },
    );

    test('preserves rewritten native URIs and existing stream-group references', () => {
      const content = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",URI="subs.m3u8?filter=NAME=keep,DEFAULT=YES"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs"',
        'stream.m3u8',
      ].join('\n');
      const rendition: SubtitleRenditionInfo = {
        language: 'eng',
        title: 'English, SDH',
        default: false,
        forced: false,
        sdh: true,
      };
      const lines = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        {
          streamBaseUrl,
          streamNameFormat,
        },
      );
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, rendition);

      expect(lines[1]).toContain(
        `URI="${streamBaseUrl}subs.m3u8?filter=NAME=keep,DEFAULT=YES"`,
      );
      expect(lines[1]).toContain('NAME="English, SDH"');
      expect(lines[2]).toBe(
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="subs"',
      );
      expect(lines[3]).toBe(`${streamBaseUrl}stream.m3u8`);
      expect(
        lines.filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')),
      ).toHaveLength(1);
    });

    test('merges SDH characteristics and remains idempotent without duplicating attributes', () => {
      const lines = [
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",URI="subs.m3u8",CHARACTERISTICS="public.easy-to-read,public.accessibility.transcribes-spoken-dialog"',
      ];
      const rendition: SubtitleRenditionInfo = {
        language: 'eng',
        title: 'English SDH',
        default: false,
        forced: false,
        sdh: true,
      };
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, rendition);
      const firstResult = [...lines];
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, rendition);

      expect(lines).toEqual(firstResult);
      expect(lines[0]).toContain('DEFAULT=NO,AUTOSELECT=YES,FORCED=NO');
      expect(lines[0]).toContain(
        'CHARACTERISTICS="public.easy-to-read,public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"',
      );
      expect(lines[0]?.match(/CHARACTERISTICS=/g)).toHaveLength(1);
      expect(lines[0]?.match(/NAME=/g)).toHaveLength(1);
    });

    test('removes stale SDH characteristics while preserving unrelated characteristics', () => {
      const lines = [
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English SDH",URI="subs.m3u8",CHARACTERISTICS="public.easy-to-read,public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"',
      ];
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, {
        language: 'eng',
        title: 'English',
        default: false,
        forced: false,
      });

      expect(lines[0]).toContain('CHARACTERISTICS="public.easy-to-read"');
      expect(lines[0]).toContain('AUTOSELECT=NO');
      expect(lines[0]).not.toContain('public.accessibility.');
    });

    test('does not alter other groups or audio entries', () => {
      const unrelated = [
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="subs",NAME="English audio",URI="stream.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="other",NAME="Other subtitles",URI="other.m3u8"',
      ];
      const lines = [
        ...unrelated,
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",URI="subs.m3u8"',
      ];
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, {
        language: 'eng',
        default: false,
        forced: false,
      });

      expect(lines.slice(0, 2)).toEqual(unrelated);
      expect(lines).toHaveLength(3);
    });

    test('returns false without inventing an entry when the native subtitle group is absent', () => {
      const original = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'stream.m3u8',
      ];
      const lines = [...original];

      expect(
        HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, {
          language: 'eng',
          default: false,
          forced: false,
        }),
      ).toBe(false);
      expect(lines).toEqual(original);
    });

    test('augments a native tag without synthesizing missing bandwidth or a variant', () => {
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",URI="subs.m3u8"',
      ];
      HlsMasterPlaylistMutator.augmentNativeSubtitleMediaTag(lines, {
        language: 'eng',
        title: 'English',
        default: false,
        forced: false,
      });

      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('NAME="English"');
      expect(lines.join('\n')).not.toContain('#EXT-X-STREAM-INF');
      expect(lines.join('\n')).not.toContain('BANDWIDTH=');
    });
  });
});
