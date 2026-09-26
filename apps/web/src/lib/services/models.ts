import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  defaultReaderPreferences,
  type Book,
  type DownloadState,
  type Highlight,
  type LibraryEntry,
  type ReaderPreferences,
  type ReadingLocator,
  type ReadingProgress,
} from '../types';
import { ApiError } from './contract';
import { sha256Hex } from './hash';

/**
 * JSON parsing and value rules shared by the stores. Everything here mirrors
 * `apps/mobile/lib/data/models/*.dart` so records written by either app parse
 * in the other.
 */

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------- time

/** Parses ISO strings with up to 6 fractional digits (Dart writes microseconds). */
export function parseIso(value: string): number {
  const trimmed = value.replace(/(\.\d{3})\d+/, '$1');
  return Date.parse(trimmed);
}

/**
 * Total order of ISO timestamps with microsecond precision, like the API's
 * `isoTimestampOrder`. Invalid values sort first.
 */
export function isoOrder(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = parseIso(value);
  if (!Number.isFinite(ms)) return Number.NEGATIVE_INFINITY;
  const fraction = /\.(\d{1,6})Z?$/i.exec(value)?.[1]?.padEnd(6, '0') ?? '000000';
  return ms * 1000 + Number(fraction.slice(3, 6));
}

export const isAfter = (a: string | null | undefined, b: string | null | undefined): boolean => isoOrder(a) > isoOrder(b);

export function nowIso(now: () => number = Date.now): string {
  return new Date(now()).toISOString();
}

/** A canonical UTC ISO string (what the API accepts), keeping canonical input as is. */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) && Number.isFinite(parseIso(value))) return value;
  const ms = parseIso(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------- origin

/** Same rules as mobile `ApiClient.normalizeBaseUrl`, reduced to an origin. */
export function normalizeOrigin(raw: string): string {
  let s = raw.trim();
  if (!s) throw new ApiError('API URL is empty.', 'BAD_URL');
  if (!s.includes('://')) s = `http://${s}`;
  while (s.endsWith('/')) s = s.slice(0, -1);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ApiError('API URL must be an http(s) origin.', 'BAD_URL');
  }
  if (!url.hostname || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new ApiError('API URL must be an http(s) origin.', 'BAD_URL');
  }
  return url.origin;
}

/** Namespaces a catalog id by source and origin, exactly like mobile. */
export function entryIdentity(bookId: string, origin: string): string {
  return sha256Hex(`api\n${origin}\n${bookId}`);
}

// ---------------------------------------------------------------- book

export function parseBook(json: unknown): Book {
  if (!isRecord(json)) throw new Error('Book must be an object.');
  const id = str(json.id);
  const downloadUrl = str(json.downloadUrl);
  const sha = str(json.sha256);
  const size = num(json.fileSize);
  if (!id || downloadUrl === undefined || !sha || size === undefined) throw new Error('Book is missing required fields.');
  const updatedAt = toIso(json.updatedAt) ?? new Date(0).toISOString();
  return {
    id,
    version: json.version === undefined || json.version === null ? '1' : String(json.version),
    title: str(json.title) ?? 'Untitled',
    author: str(json.author) ?? 'Unknown',
    description: str(json.description) ?? '',
    language: str(json.language) ?? 'en',
    subjects: Array.isArray(json.subjects) ? json.subjects.map((s) => String(s)) : [],
    coverUrl: str(json.coverUrl) ?? null,
    downloadUrl,
    fileSize: Math.trunc(size),
    sha256: sha.toLowerCase(),
    updatedAt,
  };
}

export const sameBookJson = (a: Book, b: Book): boolean => stableStringify(a) === stableStringify(b);

// ---------------------------------------------------------------- download

export const emptyDownload = (totalBytes: number | null = null): DownloadState => ({
  status: 'none',
  receivedBytes: 0,
  totalBytes,
  path: null,
  error: null,
});

export const INTERRUPTED = 'Interrupted before it finished.';
export const MISSING_FILE = 'The file is missing from storage.';

export function parseDownload(json: unknown): DownloadState {
  if (!isRecord(json)) return emptyDownload();
  const known = ['none', 'queued', 'downloading', 'verifying', 'ready', 'failed'];
  let status = (known.includes(json.status as string) ? json.status : 'none') as DownloadState['status'];
  // In-flight downloads never survive a reload; report them as failed so the
  // user gets an honest, retryable state rather than a spinner forever.
  if (status === 'queued' || status === 'downloading' || status === 'verifying') status = 'failed';
  const error = str(json.error) ?? null;
  return {
    status,
    receivedBytes: Math.trunc(num(json.receivedBytes) ?? 0),
    totalBytes: num(json.totalBytes) === undefined ? null : Math.trunc(num(json.totalBytes)!),
    path: str(json.path) ?? null,
    error: status === 'failed' ? error ?? INTERRUPTED : error,
  };
}

export const isReady = (d: DownloadState): boolean => d.status === 'ready' && d.path !== null;
export const isActive = (d: DownloadState): boolean =>
  d.status === 'queued' || d.status === 'downloading' || d.status === 'verifying';

export function downloadFraction(d: DownloadState): number | null {
  if (d.totalBytes === null || d.totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, d.receivedBytes / d.totalBytes));
}

// ---------------------------------------------------------------- locator

export function parseLocator(json: unknown): ReadingLocator {
  if (!isRecord(json) || typeof json.href !== 'string') throw new Error('Locator needs an href.');
  return {
    href: json.href,
    progression: num(json.progression) ?? 0,
    totalProgression: num(json.totalProgression) ?? null,
    title: str(json.title) ?? null,
    engine: str(json.engine) ?? 'dart',
    raw: isRecord(json.raw) ? json.raw : null,
  };
}

export function locatorToJson(l: ReadingLocator): Json {
  return {
    href: l.href,
    progression: l.progression,
    totalProgression: l.totalProgression,
    title: l.title,
    engine: l.engine,
    raw: l.raw,
  };
}

export function parseProgress(json: unknown): ReadingProgress | null {
  if (!isRecord(json)) return null;
  const updatedAt = toIso(json.updatedAt);
  if (!updatedAt) return null;
  return { locator: parseLocator(json.locator), updatedAt };
}

export const progressToJson = (p: ReadingProgress): Json => ({ locator: locatorToJson(p.locator), updatedAt: p.updatedAt });

// ---------------------------------------------------------------- entry

export function parseEntry(json: unknown): LibraryEntry {
  if (!isRecord(json)) throw new Error('Entry must be an object.');
  const book = parseBook(json.book);
  const origin = str(json.origin) ?? '';
  const addedAt = toIso(json.addedAt);
  if (!addedAt) throw new Error('Entry needs addedAt.');
  return {
    id: entryIdentity(book.id, origin),
    book,
    source: 'api',
    origin,
    addedAt,
    download: parseDownload(json.download),
    progress: parseProgress(json.progress),
    lastOpenedAt: toIso(json.lastOpenedAt),
  };
}

export function entryToJson(e: LibraryEntry): Json {
  return {
    book: e.book,
    source: 'api',
    origin: e.origin,
    addedAt: e.addedAt,
    download: e.download,
    progress: e.progress ? progressToJson(e.progress) : null,
    lastOpenedAt: e.lastOpenedAt,
  };
}

export function newEntry(book: Book, origin: string, addedAt: string): LibraryEntry {
  return {
    id: entryIdentity(book.id, origin),
    book,
    source: 'api',
    origin,
    addedAt,
    download: emptyDownload(),
    progress: null,
    lastOpenedAt: null,
  };
}

// ---------------------------------------------------------------- reader preferences

export const LINE_HEIGHT_RANGE = [1.2, 2.2] as const;
export const MARGIN_SCALE_RANGE = [0.5, 2] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keeps values inside the ranges the API validates; ids stay as written. */
export function clampReaderPreferences(p: ReaderPreferences): ReaderPreferences {
  const next: ReaderPreferences = {
    ...p,
    fontSize: clamp(Number.isFinite(p.fontSize) ? p.fontSize : defaultReaderPreferences.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE),
    lineHeight: clamp(Number.isFinite(p.lineHeight) ? p.lineHeight : defaultReaderPreferences.lineHeight, ...LINE_HEIGHT_RANGE),
    marginScale: clamp(Number.isFinite(p.marginScale) ? p.marginScale : defaultReaderPreferences.marginScale, ...MARGIN_SCALE_RANGE),
  };
  for (const key of ['themeId', 'fontFamilyId', 'highlightColor'] as const) {
    if (typeof next[key] !== 'string') delete next[key];
  }
  return next;
}

/**
 * Unknown or malformed values fall back instead of throwing, so a value
 * written by a future build cannot make preferences unreadable. Unknown ids
 * (theme, font family, highlight colour) are kept as written.
 */
export function parseReaderPreferences(json: unknown): ReaderPreferences {
  const j = isRecord(json) ? json : {};
  const d = defaultReaderPreferences;
  const prefs: ReaderPreferences = {
    fontSize: num(j.fontSize) ?? d.fontSize,
    lineHeight: num(j.lineHeight) ?? d.lineHeight,
    font: j.font === 'sans' || j.font === 'serif' ? j.font : 'serif',
    flow: j.flow === 'paginated' || j.flow === 'scrolled' ? j.flow : 'scrolled',
    marginScale: num(j.marginScale) ?? d.marginScale,
    justify: typeof j.justify === 'boolean' ? j.justify : d.justify,
    keepAwake: typeof j.keepAwake === 'boolean' ? j.keepAwake : d.keepAwake,
  };
  if (typeof j.themeId === 'string') prefs.themeId = j.themeId;
  if (typeof j.fontFamilyId === 'string') prefs.fontFamilyId = j.fontFamilyId;
  if (typeof j.highlightColor === 'string') prefs.highlightColor = j.highlightColor;
  return clampReaderPreferences(prefs);
}

export function readerPreferencesToJson(p: ReaderPreferences): Json {
  return {
    fontSize: p.fontSize,
    lineHeight: p.lineHeight,
    font: p.font,
    flow: p.flow,
    marginScale: p.marginScale,
    justify: p.justify,
    keepAwake: p.keepAwake,
    ...(p.themeId !== undefined ? { themeId: p.themeId } : {}),
    ...(p.fontFamilyId !== undefined ? { fontFamilyId: p.fontFamilyId } : {}),
    ...(p.highlightColor !== undefined ? { highlightColor: p.highlightColor } : {}),
  };
}

/** Font family ids known to both apps, with their legacy serif/sans class. */
export const FONT_FAMILY_CLASSES: Record<string, 'serif' | 'sans'> = {
  'system-serif': 'serif',
  literata: 'serif',
  'source-serif-4': 'serif',
  'system-sans': 'sans',
  'atkinson-hyperlegible-next': 'sans',
  lexend: 'sans',
  inter: 'sans',
};

// ---------------------------------------------------------------- highlights

export function parseHighlight(json: unknown): Highlight {
  if (!isRecord(json)) throw new Error('Highlight must be an object.');
  const id = str(json.id), bookId = str(json.bookId), sha = str(json.sha256);
  const createdAt = toIso(json.createdAt), updatedAt = toIso(json.updatedAt);
  if (!id || !bookId || !sha || !createdAt || !updatedAt || !isRecord(json.locator)) throw new Error('Highlight is incomplete.');
  return {
    id,
    bookId,
    sha256: sha,
    origin: str(json.origin) ?? '',
    locator: json.locator,
    text: str(json.text) ?? '',
    color: str(json.color) ?? 'yellow',
    note: str(json.note) ?? null,
    createdAt,
    updatedAt,
    deleted: json.deleted === true,
  };
}

// ---------------------------------------------------------------- json

/** JSON with sorted keys, so fingerprints ignore key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;
