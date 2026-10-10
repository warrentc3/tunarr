import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { FileStreamSource, HttpStreamSource } from '../../../stream/types.ts';
import { EmptyFfmpegCapabilities } from '../capabilities/FfmpegCapabilities.ts';
import {
  defaultHlsOptions,
  HlsDirectOutputFormat,
  HlsOutputFormat,
} from '../constants.ts';
import { AudioVolumeFilter } from '../filter/AudioVolumeFilter.ts';
import { LoudnormFilter } from '../filter/LoudnormFilter.ts';
import { PixelFormatYuv420P } from '../format/PixelFormat.ts';
import { AudioInputSource } from '../input/AudioInputSource.ts';
import { SubtitlesInputSource } from '../input/SubtitlesInputSource.ts';
import { EmptyWebVttInputSource } from '../input/EmptyWebVttInputSource.ts';
import { VideoInputSource } from '../input/VideoInputSource.ts';
import {
  AudioStream,
  EmbeddedSubtitleStream,
  ExternalSubtitleStream,
  SubtitleMethods,
  VideoStream,
} from '../MediaStream.ts';
import { AudioState } from '../state/AudioState.ts';
import { DefaultPipelineOptions, FfmpegState } from '../state/FfmpegState.ts';
import { FrameState } from '../state/FrameState.ts';
import { FrameSize } from '../types.ts';
import { BasePipelineBuilder } from './BasePipelineBuilder.ts';

dayjs.extend(duration);

class NoopPipelineBuilder extends BasePipelineBuilder {
  protected setupVideoFilters(): void {}
}

describe('BasePipelineBuilder', () => {
  const audio = AudioInputSource.withStream(
    new FileStreamSource('/path/to/song.flac'),
    AudioStream.create({
      channels: 2,
      codec: 'flac',
      index: 0,
    }),
    AudioState.create({
      audioBitrate: 192,
      audioBufferSize: 192 * 2,
      audioChannels: 2,
      audioVolume: 150,
    }),
  );

  const video = VideoInputSource.withStream(
    new FileStreamSource('/path/to/video.mkv'),
    VideoStream.create({
      codec: 'h264',
      displayAspectRatio: '16:9',
      frameSize: FrameSize.withDimensions(1920, 900),
      index: 0,
      pixelFormat: new PixelFormatYuv420P(),
      providedSampleAspectRatio: null,
    }),
  );

  const state = FfmpegState.create({
    version: {
      versionString: 'n7.0.2-15-g0458a86656-20240904',
      majorVersion: 7,
      minorVersion: 0,
      patchVersion: 2,
      isUnknown: false,
    },
  });

  const frameState = new FrameState({
    isAnamorphic: false,
    paddedSize: FrameSize.FHD,
    scaledSize: FrameSize.FHD,
  });

  test('set audio volume filter', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioVolume: 150,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const volumeFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof AudioVolumeFilter,
    );

    expect(volumeFilter).toBeDefined();
    expect(volumeFilter?.filter).toEqual(`volume=1.500`);
  });

  test('ignore invalid audio volume filter', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioVolume: -100,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const volumeFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof AudioVolumeFilter,
    );

    expect(volumeFilter).toBeUndefined();
  });

  test('add loudnorm filter when loudnormConfig is set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-24:LRA=7:TP=-2,aresample=48000',
    );
  });

  test('add loudnorm filter with custom offset gain', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: { i: -16, lra: 11, tp: -1, offsetGain: 3 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-16:LRA=11:TP=-1:offset=3,aresample=48000',
    );
  });

  test('use custom sample rate in loudnorm filter when audioSampleRate is set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioSampleRate: 44.1,
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-24:LRA=7:TP=-2,aresample=44100',
    );
  });

  test('do not add loudnorm filter when audio encoder is copy', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioEncoder: 'copy',
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  test.each([
    { desc: 'i too low', config: { i: -70.1, lra: 7, tp: -2 } },
    { desc: 'i too high', config: { i: -4.9, lra: 7, tp: -2 } },
    { desc: 'lra too low', config: { i: -24, lra: 0.9, tp: -2 } },
    { desc: 'lra too high', config: { i: -24, lra: 50.1, tp: -2 } },
    { desc: 'tp too low', config: { i: -24, lra: 7, tp: -9.1 } },
    { desc: 'tp too high', config: { i: -24, lra: 7, tp: 0.1 } },
  ])('do not add loudnorm filter when $desc', ({ config }) => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: config,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  test.each([
    { desc: 'i at lower bound', config: { i: -70, lra: 7, tp: -2 } },
    { desc: 'i at upper bound', config: { i: -5, lra: 7, tp: -2 } },
    { desc: 'lra at lower bound', config: { i: -24, lra: 1, tp: -2 } },
    { desc: 'lra at upper bound', config: { i: -24, lra: 50, tp: -2 } },
    { desc: 'tp at lower bound', config: { i: -24, lra: 7, tp: -9 } },
    { desc: 'tp at upper bound', config: { i: -24, lra: 7, tp: 0 } },
  ])('add loudnorm filter when $desc', ({ config }) => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: config,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
  });

  test('do not add loudnorm filter when loudnormConfig is not set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  test('always add channel count for Opus', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/movie.mkv'),
      AudioStream.create({
        channels: 6,
        codec: 'ac3',
        index: 0,
      }),
      AudioState.create({
        audioEncoder: 'libopus',
        audioChannels: 6,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);
    const commandArgs = result.getCommandArgs();
    const channelIdx = commandArgs?.indexOf('-ac');
    expect(channelIdx).toBeDefined();
    expect(commandArgs?.at(channelIdx + 1)).toBe('6');
  });

  // Fresh video/audio input sources per seek test: BasePipelineBuilder
  // mutates the input sources it's given (addOptions), so reusing the
  // describe-level `video`/`audio` here would leak `-ss` flags added by
  // one test's build() into another test's assertions.
  function makeVideo() {
    return VideoInputSource.withStream(
      new FileStreamSource('/path/to/video.mkv'),
      VideoStream.create({
        codec: 'h264',
        displayAspectRatio: '16:9',
        frameSize: FrameSize.withDimensions(1920, 900),
        index: 0,
        pixelFormat: new PixelFormatYuv420P(),
        providedSampleAspectRatio: null,
      }),
    );
  }

  function makeAudio() {
    return AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioVolume: 150,
      }),
    );
  }

  test('apply the stream seek offset to an external sidecar subtitle input on the hls (transcode) output', () => {
    const seekState = FfmpegState.create({
      version: state.version,
      start: dayjs.duration(90_000),
      outputFormat: HlsOutputFormat(defaultHlsOptions),
    });

    const subtitle = new SubtitlesInputSource(
      new FileStreamSource('/path/to/movie.srt'),
      [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
      SubtitleMethods.Convert,
    );

    const pipeline = new NoopPipelineBuilder(
      makeVideo(),
      makeAudio(),
      null,
      subtitle,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(
      seekState,
      frameState,
      DefaultPipelineOptions,
    );
    const commandArgs = result.getCommandArgs();

    const subtitleInputIdx = commandArgs.indexOf('/path/to/movie.srt');
    expect(subtitleInputIdx).toBeGreaterThan(0);
    expect(commandArgs[subtitleInputIdx - 1]).toBe('-i');
    expect(commandArgs[subtitleInputIdx - 2]).toBe('90000ms');
    expect(commandArgs[subtitleInputIdx - 3]).toBe('-ss');
    expect(commandArgs[subtitleInputIdx - 4]).toBe('1');
    expect(commandArgs[subtitleInputIdx - 5]).toBe('-seek_timestamp');
  });

  test('do not seek the external sidecar subtitle input on the hls_direct_v2 output', () => {
    const seekState = FfmpegState.create({
      version: state.version,
      start: dayjs.duration(90_000),
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });

    const subtitle = new SubtitlesInputSource(
      new FileStreamSource('/path/to/movie.srt'),
      [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
      SubtitleMethods.Convert,
    );

    const pipeline = new NoopPipelineBuilder(
      makeVideo(),
      makeAudio(),
      null,
      subtitle,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(
      seekState,
      frameState,
      DefaultPipelineOptions,
    );
    const commandArgs = result.getCommandArgs();

    expect(commandArgs[commandArgs.indexOf('-segment_format') + 1]).toBe(
      'webvtt',
    );

    const subtitleInputIdx = commandArgs.indexOf('/path/to/movie.srt');
    expect(subtitleInputIdx).toBeGreaterThan(0);
    expect(commandArgs[subtitleInputIdx - 1]).toBe('-i');
    expect(commandArgs).not.toContain('-seek_timestamp');
    expect(commandArgs[subtitleInputIdx - 2]).not.toBe('-ss');

    // video/audio are still seeked (subtitle is not, so only 2 -ss flags)
    const seekCount = commandArgs.filter((arg) => arg === '-ss').length;
    expect(seekCount).toBe(2);
  });

  test.each([0, 90])(
    'carries one Direct v2 AV and subtitle clock from a %s-second input seek',
    (seekSeconds) => {
      const copyState = FfmpegState.create({
        version: state.version,
        start: dayjs.duration(seekSeconds, 'seconds'),
        ptsOffset: 150 * 90000,
        hlsDirectStreamCopy: { audioInputIndex: 19 },
        hlsDirectSubtitles: [
          {
            id: 'eng',
            language: 'eng',
            default: false,
            subtitleOutputIndex: 0,
          },
        ],
        outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
      });
      const args = new NoopPipelineBuilder(
        makeVideo(),
        null,
        null,
        null,
        null,
        EmptyFfmpegCapabilities,
      )
        .setAdditionalSubtitleInputSources([new EmptyWebVttInputSource()])
        .build(
          copyState,
          new FrameState({
            ...frameState,
            videoFormat: 'copy',
            videoTrackTimescale: 90000,
          }),
          DefaultPipelineOptions,
        )
        .getCommandArgs();
      expect(args.filter((arg) => arg === '-output_ts_offset')).toHaveLength(1);
      expect(args[args.indexOf('-output_ts_offset') + 1]).toBe(
        String(150 - seekSeconds),
      );
      expect(args.indexOf('-output_ts_offset')).toBeLessThan(
        args.indexOf('tee'),
      );
      expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
      expect(args.at(-1)).toContain("select='0,1,2'");
    },
  );

  test('keeps the source timeline when the channel clock is shorter than the input seek', () => {
    const copyState = FfmpegState.create({
      version: state.version,
      start: dayjs.duration(90, 'seconds'),
      ptsOffset: 5 * 90000,
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const args = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    )
      .build(
        copyState,
        new FrameState({
          ...frameState,
          videoFormat: 'copy',
          videoTrackTimescale: 90000,
        }),
        DefaultPipelineOptions,
      )
      .getCommandArgs();
    // A negative offset would push the first copied packets below zero and
    // hlsenc's inner mpegts muxer would shift the TS timeline on its own.
    expect(args).not.toContain('-output_ts_offset');
    expect(args).toContain('-copyts');
  });

  test('Direct v2 retains selected AV mapping when using separate subtitle output', () => {
    const copyState = FfmpegState.create({
      version: state.version,
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const subtitle = new SubtitlesInputSource(
      new FileStreamSource('/path/to/movie.srt'),
      [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
      SubtitleMethods.Convert,
    );
    const builder = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      subtitle,
      null,
      EmptyFfmpegCapabilities,
    );
    const args = builder
      .build(copyState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    expect(args).not.toContain('0:d?');
    expect(args).toContain('0:V:0');
    expect(args).toContain('0:19');
    expect(args).not.toContain('0:a?');
    expect(args).not.toContain('0:v');
    expect(args).not.toContain('-var_stream_map');
    expect(args[args.indexOf('-segment_format') + 1]).toBe('webvtt');
    expect(args.indexOf('-segment_format')).toBeGreaterThan(
      args.indexOf('hls'),
    );
  });

  test('Direct selectable sidecars map once alongside the selected AV and its codec override', () => {
    const copyState = FfmpegState.create({
      version: state.version,
      start: dayjs.duration(90_000),
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      audioCodecOverrides: [{ outputIndex: 0, codec: 'ac3' }],
      hlsDirectSubtitles: [
        {
          id: 'english',
          language: 'eng',
          default: false,
          subtitleOutputIndex: 0,
        },
        {
          id: 'forced',
          language: 'eng',
          default: false,
          subtitleOutputIndex: 1,
        },
      ],
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const subtitles = ['ordinary', 'forced'].map(
      (name) =>
        new SubtitlesInputSource(
          new FileStreamSource(`/path/to/${name}.srt`),
          [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
          SubtitleMethods.Convert,
        ),
    );
    const builder = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    ).setAdditionalSubtitleInputSources(subtitles);
    const args = builder
      .build(copyState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    const maps = args.flatMap((arg, index) =>
      arg === '-map' ? [args[index + 1]] : [],
    );
    expect(maps).toEqual(['0:V:0', '0:19', '1:0', '2:0']);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3);
    expect(args.filter((arg) => arg === '-ss')).toHaveLength(1);
    expect(
      args.slice(args.indexOf('-c:a:0'), args.indexOf('-c:a:0') + 2),
    ).toEqual(['-c:a:0', 'ac3']);
    expect(args.slice(args.indexOf('-c:s'), args.indexOf('-c:s') + 2)).toEqual([
      '-c:s',
      'webvtt',
    ]);
    expect(args).toContain('tee');
    expect(args).not.toContain('-segment_format');
    expect(args[args.indexOf('-bsf:s') + 1]).toBe(
      "noise=amount=0:drop='lte((pts+duration)*tb,90)',setts=pts='max(PTS,90/TB)':dts='max(DTS,90/TB)':duration='max(0,PTS+DURATION-max(PTS,90/TB))'",
    );
  });

  test('Direct embedded text reuses the HTTP video input and its headers alongside local sidecars', () => {
    const source = new HttpStreamSource('http://media.test/program.mkv', {
      'X-Media-Test': 'header-preserved',
    });
    const video = makeVideo();
    const httpVideo = VideoInputSource.withStream(source, video.streams[0]);
    const subtitles = [
      new SubtitlesInputSource(
        source,
        [new EmbeddedSubtitleStream('subrip', 5, SubtitleMethods.Convert)],
        SubtitleMethods.Convert,
      ),
      new SubtitlesInputSource(
        new FileStreamSource('/path/to/ordinary.srt'),
        [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
        SubtitleMethods.Convert,
      ),
      new SubtitlesInputSource(
        source,
        [new EmbeddedSubtitleStream('ass', 8, SubtitleMethods.Convert)],
        SubtitleMethods.Convert,
      ),
    ];
    const copyState = FfmpegState.create({
      version: state.version,
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      hlsDirectSubtitles: subtitles.map((_, index) => ({
        id: `track${index}`,
        default: false,
        subtitleOutputIndex: index,
      })),
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const args = new NoopPipelineBuilder(
      httpVideo,
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    )
      .setAdditionalSubtitleInputSources(subtitles)
      .build(copyState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    expect(
      args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : [])),
    ).toEqual(['0:V:0', '0:19', '0:5', '1:0', '0:8']);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2);
    expect(args.filter((arg) => arg === source.path)).toHaveLength(1);
    expect(args.filter((arg) => arg === '-headers')).toHaveLength(1);
    expect(args[args.indexOf('-headers') + 1]).toContain(
      'X-Media-Test: header-preserved',
    );
    expect(args).not.toContain('-bsf:s');
  });

  test('fixed slots reuse a mapped subtitle for regular and SDH, with a shared empty source', () => {
    const sidecar = new SubtitlesInputSource(
      new FileStreamSource('/path/to/ordinary.srt'),
      [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
      SubtitleMethods.Convert,
    );
    const copyState = FfmpegState.create({
      version: state.version,
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      hlsDirectSubtitles: [
        { id: 'eng-regular', default: false, subtitleOutputIndex: 0 },
        { id: 'eng-sdh', default: false, subtitleOutputIndex: 0 },
        { id: 'eng-forced', default: false, subtitleOutputIndex: 1 },
      ],
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const args = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    )
      .setAdditionalSubtitleInputSources([
        sidecar,
        new EmptyWebVttInputSource(),
      ])
      .build(copyState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    expect(
      args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : [])),
    ).toEqual(['0:V:0', '0:19', '1:0', '2:0']);
    const children = args.at(-1)!.split('|');
    expect(children).toHaveLength(4);
    expect(children[1]).toContain("select='0,1,2'");
    expect(children[2]).toContain("select='0,1,2'");
    expect(children[3]).toContain("select='0,1,3'");
  });

  test('encoded fallback uses the separate audio input before one shared empty subtitle input', () => {
    const fallbackState = FfmpegState.create({
      version: state.version,
      hlsDirectSubtitles: ['regular', 'sdh', 'forced'].map((role) => ({
        id: `eng-${role}`,
        default: false,
        subtitleOutputIndex: 0,
      })),
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const args = new NoopPipelineBuilder(
      makeVideo(),
      makeAudio(),
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    )
      .setAdditionalSubtitleInputSources([new EmptyWebVttInputSource()])
      .build(fallbackState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    expect(
      args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : [])),
    ).toEqual(['0:0', '[a]', '2:0']);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3);
    const children = args.at(-1)!.split('|');
    expect(children).toHaveLength(4);
    for (const child of children.slice(1))
      expect(child).toContain("select='0,1,2'");
  });

  test('carries a complete bits-per-second hint without encoding limits for Direct v2', () => {
    const copyState = FfmpegState.create({
      version: state.version,
      hlsDirectStreamCopy: { audioInputIndex: 19 },
      hlsDirectBitrate: 1_234_567,
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
    });
    const builder = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );
    const args = builder
      .build(copyState, frameState, DefaultPipelineOptions)
      .getCommandArgs();
    expect(args[args.indexOf('-b:v') + 1]).toBe('1234567');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).not.toContain('-maxrate:v');
    expect(args).not.toContain('-b:a');
    expect(args).toContain('0:V:0');
    expect(args).toContain('0:19');
  });

  test.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not emit an invalid copy-mode hint: %s',
    (hlsDirectBitrate) => {
      const builder = new NoopPipelineBuilder(
        makeVideo(),
        null,
        null,
        null,
        null,
        EmptyFfmpegCapabilities,
      );
      const args = builder
        .build(
          FfmpegState.create({
            version: state.version,
            hlsDirectStreamCopy: { audioInputIndex: 1 },
            hlsDirectBitrate,
            outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
          }),
          frameState,
          DefaultPipelineOptions,
        )
        .getCommandArgs();
      expect(args).not.toContain('-b:v');
    },
  );

  test('does not add the Direct v2 hint to a shared remux output', () => {
    const builder = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );
    const args = builder
      .build(
        FfmpegState.create({
          version: state.version,
          copyAllStreams: true,
          hlsDirectBitrate: 1_234_567,
          outputFormat: { type: 'mpegts' },
        }),
        frameState,
        DefaultPipelineOptions,
      )
      .getCommandArgs();
    expect(args).not.toContain('-b:v');
    expect(args).toContain('0:a?');
    expect(args).toContain('0:V');
  });

  test('Direct v2 maps the selected input once and applies its audio override at a:0', () => {
    const builder = new NoopPipelineBuilder(
      makeVideo(),
      null,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );
    const args = builder
      .build(
        FfmpegState.create({
          version: state.version,
          hlsDirectStreamCopy: { audioInputIndex: 3 },
          audioCodecOverrides: [{ outputIndex: 0, codec: 'ac3' }],
          outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
        }),
        frameState,
        DefaultPipelineOptions,
      )
      .getCommandArgs();
    expect(
      args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : [])),
    ).toEqual(['0:V:0', '0:3']);
    expect(args[args.indexOf('-c:a:0') + 1]).toBe('ac3');
    expect(args).not.toContain('-c:a:3');
    expect(args).not.toContain('-ac');
    expect(args).not.toContain('-ar');
  });
});
