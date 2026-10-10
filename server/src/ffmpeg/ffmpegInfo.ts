import { FfprobeMediaInfoSchema } from '@/types/ffmpeg.js';
import { KEYS } from '@/types/inject.js';
import { Result } from '@/types/result.js';
import type { Nullable } from '@/types/util.js';
import type { GetStdoutOptions } from '@/util/ChildProcessHelper.js';
import { ChildProcessHelper } from '@/util/ChildProcessHelper.js';
import { cacheGetOrSet } from '@/util/cache.js';
import dayjs from '@/util/dayjs.js';
import { InjectLogger } from '@/util/inject.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import { seq } from '@tunarr/shared/util';
import { inject, injectable } from 'inversify';
import {
  drop,
  filter,
  isEmpty,
  isError,
  map,
  nth,
  reject,
  some,
  split,
  trim,
} from 'lodash-es';
import NodeCache from 'node-cache';
import { execFile } from 'node:child_process';
import { format } from 'node:util';
import { z } from 'zod';
import { attempt, isNonEmptyString, parseIntOrNull } from '../util/index.ts';
import { FfmpegCapabilities } from './builder/capabilities/FfmpegCapabilities.ts';
import { bitrateFromSize, positiveBitrate } from '../stream/SourceBitrate.ts';

const CacheKeys = {
  ENCODERS: 'encoders',
  HWACCELS: 'hwaccels',
  OPTIONS: 'options',
  NVIDIA: 'nvidia',
  VAINFO: 'vainfo_%s_%s',
  FILTERS: 'filters',
} as const;

export type FfmpegVersionResult = {
  versionString: string;
  majorVersion?: Nullable<number>;
  minorVersion?: Nullable<number>;
  patchVersion?: Nullable<number>;
  versionDetails?: Nullable<string>;
  isUnknown: boolean;
};

export type FfmpegEncoder = {
  ffmpegName: string;
  name: string;
};

export type FfprobeStreamLayout = {
  videoCount: number;
  audioCount: number;
  hasData: boolean;
};

const FfprobeStreamLayoutSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.enum([
          'video',
          'audio',
          'subtitle',
          'data',
          'attachment',
        ]),
        codec_name: z.string().optional(),
        disposition: z
          .object({ attached_pic: z.number().optional() })
          .optional(),
      }),
    )
    .nonempty(),
});

const VersionExtractionPattern = /version\s+([^\s]+)\s+.*Copyright/;
const VersionNumberExtractionPattern = /n?(\d+)\.(\d+)(\.(\d+))?[_\-.]*(.*)/;
const CoderExtractionPattern = /[A-Z.]+\s([a-z0-9_-]+)\s*(.*)$/;
export const FFmpegOptionsExtractionPattern = /^-([a-z_]+)\s+.*/m;
const FfmpegFilterExtractionPattern = /^\s*?[A-Z.]+\s+(\w+).*/m;

@injectable()
export class FfmpegInfo {
  private static resultCache: NodeCache = new NodeCache({
    stdTTL: dayjs.duration({ hours: 1 }).asSeconds(),
  });

  private static makeCacheKey(
    path: string,
    command: keyof typeof CacheKeys,
    ...args: string[]
  ): string {
    return format(`${path}_${CacheKeys[command]}`, ...args);
  }

  private childProcessHelper = new ChildProcessHelper();

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(KEYS.FFmpegPath) private ffmpegPath: string,
    @inject(KEYS.FFprobePath) private ffprobePath: string,
  ) {}

  async seed() {
    this.logger.debug('Seeding ffmpeg info');
    try {
      return await Promise.allSettled([
        this.getAvailableAudioEncoders(),
        this.getAvailableVideoEncoders(),
        this.getHwAccels(),
        this.getOptions(),
        this.getFilters(),
      ]);
    } catch (e) {
      this.logger.error(e, 'Unexpected error during ffmpeg info seed');
      return;
    }
  }

  async getVersion(): Promise<FfmpegVersionResult> {
    try {
      const s = await this.getFfmpegStdout(['-version']);
      return this.parseFfmpegVersion(s, 'ffmpeg');
    } catch (err) {
      this.logger.error(err);
      return { versionString: 'unknown', isUnknown: true };
    }
  }

  async getFfprobeVersion(): Promise<FfmpegVersionResult> {
    try {
      const s = await this.getFfprobeStdout(['-version']);
      return this.parseFfmpegVersion(s, 'ffprobe');
    } catch (err) {
      this.logger.error(err);
      return { versionString: 'unknown', isUnknown: true };
    }
  }

  parseFfmpegVersion(
    output: string,
    app: string = 'ffmpeg',
  ): FfmpegVersionResult {
    const m = output.match(VersionExtractionPattern);
    if (!m) {
      this.logger.warn(
        `${app} -version command output not in the expected format: ${output}`,
      );
      return { versionString: 'unknown', isUnknown: true };
    }
    const versionString = m[1]!;

    const extractedNums = versionString.match(VersionNumberExtractionPattern);

    if (!extractedNums) {
      return { versionString, isUnknown: true };
    }

    const majorString = nth(extractedNums, 1);
    const minorString = nth(extractedNums, 2);
    const patchString = nth(extractedNums, 4);
    const rest = nth(extractedNums, 5);
    const majorNum = isNonEmptyString(majorString)
      ? parseIntOrNull(majorString)
      : null;
    const minorNum = isNonEmptyString(minorString)
      ? parseIntOrNull(minorString)
      : null;
    const patchNum = isNonEmptyString(patchString)
      ? parseIntOrNull(patchString)
      : null;

    return {
      versionString,
      majorVersion: majorNum,
      minorVersion: minorNum,
      patchVersion: patchNum,
      versionDetails: rest,
      isUnknown: false,
    };
  }

  async getAvailableAudioEncoders(): Promise<Result<FfmpegEncoder[]>> {
    return Result.attemptAsync(async () => {
      const out = await cacheGetOrSet(
        FfmpegInfo.resultCache,
        this.cacheKey('ENCODERS'),
        () => this.getFfmpegStdout(['-hide_banner', '-encoders']),
      );

      const matchingLines = seq.collect(
        filter(split(out, '\n'), (line) => /^\s*?A/.test(line)),
        (line) => line.trim().match(CoderExtractionPattern),
      );
      return map(
        reject(matchingLines, (arr) => arr.length < 3),
        (arr) => ({ ffmpegName: arr[1]!, name: arr[2]! }),
      );
    });
  }

  async getAvailableVideoEncoders(): Promise<Result<FfmpegEncoder[]>> {
    return Result.attemptAsync(async () => {
      const out = await cacheGetOrSet(
        FfmpegInfo.resultCache,
        this.cacheKey('ENCODERS'),
        () => this.getFfmpegStdout(['-hide_banner', '-encoders']),
      );

      const matchingLines = seq.collect(
        filter(split(out, '\n'), (line) => /^\s*?V/.test(line)),
        (line) => line.trim().match(CoderExtractionPattern),
      );

      return map(
        reject(matchingLines, (arr) => arr.length < 3),
        (arr) => ({ ffmpegName: arr[1]!, name: arr[2]! }),
      );
    });
  }

  async hasVideoDecoder(name: string) {
    const available = await this.getAvailableVideoEncoders();
    // TODO should we be throwing here?
    if (isError(available)) {
      throw available;
    }
    return some(available, { name });
  }

  async getHwAccels() {
    const res = await attempt(async () => {
      const out = await cacheGetOrSet(
        FfmpegInfo.resultCache,
        this.cacheKey('HWACCELS'),
        () => this.getFfmpegStdout(['-hide_banner', '-hwaccels']),
      );

      return reject(map(drop(split(out, '\n'), 1), trim), (s) => isEmpty(s));
    });

    return isError(res) ? [] : res;
  }

  async getOptions() {
    return Result.attemptAsync(async () => {
      const out = await cacheGetOrSet(
        FfmpegInfo.resultCache,
        this.cacheKey('OPTIONS'),
        () => this.getFfmpegStdout(['-hide_banner', '-help', 'long']),
      );

      const nonEmptyLines = reject(map(drop(split(out, '\n'), 1), trim), (s) =>
        isEmpty(s),
      );

      return seq.collect(nonEmptyLines, (line) => {
        return line.match(FFmpegOptionsExtractionPattern)?.[1];
      });
    });
  }

  async getFilters() {
    return Result.attemptAsync(async () => {
      const out = await cacheGetOrSet(
        FfmpegInfo.resultCache,
        this.cacheKey('FILTERS'),
        () => this.getFfmpegStdout(['-hide_banner', '-filters']),
      );

      const nonEmptyLines = reject(map(drop(split(out, '\n'), 1), trim), (s) =>
        isEmpty(s),
      );

      return seq.collect(nonEmptyLines, (line) => {
        return line.match(FfmpegFilterExtractionPattern)?.[1];
      });
    });
  }

  async hasOption(
    option: string,
    defaultOnMissing: boolean = false,
    defaultOnError: boolean = false,
  ) {
    const opts = await this.getOptions();
    if (opts.isFailure()) {
      return defaultOnError;
    }
    return opts.get().includes(option) ? true : defaultOnMissing;
  }

  async getCapabilities() {
    const [optionsResult, encodersResult, filtersResult, hwAccelResult] =
      await Promise.allSettled([
        this.getOptions(),
        this.getAvailableVideoEncoders(),
        this.getFilters(),
        this.getHwAccels(),
      ]);

    return new FfmpegCapabilities(
      optionsResult.status === 'rejected'
        ? new Set()
        : optionsResult.value
            .map((arr) => new Set(arr))
            .getOrElse(() => new Set()),
      encodersResult.status === 'rejected'
        ? new Map<string, FfmpegEncoder>()
        : encodersResult.value
            .map(
              (arr) =>
                new Map(
                  arr.map((encoder) => [encoder.ffmpegName, encoder] as const),
                ),
            )
            .getOrElse(() => new Map<string, FfmpegEncoder>()),
      filtersResult.status === 'rejected'
        ? new Set()
        : filtersResult.value
            .map((arr) => new Set(arr))
            .getOrElse(() => new Set()),
      hwAccelResult.status === 'rejected'
        ? new Set()
        : new Set(hwAccelResult.value),
    );
  }

  async probeFile(path: string, timeout?: number) {
    const output = await this.getFfprobeStdout(
      [
        '-hide_banner',
        '-print_format',
        'json',
        '-show_format',
        '-show_chapters',
        '-show_streams',
        `${path}`,
      ],
      { timeout, swallowError: false },
    );

    const result = await FfprobeMediaInfoSchema.safeParseAsync(
      JSON.parse(output),
      { reportInput: true },
    );

    if (!result.success) {
      this.logger.warn(
        result.error,
        'Unable to parse ffprobe output for file %s. Raw output: %s',
        path,
        output,
      );
      return;
    }

    return result.data;
  }

  /** Only used when scan-time rate facts are unavailable. Never logs credentials. */
  async probeSourceBitrate(
    path: string,
    headers?: Readonly<Record<string, string>>,
  ) {
    const headerEntries = Object.entries(headers ?? {});
    if (
      headerEntries.some(
        ([name, value]) =>
          !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value),
      )
    )
      return;
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=bit_rate,size,duration',
      '-of',
      'json',
    ];
    if (headerEntries.length > 0) {
      args.push(
        '-headers',
        headerEntries.map(([name, value]) => `${name}: ${value}\r\n`).join(''),
      );
    }
    args.push(path);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          this.ffprobePath,
          args,
          {
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout) => {
            if (error !== null) {
              reject(new Error('Unable to measure source bitrate'));
              return;
            }
            resolve(stdout);
          },
        );
      });
      const parsed = z
        .object({
          format: z.object({
            bit_rate: z.coerce.number().optional(),
            size: z.coerce.number().optional(),
            duration: z.coerce.number().optional(),
          }),
        })
        .safeParse(JSON.parse(output));
      if (!parsed.success) return;
      const source = parsed.data.format;
      return (
        positiveBitrate(source.bit_rate) ??
        bitrateFromSize(
          source.size,
          source.duration === undefined ? undefined : source.duration * 1000,
        )
      );
    } catch {
      return;
    }
  }

  /**
   * Probe actual mapped streams, including attached-picture dispositions.
   * Unknown/failed layouts retain the legacy data-preserving subtitle output.
   */
  async probeStreamLayout(
    path: string,
    headers?: Readonly<Record<string, string>>,
    timeout: number = 5_000,
  ): Promise<FfprobeStreamLayout | undefined> {
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    const args = [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name:stream_disposition=attached_pic',
    ];
    const headerEntries = Object.entries(headers ?? {});
    if (headerEntries.length > 0) {
      if (
        headerEntries.some(
          ([name, value]) =>
            !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value),
        )
      )
        return;
      args.push(
        '-headers',
        headerEntries.map(([name, value]) => `${name}: ${value}\r\n`).join(''),
      );
    }
    args.push('-of', 'json', path);
    try {
      // The ordinary helper logs argv; source URLs and headers can contain
      // credentials. Neither argv nor child-process errors are logged here.
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          this.ffprobePath,
          args,
          {
            timeout: Math.min(timeout, 5_000),
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout) => {
            if (error !== null) {
              reject(new Error('Unable to probe input stream layout'));
              return;
            }
            resolve(stdout);
          },
        );
      });
      const parsed = FfprobeStreamLayoutSchema.safeParse(JSON.parse(output));
      if (!parsed.success) return;
      return {
        // Match -map 0:V. Codec/extension is not a cover classification;
        // unflagged MJPEG and intentionally generated still video remain valid.
        videoCount: parsed.data.streams.filter(
          (stream) =>
            stream.codec_type === 'video' &&
            stream.disposition?.attached_pic !== 1,
        ).length,
        audioCount: parsed.data.streams.filter(
          (stream) => stream.codec_type === 'audio',
        ).length,
        hasData: parsed.data.streams.some(
          (stream) =>
            stream.codec_type === 'data' || stream.codec_name === 'bin_data',
        ),
      };
    } catch {
      return;
    }
  }

  private getFfmpegStdout(
    args: string[],
    opts: GetStdoutOptions = { swallowError: false },
  ): Promise<string> {
    return this.getStdout(this.ffmpegPath, args, opts);
  }

  private getFfprobeStdout(
    args: string[],
    opts: GetStdoutOptions = { swallowError: false },
  ): Promise<string> {
    return this.getStdout(this.ffprobePath, args, opts);
  }

  private getStdout(
    executable: string,
    args: string[],
    opts?: GetStdoutOptions,
  ): Promise<string> {
    return this.childProcessHelper.getStdout(executable, args, opts);
  }

  private cacheKey(key: keyof typeof CacheKeys): string {
    return FfmpegInfo.makeCacheKey(this.ffmpegPath, key);
  }
}
