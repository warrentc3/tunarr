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
