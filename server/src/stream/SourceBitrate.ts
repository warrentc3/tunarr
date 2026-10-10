import type { StreamDetails } from './types.ts';

/** Source and track rates are bits/s; encoder configuration elsewhere is kbit/s. */
export function positiveBitrate(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;
}

export function bitrateFromSize(
  sizeBytes: number | undefined,
  durationMs: number | undefined,
) {
  if (
    sizeBytes === undefined ||
    durationMs === undefined ||
    !Number.isFinite(sizeBytes) ||
    !Number.isFinite(durationMs) ||
    sizeBytes <= 0 ||
    durationMs <= 0
  )
    return;
  return positiveBitrate((sizeBytes * 8_000) / durationMs);
}

/**
 * One Direct v2 variant carries all mapped A/V. A reported source total already
 * includes its audio: do not add track rates to it. Use a complete component
 * sum only when the total is unavailable, then full-file size/duration.
 * FFmpeg supplies its own running-master allowance; this is an estimate, not
 * an encoder target or an exact peak-bandwidth claim.
 */
export function estimateSourceBitrate(
  details: StreamDetails,
): number | undefined {
  const total = positiveBitrate(details.bitrate);
  if (total !== undefined) return total;
  const tracks = [
    ...(details.videoDetails ?? []).filter((stream) => !stream.isAttachedPic),
    ...(details.audioDetails ?? []),
  ];
  const rates = tracks.map(
    (stream) =>
      positiveBitrate(stream.bitrate) ??
      positiveBitrate(stream.statisticsBitrate),
  );
  if (rates.length > 0 && rates.every((rate) => rate !== undefined)) {
    return positiveBitrate(rates.reduce((sum, rate) => sum + rate, 0));
  }
  return bitrateFromSize(details.sourceSizeBytes, details.sourceFileDurationMs);
}
