import type { Book, DownloadState, LibraryEntry, ReadingLocator, ReadingProgress } from '../types';
import { ApiError, type BookFile, type LibrarySnapshot, type LibraryStore } from './contract';
import type { KeyValueStore } from './kv';
import {
  MISSING_FILE,
  emptyDownload,
  entryIdentity,
  entryToJson,
  isActive,
  isAfter,
  isReady,
  isRecord,
  isoOrder,
  newEntry,
  normalizeOrigin,
  nowIso,
  parseEntry,
  sameBookJson,
  stableStringify,
} from './models';
import type { Sha256State } from './hash';
import { Emitter, WriteQueue } from './observable';
import {
  DownloadCancelled,
  DownloadFailure,
  ProgressiveDownload,
  mimeTypeFor,
  type DownloadClient,
  type ResumePoint,
  type SpilledRun,
} from './progressiveDownload';
import { SEGMENT_ALIGNMENT, type SegmentPolicy } from './segmentPlan';
import { noopBus, type TabBus } from './tabs';

export { DownloadFailure } from './progressiveDownload';

const LIBRARY_KEY = 'library.v1';

/** IndexedDB key of an edition's verified EPUB blob. */
export const bookBlobKey = (entryId: string, sha256: string): string => `book:${entryId}:${sha256}`;

/**
 * IndexedDB key of an interrupted comic download's manifest; its verified
 * runs are stored at `${key}:${start}`. A comic can be 1 GiB, so a reload
 * resumes after the saved prefix instead of starting over.
 */
export const partialKey = (entryId: string, sha256: string): string => `partial:${entryId}:${sha256}`;

interface PartialManifest {
  size: number;
  /** The saved prefix is `[0, end)`. */
  end: number;
  hasher: Sha256State;
  /** Start offset of each run, in order. */
  runs: number[];
}

function parseManifest(json: unknown, size: number): PartialManifest | null {
  if (!isRecord(json) || json.size !== size || !isRecord(json.hasher) || !Array.isArray(json.runs)) return null;
  const end = json.end;
  const runs = json.runs as unknown[];
  if (typeof end !== 'number' || end <= 0 || end >= size || end % SEGMENT_ALIGNMENT !== 0 || runs[0] !== 0) return null;
  if (!runs.every((start, i) => typeof start === 'number' && (i === 0 || start > (runs[i - 1] as number)) && start < end)) return null;
  return { size, end, hasher: json.hasher as unknown as Sha256State, runs: runs as number[] };
}

export interface LibraryDeps {
  kv: KeyValueStore;
  /** EPUB blobs. */
  books: KeyValueStore;
  currentOrigin(): string;
  /** HTTP client of one API origin; downloads always use the entry's origin. */
  clientFor(origin: string): DownloadClient;
  bus?: TabBus;
  now?: () => number;
  segmentPolicy?: SegmentPolicy;
  /** Called after a download verifies (asks the browser to keep storage). */
  onDownloaded?: () => void;
}

/** A verified blob read from IndexedDB; slices are zero-copy. */
function blobFile(blob: Blob): BookFile {
  return {
    size: blob.size,
    provisional: false,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    slice: async (start, end, type) => blob.slice(start, end, type ?? ''),
    close: () => undefined,
  };
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
const sameEntries = (a: LibraryEntry[], b: LibraryEntry[]): boolean => a.length === b.length && a.every((e, i) => e === b[i]);

/**
 * The local library: which books were added, their durable download state
 * and reading progress. Source of truth for offline use; a downloaded book is
 * read from IndexedDB with no network. Ported from mobile LibraryRepository.
 */
export class LibraryStoreImpl extends Emitter<LibrarySnapshot> implements LibraryStore {
  private entries = new Map<string, LibraryEntry>();
  private readonly aliases = new Map<string, string>();
  private readonly cancelRequests = new Set<string>();
  /** Running downloads; early reading leases come from here. */
  private readonly progressive = new Map<string, ProgressiveDownload>();
  /** A verified edition kept while its replacement downloads. */
  private readonly verifiedBeforeUpdate = new Map<string, LibraryEntry>();
  private readonly writes = new WriteQueue();
  private queuedWrite: Promise<void> | null = null;
  private readonly bus: TabBus;
  private readonly now: () => number;

  constructor(private readonly deps: LibraryDeps) {
    super({ loaded: false, entries: [], continueReading: [], earlyReadable: [] });
    this.bus = deps.bus ?? noopBus;
    this.now = deps.now ?? Date.now;
    this.bus.listen((topic) => {
      if (topic === 'library' && this.snapshot.loaded) void this.reload();
    });
  }

  get loaded(): boolean {
    return this.snapshot.loaded;
  }

  get all(): LibraryEntry[] {
    return this.snapshot.entries;
  }

  private resolveId(id: string): string {
    const seen = new Set<string>();
    while (this.aliases.has(id) && !seen.has(id)) {
      seen.add(id);
      id = this.aliases.get(id)!;
    }
    return id;
  }

  entry(id: string): LibraryEntry | undefined {
    return this.entries.get(this.resolveId(id));
  }

  entryFor(book: Book, origin: string = this.deps.currentOrigin()): LibraryEntry | undefined {
    return this.entry(entryIdentity(book.id, origin));
  }

  /** Partial publications stay online-only until their final SHA is verified. */
  canRead(id: string): boolean {
    id = this.resolveId(id);
    const e = this.entries.get(id);
    if (!e) return false;
    return isReady(e.download) || (isActive(e.download) && this.progressive.get(id)?.canRead === true);
  }

  isProvisional(id: string): boolean {
    id = this.resolveId(id);
    const e = this.entries.get(id);
    return e !== undefined && !isReady(e.download) && this.canRead(id);
  }

  // ---------------------------------------------------------------- persistence

  async load(): Promise<void> {
    this.entries = await this.readStored();
    // Reconcile with storage: a "ready" record whose blob vanished is not ready,
    // and a verified blob saved just before the page closed (its record still
    // says interrupted) is adopted rather than downloaded again.
    const keys = new Set(await this.deps.books.keys().catch(() => [] as string[]));
    await this.reconcilePartials(keys);
    for (const e of [...this.entries.values()]) {
      if (isReady(e.download) && !keys.has(e.download.path!)) {
        this.entries.set(e.id, { ...e, download: { ...emptyDownload(), status: 'failed', error: MISSING_FILE } });
      } else if (!isReady(e.download) && keys.has(bookBlobKey(e.id, e.book.sha256))) {
        const size = e.book.fileSize;
        const path = bookBlobKey(e.id, e.book.sha256);
        this.entries.set(e.id, { ...e, download: { status: 'ready', receivedBytes: size, totalBytes: size, path, error: null } });
      }
    }
    this.publish(true);
    await this.persist();
  }

  /**
   * Drops saved comic prefixes no unfinished entry can resume, and shows how
   * much of each resumable one is already local.
   */
  private async reconcilePartials(keys: Set<string>): Promise<void> {
    const wanted = new Map<string, LibraryEntry>();
    for (const e of this.entries.values()) {
      if (e.book.format === 'comic' && !isReady(e.download)) wanted.set(partialKey(e.id, e.book.sha256), e);
    }
    for (const key of keys) {
      if (!key.startsWith('partial:')) continue;
      const manifest = key.split(':').slice(0, 3).join(':');
      if (!wanted.has(manifest)) await this.deps.books.remove(key).catch(() => undefined);
    }
    for (const [key, e] of wanted) {
      if (!keys.has(key)) continue;
      const manifest = parseManifest(await this.deps.books.get(key).catch(() => null), e.book.fileSize);
      if (manifest && e.download.status === 'failed') {
        this.entries.set(e.id, { ...e, download: { ...e.download, receivedBytes: manifest.end, totalBytes: e.book.fileSize } });
      }
    }
  }

  /** The verified prefix of an interrupted comic download, or null to start over. */
  private async readPartial(id: string, book: Book): Promise<{ resume: ResumePoint; runs: number[] } | null> {
    if (book.format !== 'comic') return null;
    const key = partialKey(id, book.sha256);
    try {
      const manifest = parseManifest(await this.deps.books.get(key), book.fileSize);
      if (!manifest) return null;
      const runs: Blob[] = [];
      for (const [i, start] of manifest.runs.entries()) {
        const blob = await this.deps.books.get<Blob>(`${key}:${start}`);
        const end = manifest.runs[i + 1] ?? manifest.end;
        if (!(blob instanceof Blob) || blob.size !== end - start) return null;
        runs.push(blob);
      }
      return { resume: { prefix: new Blob(runs), hasher: manifest.hasher }, runs: manifest.runs };
    } catch {
      return null;
    }
  }

  /** Removes saved comic prefixes of `id`, except the edition `keepSha256`. */
  private async clearPartials(id: string, keepSha256?: string): Promise<void> {
    const keep = keepSha256 === undefined ? null : partialKey(id, keepSha256);
    for (const key of await this.deps.books.keys().catch(() => [] as string[])) {
      if (!key.startsWith(`partial:${id}:`) || (keep !== null && (key === keep || key.startsWith(`${keep}:`)))) continue;
      await this.deps.books.remove(key).catch(() => undefined);
    }
  }

  private async readStored(): Promise<Map<string, LibraryEntry>> {
    const map = new Map<string, LibraryEntry>();
    const json = await this.deps.kv.get<unknown>(LIBRARY_KEY).catch(() => null);
    const list = isRecord(json) && Array.isArray(json.entries) ? json.entries : [];
    for (const raw of list) {
      try {
        const e = parseEntry(raw);
        map.set(e.id, e);
      } catch {
        // Skip a corrupt record instead of losing the whole library.
      }
    }
    return map;
  }

  /** Another tab saved the library. Keep this tab's running downloads and newer reading state. */
  private async reload(): Promise<void> {
    const stored = await this.readStored();
    const merged = new Map<string, LibraryEntry>();
    for (const [id, s] of stored) {
      const local = this.entries.get(id);
      if (local && isActive(local.download)) {
        merged.set(id, local);
        continue;
      }
      let next = s;
      if (local && local.book.sha256 === s.book.sha256) {
        if (local.progress && (!s.progress || isAfter(local.progress.updatedAt, s.progress.updatedAt))) {
          next = { ...next, progress: local.progress };
        }
        if (local.lastOpenedAt && isAfter(local.lastOpenedAt, s.lastOpenedAt)) next = { ...next, lastOpenedAt: local.lastOpenedAt };
      }
      // Unchanged records keep their object so rows do not re-render.
      if (local && stableStringify(entryToJson(local)) === stableStringify(entryToJson(next))) next = local;
      merged.set(id, next);
    }
    for (const [id, local] of this.entries) {
      if (!merged.has(id) && isActive(local.download)) merged.set(id, local);
    }
    const unchanged =
      merged.size === this.entries.size && [...merged].every(([id, e]) => this.entries.get(id) === e);
    this.entries = merged;
    if (!unchanged) this.publish();
  }

  /**
   * Saves the library. Calls made while a write is still queued share it:
   * the snapshot is taken when the write starts, so it includes every change
   * so far and a burst of progress saves costs one IndexedDB write.
   */
  private persist(): Promise<void> {
    if (this.queuedWrite) return this.queuedWrite;
    const write = this.writes.run(async () => {
      this.queuedWrite = null;
      const snapshot = {
        entries: [...this.entries.values()].map((e) =>
          entryToJson(isActive(e.download) ? this.verifiedBeforeUpdate.get(e.id) ?? e : e),
        ),
      };
      await this.deps.kv.set(LIBRARY_KEY, snapshot);
      this.bus.post('library');
    });
    this.queuedWrite = write;
    return write;
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }

  private publish(loaded = this.snapshot.loaded): void {
    const entries = [...this.entries.values()];
    let continueReading = entries
      .filter((e) => this.canRead(e.id) && e.lastOpenedAt !== null)
      .sort((a, b) => isoOrder(b.lastOpenedAt) - isoOrder(a.lastOpenedAt));
    let earlyReadable = entries.filter((e) => this.isProvisional(e.id)).map((e) => e.id);
    // Keep unchanged derived lists identical so their rows skip re-rendering
    // while a download paints progress.
    const previous = this.snapshot;
    if (sameEntries(continueReading, previous.continueReading)) continueReading = previous.continueReading;
    if (sameIds(earlyReadable, previous.earlyReadable)) earlyReadable = previous.earlyReadable;
    this.emit({ loaded, entries, continueReading, earlyReadable });
  }

  private put(e: LibraryEntry, persist = true): void {
    this.entries.set(e.id, e);
    this.publish();
    if (persist) void this.persist().catch(() => undefined);
  }

  // ---------------------------------------------------------------- downloads

  /**
   * Adds (or refreshes to a new edition) and downloads into IndexedDB from
   * `origin` (default: the current API). Returns when the download finishes
   * or fails; state is observable on the entry. Ported from mobile
   * `LibraryRepository.download`, which always takes the book's source.
   */
  async download(book: Book, options: { origin?: string } = {}): Promise<void> {
    const origin = normalizeOrigin(options.origin ?? this.deps.currentOrigin());
    const id = entryIdentity(book.id, origin);
    const existing = this.entries.get(id);
    if (existing && isActive(existing.download)) return;

    if (existing && isReady(existing.download)) this.verifiedBeforeUpdate.set(id, existing);
    let e: LibraryEntry = existing
      ? { ...existing, book, progress: existing.book.sha256 !== book.sha256 ? null : existing.progress }
      : newEntry(book, origin, nowIso(this.now));
    e = { ...e, download: { status: 'queued', receivedBytes: 0, totalBytes: book.fileSize, path: null, error: null } };
    this.cancelRequests.delete(id);
    this.put(e);

    const current = () => this.entries.get(id) ?? e;
    const setDownload = (download: Partial<DownloadState>, persist = true) => {
      // Reading locators may change while bytes arrive; never overwrite newer
      // progress with the entry captured at download start.
      e = { ...current(), download: { ...current().download, ...download } };
      this.put(e, persist);
    };
    const cancelled = () => this.cancelRequests.has(id);
    // Comics keep their verified prefix in IndexedDB as it is hashed (runs,
    // then the manifest naming them), so a reload can resume the download.
    const comic = book.format === 'comic';
    const manifestKey = partialKey(id, book.sha256);
    let saving = Promise.resolve();
    let saved = 0;
    let savedRuns: number[] = [];
    let saveFailed = false;
    const keepRun = (run: SpilledRun) => {
      saving = saving.then(async () => {
        if (saveFailed || cancelled()) return;
        try {
          await this.deps.books.set(`${manifestKey}:${run.start}`, run.blob);
          savedRuns = [...savedRuns, run.start];
          const manifest: PartialManifest = { size: book.fileSize, end: run.end, hasher: run.hasher, runs: savedRuns };
          await this.deps.books.set(manifestKey, manifest);
          saved = run.end;
        } catch {
          // Out of space: this download still finishes, it just cannot resume.
          saveFailed = true;
        }
      });
    };

    try {
      let lastPaint = this.now();
      const fivePercent = book.fileSize * 0.05;
      const progress = (received: number, total: number) => {
        const done = received >= total;
        const now = this.now();
        if (done || (received >= fivePercent && e.download.receivedBytes < fivePercent) || now - lastPaint >= 80) {
          lastPaint = now;
          setDownload({ status: done ? 'verifying' : 'downloading', receivedBytes: received, totalBytes: total }, false);
        }
      };
      let resume: ResumePoint | null = null;
      if (comic) {
        await this.clearPartials(id, book.sha256);
        const kept = await this.readPartial(id, book);
        if (kept) {
          resume = kept.resume;
          saved = resume.prefix.size;
          savedRuns = kept.runs;
        } else {
          await this.clearPartials(id);
        }
      }
      const options = {
        onProgress: progress,
        onReadable: () => this.publish(),
        policy: this.deps.segmentPolicy,
        ...(comic ? { onSpill: keepRun } : {}),
      };
      let partial: ProgressiveDownload;
      try {
        partial = new ProgressiveDownload(book, this.deps.clientFor(origin), resume ? { ...options, resume } : options);
      } catch (error) {
        if (!resume) throw error;
        await this.clearPartials(id);
        saved = 0;
        savedRuns = [];
        partial = new ProgressiveDownload(book, this.deps.clientFor(origin), options);
      }
      this.progressive.set(id, partial);
      if (cancelled()) {
        partial.cancel();
        throw new DownloadCancelled();
      }
      setDownload({ status: 'downloading', error: null });
      const blob = await partial.run();
      if (cancelled()) throw new DownloadCancelled();
      const path = bookBlobKey(id, book.sha256);
      try {
        await this.deps.books.set(path, blob);
      } catch {
        throw new DownloadFailure('Could not save the book in browser storage. Free some space and try again.', 'STORAGE');
      }
      this.put({
        ...current(),
        download: { status: 'ready', receivedBytes: book.fileSize, totalBytes: book.fileSize, path, error: null },
      });
      if (existing?.download.path && existing.download.path !== path) {
        await this.deps.books.remove(existing.download.path).catch(() => undefined);
      }
      if (comic) {
        await saving;
        await this.clearPartials(id);
      }
      this.deps.onDownloaded?.();
    } catch (error) {
      const verified = this.verifiedBeforeUpdate.get(id) ?? existing;
      await saving;
      if (error instanceof DownloadCancelled || cancelled()) {
        if (comic) await this.clearPartials(id);
        this.put(
          verified && isReady(verified.download)
            ? verified
            : { ...current(), download: { ...emptyDownload(book.fileSize) } },
        );
      } else {
        const message =
          error instanceof DownloadFailure || error instanceof ApiError
            ? error.message
            : `Download failed: ${error instanceof Error ? error.message : String(error)}`;
        this.put(
          verified && isReady(verified.download)
            ? { ...verified, download: { ...verified.download, error: `Update failed. ${message}` } }
            : {
                ...current(),
                // `receivedBytes` of a failed comic is its saved prefix: what a retry resumes from.
                download: { ...emptyDownload(book.fileSize), status: 'failed', receivedBytes: comic ? saved : 0, error: message },
              },
        );
      }
    } finally {
      await this.flush();
      this.progressive.get(id)?.release();
      this.progressive.delete(id);
      this.cancelRequests.delete(id);
      this.verifiedBeforeUpdate.delete(id);
      // Early readability ends with the download (the verified copy or nothing replaces it).
      this.publish();
    }
  }

  async downloadEntry(id: string, book?: Book): Promise<void> {
    const e = this.entry(id);
    if (!e) throw new Error('This book is not in your library.');
    if (book && book.id !== e.book.id) throw new Error('That edition belongs to a different book.');
    await this.download(book ?? e.book, { origin: e.origin });
  }

  cancelDownload(id: string): void {
    id = this.resolveId(id);
    const e = this.entries.get(id);
    if (e && isActive(e.download)) {
      this.cancelRequests.add(id);
      this.progressive.get(id)?.cancel();
    }
  }

  async remove(id: string, options: { keepMetadata?: boolean } = {}): Promise<void> {
    id = this.resolveId(id);
    const e = this.entries.get(id);
    if (e && isActive(e.download)) return;
    this.entries.delete(id);
    if (options.keepMetadata && e) this.entries.set(id, { ...e, download: emptyDownload() });
    this.publish();
    if (e) {
      if (e.download.path) await this.deps.books.remove(e.download.path).catch(() => undefined);
      const prefixes = [`book:${id}:`, `partial:${id}:`];
      for (const key of await this.deps.books.keys().catch(() => [] as string[])) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) await this.deps.books.remove(key).catch(() => undefined);
      }
    }
    await this.persist();
  }

  async openForReading(id: string): Promise<Blob> {
    id = this.resolveId(id);
    if (this.isProvisional(id)) await this.settled(id);
    return this.readVerified(id);
  }

  async openFile(id: string): Promise<BookFile> {
    id = this.resolveId(id);
    const e = this.entries.get(id);
    if (e && isReady(e.download)) return blobFile(await this.readVerified(id));
    const partial = this.progressive.get(id);
    if (e && isActive(e.download) && partial?.canRead) return partial.open();
    throw new Error('This book is not ready to read yet.');
  }

  private async readVerified(id: string): Promise<Blob> {
    const e = this.entries.get(id);
    if (!e || !isReady(e.download)) throw new Error('This book is not ready to read yet.');
    const blob = await this.deps.books.get<Blob>(e.download.path!);
    if (!blob) {
      this.put({ ...e, download: { ...emptyDownload(), status: 'failed', error: MISSING_FILE } });
      throw new Error(MISSING_FILE);
    }
    // Re-typing is a zero-copy slice; the bytes stay in IndexedDB's blob store.
    const type = mimeTypeFor(e.book);
    return blob.type === type ? blob : blob.slice(0, blob.size, type);
  }

  /** Resolves once the entry's download is no longer running. */
  private settled(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        const e = this.entries.get(id);
        if (!e || !isActive(e.download)) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = this.subscribe(check);
      check();
    });
  }

  // ---------------------------------------------------------------- imports & cloud

  /** Adopts already verified local bytes; no HTTP download is involved. */
  async importLocal(options: { book: Book; origin: string; path: string }): Promise<LibraryEntry> {
    const { book, origin, path } = options;
    const id = entryIdentity(book.id, origin);
    const old = this.entries.get(id);
    if (old && isActive(old.download)) throw new Error('A download of this book is already running.');
    const base = old ?? newEntry(book, origin, nowIso(this.now));
    const next: LibraryEntry = {
      ...base,
      book,
      progress: old && old.book.sha256 !== book.sha256 ? null : base.progress,
      download: { status: 'ready', path, receivedBytes: book.fileSize, totalBytes: book.fileSize, error: null },
    };
    this.put(next);
    await this.flush();
    return next;
  }

  /**
   * Deduplication can map an imported SHA to an existing server book ID. Keep
   * the local file and alias the old ID so open readers keep working.
   */
  async adoptCanonical(options: { entryId: string; book: Book; origin: string }): Promise<LibraryEntry> {
    const { entryId, book, origin } = options;
    const local = this.entry(entryId);
    if (!local || local.book.sha256 !== book.sha256 || local.origin !== origin) {
      throw new Error('The imported book is no longer available.');
    }
    const id = entryIdentity(book.id, origin);
    if (this.entries.get(id) && isActive(this.entries.get(id)!.download)) {
      await new Promise<void>((resolve) => {
        const check = () => {
          const e = this.entries.get(id);
          if (!e || !isActive(e.download)) {
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = this.subscribe(check);
        this.cancelDownload(id);
        check();
      });
    }
    const latest = this.entry(entryId);
    if (!latest) throw new Error('The imported book was removed.');
    const existing = this.entries.get(id);
    const otherProgress: ReadingProgress | null = existing?.book.sha256 === book.sha256 ? existing.progress : null;
    const progress =
      otherProgress && (!latest.progress || isAfter(otherProgress.updatedAt, latest.progress.updatedAt))
        ? otherProgress
        : latest.progress;
    const next: LibraryEntry = { ...latest, id, book, progress };
    if (latest.id !== id) {
      this.entries.delete(latest.id);
      this.aliases.set(latest.id, id);
    }
    this.put(next);
    await this.flush();
    return next;
  }

  /** Cloud membership/progress never implies that bytes exist here. */
  async applyCloudEntry(options: {
    book: Book;
    origin: string;
    addedAt: string;
    progress?: ReadingProgress | null;
    lastOpenedAt?: string | null;
  }): Promise<void> {
    const { book, origin, addedAt, progress, lastOpenedAt } = options;
    const id = entryIdentity(book.id, origin);
    const current = this.entries.get(id);
    // A local replacement may still be downloading. Do not attach an older
    // cloud edition's locator or metadata to it.
    if (current && current.book.sha256 !== book.sha256) return;
    let next = current ?? newEntry(book, origin, addedAt);
    // Metadata can gain an extracted cover without changing EPUB bytes.
    if (current && !sameBookJson(current.book, book)) next = { ...next, book };
    if (progress && (!next.progress || isAfter(progress.updatedAt, next.progress.updatedAt))) next = { ...next, progress };
    if (lastOpenedAt && (!next.lastOpenedAt || isAfter(lastOpenedAt, next.lastOpenedAt))) next = { ...next, lastOpenedAt };
    if (!current || current !== next) {
      this.put(next);
      await this.flush();
    }
  }

  // ---------------------------------------------------------------- reading state

  markOpened(id: string, expectedSha256: string): Promise<void> {
    const now = nowIso(this.now);
    return this.updateReadingState(id, expectedSha256, (e) => ({ ...e, lastOpenedAt: now }));
  }

  saveProgress(id: string, locator: ReadingLocator, expectedSha256: string): Promise<void> {
    const now = nowIso(this.now);
    return this.updateReadingState(id, expectedSha256, (e) => ({
      ...e,
      progress: { locator, updatedAt: now },
      lastOpenedAt: now,
    }));
  }

  private async updateReadingState(
    id: string,
    expectedSha256: string | null,
    update: (e: LibraryEntry) => LibraryEntry,
  ): Promise<void> {
    id = this.resolveId(id);
    const current = this.entries.get(id);
    if (!current) return;
    const verified = this.verifiedBeforeUpdate.get(id);
    if (expectedSha256 === null || current.book.sha256 === expectedSha256) {
      if (verified?.book.sha256 === current.book.sha256) this.verifiedBeforeUpdate.set(id, update(verified));
      this.put(update(current));
      await this.flush();
      return;
    }
    // A verified edition can stay open while its replacement downloads. Route
    // that reader's progress to the recovery snapshot rather than the new
    // edition; after replacement the snapshot is gone and late writes are dropped.
    if (verified?.book.sha256 !== expectedSha256) return;
    this.verifiedBeforeUpdate.set(id, update(verified));
    await this.persist();
  }
}
