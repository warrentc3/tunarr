import { faker } from '@faker-js/faker';
import axios from 'axios';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import type { ProgramWithRelationsOrm } from '../db/schema/derivedTypes.ts';
import type {
  ArtworkResult,
  ArtworkService,
} from '../services/ArtworkService.ts';
import { fileExists } from '../util/fsUtil.ts';
import { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';
import { FileStreamSource, HttpStreamSource } from './types.ts';
import type { FfmpegInfo } from '../ffmpeg/ffmpegInfo.ts';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';

const probeSourceBitrate = vi.fn();
const ffmpegInfo = { probeSourceBitrate } as unknown as FfmpegInfo;

vi.mock('@/util/logging/LoggerFactory.js', () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    setBindings: vi.fn(),
  };
  return {
    LoggerFactory: {
      isInitialized: true,
      root: logger,
      child: () => logger,
    },
  };
});

vi.mock('../util/fsUtil.ts', () => ({
  fileExists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../util/serverUtil.ts', () => ({
  makeLocalUrl: (path: string) => `http://localhost:8000${path}`,
}));

vi.mock('axios', () => ({
  default: { head: vi.fn() },
}));

vi.mock('./PathCalculator.ts', () => ({
  PathCalculator: {
    findFirstValidPath: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeServer(
  overrides: Partial<MediaSourceWithRelations> & { type: string; uri: string },
): MediaSourceWithRelations {
  return {
    uuid: faker.string.uuid(),
    accessToken: faker.string.alphanumeric(20),
    name: faker.company.name(),
    index: 0,
    createdAt: null,
    updatedAt: null,
    clientIdentifier: null,
    sendChannelUpdates: false,
    sendGuideUpdates: false,
    username: null,
    userId: null,
    mediaType: null,
    libraries: [],
    paths: [],
    replacePaths: [],
    ...overrides,
  } as MediaSourceWithRelations;
}

function makeProgram(
  serverType: string,
  serverPath: string,
): ProgramWithRelationsOrm {
  const externalSourceId = faker.string.uuid();
  return {
    uuid: faker.string.uuid(),
    title: faker.lorem.words(3),
    duration: 3600000,
    type: 'episode' as const,
    sourceType: serverType,
    seasonNumber: 1,
    episodeNumber: 1,
    showTitle: faker.lorem.words(2),
    showIcon: null,
    albumName: null,
    artistName: null,
    summary: null,
    plexRatingKey: null,
    plexFilePath: null,
    rating: null,
    icon: null,
    year: null,
    date: null,
    order: null,
    channelUuid: null,
    fillerShowUuid: null,
    customShowUuid: null,
    mediaSourceId: externalSourceId,
    parentExternalKey: null,
    grandparentExternalKey: null,
    createdAt: null,
    updatedAt: null,
    originalAirDate: null,
    imdbId: null,
    versions: [
      {
        uuid: faker.string.uuid(),
        programUuid: faker.string.uuid(),
        mediaSourceId: externalSourceId,
        sourceType: serverType,
        duration: 3600000,
        width: 1920,
        height: 1080,
        displayAspectRatio: '16/9',
        sampleAspectRatio: null,
        frameRate: null,
        scanKind: null,
        videoCodec: null,
        audioCodec: null,
        videoProfile: null,
        chapters: [],
        externalKey: null,
        directStreamUrl: null,
        createdAt: null,
        updatedAt: null,
        mediaFiles: [
          {
            uuid: faker.string.uuid(),
            mediaVersionUuid: faker.string.uuid(),
            path: '/some/local/path/file.mkv',
            createdAt: null,
            updatedAt: null,
          },
        ],
        mediaStreams: [
          {
            uuid: faker.string.uuid(),
            mediaVersionUuid: faker.string.uuid(),
            streamKind: 'video',
            index: 0,
            codec: 'h264',
            default: true,
            forced: false,
            title: null,
            channels: null,
            language: null,
            bitsPerSample: null,
            profile: null,
            pixelFormat: 'yuv420p',
            colorRange: null,
            colorSpace: null,
            colorTransfer: null,
            colorPrimaries: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
      },
    ],
    externalIds: [
      {
        uuid: faker.string.uuid(),
        sourceType: serverType,
        externalKey: faker.string.alphanumeric(10),
        externalFilePath: serverPath,
        externalSourceId,
        programUuid: faker.string.uuid(),
        directFilePath: null,
        parentExternalKey: null,
        grandparentExternalKey: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    subtitles: [],
    customShows: [],
    fillerShows: [],
  } as unknown as ProgramWithRelationsOrm;
}

function makeArtworkService(
  result: ArtworkResult = { kind: 'not-found' },
): ArtworkService {
  return {
    resolveArtwork: vi.fn().mockResolvedValue(result),
  } as unknown as ArtworkService;
}

function makeProgramDB(program: ProgramWithRelationsOrm): IProgramDB {
  return {
    getStreamProgramById: vi.fn().mockResolvedValue(program),
  } as unknown as IProgramDB;
}

describe('ProgramStreamDetailsFetcher', () => {
  it('retains source SDH metadata for the matching unextracted embedded index', async () => {
    const program = makeProgram('local', 'unused');
    const version = program.versions[0];
    const video = version?.mediaStreams[0];
    if (version === undefined || video === undefined)
      throw new Error('Missing fixture video');
    version.mediaStreams.push(
      {
        ...video,
        streamKind: 'subtitles',
        codec: 'subrip',
        index: 2,
        title: 'English SDH',
        language: 'eng',
        default: false,
      },
      {
        ...video,
        streamKind: 'subtitles',
        codec: 'subrip',
        index: 3,
        title: 'English',
        language: 'eng',
        default: true,
      },
    );
    program.subtitles = [
      {
        uuid: 'subtitle-2',
        programId: program.uuid,
        subtitleType: 'embedded',
        streamIndex: 2,
        codec: 'subrip',
        default: false,
        forced: false,
        sdh: true,
        language: 'eng',
        path: null,
        sourcePath: null,
        sourceKey: null,
        isExtracted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const fetcher = new ProgramStreamDetailsFetcher(
      makeProgramDB(program),
      ffmpegInfo,
      makeArtworkService(),
    );
    const result = await fetcher.getStream({
      server: makeServer({ type: 'local', uri: '' }),
      lineupItem: { uuid: program.uuid } as StreamLineupProgram,
    });
    expect(result.get().streamDetails.subtitleDetails).toMatchObject([
      {
        type: 'embedded',
        index: 2,
        sdh: true,
        title: 'English SDH',
        default: false,
      },
      {
        type: 'embedded',
        index: 3,
        sdh: false,
        title: 'English',
        default: true,
      },
    ]);
    expect(
      result
        .get()
        .streamDetails.subtitleDetails?.every(
          (stream) => stream.path === undefined,
        ),
    ).toBe(true);
  });

  describe('Direct v2 persisted bitrate carry', () => {
    beforeEach(() => probeSourceBitrate.mockReset());

    it('reads stored rates and full-file facts without probing populated records', async () => {
      const program = makeProgram('local', 'unused');
      const version = program.versions[0];
      if (!version) throw new Error('fixture has no version');
      version.bitrate = 1_646_365;
      version.container = 'matroska';
      const stream = version.mediaStreams[0];
      if (!stream) throw new Error('fixture has no stream');
      stream.statisticsBitrate = 1_467_721;
      const file = version.mediaFiles[0];
      if (!file) throw new Error('fixture has no file');
      file.sizeBytes = 415_590_909;
      file.duration = 2_019_435;
      const fetcher = new ProgramStreamDetailsFetcher(
        makeProgramDB(program),
        ffmpegInfo,
        makeArtworkService(),
      );
      const result = await fetcher.getStream({
        server: makeServer({ type: 'local', uri: '' }),
        lineupItem: { uuid: program.uuid } as StreamLineupProgram,
        requireBitrate: true,
      });
      expect(result.get().streamDetails).toMatchObject({
        bitrate: 1_646_365,
        hlsDirectBitrate: 1_646_365,
        sourceSizeBytes: 415_590_909,
        sourceFileDurationMs: 2_019_435,
        sourceContainer: 'matroska',
        videoDetails: [{ statisticsBitrate: 1_467_721 }],
      });
      expect(probeSourceBitrate).not.toHaveBeenCalled();
    });

    it('probes an unfilled HTTP record with its resolved playback headers', async () => {
      const program = makeProgram('jellyfin', 'abc123');
      probeSourceBitrate.mockResolvedValue(1_593_633);
      const fetcher = new ProgramStreamDetailsFetcher(
        makeProgramDB(program),
        ffmpegInfo,
        makeArtworkService(),
      );
      const result = await fetcher.getStream({
        server: makeServer({ type: 'jellyfin', uri: 'http://jellyfin:8096' }),
        lineupItem: { uuid: program.uuid } as StreamLineupProgram,
        requireBitrate: true,
      });
      const source = result.get().streamSource;
      if (source.type !== 'http') throw new Error('expected HTTP fixture');
      expect(probeSourceBitrate).toHaveBeenCalledWith(
        source.path,
        source.extraHeaders,
      );
      expect(result.get().streamDetails.hlsDirectBitrate).toBe(1_593_633);
    });

    it('excludes a persisted attached picture from selected video details', async () => {
      const program = makeProgram('local', 'unused');
      const version = program.versions[0];
      const realVideo = version?.mediaStreams[0];
      if (!version || !realVideo) throw new Error('fixture has no video');
      version.mediaStreams = [
        { ...realVideo, index: 0, codec: 'mjpeg', hasAttachedPicture: true },
        { ...realVideo, index: 1, hasAttachedPicture: false },
      ];
      const fetcher = new ProgramStreamDetailsFetcher(
        makeProgramDB(program),
        ffmpegInfo,
        makeArtworkService(),
      );
      const result = await fetcher.getStream({
        server: makeServer({ type: 'local', uri: '' }),
        lineupItem: { uuid: program.uuid } as StreamLineupProgram,
      });
      expect(result.get().streamDetails.videoDetails).toHaveLength(1);
      expect(result.get().streamDetails.videoDetails?.[0]?.streamIndex).toBe(1);
      expect(probeSourceBitrate).not.toHaveBeenCalled();
    });
  });
  describe('getStream constructs valid HTTP URLs for remote streams', () => {
    it('constructs a valid Plex stream URL preserving the http:// protocol', async () => {
      const serverPath = '/library/parts/1014/1222133011/file.avi';
      const program = makeProgram('plex', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'plex',
        uri: 'http://10.0.0.110:32400',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const streamSource = result.get().streamSource;
      expect(streamSource).toBeInstanceOf(HttpStreamSource);
      expect(streamSource.type).toBe('http');

      const url = (streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        `http://10.0.0.110:32400/library/parts/1014/1222133011/file.avi?X-Plex-Token=${server.accessToken}`,
      );
    });

    it('constructs a valid Jellyfin stream URL preserving the http:// protocol', async () => {
      const serverPath = 'abc123def456';
      const program = makeProgram('jellyfin', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'jellyfin',
        uri: 'http://192.168.1.100:8096',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const streamSource = result.get().streamSource;
      expect(streamSource).toBeInstanceOf(HttpStreamSource);

      const url = (streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        'http://192.168.1.100:8096/Videos/abc123def456/stream?static=true',
      );
    });

    it('constructs a valid Emby stream URL preserving the http:// protocol', async () => {
      const serverPath = 'xyz789';
      const program = makeProgram('emby', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'emby',
        uri: 'http://10.0.0.50:8096',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const streamSource = result.get().streamSource;
      expect(streamSource).toBeInstanceOf(HttpStreamSource);

      const url = (streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        `http://10.0.0.50:8096/Videos/xyz789/stream?X-Emby-Token=${server.accessToken}&static=true`,
      );
    });

    it('handles server URIs with trailing slashes', async () => {
      const serverPath = '/library/parts/1014/file.avi';
      const program = makeProgram('plex', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'plex',
        uri: 'http://10.0.0.110:32400/',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const url = (result.get().streamSource as HttpStreamSource).path;
      // Should not have double slashes between host and path
      expect(url).not.toMatch(/:\d+\/\//);
      expect(url).toContain('http://');
    });
  });

  describe('getStream constructs valid HTTP URLs on Windows (simulated)', () => {
    beforeEach(() => {
      vi.spyOn(path, 'join').mockImplementation((...args: string[]) =>
        path.win32.join(...args),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('constructs a valid Plex stream URL on Windows without backslash mangling', async () => {
      const serverPath = '/library/parts/1014/1222133011/file.avi';
      const program = makeProgram('plex', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'plex',
        uri: 'http://10-0-0-110.abc123.plex.direct:32400',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const url = (result.get().streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        `http://10-0-0-110.abc123.plex.direct:32400/library/parts/1014/1222133011/file.avi?X-Plex-Token=${server.accessToken}`,
      );
    });

    it('constructs a valid Jellyfin stream URL on Windows without backslash mangling', async () => {
      const serverPath = 'abc123def456';
      const program = makeProgram('jellyfin', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'jellyfin',
        uri: 'http://192.168.1.100:8096',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const url = (result.get().streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        'http://192.168.1.100:8096/Videos/abc123def456/stream?static=true',
      );
    });

    it('constructs a valid Emby stream URL on Windows without backslash mangling', async () => {
      const serverPath = 'xyz789';
      const program = makeProgram('emby', serverPath);
      const programDB = makeProgramDB(program);
      const fetcher = new ProgramStreamDetailsFetcher(
        programDB,
        ffmpegInfo,
        makeArtworkService(),
      );

      const server = makeServer({
        type: 'emby',
        uri: 'http://10.0.0.50:8096',
      });

      const result = await fetcher.getStream({
        server,
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.isSuccess()).toBe(true);

      const url = (result.get().streamSource as HttpStreamSource).path;
      expect(url).toContain('http://');
      expect(url).not.toContain('\\');
      expect(url).toBe(
        `http://10.0.0.50:8096/Videos/xyz789/stream?X-Emby-Token=${server.accessToken}&static=true`,
      );
    });
  });

  describe('getStream picks a placeholder image for audio-only programs', () => {
    const GenericMusicScreen =
      'http://localhost:8000/images/generic-music-screen.png';

    function makeAudioOnlyProgram(): ProgramWithRelationsOrm {
      const program = makeProgram('local', '');
      const version = program.versions[0];
      if (!version) {
        throw new Error('makeProgram always creates a version');
      }
      const videoStream = version.mediaStreams?.[0];
      if (!videoStream) {
        throw new Error('makeProgram always creates a video stream');
      }
      version.mediaStreams = [
        {
          ...videoStream,
          streamKind: 'audio',
          codec: 'flac',
          channels: 2,
          pixelFormat: null,
        },
      ];
      return program;
    }

    async function getStreamDetails(artworkService: ArtworkService) {
      const program = makeAudioOnlyProgram();
      const fetcher = new ProgramStreamDetailsFetcher(
        makeProgramDB(program),
        ffmpegInfo,
        artworkService,
      );
      const result = await fetcher.getStream({
        server: makeServer({ type: 'local', uri: '' }),
        lineupItem: program.externalIds[0] as any,
      });
      expect(result.isSuccess()).toBe(true);
      return result.get().streamDetails;
    }

    afterEach(() => {
      vi.mocked(fileExists).mockReset().mockResolvedValue(false);
      vi.mocked(axios.head).mockReset();
    });

    it('uses cached artwork on disk', async () => {
      vi.mocked(fileExists).mockResolvedValueOnce(true);

      const details = await getStreamDetails(
        makeArtworkService({
          kind: 'file',
          path: '/cache/album.jpg',
          artworkType: 'poster',
        }),
      );

      expect(details.audioOnly).toBe(true);
      expect(details.placeholderImage).toEqual(
        new FileStreamSource('/cache/album.jpg'),
      );
    });

    it('uses reachable remote artwork and keeps its auth headers', async () => {
      vi.mocked(axios.head).mockResolvedValueOnce({ status: 200 });
      const headers = { 'X-Plex-Token': 'token' };

      const details = await getStreamDetails(
        makeArtworkService({
          kind: 'url',
          url: 'http://plex:32400/library/metadata/1/thumb',
          headers,
        }),
      );

      expect(details.placeholderImage).toEqual(
        new HttpStreamSource(
          'http://plex:32400/library/metadata/1/thumb',
          headers,
        ),
      );
    });

    it('falls back to the generic music screen when remote artwork is unreachable', async () => {
      vi.mocked(axios.head).mockRejectedValueOnce(new Error('404'));

      const details = await getStreamDetails(
        makeArtworkService({
          kind: 'url',
          url: 'http://plex:32400/library/metadata/1/thumb',
        }),
      );

      expect(details.placeholderImage?.path).toBe(GenericMusicScreen);
    });

    it('falls back to the generic music screen when cached artwork is missing', async () => {
      const details = await getStreamDetails(
        makeArtworkService({
          kind: 'file',
          path: '/cache/missing.jpg',
          artworkType: 'poster',
        }),
      );

      expect(details.placeholderImage?.path).toBe(GenericMusicScreen);
    });

    it('falls back to the generic music screen when cached artwork is unreadable', async () => {
      vi.mocked(fileExists).mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      const details = await getStreamDetails(
        makeArtworkService({
          kind: 'file',
          path: '/cache/poster.jpg',
          artworkType: 'poster',
        }),
      );

      expect(details.placeholderImage?.path).toBe(GenericMusicScreen);
    });

    it('falls back to the generic music screen when there is no artwork', async () => {
      const details = await getStreamDetails(makeArtworkService());

      expect(details.placeholderImage?.path).toBe(GenericMusicScreen);
    });

    it('falls back to the generic music screen when artwork lookup throws', async () => {
      const artworkService = {
        resolveArtwork: vi.fn().mockRejectedValue(new Error('db is gone')),
      } as unknown as ArtworkService;

      const details = await getStreamDetails(artworkService);

      expect(details.placeholderImage?.path).toBe(GenericMusicScreen);
    });

    it('does not look up artwork for programs with video', async () => {
      const program = makeProgram('local', '');
      const artworkService = makeArtworkService();
      const fetcher = new ProgramStreamDetailsFetcher(
        makeProgramDB(program),
        ffmpegInfo,
        artworkService,
      );

      const result = await fetcher.getStream({
        server: makeServer({ type: 'local', uri: '' }),
        lineupItem: program.externalIds[0] as any,
      });

      expect(result.get().streamDetails.placeholderImage).toBeUndefined();
      expect(artworkService.resolveArtwork).not.toHaveBeenCalled();
    });
  });
});
