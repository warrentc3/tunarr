import { Result } from '@/types/result.ts';
import type { EmbyMovie } from '@tunarr/types/emby';
import { describe, expect, it, vi } from 'vitest';
import { EmbyApiClient } from './EmbyApiClient.ts';

const { fakeLogger } = vi.hoisted(() => {
  const fakeLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => fakeLogger,
  };
  return { fakeLogger };
});

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: { child: () => fakeLogger, root: fakeLogger },
}));
vi.mock('@/util/version.js', () => ({ getTunarrVersion: () => '1.0.0-test' }));

describe('EmbyApiClient bitrate metadata', () => {
  it('preserves equal source/video reports separately and marks covers', async () => {
    const client = new EmbyApiClient(
      { getCanonicalId: () => 'emby://movie/movie-id' } as never,
      {
        mediaSource: {
          uuid: 'media-source-id',
          type: 'emby',
          name: 'Test Emby',
          uri: 'http://localhost:8096',
          accessToken: 'test-token',
          libraries: [],
        } as never,
      },
    );
    // Modeled API input tests preservation, not the accuracy of Emby's rates.
    const movie: EmbyMovie = {
      Id: 'movie-id',
      Type: 'Movie',
      Name: 'Test movie',
      RunTimeTicks: 3605000000,
      MediaSources: [
        {
          Id: 'source-id',
          Protocol: 'File',
          Path: '/media/movie.mkv',
          Container: 'mkv',
          Size: 112500000,
          RunTimeTicks: 3605000000,
          Bitrate: 2500000,
          MediaStreams: [
            {
              Type: 'EmbeddedImage',
              Index: 0,
              Codec: 'mjpeg',
              Width: 300,
              Height: 300,
            },
            {
              Type: 'Video',
              Index: 1,
              Codec: 'h264',
              BitRate: 2500000,
              Width: 1920,
              Height: 1080,
            },
            { Type: 'Audio', Index: 2, Codec: 'aac', BitRate: 128000 },
          ],
        },
      ],
    };
    vi.spyOn(client, 'getItem').mockResolvedValue(Result.success(movie));
    const result = await client.getMovie('movie-id');
    expect(result.isSuccess()).toBe(true);
    const media = result.get().mediaItem;
    expect(media).toMatchObject({
      bitrate: 2500000,
      container: 'mkv',
      resolution: { widthPx: 1920, heightPx: 1080 },
    });
    expect(media?.locations[0]).toMatchObject({
      sizeBytes: 112500000,
      duration: 360500,
    });
    expect(media?.streams).toEqual([
      expect.objectContaining({ index: 0, hasAttachedPicture: true }),
      expect.objectContaining({
        index: 1,
        hasAttachedPicture: false,
        bitrate: 2500000,
      }),
      expect.objectContaining({ index: 2, bitrate: 128000 }),
    ]);
  });
});

describe('EmbyApiClient external subtitles', () => {
  it('retains a download route for Emby VTT sidecars without DeliveryUrl', async () => {
    const client = new EmbyApiClient(
      { getCanonicalId: () => 'emby://movie/109' } as never,
      {
        mediaSource: {
          uuid: 'media-source-id',
          type: 'emby',
          name: 'Test Emby',
          uri: 'http://localhost:8096',
          accessToken: 'test-token',
          libraries: [],
        } as never,
      },
    );
    const movie: EmbyMovie = {
      Id: '109',
      Type: 'Movie',
      Name: 'Test movie',
      RunTimeTicks: 3605000000,
      MediaSources: [
        {
          Id: 'mediasource_109',
          Protocol: 'File',
          Path: '/media/movie.mkv',
          MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'h264' },
            { Type: 'Audio', Index: 1, Codec: 'aac' },
            // Emby's scanned VTT metadata has a raw stream index and no URL.
            {
              Type: 'Subtitle',
              Index: 3,
              Codec: 'vtt',
              IsExternal: true,
              Path: '/media/movie.eng.vtt',
              Language: 'en',
              IsForced: false,
              IsHearingImpaired: false,
            },
          ],
        },
      ],
    };
    vi.spyOn(client, 'getItem').mockResolvedValue(Result.success(movie));

    const result = await client.getMovie('109');

    expect(result.get().mediaItem?.streams).toContainEqual(
      expect.objectContaining({
        streamType: 'external_subtitles',
        codec: 'vtt',
        fileName: '/media/movie.eng.vtt',
        externalKey: '/Videos/109/mediasource_109/Subtitles/3/Stream.vtt',
        forced: false,
        sdh: false,
      }),
    );
  });
});
