import { describe, expect, test } from 'vitest';
import { HlsDirectOutputFormat } from './HlsDirectOutputFormat.ts';

function makeFormat(
  isFirstTranscode: boolean,
  playlistPath = '/some/path/stream.m3u8',
) {
  return new HlsDirectOutputFormat(
    playlistPath,
    '/some/path/data%06d.ts',
    '/stream/channels/test-uuid/hls/',
    isFirstTranscode,
  );
}

describe('HlsDirectOutputFormat', () => {
  test.each([true, false])(
    'does not date programme segments from the producer clock (first=%s)',
    (isFirst) => {
      const opts = makeFormat(isFirst).options();
      const flags = opts[opts.indexOf('-hls_flags') + 1].split('+');
      expect(flags).not.toContain('program_date_time');
      expect(flags).toContain('append_list');
      expect(flags.includes('discont_start')).toBe(!isFirst);
    },
  );

  test('keeps the no-subtitle output free of native subtitle mapping', () => {
    expect(makeFormat(true).options()).not.toContain('-var_stream_map');
  });

  test('emits FFmpeg 7 native subtitle mapping with the existing subtitle playlist URL', () => {
    const opts = new HlsDirectOutputFormat(
      '/some/path/stream.m3u8',
      '/some/path/data%06d.ts',
      '/stream/channels/test/hls_direct_v2/',
      true,
      false,
      {
        videoOutputIndexes: [0],
        audioOutputIndexes: [0, 1],
        subtitleOutputIndex: 0,
        group: 'subs',
        language: 'eng',
        default: false,
      },
    ).options();
    expect(opts[opts.indexOf('-hls_subtitle_path') + 1]).toBe(
      '/some/path/subs.m3u8',
    );
    expect(opts[opts.indexOf('-var_stream_map') + 1]).toBe(
      'v:0,a:0,a:1,s:0,sgroup:subs,default:no,language:eng',
    );
    expect(opts.join(' ')).not.toContain('sname:');
    expect(opts.at(-1)).toBe('/some/path/stream.m3u8');
  });
  test('includes -master_pl_name playlist.m3u8 for first transcode', () => {
    const opts = makeFormat(true).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('includes -master_pl_name playlist.m3u8 for subsequent transcodes', () => {
    const opts = makeFormat(false).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('-master_pl_name appears before the output path', () => {
    const playlistPath = '/some/path/stream.m3u8';
    const opts = makeFormat(true, playlistPath).options();
    const masterIdx = opts.indexOf('-master_pl_name');
    const outputIdx = opts.lastIndexOf(playlistPath);
    expect(masterIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeLessThan(outputIdx);
  });
});
