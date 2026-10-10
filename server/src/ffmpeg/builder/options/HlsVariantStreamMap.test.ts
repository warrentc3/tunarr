import { describe, expect, test } from 'vitest';
import { HlsVariantStreamMap } from './HlsVariantStreamMap.ts';

describe('HlsVariantStreamMap', () => {
  test('maps empty WebVTT continuity without advertising a subtitle group', () => {
    expect(
      new HlsVariantStreamMap({
        videoOutputIndexes: [0],
        audioOutputIndexes: [0],
        subtitleOutputIndex: 0,
        default: false,
      }).toString(),
    ).toBe('v:0,a:0,s:0,default:no');
  });
  test('maps all copied audio output ordinals and the selected WebVTT output', () => {
    expect(
      new HlsVariantStreamMap({
        videoOutputIndexes: [0],
        audioOutputIndexes: [0, 1],
        subtitleOutputIndex: 0,
        group: 'subs',
        language: 'eng',
        default: false,
      }).toString(),
    ).toBe('v:0,a:0,a:1,s:0,sgroup:subs,default:no,language:eng');
  });

  test('uses supplied output ordinals without treating them as input selectors', () => {
    expect(
      new HlsVariantStreamMap({
        videoOutputIndexes: [1, 2],
        audioOutputIndexes: [],
        subtitleOutputIndex: 3,
        group: 'subs',
        default: true,
      }).toString(),
    ).toBe('v:1,v:2,s:3,sgroup:subs,default:yes');
  });

  test.each(['', 'English SDH', 'en,default:yes', 'en"', 'en\n'])(
    'rejects a token that cannot be represented by the FFmpeg grammar: %j',
    (language) => {
      expect(() =>
        new HlsVariantStreamMap({
          videoOutputIndexes: [0],
          audioOutputIndexes: [0],
          subtitleOutputIndex: 0,
          group: 'subs',
          language,
          default: false,
        }).toString(),
      ).toThrow('Invalid HLS variant mapping token');
    },
  );

  test.each([[-1], [0.5], [0, 0], [Number.NaN]])(
    'rejects invalid output ordinals: %j',
    (...videoOutputIndexes) => {
      expect(() =>
        new HlsVariantStreamMap({
          videoOutputIndexes,
          audioOutputIndexes: [0],
          subtitleOutputIndex: 0,
          group: 'subs',
          default: false,
        }).toString(),
      ).toThrow('Invalid or repeated HLS v output ordinal');
    },
  );
});
