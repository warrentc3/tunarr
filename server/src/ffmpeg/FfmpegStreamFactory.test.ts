import type { ContentBackedStreamLineupItem } from '@/db/derived_types/StreamLineup.ts';
import type { IChannelDB } from '@/db/interfaces/IChannelDB.ts';
import type {
  ISettingsDB,
  ReadableFfmpegSettings,
} from '@/db/interfaces/ISettingsDB.ts';
import type { ChannelOrm } from '@/db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.ts';
import {
  AudioFormats,
  HlsDirectOutputFormat,
  HlsOutputFormat,
  MpegTsOutputFormat,
  VideoFormats,
  VideoPresets,
  defaultHlsOptions,
} from '@/ffmpeg/builder/constants.ts';
import type { PipelineBuilder } from '@/ffmpeg/builder/pipeline/PipelineBuilder.ts';
import type { OutputFormat } from '@/ffmpeg/builder/constants.ts';
import type { PipelineBuilderFactory } from '@/ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import { FrameState } from '@/ffmpeg/builder/state/FrameState.ts';
import { FfmpegState } from '@/ffmpeg/builder/state/FfmpegState.ts';
import type { FfmpegInfo, FfmpegVersionResult } from '@/ffmpeg/ffmpegInfo.ts';
import type { StreamSelector } from '@/ffmpeg/StreamSelector.ts';
import type { FeatureFlagService } from '@/services/FeatureFlagService.ts';
import type {
  AudioStreamDetails,
  StreamDetails,
  SubtitleStreamDetails,
  DirectSubtitleSlot,
} from '@/stream/types.ts';
import { FileStreamSource, HttpStreamSource } from '@/stream/types.ts';
import type { SubtitlesInputSource } from '@/ffmpeg/builder/input/SubtitlesInputSource.ts';
import { EmptyWebVttInputSource } from '@/ffmpeg/builder/input/EmptyWebVttInputSource.ts';
import type { VideoInputSource } from '@/ffmpeg/builder/input/VideoInputSource.ts';
import {
  StillImageStream,
  SubtitleMethods,
} from '@/ffmpeg/builder/MediaStream.ts';
import { InfiniteLoopInputOption } from '@/ffmpeg/builder/options/input/InfiniteLoopInputOption.ts';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectSubtitleRendition } from './DirectSubtitleRenditions.ts';
import { collectDirectSubtitleRenditions } from './DirectSubtitleRenditions.ts';
import { createDirectSubtitleSlots } from './DirectSubtitleSlots.ts';
import { FfmpegStreamFactory } from './FfmpegStreamFactory.ts';
import { resolveAudioAction } from './StreamSelectionEvaluator.ts';

vi.mock('@/util/serverUtil.ts', () => ({
  makeLocalUrl: (path: string) => `http://localhost:8000${path}`,
}));
vi.mock('./DirectSubtitleRenditions.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collectDirectSubtitleRenditions: vi.fn().mockResolvedValue([]),
}));

dayjs.extend(duration);

const mockFfmpegVersion: FfmpegVersionResult = {
  versionString: '7.0',
  majorVersion: 7,
  minorVersion: 0,
  patchVersion: 0,
  isUnknown: false,
};

function makeTranscodeConfig(
  overrides: Partial<TranscodeConfigOrm> = {},
): TranscodeConfigOrm {
  return {
    uuid: 'test-uuid',
    name: 'Test',
    threadCount: 0,
    hardwareAccelerationMode: 'none',
    vaapiDriver: 'system',
    vaapiDevice: null,
    resolution: { widthPx: 1920, heightPx: 1080 },
    videoFormat: 'h264',
    videoProfile: null,
    videoPreset: null,
    videoBitDepth: 8,
    videoBitRate: 2000,
    videoBufferSize: 4000,
    audioChannels: 2,
    audioFormat: 'aac',
    audioBitRate: 192,
    audioBufferSize: 384,
    audioSampleRate: 48,
    audioVolumePercent: 100,
    audioLoudnormConfig: null,
    normalizeFrameRate: false,
    deinterlaceVideo: true,
    disableChannelOverlay: false,
    errorScreen: 'pic',
    errorScreenAudio: 'silent',
    isDefault: true,
    disableHardwareDecoder: false,
    disableHardwareEncoding: false,
    disableHardwareFilters: false,
    ...overrides,
  } as TranscodeConfigOrm;
}

function makeChannel(overrides: Partial<ChannelOrm> = {}): ChannelOrm {
  return {
    uuid: 'channel-uuid',
    name: 'Test Channel',
    number: 1,
    streamMode: 'hls',
    subtitlesEnabled: false,
    offline: { mode: 'pic' },
    duration: 0,
    groupTitle: null,
    stealth: false,
    fillerCollections: [],
    fillerRepeatCooldownMs: 0,
    transcodeConfigId: null,
    icon: null,
    startTime: 0,
    ...overrides,
  } as ChannelOrm;
}

function makeFfmpegSettings(): ReadableFfmpegSettings {
  return {
    configVersion: 5,
    ffmpegExecutablePath: '/usr/bin/ffmpeg',
    ffprobeExecutablePath: '/usr/bin/ffprobe',
    enableLogging: false,
    enableFileLogging: false,
    logLevel: 'warning',
    languagePreferences: {
      preferences: [{ iso6391: 'en', iso6392: 'eng', displayName: 'English' }],
    },
    scalingAlgorithm: 'bicubic',
    deinterlaceFilter: 'none',
    hlsDirectOutputFormat: 'mpegts',
    enableSubtitleExtraction: false,
  } as ReadableFfmpegSettings;
}

function makeStreamDetails(): StreamDetails {
  return {
    duration: dayjs.duration({ seconds: 30 }),
    videoDetails: [
      {
        codec: 'h264',
        profile: 'Main',
        width: 1920,
        height: 1080,
        framerate: 24,
        pixelFormat: 'yuv420p',
        bitDepth: 8,
        streamIndex: 0,
        sampleAspectRatio: '1:1',
        displayAspectRatio: '16:9',
        anamorphic: false,
        bitrate: 5000,
        isAttachedPic: false,
        colorRange: null,
        colorSpace: null,
        colorTransfer: null,
        colorPrimaries: null,
      },
    ],
    audioDetails: [
      {
        codec: 'aac',
        channels: 2,
        index: 1,
      },
    ],
  };
}

function makeLineupItem(): ContentBackedStreamLineupItem {
  return {
    type: 'program',
    streamDuration: 30000,
    programBeginMs: 0,
    duration: 30000,
    infiniteLoop: false,
    program: {
      uuid: 'program-uuid',
      mediaSourceId: 'source-id',
      externalIds: [],
    },
  } as ContentBackedStreamLineupItem;
}

/**
 * Creates a mock PipelineBuilderFactory that intercepts PipelineBuilder.build()
 * to capture the FrameState for assertion.
 */
function createCapturingPipelineBuilderFactory(): {
  factory: PipelineBuilderFactory;
  getCapturedFrameState: () => FrameState | undefined;
  getCapturedFfmpegState: () => FfmpegState | undefined;
  getCapturedHwAccel: () => string | undefined;
  getCapturedSubtitleInput: () => SubtitlesInputSource | null | undefined;
  getCapturedVideoInput: () => VideoInputSource | undefined;
  getCapturedAdditionalSubtitleInputs: () => SubtitlesInputSource[];
} {
  let capturedFrameState: FrameState | undefined;
  let capturedFfmpegState: FfmpegState | undefined;
  let capturedHwAccel: string | undefined;
  let capturedSubtitleInput: SubtitlesInputSource | null | undefined;
  let capturedVideoInput: VideoInputSource | undefined;
  let capturedAdditionalSubtitleInputs: SubtitlesInputSource[] = [];

  const factory: PipelineBuilderFactory = () => {
    const builderProxy: Record<string, unknown> = {};
    for (const method of [
      'setAudioInputSource',
      'setWatermarkInputSource',
      'setConcatInputSource',
    ]) {
      builderProxy[method] = vi.fn().mockReturnValue(builderProxy);
    }

    builderProxy.setVideoInputSource = vi.fn((input: VideoInputSource) => {
      capturedVideoInput = input;
      return builderProxy;
    });

    builderProxy.setSubtitleInputSource = vi.fn(
      (input: SubtitlesInputSource | null) => {
        capturedSubtitleInput = input;
        return builderProxy;
      },
    );
    builderProxy.setAdditionalSubtitleInputSources = vi.fn(
      (inputs: SubtitlesInputSource[]) => {
        capturedAdditionalSubtitleInputs = inputs;
        return builderProxy;
      },
    );

    builderProxy.setHardwareAccelerationMode = vi.fn((mode: string) => {
      capturedHwAccel = mode;
      return builderProxy;
    });

    builderProxy.build = vi.fn().mockResolvedValue({
      build: (ffmpegState: FfmpegState, frameState: FrameState) => {
        capturedFfmpegState = ffmpegState;
        capturedFrameState = frameState;
        return {
          getCommandArgs: () => [],
          getCommandEnvironment: () => ({}),
          inputs: {},
          steps: [],
          setInputs: vi.fn(),
        };
      },
    } as unknown as PipelineBuilder);

    return builderProxy as ReturnType<PipelineBuilderFactory>;
  };

  return {
    factory,
    getCapturedFrameState: () => capturedFrameState,
    getCapturedFfmpegState: () => capturedFfmpegState,
    getCapturedHwAccel: () => capturedHwAccel,
    getCapturedSubtitleInput: () => capturedSubtitleInput,
    getCapturedVideoInput: () => capturedVideoInput,
    getCapturedAdditionalSubtitleInputs: () => capturedAdditionalSubtitleInputs,
  };
}

function makeMockFfmpegInfo(): FfmpegInfo {
  return {
    getVersion: vi.fn().mockResolvedValue(mockFfmpegVersion),
    probeStreamLayout: vi
      .fn()
      .mockResolvedValue({ videoCount: 1, audioCount: 1, hasData: false }),
  } as unknown as FfmpegInfo;
}

function makeMockSettingsDB(
  ffmpegSettings: ReadableFfmpegSettings,
): ISettingsDB {
  return {
    systemSettings: vi.fn().mockReturnValue({
      logging: { logsDirectory: null },
    }),
    ffmpegSettings: vi.fn().mockReturnValue(ffmpegSettings),
  } as unknown as ISettingsDB;
}

function makeMockChannelDB(): IChannelDB {
  return {
    getChannelSubtitlePreferences: vi.fn().mockResolvedValue([]),
  } as unknown as IChannelDB;
}

function makeMockFeatureFlagService(
  flags: Record<string, boolean> = {},
): FeatureFlagService {
  return {
    get: vi.fn((flag: string) => flags[flag] ?? false),
    getAll: vi.fn().mockReturnValue(flags),
  } as unknown as FeatureFlagService;
}

function makeMockStreamSelector(
  subtitleStream: SubtitleStreamDetails | null = null,
  audioStream?: AudioStreamDetails,
): StreamSelector {
  return {
    selectAudioStream: vi
      .fn()
      .mockImplementation(
        async (request: Parameters<StreamSelector['selectAudioStream']>[0]) =>
          audioStream ??
          resolveAudioAction(
            { type: 'by_language', languages: ['eng'] },
            request.audioStreams,
          ),
      ),
    selectAudioAndSubtitleStreams: vi.fn().mockImplementation(async () => ({
      audioStream: { index: 1, codec: 'aac', channels: 2 },
      subtitleStream,
    })),
  } as unknown as StreamSelector;
}

describe('FfmpegStreamFactory', () => {
  beforeEach(() => {
    vi.mocked(collectDirectSubtitleRenditions)
      .mockReset()
      .mockResolvedValue([]);
  });
  describe('videoPreset wiring into FrameState', () => {
    test('createStreamSession passes videoPreset=veryfast for software h264', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('createStreamSession passes videoPreset=veryfast for software hevc', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'hevc',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('createStreamSession does not set videoPreset for hardware-accelerated encoding', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'cuda',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (error) wires videoPreset into FrameState', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
        errorScreen: 'testsrc',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'error',
        title: 'Test Error',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
        realtime: true,
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      // calculateForErrorStream doesn't compute a videoPreset, so it should be null
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (offline) wires videoPreset into FrameState', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'offline',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      // calculateForErrorStream (used by offline) doesn't set videoPreset
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (offline) applies software deinterlace + scaling filters', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFfmpegState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = {
        ...makeFfmpegSettings(),
        deinterlaceFilter: 'yadif=0',
        scalingAlgorithm: 'lanczos',
      };
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'offline',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
      });

      const ffmpegState = getCapturedFfmpegState();
      expect(ffmpegState).toBeDefined();
      // Mirrors the error session: reuse the configured ffmpegSettings,
      // not the FfmpegState class defaults.
      expect(ffmpegState!.softwareDeinterlaceFilter).toBe('yadif=0');
      expect(ffmpegState!.softwareScalingAlgorithm).toBe('lanczos');
    });
  });

  describe('passthrough mode (HlsDirectV2 / remux)', () => {
    const hlsDirectV2Format = HlsDirectOutputFormat(defaultHlsOptions);

    function createPassthroughSut(
      configOverrides: Partial<TranscodeConfigOrm> = {},
      streamDetails?: StreamDetails,
      selectedAudio?: AudioStreamDetails,
    ) {
      const config = makeTranscodeConfig(configOverrides);
      const capturing = createCapturingPipelineBuilderFactory();

      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        capturing.factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(null, selectedAudio),
        config,
        makeChannel(),
      );

      return {
        sut,
        ...capturing,
        streamDetails: streamDetails ?? makeStreamDetails(),
      };
    }

    test('HlsDirectV2 does not crash (playbackParams is null)', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedFrameState()).toBeDefined();
    });

    test('remux mode does not crash (playbackParams is null)', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
          encoding: { mode: 'remux' },
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedFrameState()).toBeDefined();
    });

    test('HlsDirectV2 sets passthrough defaults in FrameState', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState()!;
      expect(frameState.videoFormat).toBe(VideoFormats.Copy);
      // videoPreset falls back to DefaultFrameState (null) because lodash
      // merge skips the undefined value passed in passthrough mode.
      expect(frameState.videoPreset).toBeNull();
      expect(frameState.deinterlace).toBe(false);
      expect(frameState.videoBitrate).toBeNull();
      expect(frameState.videoBufferSize).toBeNull();
      expect(frameState.frameRate).toBeNull();
      expect(frameState.videoTrackTimescale).toBe(90000);
    });

    test('passthrough forces hardware acceleration to none', async () => {
      const { sut, getCapturedHwAccel, streamDetails } = createPassthroughSut({
        hardwareAccelerationMode: 'cuda',
      });

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedHwAccel()).toBe('none');
    });

    test('Direct v2 uses selected stream copy and zeroes threadCount in FfmpegState', async () => {
      const { sut, getCapturedFfmpegState, streamDetails } =
        createPassthroughSut({ threadCount: 4 });

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const ffmpegState = getCapturedFfmpegState()!;
      expect(ffmpegState.copyAllStreams).toBe(false);
      expect(ffmpegState.hlsDirectStreamCopy).toEqual({ audioInputIndex: 1 });
      expect(ffmpegState.threadCount).toBe(0);
      expect(ffmpegState.vaapiDevice).toBeNull();
      expect(ffmpegState.vaapiDriver).toBeNull();
      // lodash merge skips undefined, so FfmpegState class defaults are kept.
      expect(ffmpegState.softwareDeinterlaceFilter).toBe('yadif=1');
      expect(ffmpegState.softwareScalingAlgorithm).toBe('fast_bilinear');
    });

    test('explicit remux retains all-audio codec override ordinals', async () => {
      const details = makeStreamDetails();
      details.audioDetails = [
        { codec: AudioFormats.Aac, channels: 2, index: 1 },
        { codec: AudioFormats.Dca, channels: 6, index: 2 },
        { codec: AudioFormats.TrueHd, channels: 8, index: 3 },
      ];

      const { sut, getCapturedFfmpegState } = createPassthroughSut({}, details);

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          encoding: { mode: 'remux' },
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const ffmpegState = getCapturedFfmpegState()!;
      expect(ffmpegState.audioCodecOverrides).toEqual([
        { outputIndex: 1, codec: AudioFormats.Ac3 },
        { outputIndex: 2, codec: AudioFormats.Ac3 },
      ]);
      expect(ffmpegState.copyAllStreams).toBe(true);
      expect(ffmpegState.hlsDirectStreamCopy).toBeUndefined();
    });

    test.each([AudioFormats.Dca, AudioFormats.TrueHd])(
      'Direct v2 applies the selected %s override to audio output zero',
      async (codec) => {
        const details = makeStreamDetails();
        const selectedAudio = {
          codec,
          channels: 6,
          index: 3,
          languageCodeISO6392: 'eng',
        };
        details.audioDetails = [
          {
            codec: AudioFormats.Aac,
            channels: 2,
            index: 1,
            languageCodeISO6392: 'jpn',
          },
          selectedAudio,
        ];
        const { sut, getCapturedFfmpegState } = createPassthroughSut(
          {},
          details,
          selectedAudio,
        );
        const result = await sut.createStreamSession({
          stream: { source: new FileStreamSource('/media/input.mkv'), details },
          options: {
            startTime: dayjs.duration(0),
            duration: details.duration,
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls_direct_v2',
          },
          lineupItem: makeLineupItem(),
        });
        expect(getCapturedFfmpegState()?.hlsDirectStreamCopy).toEqual({
          audioInputIndex: 3,
        });
        expect(getCapturedFfmpegState()?.audioCodecOverrides).toEqual([
          { outputIndex: 0, codec: AudioFormats.Ac3 },
        ]);
        expect(result?.renditions.audio).toHaveLength(1);
        expect(result?.renditions.audio[0]?.language).toBe('eng');
      },
    );

    test('Direct v2 does not encode an incompatible unselected audio track', async () => {
      const details = makeStreamDetails();
      details.audioDetails = [
        { codec: AudioFormats.TrueHd, index: 1, languageCodeISO6392: 'jpn' },
        { codec: AudioFormats.Aac, index: 19, languageCodeISO6392: 'eng' },
      ];
      const { sut, getCapturedFfmpegState } = createPassthroughSut({}, details);
      await sut.createStreamSession({
        stream: { source: new FileStreamSource('/media/input.mkv'), details },
        options: {
          startTime: dayjs.duration(0),
          duration: details.duration,
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls_direct_v2',
        },
        lineupItem: makeLineupItem(),
      });
      expect(getCapturedFfmpegState()?.hlsDirectStreamCopy).toEqual({
        audioInputIndex: 19,
      });
      expect(getCapturedFfmpegState()?.audioCodecOverrides).toEqual([]);
    });

    test('Direct v2 retains the existing absence of audio for an audio-less source', async () => {
      const details = makeStreamDetails();
      details.audioDetails = undefined;
      const { sut, getCapturedFfmpegState } = createPassthroughSut({}, details);
      const result = await sut.createStreamSession({
        stream: { source: new FileStreamSource('/media/input.mkv'), details },
        options: {
          startTime: dayjs.duration(0),
          duration: details.duration,
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls_direct_v2',
        },
        lineupItem: makeLineupItem(),
      });
      expect(getCapturedFfmpegState()?.hlsDirectStreamCopy).toBeDefined();
      expect(
        getCapturedFfmpegState()?.hlsDirectStreamCopy?.audioInputIndex,
      ).toBeUndefined();
      expect(getCapturedFfmpegState()?.audioCodecOverrides).toEqual([]);
      expect(result?.renditions.audio).toEqual([]);
    });

    test('passthrough uses source video dimensions for FrameState sizes', async () => {
      const details = makeStreamDetails();
      details.videoDetails = [
        {
          ...details.videoDetails![0],
          width: 3840,
          height: 2160,
        },
      ];

      const { sut, getCapturedFrameState } = createPassthroughSut(
        { resolution: { widthPx: 1920, heightPx: 1080 } },
        details,
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState()!;
      // In passthrough, scaled/padded sizes come from the source, not the
      // transcode config resolution (1920x1080).
      expect(frameState.scaledSize.width).toBe(3840);
      expect(frameState.scaledSize.height).toBe(2160);
      expect(frameState.paddedSize.width).toBe(3840);
      expect(frameState.paddedSize.height).toBe(2160);
    });
  });

  describe('audio renditions', () => {
    function makeMultiAudioStreamDetails(): StreamDetails {
      return {
        ...makeStreamDetails(),
        audioDetails: [
          {
            codec: 'aac',
            channels: 2,
            index: 1,
            language: 'Japanese',
            languageCodeISO6392: 'jpn',
          },
          {
            codec: 'aac',
            channels: 2,
            index: 2,
            language: 'English',
            languageCodeISO6392: 'eng',
          },
        ],
      };
    }

    function makeSut() {
      return new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        createCapturingPipelineBuilderFactory().factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        makeTranscodeConfig(),
        makeChannel(),
      );
    }

    test('transcode mode advertises no audio renditions', async () => {
      const result = await makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeMultiAudioStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: HlsOutputFormat(defaultHlsOptions),
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(result?.renditions.audio).toEqual([]);
    });

    test('Direct v2 advertises only the selected source audio track', async () => {
      const result = await makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeMultiAudioStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls_direct_v2',
        },
        lineupItem: makeLineupItem(),
      });

      expect(result?.renditions.audio.map((r) => r.language)).toEqual(['eng']);
    });

    test('explicit remux advertises every source audio track', async () => {
      const result = await makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeMultiAudioStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          encoding: { mode: 'remux' },
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(result?.renditions.audio.map((r) => r.language)).toEqual([
        'jpn',
        'eng',
      ]);
    });
  });

  describe('audio-only programs', () => {
    function makeAudioOnlyStreamDetails(
      placeholderImage?: HttpStreamSource,
    ): StreamDetails {
      return {
        ...makeStreamDetails(),
        videoDetails: undefined,
        audioOnly: true,
        placeholderImage,
      };
    }

    function makeSut(factory: PipelineBuilderFactory) {
      return new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        makeTranscodeConfig(),
        makeChannel(),
      );
    }

    const options = {
      startTime: dayjs.duration(0),
      duration: dayjs.duration({ seconds: 30 }),
      outputFormat: HlsOutputFormat(defaultHlsOptions),
      ptsOffset: 0,
      realtime: true,
      streamMode: 'hls',
    } as const;

    test('loops the placeholder image as the video input', async () => {
      const { factory, getCapturedVideoInput } =
        createCapturingPipelineBuilderFactory();
      const placeholder = new HttpStreamSource(
        'http://localhost:8000/images/generic-music-screen.png',
      );

      const result = await makeSut(factory).createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/track.flac'),
          details: makeAudioOnlyStreamDetails(placeholder),
        },
        options,
        lineupItem: makeLineupItem(),
      });

      expect(result).not.toBeNull();
      const videoInput = getCapturedVideoInput();
      expect(videoInput?.source).toBe(placeholder);
      expect(videoInput?.streams[0]).toBeInstanceOf(StillImageStream);
      expect(videoInput?.hasInputOption(InfiniteLoopInputOption)).toBe(true);
    });

    test('rejects an audio-only stream without a placeholder image', async () => {
      const { factory } = createCapturingPipelineBuilderFactory();

      await expect(
        makeSut(factory).createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/track.flac'),
            details: makeAudioOnlyStreamDetails(),
          },
          options,
          lineupItem: makeLineupItem(),
        }),
      ).rejects.toThrow('Streams with no video are not currently supported.');
    });
  });

  describe('subtitle handling', () => {
    const textSubtitleStream: SubtitleStreamDetails = {
      type: 'embedded',
      codec: 'subrip',
      index: 2,
      default: true,
      forced: false,
      sdh: false,
      language: 'English',
      languageCodeISO6392: 'eng',
      title: 'English SRT',
    };

    const imageSubtitleStream: SubtitleStreamDetails = {
      type: 'embedded',
      codec: 'hdmv_pgs_subtitle',
      index: 3,
      default: false,
      forced: false,
      sdh: false,
      language: 'English',
      languageCodeISO6392: 'eng',
      title: 'English PGS',
    };

    const externalSubtitleStream: SubtitleStreamDetails = {
      type: 'external',
      codec: 'subrip',
      default: false,
      forced: false,
      sdh: false,
      language: 'Spanish',
      languageCodeISO6392: 'spa',
      path: 'http://example.com/subs.srt',
      title: 'Spanish SRT',
    };

    describe('non-passthrough modes (HLS, mpegts, etc.)', () => {
      test('uses sidecar (Convert) when webvttSidecarEnabled and text-based subtitle', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        expect(result!.renditions.subtitle).toEqual({
          language: 'eng',
          languageName: 'English',
          default: true,
          forced: false,
          title: 'English SRT',
        });
      });

      test('uses burn-in when webvttSidecarEnabled is false', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: false }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Burn);
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('falls back to burn-in for image-based subtitles even when sidecar enabled', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(imageSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Burn);
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('skips subtitles when channel.subtitlesEnabled is false', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: false }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('skips subtitles when stream selector returns no subtitle', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(null),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('handles external subtitle streams with sidecar', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(externalSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        expect(result!.renditions.subtitle).toEqual({
          language: 'spa',
          languageName: 'Spanish',
          default: false,
          forced: false,
          title: 'Spanish SRT',
        });
      });

      test('extracted embedded subtitle uses stream index 0, not the original container index', async () => {
        // Simulates the bug from issue #1904: an embedded subtitle at index 2
        // in the source MKV is extracted to a standalone .srt file. The stream
        // selector returns it with type still set to 'embedded' and the
        // original container index. The pipeline should treat this as external
        // (index 0) since the .srt only has one stream, but without the fix it
        // creates an EmbeddedSubtitleStream with index 2, producing the wrong
        // ffmpeg map (e.g. -map 2:2 instead of -map 2:0).
        const extractedEmbeddedStream: SubtitleStreamDetails = {
          type: 'embedded',
          codec: 'subrip',
          index: 2,
          default: true,
          forced: false,
          sdh: false,
          language: 'English',
          languageCodeISO6392: 'eng',
          title: 'English SRT',
          // Path is a local file, different from the video source — this means
          // the subtitle has been extracted and is no longer embedded.
          path: '/tmp/cache/subtitles/ab/cd/abcdef1234.srt',
        };

        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(extractedEmbeddedStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        // The subtitle source path should be the extracted file, not the video
        expect(subtitleInput!.path).toBe(
          '/tmp/cache/subtitles/ab/cd/abcdef1234.srt',
        );
        // Critical: the stream must be treated as external with index 0, since
        // the standalone .srt only has one stream. Using the original container
        // index (2) would produce -map 2:2 which matches nothing.
        const stream = subtitleInput!.streams[0];
        expect(stream.inputKind).toBe('external');
        expect(stream.index).toBe(0);
      });
    });

    describe('Direct v2 fixed channel subtitle slots', () => {
      const hlsDirectV2Format = HlsDirectOutputFormat(defaultHlsOptions);
      const englishSlots = createDirectSubtitleSlots(['eng']);
      const localTextSubtitle: SubtitleStreamDetails = {
        ...textSubtitleStream,
        type: 'external',
        path: '/media/input.eng.srt',
      };

      function available(
        source: SubtitleStreamDetails,
      ): DirectSubtitleRendition {
        if (source.type === 'embedded' && source.path === undefined) {
          if (source.index === undefined)
            throw new Error('Embedded fixture requires an index');
          return {
            source,
            stream: {
              ...source,
              type: 'embedded',
              index: source.index,
              path: undefined,
            },
          };
        }
        if (source.path === undefined)
          throw new Error('Fixture requires a local path');
        return {
          source,
          stream: { ...source, type: 'external', index: 0, path: source.path },
        };
      }

      async function directSession(
        options: {
          source?: FileStreamSource | HttpStreamSource;
          subtitle?: SubtitleStreamDetails;
          subtitles?: StreamDetails['subtitleDetails'];
          available?: DirectSubtitleRendition[];
          slots?: readonly DirectSubtitleSlot[];
          noPlan?: boolean;
          hlsDirectBitrate?: number;
          outputFormat?: OutputFormat;
          remux?: boolean;
          noSubtitle?: boolean;
          subtitlesEnabled?: boolean;
          sidecarEnabled?: boolean;
          audioDetails?: StreamDetails['audioDetails'];
        } = {},
      ) {
        const info = makeMockFfmpegInfo();
        const capturing = createCapturingPipelineBuilderFactory();
        const details = makeStreamDetails();
        details.hlsDirectBitrate = options.hlsDirectBitrate;
        if (options.audioDetails !== undefined)
          details.audioDetails = options.audioDetails;
        const subtitle = options.subtitle ?? localTextSubtitle;
        details.subtitleDetails = options.noSubtitle
          ? undefined
          : (options.subtitles ?? [subtitle]);
        vi.mocked(collectDirectSubtitleRenditions).mockResolvedValue(
          options.available ??
            (options.noSubtitle ? [] : [available(subtitle)]),
        );
        const channelDB = makeMockChannelDB();
        const selector = makeMockStreamSelector(
          options.noSubtitle ? null : subtitle,
        );
        const sut = new FfmpegStreamFactory(
          info,
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          channelDB,
          makeMockFeatureFlagService({
            webvttSidecarEnabled: options.sidecarEnabled ?? true,
          }),
          selector,
          makeTranscodeConfig(),
          makeChannel({ subtitlesEnabled: options.subtitlesEnabled ?? true }),
        );
        const result = await sut.createStreamSession({
          stream: {
            source: options.source ?? new FileStreamSource('/media/input.mkv'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: options.outputFormat ?? hlsDirectV2Format,
            encoding: options.remux ? { mode: 'remux' } : undefined,
            directSubtitleSlots: options.noPlan
              ? undefined
              : (options.slots ?? englishSlots),
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });
        return { info, capturing, result, channelDB, selector, details };
      }

      test('fills regular and SDH from one plain input while the forced slot stays empty', async () => {
        const { capturing, result, selector, details, info } =
          await directSession({
            audioDetails: [
              { index: 1, codec: 'truehd', languageCodeISO6392: 'jpn' },
              { index: 19, codec: 'aac', languageCodeISO6392: 'eng' },
            ],
          });
        const inputs = capturing.getCapturedAdditionalSubtitleInputs();
        expect(inputs).toHaveLength(2);
        expect(inputs[0]?.path).toBe('/media/input.eng.srt');
        expect(inputs[0]?.streams[0]?.index).toBe(0);
        expect(inputs[1]).toBeInstanceOf(EmptyWebVttInputSource);
        expect(capturing.getCapturedFfmpegState()?.hlsDirectSubtitles).toEqual([
          {
            id: 'eng_regular',
            language: 'eng',
            default: false,
            subtitleOutputIndex: 0,
          },
          {
            id: 'eng_sdh',
            language: 'eng',
            default: false,
            subtitleOutputIndex: 0,
          },
          {
            id: 'eng_forced',
            language: 'eng',
            default: true,
            subtitleOutputIndex: 1,
          },
        ]);
        expect(result?.renditions.subtitles).toEqual(englishSlots);
        expect(capturing.getCapturedSubtitleInput()).toBeNull();
        expect(capturing.getCapturedFfmpegState()?.hlsDirectStreamCopy).toEqual(
          { audioInputIndex: 19 },
        );
        expect(capturing.getCapturedFfmpegState()?.audioCodecOverrides).toEqual(
          [],
        );
        expect(result?.renditions.audio).toHaveLength(1);
        expect(result?.renditions.audio[0]?.language).toBe('eng');
        expect(result?.renditions.subtitle).toBeUndefined();
        expect(collectDirectSubtitleRenditions).toHaveBeenCalledWith({
          lineupItem: makeLineupItem(),
          subtitleStreams: details.subtitleDetails,
        });
        expect(selector.selectAudioAndSubtitleStreams).not.toHaveBeenCalled();
        expect(info.probeStreamLayout).not.toHaveBeenCalled();
      });

      test.each([
        new FileStreamSource('/media/input.mkv'),
        new HttpStreamSource('http://media.test/input.mkv', {
          'X-Emby-Token': 'fixture-token',
        }),
      ])(
        'fills slots from embedded, cached and external text collectively with %o media',
        async (source) => {
          const embedded = { ...textSubtitleStream, index: 17, default: false };
          const sdh = { ...localTextSubtitle, sdh: true };
          const cachedForced = {
            ...textSubtitleStream,
            index: 23,
            path: '/cache/forced.srt',
            forced: true,
          };
          const { capturing, result } = await directSession({
            source,
            subtitles: [embedded, sdh, cachedForced],
            available: [
              available(embedded),
              available(sdh),
              available(cachedForced),
            ],
          });
          const inputs = capturing.getCapturedAdditionalSubtitleInputs();
          expect(inputs.map((input) => input.path)).toEqual([
            source.path,
            '/media/input.eng.srt',
            '/cache/forced.srt',
          ]);
          expect(inputs.map((input) => input.streams[0]?.index)).toEqual([
            17, 0, 0,
          ]);
          expect(inputs.map((input) => input.streams[0]?.inputKind)).toEqual([
            'embedded',
            'external',
            'external',
          ]);
          expect(
            capturing
              .getCapturedFfmpegState()
              ?.hlsDirectSubtitles?.map(
                ({ subtitleOutputIndex }) => subtitleOutputIndex,
              ),
          ).toEqual([0, 1, 2]);
          expect(result?.renditions.subtitles).toEqual(englishSlots);
        },
      );

      test('keeps the same catalogue across storage, title, default and availability changes', async () => {
        const first = await directSession();
        const next = await directSession({
          source: new HttpStreamSource('http://media.test/next.mkv'),
          subtitle: {
            ...textSubtitleStream,
            index: 23,
            title: 'Different programme title',
            sdh: true,
            default: false,
          },
        });
        const empty = await directSession({ noSubtitle: true });
        expect(first.result?.renditions.subtitles).toEqual(englishSlots);
        expect(next.result?.renditions.subtitles).toEqual(englishSlots);
        expect(empty.result?.renditions.subtitles).toEqual(englishSlots);
        expect(
          next.capturing
            .getCapturedFfmpegState()
            ?.hlsDirectSubtitles?.map(
              ({ subtitleOutputIndex }) => subtitleOutputIndex,
            ),
        ).toEqual([0, 0, 1]);
        expect(
          empty.capturing.getCapturedAdditionalSubtitleInputs(),
        ).toHaveLength(1);
        expect(
          empty.capturing.getCapturedAdditionalSubtitleInputs()[0],
        ).toBeInstanceOf(EmptyWebVttInputSource);
        expect(
          empty.capturing
            .getCapturedFfmpegState()
            ?.hlsDirectSubtitles?.map(
              ({ subtitleOutputIndex }) => subtitleOutputIndex,
            ),
        ).toEqual([0, 0, 0]);
      });

      test('takes the first path-ordered sidecar despite database order and a default alternative', async () => {
        const first = { ...localTextSubtitle, default: false };
        const second = {
          ...localTextSubtitle,
          path: '/media/later-default.vtt',
          codec: 'webvtt',
          default: true,
        };
        const { capturing } = await directSession({
          available: [available(second), available(first)],
        });
        expect(capturing.getCapturedAdditionalSubtitleInputs()[0]?.path).toBe(
          first.path,
        );
      });

      test('keeps same-file regular and forced candidates eligible while reusing one encoded input', async () => {
        const forced = { ...localTextSubtitle, forced: true };
        const { capturing, result } = await directSession({
          available: [available(forced), available(localTextSubtitle)],
        });
        expect(capturing.getCapturedAdditionalSubtitleInputs()).toHaveLength(1);
        expect(capturing.getCapturedAdditionalSubtitleInputs()[0]?.path).toBe(
          localTextSubtitle.path,
        );
        expect(
          capturing
            .getCapturedFfmpegState()
            ?.hlsDirectSubtitles?.map(
              ({ subtitleOutputIndex }) => subtitleOutputIndex,
            ),
        ).toEqual([0, 0, 0]);
        expect(result?.renditions.subtitles).toEqual(englishSlots);
      });

      test.each([
        { noSubtitle: true },
        {
          subtitles: [imageSubtitleStream] as StreamDetails['subtitleDetails'],
          available: [],
        },
      ])(
        'retains all configured slots with empty input when usable text is absent: %o',
        async (options) => {
          const { capturing, result } = await directSession(options);
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toHaveLength(
            1,
          );
          expect(
            capturing.getCapturedAdditionalSubtitleInputs()[0],
          ).toBeInstanceOf(EmptyWebVttInputSource);
          expect(result?.renditions.subtitles).toEqual(englishSlots);
          expect(result?.renditions.nativeSubtitleOutput).toBe(true);
        },
      );

      test.each([{ subtitlesEnabled: false }, { sidecarEnabled: false }])(
        'honors the frozen tuned-channel plan despite another factory channel gate: %o',
        async (options) => {
          const { capturing, result, channelDB } = await directSession(options);
          expect(collectDirectSubtitleRenditions).toHaveBeenCalledOnce();
          expect(
            channelDB.getChannelSubtitlePreferences,
          ).not.toHaveBeenCalled();
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toHaveLength(
            2,
          );
          expect(result?.renditions.subtitles).toEqual(englishSlots);
        },
      );

      test.each([{ slots: [] }, { noPlan: true }])(
        'does not invent a catalogue when the supplied plan is empty or absent: %o',
        async (options) => {
          const { capturing, result, channelDB } = await directSession(options);
          expect(collectDirectSubtitleRenditions).not.toHaveBeenCalled();
          expect(
            channelDB.getChannelSubtitlePreferences,
          ).not.toHaveBeenCalled();
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toEqual([]);
          expect(result?.renditions.subtitles).toEqual([]);
        },
      );

      test.each(['error', 'offline'] as const)(
        'preserves tuned-channel slots through an encoded %s placeholder on a subtitle-disabled target',
        async (kind) => {
          const capturing = createCapturingPipelineBuilderFactory();
          const sut = new FfmpegStreamFactory(
            makeMockFfmpegInfo(),
            makeMockSettingsDB(makeFfmpegSettings()),
            capturing.factory,
            makeMockChannelDB(),
            makeMockFeatureFlagService({ webvttSidecarEnabled: false }),
            makeMockStreamSelector(),
            makeTranscodeConfig(),
            makeChannel({ subtitlesEnabled: false }),
          );
          const common = {
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            directSubtitleSlots: englishSlots,
          };
          const result = await sut.createPlaceholderSession(
            kind === 'error'
              ? { ...common, kind, title: 'Fixture error' }
              : { ...common, kind },
          );
          expect(result?.renditions.subtitles).toEqual(englishSlots);
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toHaveLength(
            1,
          );
          expect(
            capturing.getCapturedAdditionalSubtitleInputs()[0],
          ).toBeInstanceOf(EmptyWebVttInputSource);
          expect(
            capturing
              .getCapturedFfmpegState()
              ?.hlsDirectSubtitles?.map(
                ({ subtitleOutputIndex }) => subtitleOutputIndex,
              ),
          ).toEqual([0, 0, 0]);
        },
      );

      test('carries the evaluated bitrate into Direct v2 state in bits per second', async () => {
        expect(
          (
            await directSession({ hlsDirectBitrate: 1_234_567 })
          ).capturing.getCapturedFfmpegState()?.hlsDirectBitrate,
        ).toBe(1_234_567);
      });

      test('does not carry the Direct v2 estimate into explicit remux state', async () => {
        const { capturing } = await directSession({
          hlsDirectBitrate: 1_234_567,
          remux: true,
          outputFormat: { type: 'mpegts' },
        });
        expect(
          capturing.getCapturedFfmpegState()?.hlsDirectBitrate,
        ).toBeUndefined();
      });

      test.each([
        { outputFormat: { type: 'mpegts' as const }, remux: true },
        { outputFormat: HlsOutputFormat(defaultHlsOptions), remux: false },
      ])(
        'retains singular subtitle metadata and input in other modes: %o',
        async (options) => {
          const { info, capturing, result } = await directSession(options);
          const subtitleInput = capturing.getCapturedSubtitleInput();
          expect(subtitleInput).not.toBeNull();
          expect(subtitleInput?.method).toBe(SubtitleMethods.Convert);
          expect(collectDirectSubtitleRenditions).not.toHaveBeenCalled();
          expect(info.probeStreamLayout).not.toHaveBeenCalled();
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toEqual([]);
          expect(
            capturing.getCapturedFfmpegState()?.hlsDirectSubtitles,
          ).toBeUndefined();
          expect(result?.renditions.subtitles).toBeUndefined();
          expect(result?.renditions.subtitle).toEqual({
            language: 'eng',
            languageName: 'English',
            default: true,
            forced: false,
            title: 'English SRT',
          });
        },
      );

      test.each([
        { subtitle: imageSubtitleStream },
        { subtitlesEnabled: false },
      ])(
        'explicit remux excludes image subtitles and honors the channel subtitle gate: %o',
        async (options) => {
          const { capturing, result } = await directSession({
            ...options,
            outputFormat: MpegTsOutputFormat,
            remux: true,
          });
          expect(capturing.getCapturedSubtitleInput()).toBeNull();
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toEqual([]);
          expect(result?.renditions.subtitle).toBeUndefined();
          expect(result?.renditions.subtitles).toBeUndefined();
        },
      );

      test.each([
        { outputFormat: { type: 'mpegts' as const }, remux: true },
        { outputFormat: HlsOutputFormat(defaultHlsOptions), remux: false },
      ])(
        'does not add a subtitle producer to another mode without text: %o',
        async (options) => {
          const { capturing, result } = await directSession({
            ...options,
            noSubtitle: true,
          });
          expect(capturing.getCapturedSubtitleInput()).toBeNull();
          expect(capturing.getCapturedAdditionalSubtitleInputs()).toEqual([]);
          expect(result?.renditions.subtitle).toBeUndefined();
          expect(result?.renditions.subtitles).toBeUndefined();
        },
      );
    });
  });
});
