import type { Book, LibraryEntry } from '../types';
import { ImportError, type InspectFile, type UploadBook } from '../import/contract';
import { ApiError, type ImportStore, type ImportsSnapshot } from './contract';
import type { KeyValueStore } from './kv';
import { bookBlobKey, type LibraryStoreImpl } from './library';
import { EPUB_TYPE } from './progressiveDownload';
import { entryIdentity, isActive, isReady, isRecord, nowIso, parseBook } from './models';
import { Emitter, WriteQueue } from './observable';
import { createMemoryLocks, noopBus, type Locks, type TabBus } from './tabs';

const PENDING_KEY = 'imports.pending.v1';
const UPLOAD_LOCK = 'thereader-uploads';
const GENERIC_FAILURE = 'Could not finish the import or upload. Your existing books are unchanged.';

/** A failure whose message is already meant for the reader. */
class ImportProblem extends Error {}

interface Pending {
  book: Book;
  origin: string;
  /** IndexedDB key of the verified EPUB blob. */
  path: string;
}

const pendingId = (p: Pending): string => entryIdentity(p.book.id, p.origin);

export interface ImportDeps {
  kv: KeyValueStore;
  books: KeyValueStore;
  library: LibraryStoreImpl;
  currentOrigin(): string;
  inspect: InspectFile;
  upload: UploadBook;
  covers?: { storeEmbedded(sha256: string, blob: Blob): Promise<void> };
  bus?: TabBus;
  locks?: Locks;
  now?: () => number;
}

/**
 * EPUB/MOBI imports, ported from mobile `EpubImportService`: the book is
 * readable from local storage as soon as it is imported, and a persisted
 * queue uploads it to the configured API, then adopts the canonical server
 * book (which may be an existing edition with the same SHA-256).
 */
export class ImportStoreImpl extends Emitter<ImportsSnapshot> implements ImportStore {
  private pending = new Map<string, Pending>();
  private readonly errors = new Map<string, string>();
  private readonly writes = new WriteQueue();
  private loading: Promise<void> | null = null;
  private retrying: Promise<void> | null = null;
  private retryRequested = false;
  private activeId: string | null = null;
  private activeController: AbortController | null = null;
  private fraction: number | null = null;
  private busyCount = 0;
  private error: string | null = null;
  private importChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly bus: TabBus;
  private readonly locks: Locks;
  private readonly now: () => number;

  constructor(private readonly deps: ImportDeps) {
    super({ busy: false, error: null, pendingCount: 0, uploadingId: null, uploadFraction: null, errors: {} });
    this.bus = deps.bus ?? noopBus;
    this.locks = deps.locks ?? createMemoryLocks();
    this.now = deps.now ?? Date.now;
    this.bus.listen((topic) => {
      if (topic === 'imports' && this.loading) void this.reload();
    });
  }

  private publish(): void {
    if (this.disposed) return;
    this.emit({
      busy: this.busyCount > 0,
      error: this.error,
      pendingCount: this.pending.size,
      uploadingId: this.activeId,
      uploadFraction: this.fraction,
      errors: Object.fromEntries(this.errors),
    });
  }

  // ---------------------------------------------------------------- queries

  private matches(queuedId: string | null, entryId: string): boolean {
    if (queuedId === null) return false;
    if (queuedId === entryId) return true;
    const queued = this.pending.get(queuedId);
    const entry = this.deps.library.entry(entryId);
    return queued !== undefined && entry?.origin === queued.origin && entry.book.sha256 === queued.book.sha256;
  }

  isPending(entryId: string): boolean {
    return [...this.pending.keys()].some((id) => this.matches(id, entryId));
  }

  isUploading(entryId: string): boolean {
    return this.matches(this.activeId, entryId);
  }

  errorFor(entryId: string): string | null {
    for (const [id, message] of this.errors) if (this.matches(id, entryId)) return message;
    return null;
  }

  // ---------------------------------------------------------------- persistence

  load(): Promise<void> {
    return (this.loading ??= this.loadStored());
  }

  private async readStored(): Promise<Pending[]> {
    const json = await this.deps.kv.get<unknown>(PENDING_KEY).catch(() => null);
    const items: Pending[] = [];
    for (const raw of isRecord(json) && Array.isArray(json.items) ? json.items : []) {
      try {
        if (!isRecord(raw) || typeof raw.origin !== 'string' || typeof raw.path !== 'string') continue;
        items.push({ book: parseBook(raw.book), origin: raw.origin, path: raw.path });
      } catch {
        /* A malformed queue item must not prevent reading. */
      }
    }
    return items;
  }

  private async loadStored(): Promise<void> {
    const keys = new Set(await this.deps.books.keys().catch(() => [] as string[]));
    for (let p of await this.readStored()) {
      try {
        if (!keys.has(p.path)) continue;
        const canonical = this.deps.library.all.find(
          (e) => e.origin === p.origin && e.book.sha256 === p.book.sha256 && e.download.path === p.path,
        );
        if (canonical) p = { ...p, book: canonical.book };
        this.pending.set(pendingId(p), p);
        // Recover the small window between the queue and library writes.
        if (!this.deps.library.entry(pendingId(p))) await this.deps.library.importLocal(p);
      } catch {
        /* A malformed queue item must not prevent reading. */
      }
    }
    await this.persist().catch(() => undefined);
    this.publish();
  }

  /** Another tab changed the queue (it imported, uploaded or cancelled). */
  private async reload(): Promise<void> {
    const next = new Map<string, Pending>();
    for (const p of await this.readStored()) next.set(pendingId(p), p);
    if (this.activeId && this.pending.has(this.activeId) && !next.has(this.activeId)) {
      // The other tab finished or cancelled this upload; stop ours.
      this.activeController?.abort();
    }
    this.pending = next;
    this.publish();
  }

  private persist(): Promise<void> {
    const snapshot = { items: [...this.pending.values()] };
    return this.writes.run(async () => {
      await this.deps.kv.set(PENDING_KEY, snapshot);
      this.bus.post('imports');
    });
  }

  // ---------------------------------------------------------------- import

  /** Imports run one after another; each resolves with its library entry. */
  importFile(file: File): Promise<LibraryEntry> {
    const run = this.importChain.then(() => this.importOne(file));
    this.importChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async importOne(file: File): Promise<LibraryEntry> {
    this.busyCount++;
    this.error = null;
    this.publish();
    try {
      // Origin is captured before file work, like mobile.
      const origin = this.deps.currentOrigin();
      await this.load();
      return await this.importInspected(file, origin);
    } catch (error) {
      const message = messageFor(error);
      this.error = message;
      throw error instanceof ImportError ? error : new ImportError(message);
    } finally {
      this.busyCount--;
      this.publish();
    }
  }

  private async importInspected(file: File, origin: string): Promise<LibraryEntry> {
    const inspected = await this.deps.inspect(file);
    const sha = inspected.sha256.toLowerCase();
    if (inspected.cover) {
      // An unusable cover never blocks the import; the book renders a plate.
      await this.deps.covers?.storeEmbedded(sha, inspected.cover).catch(() => undefined);
    }
    const book: Book = {
      id: `epub-${sha}`,
      version: sha.slice(0, 12),
      title: inspected.title || 'Untitled',
      author: inspected.author || 'Unknown',
      description: inspected.description ?? '',
      language: inspected.language || 'en',
      subjects: inspected.subjects ?? [],
      coverUrl: null,
      downloadUrl: `/v1/books/epub-${sha}/download`,
      fileSize: inspected.fileSize,
      sha256: sha,
      updatedAt: nowIso(this.now),
    };
    const existing = this.deps.library.all.find((e) => e.origin === origin && e.book.sha256 === sha && isReady(e.download));
    if (existing) {
      void this.retryPending();
      return existing;
    }
    const id = entryIdentity(book.id, origin);
    const current = this.deps.library.entry(id);
    if (current && isActive(current.download)) throw new ImportProblem('A download of this EPUB is already running.');
    if (inspected.epub.size !== book.fileSize) throw new ImportProblem('The EPUB changed while importing.');

    const path = bookBlobKey(id, sha);
    // Re-typing is a zero-copy slice; the bytes are not duplicated in memory.
    const blob = inspected.epub.type === EPUB_TYPE ? inspected.epub : inspected.epub.slice(0, inspected.epub.size, EPUB_TYPE);
    let stored = false;
    let queued = false;
    try {
      try {
        await this.deps.books.set(path, blob);
      } catch {
        throw new ImportProblem('Could not save the book in browser storage. Free some space and try again.');
      }
      stored = true;
      this.pending.set(id, { book, origin, path });
      await this.persist();
      queued = true;
      const entry = await this.deps.library.importLocal({ book, origin, path });
      this.publish();
      void this.retryPending();
      return entry;
    } catch (error) {
      if (!queued) {
        this.pending.delete(id);
        if (stored) await this.deps.books.remove(path).catch(() => undefined);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- upload

  retryPending(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.retrying) {
      this.retryRequested = true;
      return this.retrying;
    }
    return (this.retrying = this.locks
      .tryExclusive(UPLOAD_LOCK, () => this.retry())
      .then(() => undefined)
      .finally(() => {
        this.retrying = null;
        if (this.retryRequested) {
          this.retryRequested = false;
          void this.retryPending();
        }
      }));
  }

  private async retry(): Promise<void> {
    try {
      await this.load();
      const origin = this.deps.currentOrigin();
      for (const p of [...this.pending.values()]) {
        const id = pendingId(p);
        if (this.disposed || p.origin !== origin || !this.pending.has(id)) continue;
        const controller = new AbortController();
        this.activeId = id;
        this.activeController = controller;
        this.fraction = null;
        this.errors.delete(id);
        this.publish();
        try {
          const blob = await this.deps.books.get<Blob>(p.path).catch(() => null);
          if (!blob || !this.deps.library.entry(id)) {
            await this.cancelPending(id);
            continue;
          }
          if (blob.size !== p.book.fileSize) throw new ImportProblem('The local EPUB size changed. Import it again.');
          let lastPaint = 0;
          const uploaded = await this.deps.upload({
            origin: p.origin,
            book: p.book,
            epub: blob,
            signal: controller.signal,
            onProgress: ({ sent, total }) => {
              this.fraction = total > 0 ? Math.min(1, sent / total) : null;
              const now = this.now();
              if (sent >= total || now - lastPaint >= 80) {
                lastPaint = now;
                this.publish();
              }
            },
          });
          if (!this.pending.has(id) || this.disposed || controller.signal.aborted) continue;
          const canonical = parseBook(uploaded);
          await this.deps.library.adoptCanonical({ entryId: id, book: canonical, origin: p.origin });
          // Keep pending membership until canonical metadata is durable, so
          // sync never sends a transient book ID.
          this.pending.delete(id);
          try {
            await this.persist();
          } catch (error) {
            this.pending.set(id, p);
            throw error;
          }
          this.errors.delete(id);
        } catch (error) {
          if (this.pending.has(id) && !this.disposed && !controller.signal.aborted) this.errors.set(id, messageFor(error));
        } finally {
          this.activeId = null;
          this.activeController = null;
          this.fraction = null;
          this.publish();
        }
      }
    } catch (error) {
      this.error = messageFor(error);
      this.publish();
    }
  }

  /**
   * Call and await before deleting local bytes. Aborts an active upload and
   * durably removes the retry intent so a reload cannot resurrect it.
   */
  async cancelPending(entryId: string): Promise<void> {
    await this.load();
    const removed = new Map<string, Pending>();
    for (const id of [...this.pending.keys()]) {
      if (!this.matches(id, entryId)) continue;
      if (this.activeId === id) this.activeController?.abort();
      removed.set(id, this.pending.get(id)!);
      this.pending.delete(id);
      this.errors.delete(id);
    }
    try {
      await this.persist();
    } catch (error) {
      for (const [id, p] of removed) this.pending.set(id, p);
      throw error;
    }
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
  }
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError || error instanceof ImportError || error instanceof ImportProblem) return error.message;
  return GENERIC_FAILURE;
}
