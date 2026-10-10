import { ChildProcessHelper } from '@/util/ChildProcessHelper.ts';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FfmpegInfo } from './ffmpegInfo.ts';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => childProcess);

function probeOutput(output: string, error: Error | null = null) {
  childProcess.execFile.mockImplementationOnce(
    (
      _executable: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(error, output, 'not logged'),
  );
}

describe('unfilled-record bitrate measurement', () => {
  beforeEach(() => childProcess.execFile.mockReset());

  test('uses the whole source rate with matching HTTP headers and no argv logging', async () => {
    probeOutput(
      JSON.stringify({
        format: { bit_rate: '1593632', size: '15343893', duration: '77.026' },
      }),
    );
    const stdoutSpy = vi.spyOn(ChildProcessHelper.prototype, 'getStdout');
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    expect(
      await info.probeSourceBitrate('http://media.test/video', {
        Authorization: 'fixture',
      }),
    ).toBe(1593632);
    expect(childProcess.execFile.mock.calls[0]?.[1]).toContain(
      'Authorization: fixture\r\n',
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  test('calculates from source bytes and seconds when the reported rate is absent', async () => {
    probeOutput(
      JSON.stringify({ format: { size: '15343893', duration: '77.026' } }),
    );
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    expect(await info.probeSourceBitrate('/media/input.mkv')).toBe(1593633);
  });

  test('leaves failed measurement unavailable instead of inventing a fixed rate', async () => {
    probeOutput('', new Error('private URL in failed command'));
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    expect(
      await info.probeSourceBitrate('http://media.test/video'),
    ).toBeUndefined();
  });
});

describe('focused Direct v2 stream-layout probe', () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
  });

  test('excludes attached covers from native ordinals while retaining genuine MJPEG', async () => {
    probeOutput(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'png',
            disposition: { attached_pic: 1 },
          },
          {
            codec_type: 'video',
            codec_name: 'h264',
            disposition: { attached_pic: 0 },
          },
          { codec_type: 'audio', codec_name: 'aac' },
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            disposition: { attached_pic: 0 },
          },
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          },
        ],
      }),
    );
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    expect(await info.probeStreamLayout('/media/covered.mkv')).toEqual({
      videoCount: 2,
      audioCount: 1,
      hasData: false,
    });
  });

  test('counts all actual video/audio streams without requiring format metadata', async () => {
    probeOutput(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'audio', codec_name: 'ac3' },
          { codec_type: 'subtitle', codec_name: 'subrip' },
          { codec_type: 'attachment', codec_name: 'ttf' },
          { codec_type: 'video', codec_name: 'mjpeg' },
        ],
      }),
    );
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');

    await expect(info.probeStreamLayout('/media/input.mkv')).resolves.toEqual({
      videoCount: 2,
      audioCount: 2,
      hasData: false,
    });
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/configured/ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name:stream_disposition=attached_pic',
        '-of',
        'json',
        '/media/input.mkv',
      ],
      {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      expect.any(Function),
    );
  });

  test.each([
    { codec_type: 'data', codec_name: 'bin_data' },
    { codec_type: 'data', codec_name: 'timed_id3' },
    { codec_type: 'subtitle', codec_name: 'bin_data' },
  ])('retains the data-preservation signal for %o', async (stream) => {
    probeOutput(JSON.stringify({ streams: [{ codec_type: 'video' }, stream] }));
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    expect(await info.probeStreamLayout('/media/input.ts')).toEqual({
      videoCount: 1,
      audioCount: 0,
      hasData: true,
    });
  });

  test.each([
    'not JSON',
    JSON.stringify({}),
    JSON.stringify({ streams: [] }),
    JSON.stringify({ streams: [{ codec_type: 'unknown' }] }),
    JSON.stringify({ streams: [{ codec_name: 'h264' }] }),
  ])('leaves malformed or unknown layout unavailable: %s', async (output) => {
    probeOutput(output);
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    await expect(
      info.probeStreamLayout('/media/input.ts'),
    ).resolves.toBeUndefined();
  });

  test('passes HTTP headers without using the argv-logging helper', async () => {
    const stdoutSpy = vi.spyOn(ChildProcessHelper.prototype, 'getStdout');
    probeOutput(JSON.stringify({ streams: [{ codec_type: 'video' }] }));
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    await info.probeStreamLayout(
      'http://media.test/video?api_key=fixture-token',
      {
        'X-Emby-Token': 'fixture-header',
      },
      3000,
    );
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/configured/ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name:stream_disposition=attached_pic',
        '-headers',
        'X-Emby-Token: fixture-header\r\n',
        '-of',
        'json',
        'http://media.test/video?api_key=fixture-token',
      ],
      {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      expect.any(Function),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  test('returns unavailable on process errors, without exposing their arguments', async () => {
    probeOutput('', new Error('fixture-token in an exec error'));
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    await expect(
      info.probeStreamLayout('http://media.test/video?api_key=fixture-token'),
    ).resolves.toBeUndefined();
  });

  test('does not spawn for malformed header values or an unbounded timeout', async () => {
    const info = new FfmpegInfo('/configured/ffmpeg', '/configured/ffprobe');
    await expect(
      info.probeStreamLayout('http://media.test/video', {
        'X-Emby-Token': 'fixture\r\nOther: injected',
      }),
    ).resolves.toBeUndefined();
    await expect(
      info.probeStreamLayout('/media/input.ts', undefined, 0),
    ).resolves.toBeUndefined();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
