import { isNonEmptyString } from '@tunarr/shared/util';
import type { MediaSubtitles } from '@tunarr/types';
import { injectable } from 'inversify';
import fs from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { match, P } from 'ts-pattern';
import type { Nullable } from '../../types/util.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { LoggerFactory } from '../../util/logging/LoggerFactory.ts';
import { LanguageService } from '../LanguageService.ts';

@injectable()
export class LocalSubtitlesService {
  private static _logger?: Logger;
  private static get logger() {
    return (this._logger ??= LoggerFactory.child({
      className: LocalSubtitlesService.name,
    }));
  }
  constructor() {}

  async findExternalSubtitles(fullItemPath: string) {
    const subtitles: MediaSubtitles[] = [];
    const itemName = basename(fullItemPath, extname(fullItemPath));
    for (const dirent of await fs.readdir(dirname(fullItemPath), {
      withFileTypes: true,
    })) {
      if (!dirent.isFile()) {
        continue;
      }

      if (!dirent.name.startsWith(itemName)) {
        continue;
      }

      const parsedSubtitles = LocalSubtitlesService.parseSubtitleFilePath(
        fullItemPath,
        join(dirname(fullItemPath), dirent.name),
      );

      if (!parsedSubtitles) {
        continue;
      }

      subtitles.push(parsedSubtitles);
    }

    return subtitles;
  }

  static parseSubtitleFilePath(
    originalItemPath: string,
    fullPath: string,
  ): Nullable<MediaSubtitles> {
    const itemName = basename(originalItemPath, extname(originalItemPath));
    const fileName = basename(fullPath);
    const extension = extname(fileName);
    const codec = match(extension.toLowerCase())
      .with(P.union('.ssa', '.ass'), () => 'ass')
      .with('.srt', () => 'subrip')
      .with('.vtt', () => 'webvtt')
      .otherwise(() => null);

    if (!codec) {
      return null;
    }

    const subtitleName = basename(fileName, extension);
    if (!subtitleName.startsWith(itemName)) {
      return null;
    }

    // Interpret only the suffix after the complete video basename, so a
    // language or flag in the title is not mistaken for subtitle metadata.
    const suffix = subtitleName.slice(itemName.length);
    if (suffix.length > 0 && !/^[.\s_-]/.test(suffix)) {
      return null;
    }
    const tokens = suffix
      .toLowerCase()
      .split(/[.\s_-]+/)
      .filter((s) => s.length > 0);
    const languageTokens = tokens.filter(
      (token) => !['forced', 'sdh', 'cc', 'default'].includes(token),
    );
    // HI is Hindi when it is the language token; alongside another language
    // it is the established hearing-impaired filename marker.
    const lang =
      languageTokens.find((token) =>
        isNonEmptyString(LanguageService.normalizeToAlpha3T(token)),
      ) ??
      languageTokens[0] ??
      '';
    const sdh =
      tokens.includes('sdh') ||
      tokens.includes('cc') ||
      (tokens.includes('hi') && lang !== 'hi');
    const forced = tokens.includes('forced');
    const maybeLang3T = LanguageService.normalizeToAlpha3T(lang);

    if (isNonEmptyString(maybeLang3T)) {
      return {
        codec,
        language: maybeLang3T,
        subtitleType: 'sidecar',
        default: false,
        forced,
        sdh,
        path: fullPath,
      };
    } else {
      this.logger.debug(
        'Found unknown subtitle language (%s) for file: %s',
        lang,
        fullPath,
      );
      return {
        codec,
        language: lang,
        subtitleType: 'sidecar',
        default: false,
        forced,
        sdh,
        path: fullPath,
      };
    }
  }
}
