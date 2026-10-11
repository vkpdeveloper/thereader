import { utf8Decode } from './bytes';
import { clean } from './epub';
import { childElements, innerText, parseXml, type XmlElement } from './xml';

/** Library metadata of a comic, from `ComicInfo.xml` or the file name (docs/comics.md "Metadata"). */
export interface ComicMetadata {
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
}

/** `ComicInfo.xml` is a few KiB; anything far larger is not metadata. */
export const MAX_COMIC_INFO_BYTES = 1024 * 1024;

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** File name without its extension, `_` → space, trimmed. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return clean((dot > 0 ? base.slice(0, dot) : base).replace(/_/g, ' '), 300);
}

/** Metadata from `ComicInfo.xml` bytes (null when absent or unreadable), falling back to `fileName`. */
export function comicMetadata(info: Uint8Array | null, fileName: string): ComicMetadata {
  const root = info === null ? null : parseComicInfo(info);
  const field = (name: string, limit: number): string => {
    const element = root === null ? undefined : childElements(root).find((child) => child.local === name);
    return element === undefined ? '' : clean(innerText(element), limit);
  };
  const series = field('Series', 300);
  const number = field('Number', 40);
  const title = field('Title', 300);
  const head = series && number ? `${series} #${number}` : series;
  const composed = head && title ? `${head}: ${title}` : head || title;
  const language = field('LanguageISO', 32);
  const genres = field('Genre', 4000)
    .split(',')
    .map((genre) => clean(genre, 100))
    .filter((genre) => genre.length > 0);
  return {
    title: clean(composed, 300) || titleFromFileName(fileName) || 'Untitled',
    author: field('Writer', 300) || field('Penciller', 300) || 'Unknown',
    description: field('Summary', 4000),
    language: LANGUAGE.test(language) ? language : 'en',
    subjects: [...new Set(['Comics', ...genres])].slice(0, 32),
  };
}

/** The `<ComicInfo>` root, or null: metadata never blocks an import. */
function parseComicInfo(bytes: Uint8Array): XmlElement | null {
  if (bytes.length > MAX_COMIC_INFO_BYTES) return null;
  // Like EPUB metadata: drop an external DTD declaration, refuse internal subsets.
  const text = utf8Decode(bytes).replace(/<!DOCTYPE\s+[^>[]*>/g, '');
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) return null;
  try {
    const root = parseXml(text);
    return root.local === 'ComicInfo' ? root : null;
  } catch {
    return null;
  }
}
