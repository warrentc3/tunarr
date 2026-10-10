import { describe, expect, test } from 'vitest';
import {
  defaultHlsOptions,
  HlsDirectOutputFormat,
  MpegTsOutputFormat,
} from '../constants.ts';
import { FfmpegState } from './FfmpegState.ts';

describe('FfmpegState output isolation', () => {
  test('creating Direct v2 state does not change existing states or the remux default', () => {
    const version = {
      versionString: '7.1.1',
      majorVersion: 7,
      minorVersion: 1,
      patchVersion: 1,
      isUnknown: false,
    };
    const existing = FfmpegState.create({ version });
    const direct = FfmpegState.create({
      version,
      outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
      hlsDirectStreamCopy: { audioInputIndex: 19 },
    });
    const remux = FfmpegState.create({ version, copyAllStreams: true });
    expect(direct.outputFormat.type).toBe('hls_direct_v2');
    expect(existing.outputFormat).toEqual({ type: 'mpegts' });
    expect(remux.outputFormat).toEqual({ type: 'mpegts' });
    expect(MpegTsOutputFormat).toEqual({ type: 'mpegts' });
    expect(remux.outputFormat).not.toBe(MpegTsOutputFormat);
  });
});
