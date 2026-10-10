# Channel Trancoding Settings

## Stream Mode

Tunarr supports several different stream modes that can be set at the channel level.

!!! info

    No matter which stream mode you choose for a channel, clients which require an MPEG-TS stream will still work.

### HLS (recommended)

HLS is the default streaming mode for a channel. In our testing, it is generally the most reliable and efficient. It is akin to [ErsatzTV's](https://ersatztv.org/) "HLS Segmenter" mode.

#### How does it work?

This mode creates a single FFMPEG process, per-program. The process applies all transcoding configuration necessary. Tunarr manages interleaving these processes to create seamless m3u8 playlists for playback.

#### Things to consider

In our testing, we've found this mode to be both efficient and reliable. That said, it is also the newest mode introduced to Tunarr, so there might be some kinks to work out.

### HLS alt

HLS alt (name pending!) is another HLS streaming mode, which operates a little differently. This mode is akin to [ErsatzTV's](https://ersatztv.org/) "HLS Segmenter V2" mode.

#### How does it work?

This mode creates two FFMPEG processes. The first runs per-program and applies scaling/cropping, watermarks, frame rate changes, etc, but outputs a rawvideo stream. The second process concatenates all of these together while also applying bit rate limits and codec changes.

#### Things to consider

The downside to this mode is that the one of the steps (the per-program process) _requires_ software encoding. This can put a lot of stress on certain systems. The stream setup can also lead to quality loss, due to generation loss. However, it does have the potential to create a more reliable / robust stream.

### HLS Direct

#### How does it work?

This mode does not perform any stream normalization. When the channel m3u8 playlist is requested, it returns a playlist with a single item URL set to the duration of the current item in the channel. The URL returns a direct stream of the item, remuxed to the container configured in the ffmpeg settings (MPEG-TS, MKV, or MP4).

#### Things to consider

Because this mode does not perform stream normalization, there may be issues when transitioning between programs; the mode requires clients to essentially "reset" themselves between each program for transitions to function as expected. Some clients that are known to work in this mode are Jellyfin and MPV, but there are almost certainly others.

### HLS Direct v2

#### How does it work?

HLS Direct v2 produces a continuous HLS playlist of segmented chunks, using the same structure as regular HLS mode. Source video is copied into the segments. Audio codecs incompatible with the output container can be converted. HLS Direct instead returns a single-item m3u8 pointing directly to the program stream.

Direct v2 maps one non-cover video and one audio track. Audio selection uses the applicable stream-selection profile, or the global audio language preferences when no profile applies. The selected input becomes the single output audio track; other source audio tracks are not advertised as alternatives. Existing DTS/TrueHD compatibility conversion to AC-3 still applies to the selected track.

Tunarr retains source and track bitrate information during library scans and uses it to supply the HLS master playlist's bandwidth estimate. Matroska track statistics are read when available. Force-rescan existing libraries after upgrading to populate this metadata; records without it use playback-time measurement as a fallback. The estimate does not change the copied video or require converting the source file to another container.

With the experimental sidecar feature and channel subtitles enabled, the channel's ordered subtitle language filter defines its selectable WebVTT renditions. With no language filter, subtitles are disabled. Each configured language has three fixed options: Regular, SDH and Forced. Their names and playlist URLs remain the same across programmes; clients do not need a new master to discover the next programme's tracks.

Regular uses a plain dialogue track, excluding forced and SDH tracks. If only SDH exists, it also fills Regular. SDH uses the SDH track, or a copy of Regular when no SDH track exists. Forced uses the forced track or remains empty. Container default/enabled flags do not choose or classify these tracks. Embedded and adjacent text tracks form one inventory; a missing extraction does not exclude an embedded track. External files are resolved during scanning, so playback does not download missing sidecars.

The Forced option for the first language in priority order is the group's default and autoselect option. Other options are available for manual selection; SDH carries its accessibility characteristics. An empty option still advances alongside A/V with valid, cue-free WebVTT segments. FFmpeg writes the live playlists; Tunarr only enriches the master and repairs FFmpeg 7.1.1's programme-boundary discontinuities, end markers and inherited subtitle URIs.

Each configured language adds three HLS muxers to the programme's FFmpeg process. Each of them receives the full audio and video stream, so that its subtitle segments stay on the video clock, and discards that copy; keep the language list short. A subtitle option that fails to write stops advancing until the next programme and does not interrupt audio and video.

Image subtitles are excluded because they require burn-in. Text formats that the bundled FFmpeg cannot decode, such as TTML and Blu-ray text subtitles, are excluded as well, because a track FFmpeg cannot convert would stop the programme's single output process. Attached cover pictures are excluded from video selection and copying; intentional image inputs such as offline screens remain available.

#### Things to consider

Users who want direct streaming without transcoding may find this mode more compatible than HLS Direct, particularly with clients that do not rely on FFmpeg's HLS demuxer implementation. Because the output is a standard segmented HLS playlist, clients that expect that structure should handle program transitions more gracefully than they would with HLS Direct.

As with HLS Direct, no stream normalization is applied, so mixed source formats (different codecs, resolutions, frame rates) across lineup items may cause playback issues depending on the client.

### MPEG-TS

This mode is the closest to the DizqueTV experience.

#### How does it work?

It consists of two FFMPEG processes, one which performs the per-program transcode, outputting an mpeg-ts stream and one which concatenates this raw stream together and outputs it.

#### Things to consider

If this mode was "good enough" we probably wouldn't have spent time implementing the other modes! There are a lot of potential issues with this mode; too many to list here.
