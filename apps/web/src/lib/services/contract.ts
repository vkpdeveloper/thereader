import type { AppSettings, Book, Highlight, LibraryEntry, ReaderPreferences, ReadingLocator } from '../types';

/**
 * Contract between the data layer (`lib/services/*`, owned by one agent) and
 * the UI (`routes/*`, `components/*`, owned by another). Every store is a
 * plain observable: UI reads snapshots through `useStore(store)` (a
 * useSyncExternalStore hook exported from `lib/services/react.ts`) and calls
 * methods. Snapshots are immutable; a change produces a new snapshot object.
 *
 * Behaviour mirrors the mobile repositories in apps/mobile/lib/data/**.
 */

export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------- settings

export interface SettingsSnapshot {
  loaded: boolean;
  settings: AppSettings;
  reader: ReaderPreferences;
  readerUpdatedAt: string | null;
}

export interface SettingsStore extends Observable<SettingsSnapshot> {
  /** Default API base URL: this page's origin. */
  readonly defaultApiBaseUrl: string;
  /** Normalized origin of the current API (http(s)://host[:port]). */
  currentOrigin(): string;
  setApiBaseUrl(url: string): Promise<void>;
  setThemeId(id: string): Promise<void>;
  /** Writes fontFamilyId + its legacy class (`font`), like ReaderFonts.select. */
  setFontFamily(familyId: string): Promise<void>;
  updateReader(change: (prefs: ReaderPreferences) => ReaderPreferences): Promise<void>;
}

// ---------------------------------------------------------------- api

export class ApiError extends Error {
  constructor(message: string, readonly code = 'UNKNOWN', readonly status: number | null = null, readonly isNetwork = false) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  readonly origin: string;
  health(): Promise<{ ok: boolean; service: string }>;
  listBooks(options: { limit?: number; cursor?: string | null; query?: string }): Promise<{ items: Book[]; nextCursor: string | null }>;
  getBook(id: string): Promise<Book>;
  /** Absolute URL for a relative contract URL (coverUrl, downloadUrl). */
  resolve(pathOrUrl: string): string;
}

// ---------------------------------------------------------------- catalog

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CatalogSnapshot {
  status: CatalogStatus;
  items: Book[];
  query: string;
  /** Sorted unique subjects of loaded items. */
  subjects: string[];
  hasMore: boolean;
  isLoadingMore: boolean;
  error: ApiError | null;
  origin: string;
}

export interface CatalogStore extends Observable<CatalogSnapshot> {
  refresh(): Promise<void>;
  /** Debounced server-side search (~250 ms). */
  search(query: string): void;
  loadMore(): Promise<void>;
}

// ---------------------------------------------------------------- library

export interface LibrarySnapshot {
  loaded: boolean;
  entries: LibraryEntry[];
  /** Readable entries with lastOpenedAt, most recent first. */
  continueReading: LibraryEntry[];
}

export interface LibraryStore extends Observable<LibrarySnapshot> {
  entry(id: string): LibraryEntry | undefined;
  /** Entry for a catalog book at the current origin. */
  entryFor(book: Book): LibraryEntry | undefined;
  canRead(id: string): boolean;
  /** Adds (or updates to a new edition) and downloads into IndexedDB with SHA-256 verification. Progress is observable on the entry. */
  download(book: Book): Promise<void>;
  cancelDownload(id: string): void;
  /**
   * Removes local bytes. With `keepMetadata` (cloud books when sync is on)
   * the entry stays in the library, not downloaded, keeping its progress.
   */
  remove(id: string, options?: { keepMetadata?: boolean }): Promise<void>;
  /** Verified EPUB bytes for reading. Throws if not downloaded. */
  openForReading(id: string): Promise<Blob>;
  markOpened(id: string, expectedSha256: string): Promise<void>;
  saveProgress(id: string, locator: ReadingLocator, expectedSha256: string): Promise<void>;
}

// ---------------------------------------------------------------- highlights

export interface HighlightsSnapshot {
  loaded: boolean;
  /** Every record, tombstones included. */
  all: Highlight[];
}

export interface HighlightStore extends Observable<HighlightsSnapshot> {
  /** Live highlights of one edition in reading order. */
  forEdition(origin: string, sha256: string): Highlight[];
  byId(id: string): Highlight | undefined;
  create(input: { bookId: string; sha256: string; origin: string; locator: Record<string, unknown>; text: string; color: string }): Promise<Highlight>;
  recolor(id: string, color: string): Promise<void>;
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------- sync

export interface SyncSnapshot {
  isSyncing: boolean;
  lastSyncedAt: string | null;
  pendingCount: number;
  totalReadingMilliseconds: number;
  error: string | null;
}

export interface SyncStore extends Observable<SyncSnapshot> {
  syncNow(): Promise<void>;
  /** Reading-time session for the open book; mirrors mobile beginReading/endReading. */
  beginReading(entry: LibraryEntry): void;
  endReading(): void;
  readingMillisecondsFor(entry: LibraryEntry): number;
}

// ---------------------------------------------------------------- imports

export interface ImportsSnapshot {
  busy: boolean;
  error: string | null;
  pendingCount: number;
  /** Library entry id currently uploading. */
  uploadingId: string | null;
  uploadFraction: number | null;
  /** entry id -> upload error. */
  errors: Record<string, string>;
}

export interface ImportStore extends Observable<ImportsSnapshot> {
  /** Local copy + verification, then queues the upload. Returns the new entry. */
  importFile(file: File): Promise<LibraryEntry>;
  retryPending(): Promise<void>;
  isPending(entryId: string): boolean;
  isUploading(entryId: string): boolean;
  errorFor(entryId: string): string | null;
  cancelPending(entryId: string): Promise<void>;
}

// ---------------------------------------------------------------- covers

export interface CoverStore {
  /**
   * Object URL for a book's cover, cached in IndexedDB by sha256 so covers
   * work offline. Null means the book has no cover (render a plate).
   * Rejects on network failure (render a quiet "unavailable" state, retry later).
   */
  load(book: Book, origin: string): Promise<string | null>;
}

// ---------------------------------------------------------------- storage

export interface StorageInfo {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  bookCount: number;
  bookBytes: number;
}

export interface StorageStore {
  info(): Promise<StorageInfo>;
  requestPersistence(): Promise<boolean>;
}

// ---------------------------------------------------------------- root

export interface AppServices {
  settings: SettingsStore;
  catalog: CatalogStore;
  library: LibraryStore;
  highlights: HighlightStore;
  sync: SyncStore;
  imports: ImportStore;
  covers: CoverStore;
  storage: StorageStore;
  /** Resolves once every store has loaded from IndexedDB. */
  ready: Promise<void>;
}
