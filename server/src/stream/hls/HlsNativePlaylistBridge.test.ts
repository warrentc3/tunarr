import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HlsNativePlaylistBridge } from './HlsNativePlaylistBridge.ts';

const slots = ['regular', 'sdh', 'forced'].map(
  (kind) => `subtitle_eng_${kind}.m3u8`,
);
const fixture = (name: string, run: number) =>
  fs
    .readFileSync(
      new URL(
        `./fixtures/ffmpeg7-native-hls/${name}.run${run}.txt`,
        import.meta.url,
      ),
      'utf8',
    )
    .split('\n');
const entries = (lines: readonly string[]) =>
  lines.filter((line) => line.startsWith('#EXTINF:'));
const uris = (lines: readonly string[]) =>
  lines.filter((line) => line.trim().length > 0 && !line.startsWith('#'));
const boundaries = (lines: readonly string[]) => {
  let sequence = Number(
    lines
      .find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
      ?.split(':')[1] ?? 0,
  );
  const result: number[] = [];
  for (const line of lines) {
    if (line.trim() === '#EXT-X-DISCONTINUITY') result.push(sequence);
    if (line.startsWith('#EXTINF:')) sequence++;
  }
  return result;
};

describe('HlsNativePlaylistBridge', () => {
  test('preserves the producer boundary after restarting an already-rolled native window', () => {
    const slot = 'subtitle_eng_regular.m3u8';
    const bridge = new HlsNativePlaylistBridge([slot]);
    const outgoing = fixture('rolled-stream.m3u8', 0);
    bridge.repairVideo(outgoing);
    bridge.repairSubtitles(slot, fixture(`rolled-${slot}`, 0));
    expect(bridge.nextSequence(outgoing)).toBe(25);
    bridge.beginProgram(25);
    const incoming = fixture('rolled-stream.m3u8', 1);
    const video = bridge.repairVideo(incoming);
    const rawSubtitles = fixture(`rolled-${slot}`, 1);
    const subtitles = bridge.repairSubtitles(slot, rawSubtitles);
    expect(entries(video)).toEqual(entries(incoming));
    expect(uris(video)).toEqual(uris(incoming));
    expect(entries(subtitles)).toEqual(entries(rawSubtitles));
    expect(boundaries(video)).toEqual([25]);
    expect(boundaries(subtitles)).toEqual([25]);
    expect(uris(subtitles).map((uri) => uri.trim())).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `/stream/subtitle_eng_regular_av_${15 + index}.vtt`,
      ),
    );
  });

  test('repairs captured populated, empty and returned FFmpeg 7 output without changing its windows or durations', () => {
    const bridge = new HlsNativePlaylistBridge(slots);
    for (let run = 0; run < 3; run++) {
      const rawVideo = fixture('stream.m3u8', run);
      const video = bridge.repairVideo(rawVideo);
      expect(entries(video)).toEqual(entries(rawVideo));
      expect(uris(video)).toEqual(uris(rawVideo));
      for (const slot of slots) {
        const rawSubtitles = fixture(slot, run);
        const subtitles = bridge.repairSubtitles(slot, rawSubtitles);
        expect(entries(subtitles)).toEqual(entries(rawSubtitles));
        expect(entries(subtitles)).toEqual(entries(video));
        expect(
          subtitles.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:')),
        ).toBe(
          rawSubtitles.find((line) =>
            line.startsWith('#EXT-X-MEDIA-SEQUENCE:'),
          ),
        );
        expect(boundaries(subtitles)).toEqual(boundaries(video));
        expect(
          subtitles.find((line) =>
            line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'),
          ),
        ).toBe(
          video.find((line) =>
            line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'),
          ),
        );
        expect(subtitles.join('\n')).not.toContain('#EXT-X-ENDLIST');
        expect(uris(subtitles).some((uri) => uri.trim().endsWith('/.'))).toBe(
          false,
        );
        const sequence = run === 2 ? 10 : 0;
        const prefix = slot.replace('.m3u8', '_av_');
        expect(uris(subtitles).map((uri) => uri.trim())).toEqual(
          Array.from(
            { length: run === 0 ? 10 : 20 },
            (_, index) => `/stream/${prefix}${sequence + index}.vtt`,
          ),
        );
      }
      bridge.beginProgram(bridge.nextSequence(rawVideo));
    }
  });

  test('inserts a known programme cut if the native subtitle and video writers omit it', () => {
    const bridge = new HlsNativePlaylistBridge(['subtitle.m3u8']);
    bridge.beginProgram(5);
    const raw = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:4',
      '#EXTINF:3.75,',
      'data4.ts',
      '#EXTINF:4.12,',
      'data5.ts',
    ];
    expect(bridge.repairVideo(raw)).toEqual([
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:4',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXTINF:3.75,',
      'data4.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.12,',
      'data5.ts',
    ]);
  });

  test('rejects lost URIs that have no outgoing snapshot instead of inventing an entry', () => {
    const bridge = new HlsNativePlaylistBridge(['subtitle.m3u8']);
    expect(() =>
      bridge.repairSubtitles('subtitle.m3u8', [
        '#EXTM3U',
        '#EXTINF:4,',
        '/stream/.',
      ]),
    ).toThrow('unknown URI');
  });
});
