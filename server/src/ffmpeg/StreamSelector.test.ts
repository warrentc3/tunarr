import type { StreamSelectionRule } from '@tunarr/types/schemas';
import type { NonEmptyArray } from 'ts-essentials';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import { CelEvaluationService } from '../services/CelEvaluationService.ts';
import type { StreamSelectionProfileResolver } from '../services/StreamSelectionProfileResolver.ts';
import type {
  AudioStreamDetails,
  SubtitleStreamDetails,
} from '../stream/types.ts';
import { StreamSelector } from './StreamSelector.ts';
import { SubtitleStreamPicker } from './SubtitleStreamPicker.ts';

vi.mock('./SubtitleStreamPicker.ts', () => ({
  SubtitleStreamPicker: {
    getSubtitleDetailsWithExtractedPath: vi.fn(
      (_lineup: ContentBackedStreamLineupItem, stream: SubtitleStreamDetails) =>
        Promise.resolve({ ...stream, path: '/subtitles/extracted.srt' }),
    ),
  },
}));

function request() {
  const audioStreams: NonEmptyArray<AudioStreamDetails> = [
    { index: 1, codec: 'aac', languageCodeISO6392: 'eng', default: true },
    { index: 7, codec: 'aac', languageCodeISO6392: 'jpn', selected: true },
  ];
  const subtitleStreams: SubtitleStreamDetails[] = [
    {
      index: 8,
      codec: 'subrip',
      languageCodeISO6392: 'eng',
      type: 'embedded',
      default: true,
      forced: false,
      sdh: false,
    },
  ];
  return {
    channel: { uuid: 'channel-id', name: 'Channel', number: 1 } as ChannelOrm,
    lineupItem: {
      type: 'program',
      customShowId: 'custom-show-id',
      program: { uuid: 'program-id', title: 'Program', type: 'movie' },
    } as ContentBackedStreamLineupItem,
    audioStreams,
    subtitleStreams,
  };
}

function selector(rules: StreamSelectionRule[]) {
  const resolve = vi.fn().mockResolvedValue({
    uuid: 'profile-id',
    name: 'Profile',
    rules,
  });
  return {
    resolve,
    selector: new StreamSelector(
      { resolve } as unknown as StreamSelectionProfileResolver,
      new CelEvaluationService(),
    ),
  };
}

describe('StreamSelector audio-only selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the full subtitle CEL context without resolving or extracting subtitles', async () => {
    const input = request();
    const { selector: sut, resolve } = selector([
      {
        condition: 'false',
        audioAction: { type: 'by_language', languages: ['eng'] },
        subtitleAction: { type: 'default' },
      },
      {
        condition: '"eng" in subtitle.languages',
        audioAction: { type: 'by_language', languages: ['jpn'] },
        subtitleAction: { type: 'default' },
      },
      {
        condition: 'true',
        audioAction: { type: 'by_language', languages: ['eng'] },
        subtitleAction: { type: 'default' },
      },
    ]);

    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[1]);
    expect(resolve).toHaveBeenCalledWith({
      channelId: 'channel-id',
      programId: 'program-id',
      customShowId: 'custom-show-id',
      fillerListId: undefined,
    });
    expect(
      SubtitleStreamPicker.getSubtitleDetailsWithExtractedPath,
    ).not.toHaveBeenCalled();

    // Positive control: the same rule still resolves subtitles for existing callers.
    const combined = await sut.selectAudioAndSubtitleStreams(input);
    expect(combined.audioStream).toBe(input.audioStreams[1]);
    expect(combined.subtitleStream?.path).toBe('/subtitles/extracted.srt');
    expect(
      SubtitleStreamPicker.getSubtitleDetailsWithExtractedPath,
    ).toHaveBeenCalledOnce();
  });

  it('retains selected-before-default fallback when a matched language action finds no match', async () => {
    const input = request();
    const { selector: sut } = selector([
      {
        condition: 'true',
        audioAction: { type: 'by_language', languages: ['fra'] },
        subtitleAction: { type: 'default' },
      },
    ]);
    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[1]);
    const selected = input.audioStreams[1];
    if (selected === undefined) throw new Error('Fixture needs a second audio');
    selected.selected = false;
    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[0]);
  });

  it('falls back to the selected, then default, audio when no rule matches', async () => {
    const input = request();
    const { selector: sut } = selector([
      {
        condition: 'false',
        audioAction: { type: 'default' },
        subtitleAction: { type: 'default' },
      },
    ]);
    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[1]);
    const selected = input.audioStreams[1];
    if (selected === undefined) throw new Error('Fixture needs a second audio');
    selected.selected = false;
    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[0]);
  });

  it('does not map a commentary track first when no rule matches', async () => {
    const input = request();
    input.audioStreams = [
      {
        index: 1,
        codec: 'aac',
        languageCodeISO6392: 'eng',
        title: 'Commentary',
      },
      { index: 2, codec: 'aac', languageCodeISO6392: 'eng', default: true },
    ];
    const { selector: sut } = selector([
      {
        condition: 'program.type == "episode"',
        audioAction: { type: 'default' },
        subtitleAction: { type: 'default' },
      },
    ]);
    expect(await sut.selectAudioStream(input)).toBe(input.audioStreams[1]);
  });
});
