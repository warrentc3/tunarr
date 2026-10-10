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
    // The suffix is a strict grammar: dot- or space-separated tokens, each a
    // flag, a language, or a language joined by '-' or '_' to a region or
    // script qualifier or to a flag (pt-BR, zh-Hant, eng_sdh). Any other
    // token means the file belongs to a sibling title whose name extends this
    // video's, such as "Episode 2.eng.srt" beside "Episode.mkv", and is not
    // this video's subtitle at all.
    const flagTokens = new Set(['forced', 'sdh', 'cc', 'hi', 'default']);
    const privateUse = /^q[a-t][a-z]$/;
    const flags = new Set<string>();
    const languageTokens: string[] = [];
    for (const token of suffix
      .toLowerCase()
      .split(/[.\s]+/)
      .filter((s) => s.length > 0)) {
      if (flagTokens.has(token)) {
        flags.add(token);
        continue;
      }
      const [head, ...qualifiers] = token
        .split(/[-_]+/)
        .filter((s) => s.length > 0);
      if (
        head === undefined ||
        (!isNonEmptyString(LanguageService.normalizeToAlpha3T(head)) &&
          !privateUse.test(head))
      ) {
        return null;
      }
      for (const qualifier of qualifiers) {
        if (flagTokens.has(qualifier)) {
          flags.add(qualifier);
        } else if (!/^[a-z]{2,4}$/.test(qualifier)) {
          return null;
        }
      }
      languageTokens.push(head);
    }
    if (languageTokens.length > 1) {
      return null;
    }
    // HI is Hindi when it is the only language token; alongside another
    // language it is the established hearing-impaired filename marker.
    let lang = languageTokens[0] ?? '';
    let hearingImpaired = flags.has('hi');
    if (lang === '' && hearingImpaired) {
      lang = 'hi';
      hearingImpaired = false;
    }
    const sdh = flags.has('sdh') || flags.has('cc') || hearingImpaired;
    const forced = flags.has('forced');
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
