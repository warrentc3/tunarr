import { HlsDirectSubtitleOutputFormat } from './HlsDirectSubtitleOutputFormat.ts';

describe('HlsDirectSubtitleOutputFormat', () => {
  const renditions = [
    { id: 'eng', language: 'eng', default: true, subtitleOutputIndex: 0 },
    {
      id: 'eng-forced',
      language: 'eng',
      default: false,
      subtitleOutputIndex: 1,
    },
  ];

  test('publishes one AV child and uses identical segment options for each native subtitle child', () => {
    const args = new HlsDirectSubtitleOutputFormat(
      '/streams/stream.m3u8',
      '/streams/data%06d.ts',
      '/stream/channels/test/',
      true,
      renditions,
      false,
      false,
      'linux',
    ).options();
    expect(args.slice(0, 5)).toEqual([
      '-copyts',
      '-max_interleave_delta',
      '1000000',
      '-f',
      'tee',
    ]);
    const children = args[5].split('|');
    expect(children).toHaveLength(3);
    expect(children[0]).toContain("select='0,1'");
    expect(children[0]).toContain("onfail='abort'");
    expect(children[0]).toContain("master_pl_name='playlist.m3u8'");
    expect(children[0]).not.toContain('var_stream_map');
    expect(children[0]).toContain('append_list');
    expect(children[0]).not.toContain('start_number');
    expect(children[1]).toContain("select='0,1,2'");
    expect(children[2]).toContain("select='0,1,3'");
    for (const child of children) {
      expect(child).not.toContain('program_date_time');
      expect(child).toContain(
        'independent_segments+append_list+omit_endlist+discont_start',
      );
      expect(child).toContain(
        "hls_segment_options='mpegts_flags=+initial_discontinuity'",
      );
      expect(child).not.toMatch(
        /avoid_negative_ts|delete_segments|temp_file|second_level/u,
      );
      expect(child).toContain("hls_list_size='20'");
      expect(child).toContain("max_interleave_delta='1'");
      expect(child).not.toContain('start_number');
    }
    for (const child of children.slice(1)) {
      expect(child).toContain("onfail='ignore'");
      expect(child).toContain('append_list');
      expect(child).toContain("hls_segment_filename='/dev/null'");
      expect(child).toContain("strftime='1'");
      expect(child).not.toContain('master_pl_name');
    }
    expect(children[1]).toContain(
      "hls_subtitle_path='/streams/subtitle_eng.m3u8'",
    );
    expect(children[1]).toContain(
      "var_stream_map='v\\:0,a\\:0,s\\:0,sgroup\\:subs,default\\:yes,language\\:eng'",
    );
  });

  test('supports video without audio and preserves finite/first-program flags', () => {
    const args = new HlsDirectSubtitleOutputFormat(
      '/streams/stream.m3u8',
      '/streams/data%06d.ts',
      '/stream/',
      false,
      renditions.slice(0, 1),
      true,
      true,
      'linux',
    ).options();
    expect(args[5]).toContain("select='0'");
    expect(args[5]).toContain("select='0,1'");
    expect(args[5]).not.toContain('a\\:0');
    expect(args[5]).not.toContain('program_date_time');
    expect(args[5]).not.toMatch(
      /omit_endlist|discont_start|initial_discontinuity/u,
    );
  });

  test('escapes the Windows null device and output paths for both tee parsers', () => {
    const args = new HlsDirectSubtitleOutputFormat(
      String.raw`C:\channel files\stream.m3u8`,
      String.raw`C:\channel files\data%06d.ts`,
      '/stream/',
      true,
      renditions.slice(0, 1),
      true,
      false,
      'win32',
    ).options();
    expect(args[5]).toContain(String.raw`hls_segment_filename='\\\\.\\nul'`);
    expect(args[5]).toContain(
      String.raw`hls_subtitle_path='C\:\\channel files\\subtitle_eng.m3u8'`,
    );
  });

  test.each(['../eng', 'eng/sdh', 'eng:sdh', '', 'eng|sdh'])(
    'rejects unsafe rendition filename %s',
    (id) => {
      expect(() =>
        new HlsDirectSubtitleOutputFormat(
          '/streams/stream.m3u8',
          '/streams/data%06d.ts',
          '/stream/',
          true,
          [{ id, default: false, subtitleOutputIndex: 0 }],
          true,
          false,
          'linux',
        ).options(),
      ).toThrow('filename-safe');
    },
  );
});
