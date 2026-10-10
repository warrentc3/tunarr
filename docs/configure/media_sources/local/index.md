# Local Media

Local Media Sources allow scheduling media from your filesystem without requiring a media server like Plex or Jellyfin.

Tunarr traverses folders to discover metadata and media files which can then be scheduled to channels.

<div class="grid cards" markdown>

-   **[Movies](movies.md)**

    ---

    Add movie files with NFO metadata support.

-   **[Shows](shows.md)**

    ---

    Add TV series with episode organization and NFO metadata.

-   **[Other Videos](other_videos.md)**

    ---

    Add unstructured video files without specific metadata requirements.

-   **[Music](music.md)**

    ---

    Add music libraries with artist/album organization and embedded metadata support.

-   **[Music Videos](music_videos.md)**

    ---

    Add music video files with artist, album, and genre metadata via NFO files.

</div>

## Generating Metadata

There are many ways to generate NFO files for consumption by Tunarr if your media does not already have them. Popular *arr stack programs, Jellyfin, and Emby all support writing out NFO files for media.

## External Subtitles

Local scans discover SRT, VTT, ASS, and SSA subtitle files next to their video. Start the subtitle filename with the complete video basename, then add the language and any `forced`, `sdh`, `cc`, or `hi` markers before the extension. For example, `Episode.mkv` can have `Episode.eng.forced.srt` and `Episode.en.sdh.vtt`.

Language codes and English language names are recognized. Regional suffixes such as `en-US` resolve to the base language. `hi` identifies Hindi when it is the language; after another language, it marks hearing-impaired subtitles. A literal `default` filename marker is ignored and does not make a subtitle the default.

Run a forced library scan to discover sidecars for media that was already scanned. Subtitle selection follows the channel's language and subtitle preferences. HLS Direct v2 serves text subtitles as selectable WebVTT renditions; image subtitles require burn-in and are excluded from that mode.

## Folder Structure

For best results, organize your media following standard conventions:

**Movies:**
```
/movies/
  Movie Name (2024)/
    Movie Name (2024).mkv
    Movie Name (2024).nfo
```

**TV Shows:**
```
/shows/
  Show Name/
    Season 01/
      Show Name - S01E01 - Episode Title.mkv
      Show Name - S01E01 - Episode Title.nfo
```

**Other Videos**
```
commercials/
|
├ 1999/
| ├ Coke.mkv
| └ Coke.nfo
|
├ 2000/
| └ Food/ 
|   ├ Burger King.mkv
|   └ Burger King.nfo
|
├ Random.mkv
├ Random.nfo
|
```

**Music:**
```
/music/
  Artist Name/
    artist.nfo
    Album Name (2024)/
      album.nfo
      01 - Track Title.flac
```
