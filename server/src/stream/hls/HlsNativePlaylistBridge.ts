export type NativeSubtitlePlaylist = {
  playlistName: string;
  /** Filename stem FFmpeg derives its WebVTT segment names from. */
  segmentPrefix: string;
};

/**
 * Repairs FFmpeg 7's HLS restart metadata without selecting or rebuilding its
 * media windows. FFmpeg owns every entry, URI number, duration and timestamp.
 */
export class HlsNativePlaylistBridge {
  private subtitleUris = new Map<string, Map<number, string>>();
  private segmentPrefixes = new Map<string, string>();
  private sequenceFloors = new Map<string, number>([['stream.m3u8', 0]]);
  private discontinuities = new Set<number>();
  private retiredDiscontinuities = 0;

  constructor(subtitlePlaylists: readonly (string | NativeSubtitlePlaylist)[]) {
    for (const playlist of subtitlePlaylists) {
      const { playlistName, segmentPrefix } =
        typeof playlist === 'string'
          ? {
              playlistName: playlist,
              // Direct slot playlists are subtitle_<id>.m3u8 and their
              // discard-side AV playlist subtitle_<id>_av_.m3u8, whose stem
              // hlsenc uses for the WebVTT segment names.
              segmentPrefix: `${playlist.replace(/\.m3u8$/, '')}_av_`,
            }
          : playlist;
      this.subtitleUris.set(playlistName, new Map());
      this.segmentPrefixes.set(playlistName, segmentPrefix);
      this.sequenceFloors.set(playlistName, 0);
    }
  }

  beginProgram(sequence: number): void {
    if (sequence > 0) this.discontinuities.add(sequence);
  }

  repairVideo(lines: readonly string[]): string[] {
    let sequence = this.sequence(lines);
    let pendingDiscontinuity = false;
    let inEntry = false;
    for (const line of lines) {
      if (line.trim() === '#EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
      } else if (line.startsWith('#EXTINF:')) {
        inEntry = true;
      } else if (inEntry && line.trim() && !line.startsWith('#')) {
        if (pendingDiscontinuity) this.discontinuities.add(sequence);
        pendingDiscontinuity = false;
        inEntry = false;
        sequence++;
      }
    }
    const repaired = this.repairMetadata(lines);
    this.sequenceFloors.set('stream.m3u8', this.sequence(lines));
    this.retireBoundaries();
    return repaired;
  }

  repairSubtitles(name: string, lines: readonly string[]): string[] {
    const knownUris = this.subtitleUris.get(name);
    const segmentPrefix = this.segmentPrefixes.get(name);
    if (!knownUris || segmentPrefix === undefined)
      throw new Error('Unregistered native subtitle playlist');
    let sequence = this.sequence(lines);
    let inEntry = false;
    const currentUris = new Map<number, string>();
    const repairedUris = lines.map((line) => {
      if (line.startsWith('#EXTINF:')) {
        inEntry = true;
      } else if (inEntry && line.trim() && !line.startsWith('#')) {
        const uri = line.trim();
        const isLostUri = uri === '.' || uri.endsWith('/.');
        // hlsenc numbers every WebVTT segment with its media sequence under
        // the AV playlist stem, so an inherited entry FFmpeg rewrote to '.'
        // is exactly <base><prefix><sequence>.vtt. The snapshot taken before
        // the restart is preferred when present; the derivation covers a
        // snapshot that was missed, instead of failing the rendition.
        const restored = isLostUri
          ? (knownUris.get(sequence) ??
            `${uri.slice(0, uri.length - 1)}${segmentPrefix}${sequence}.vtt`)
          : line;
        currentUris.set(sequence++, restored);
        inEntry = false;
        return restored;
      }
      return line;
    });
    const repaired = this.repairMetadata(repairedUris);
    this.subtitleUris.set(name, currentUris);
    this.sequenceFloors.set(name, this.sequence(lines));
    this.retireBoundaries();
    return repaired;
  }

  nextSequence(lines: readonly string[]): number {
    return (
      this.sequence(lines) +
      lines.filter((line) => line.startsWith('#EXTINF:')).length
    );
  }

  private repairMetadata(lines: readonly string[]): string[] {
    const startSequence = this.sequence(lines);
    let sequence = startSequence;
    const beforeWindow =
      this.retiredDiscontinuities +
      [...this.discontinuities].filter((boundary) => boundary < startSequence)
        .length;
    const result: string[] = [];
    for (const line of lines) {
      const tag = line.trim();
      if (
        tag === '#EXT-X-ENDLIST' ||
        tag === '#EXT-X-DISCONTINUITY' ||
        tag.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')
      )
        continue;
      if (line.startsWith('#EXTINF:')) {
        if (this.discontinuities.has(sequence))
          result.push('#EXT-X-DISCONTINUITY');
        sequence++;
      }
      result.push(line);
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        result.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${beforeWindow}`);
      }
    }
    if (!lines.some((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))) {
      result.splice(1, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${beforeWindow}`);
    }
    return result;
  }

  private sequence(lines: readonly string[]): number {
    for (const line of lines) {
      const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line);
      if (match?.[1] !== undefined) return Number(match[1]);
    }
    return 0;
  }

  private retireBoundaries() {
    const floor = Math.min(...this.sequenceFloors.values());
    for (const boundary of this.discontinuities) {
      if (boundary < floor) {
        this.discontinuities.delete(boundary);
        this.retiredDiscontinuities++;
      }
    }
  }
}
