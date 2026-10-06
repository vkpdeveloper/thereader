/** Catalog book as described by the API contract (`docs/api-contract.md`). */
export interface Book {
  id: string;
  version: string;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
  coverUrl: string | null;
  downloadUrl: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
}

export type DownloadStatus = 'none' | 'queued' | 'downloading' | 'verifying' | 'ready' | 'failed';

export interface DownloadState {
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  /** IndexedDB key of the verified EPUB blob. */
  path: string | null;
  error: string | null;
}

/**
 * Engine-agnostic reading position, byte-compatible with the mobile app's
 * `ReadingLocator` so positions sync both ways. `href` is the spine item's
 * path inside the EPUB container (e.g. `OEBPS/ch01.xhtml`, no leading slash).
 */
export interface ReadingLocator {
  href: string;
  /** 0..1 inside `href`. */
  progression: number;
  /** 0..1 across the publication, if known. */
  totalProgression: number | null;
  title: string | null;
  /** `web` for this app, `readium` / `dart` from mobile. */
  engine: string;
  /** Engine-specific payload; a Readium locator JSON when `engine == 'readium'`. */
  raw: Record<string, unknown> | null;
}

export interface ReadingProgress {
  locator: ReadingLocator;
  updatedAt: string;
}

export interface LibraryEntry {
  /** Local identity: source + origin + book id. */
  id: string;
  book: Book;
  source: 'api';
  /** Normalized API origin the edition came from. */
  origin: string;
  addedAt: string;
  download: DownloadState;
  progress: ReadingProgress | null;
  lastOpenedAt: string | null;
}

export type ReaderFont = 'serif' | 'sans';
export type ReaderFlow = 'scrolled' | 'paginated';

/** Synced typography preferences. Field names and ranges match the API. */
export interface ReaderPreferences {
  fontSize: number;
  lineHeight: number;
  font: ReaderFont;
  flow: ReaderFlow;
  marginScale: number;
  justify: boolean;
  keepAwake: boolean;
  themeId?: string;
  fontFamilyId?: string;
  highlightColor?: string;
}

export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 28;

export const defaultReaderPreferences: ReaderPreferences = {
  fontSize: 18,
  lineHeight: 1.6,
  font: 'serif',
  flow: 'scrolled',
  marginScale: 1,
  justify: false,
  keepAwake: true,
};

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
export const highlightColors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

/**
 * One highlighted passage, pinned to an edition by `sha256`. `locator` is a
 * Readium-shaped locator (`href`, `locations`, `text.{before,highlight,after}`)
 * so highlights made here render on mobile and vice versa.
 */
export interface Highlight {
  id: string;
  bookId: string;
  sha256: string;
  origin: string;
  locator: Record<string, unknown>;
  text: string;
  color: string;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface AppSettings {
  apiBaseUrl: string;
}

/**
 * A saved web article as the Library lists it. The full document (blocks)
 * is stored separately and loaded only when the article opens.
 */
export interface ArticleSummary {
  id: string;
  /** Canonical article URL, for "Open original". */
  url: string;
  /** Normalized forms of every address that led here (typed, final, canonical); dedupe keys. */
  urls: string[];
  title: string;
  /** Publisher name, or the host when the page has none. */
  siteName: string;
  byline: string | null;
  excerpt: string | null;
  favicon: string | null;
  /** Lead image source, for the thumbnail. */
  image: string | null;
  readingMinutes: number;
  addedAt: string;
  lastOpenedAt: string | null;
  /**
   * Reading position 0..1: the fraction of the article's top-level blocks
   * above the reading line (1 at the end), or null before the first read.
   */
  progress: number | null;
  /** When `progress` last changed; orders positions between devices. */
  progressUpdatedAt?: string | null;
  /**
   * False while only the cloud has the document (saved on another device and
   * not opened here yet); it downloads on open. Absent means stored.
   */
  stored?: boolean;
  // Synced metadata, recorded when the article is saved or pulled.
  language?: string | null;
  dir?: 'ltr' | 'rtl';
  wordCount?: number;
  publishedAt?: string | null;
  /** Top-level blocks, to translate reading positions between devices. */
  blockCount?: number;
  /** SHA-256 and byte size of the document JSON every device shares. */
  bodySha256?: string | null;
  bodySize?: number | null;
}
