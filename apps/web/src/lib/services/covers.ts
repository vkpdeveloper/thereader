import type { Book } from '../types';
import type { CoverStore } from './contract';
import type { FetchLike } from './api';
import { sha256Hex } from './hash';
import type { KeyValueStore } from './kv';
import { COVER_CONTENT_TYPES, MAX_COVER_BYTES, coverType } from './coverValidation';

export class CoverUnavailable extends Error {
  /** The server answered that this cover does not exist (404/410). */
  constructor(readonly missing = false) {
    super('Cover unavailable.');
    this.name = 'CoverUnavailable';
  }
}

interface Failure {
  /** null: missing; do not retry this session. */
  until: number | null;
  attempts: number;
}

interface IndexEntry {
  bytes: number;
  /** Last use, for least-recently-used eviction. */
  at: number;
}

export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

const browserObjectUrls: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

const RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
/** Live object URLs; the least recently used is revoked past this. */
export const MAX_OBJECT_URLS = 300;
const MAX_REQUESTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
/** Stored covers are bounded like mobile's disk cache (64 MB, least recently used first). */
export const MAX_STORED_COVER_BYTES = 64 * 1024 * 1024;
const INDEX_KEY = 'cover-index.v1';
const KEY_PREFIX = 'cover:';
/** Last-use stamps are written in one batch this long after the last change. */
const INDEX_SAVE_DELAY_MS = 2_000;
const MAX_FAILURES = 256;
/** Uses closer together than this do not rewrite a cover's last-use stamp. */
const TOUCH_RESOLUTION_MS = 60_000;

/**
 * Covers cached in IndexedDB so they render offline, keyed by the edition's
 * SHA-256 and cover URL like mobile `CoverCache`. Embedded covers from
 * imports are stored under the edition's `embedded` key and back up a
 * missing or unreachable network cover.
 *
 * Each cached cover has one object URL, reused by every render and revoked
 * when it is evicted or replaced. Loads of the same cover share one request,
 * at most three covers download at once, and a cover in storage is never
 * requested again. Storage is bounded by a least-recently-used index whose
 * stamps are saved in batches.
 */
export class CoverStoreImpl implements CoverStore {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Map<string, Failure>();
  /** Keys known to be absent from storage, so repeated misses skip IndexedDB. */
  private readonly absent = new Set<string>();
  private readonly keys = new Map<string, string>();
  private requests = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly objectUrls: ObjectUrls;
  private readonly maxStoredBytes: number;
  private index: Map<string, IndexEntry> | null = null;
  private indexLoading: Promise<Map<string, IndexEntry>> | null = null;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private indexWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly resolveUrl: (origin: string, path: string) => string,
    options: { fetch?: FetchLike; now?: () => number; objectUrls?: ObjectUrls; maxStoredBytes?: number } = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.objectUrls = options.objectUrls ?? browserObjectUrls;
    this.maxStoredBytes = options.maxStoredBytes ?? MAX_STORED_COVER_BYTES;
  }

  private key(sha: string, url: string | null): string {
    const id = `${sha}\n${url ?? 'embedded'}`;
    let key = this.keys.get(id);
    if (!key) {
      key = `${KEY_PREFIX}${sha256Hex(id)}`;
      if (this.keys.size >= 2048) this.keys.clear();
      this.keys.set(id, key);
    }
    return key;
  }

  private coverUrl(book: Book, origin: string): string | null {
    if (!book.coverUrl) return null;
    try {
      return this.resolveUrl(origin, book.coverUrl);
    } catch {
      return null;
    }
  }

  load(book: Book, origin: string): Promise<string | null> {
    const url = this.coverUrl(book, origin);
    const key = this.key(book.sha256, url);
    const known = this.touchUrl(key);
    if (known) return Promise.resolve(known);
    let running = this.pending.get(key);
    if (!running) {
      running = this.loadUncached(book.sha256, url, key).finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    return running;
  }

  /**
   * What `load` would resolve to right now without any I/O: an object URL,
   * null for a book known to have no cover, or undefined when `load` is needed.
   * Lets a remounted cover render its image on the first frame.
   */
  peek(book: Book, origin: string): string | null | undefined {
    const url = this.coverUrl(book, origin);
    const key = this.key(book.sha256, url);
    const known = this.urls.get(key);
    if (known) return known;
    const embeddedKey = this.key(book.sha256, null);
    if (url === null) return this.absent.has(embeddedKey) ? null : undefined;
    // A cover that cannot be fetched now falls back to the embedded one.
    if (this.backingOff(key) && this.absent.has(key)) return this.urls.get(embeddedKey);
    return undefined;
  }

  /**
   * The browser could not decode a cached cover: drop it and back off before
   * fetching it again (mobile `CoverCache.reject`).
   */
  async reject(book: Book, origin: string): Promise<void> {
    const url = this.coverUrl(book, origin);
    if (url === null) return;
    const key = this.key(book.sha256, url);
    this.forget(key);
    this.fail(key, false);
    await this.removeStored(key);
  }

  /** Keeps an import's embedded cover so the book has artwork before and without upload. */
  async storeEmbedded(sha: string, blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = coverType(bytes);
    if (!type) throw new CoverUnavailable();
    const key = this.key(sha, null);
    const stored = new Blob([bytes], { type });
    await this.kv.set(key, stored);
    this.remember(key, stored);
    await this.recordStored(key, stored.size);
  }

  /** Waits for pending index writes (tests and shutdown). */
  async flush(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
      this.saveIndex();
    }
    await this.indexWrites;
  }

  // ---------------------------------------------------------------- object URLs

  /** Known URL for `key`, marked most recently used (in memory and, coarsely, in storage). */
  private touchUrl(key: string): string | undefined {
    const url = this.urls.get(key);
    if (url) {
      this.urls.delete(key);
      this.urls.set(key, url);
      const entry = this.index?.get(key);
      const now = this.now();
      if (entry && now - entry.at > TOUCH_RESOLUTION_MS) {
        entry.at = now;
        this.scheduleIndexSave();
      }
    }
    return url;
  }

  private remember(key: string, blob: Blob): string {
    this.forget(key);
    this.absent.delete(key);
    const url = this.objectUrls.create(blob);
    this.urls.set(key, url);
    while (this.urls.size > MAX_OBJECT_URLS) {
      const [oldest, oldUrl] = this.urls.entries().next().value as [string, string];
      this.urls.delete(oldest);
      this.objectUrls.revoke(oldUrl);
    }
    return url;
  }

  private forget(key: string): void {
    const url = this.urls.get(key);
    if (url) {
      this.urls.delete(key);
      this.objectUrls.revoke(url);
    }
  }

  // ---------------------------------------------------------------- storage

  private async cached(key: string): Promise<string | null> {
    const known = this.touchUrl(key);
    if (known) return known;
    if (this.absent.has(key)) return null;
    const blob = await this.kv.get<Blob>(key).catch(() => null);
    if (!blob) {
      this.absent.add(key);
      void this.dropFromIndex(key);
      return null;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = coverType(bytes);
    if (!type) {
      await this.removeStored(key);
      return null;
    }
    void this.recordStored(key, blob.size, false);
    return this.remember(key, blob.type === type ? blob : new Blob([bytes], { type }));
  }

  private async removeStored(key: string): Promise<void> {
    this.absent.add(key);
    await this.kv.remove(key).catch(() => undefined);
    await this.dropFromIndex(key);
  }

  /**
   * The stored-cover index, loaded once. Covers stored without an index entry
   * (another tab, an older build) are adopted as least recently used.
   */
  private loadIndex(): Promise<Map<string, IndexEntry>> {
    if (this.index) return Promise.resolve(this.index);
    return (this.indexLoading ??= (async () => {
      const index = new Map<string, IndexEntry>();
      try {
        const saved = await this.kv.get<Record<string, unknown>>(INDEX_KEY);
        for (const [key, value] of Object.entries(saved ?? {})) {
          const v = value as Partial<IndexEntry> | null;
          if (typeof v?.bytes === 'number' && typeof v.at === 'number') index.set(key, { bytes: v.bytes, at: v.at });
        }
        const stored = new Set((await this.kv.keys()).filter((k) => k.startsWith(KEY_PREFIX)));
        for (const key of [...index.keys()]) if (!stored.has(key)) index.delete(key);
        for (const key of stored) {
          if (index.has(key)) continue;
          const blob = await this.kv.get<Blob>(key).catch(() => null);
          if (blob) index.set(key, { bytes: blob.size, at: 0 });
        }
      } catch {
        /* An unreadable index only delays eviction. */
      }
      this.index = index;
      return index;
    })());
  }

  /** Records a stored cover (or a use of one) and evicts past the size bound. */
  private async recordStored(key: string, bytes: number, written = true): Promise<void> {
    const index = await this.loadIndex();
    index.set(key, { bytes, at: this.now() });
    if (written) await this.evict(index, key);
    this.scheduleIndexSave();
  }

  private async dropFromIndex(key: string): Promise<void> {
    if (!this.index) return;
    if (this.index.delete(key)) this.scheduleIndexSave();
  }

  private async evict(index: Map<string, IndexEntry>, keep: string): Promise<void> {
    let total = 0;
    for (const entry of index.values()) total += entry.bytes;
    if (total <= this.maxStoredBytes) return;
    const oldest = [...index].filter(([key]) => key !== keep).sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of oldest) {
      if (total <= this.maxStoredBytes) break;
      index.delete(key);
      total -= entry.bytes;
      this.forget(key);
      this.absent.add(key);
      await this.kv.remove(key).catch(() => undefined);
    }
  }

  private scheduleIndexSave(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.saveIndex();
    }, INDEX_SAVE_DELAY_MS);
  }

  private saveIndex(): void {
    const index = this.index;
    if (!index) return;
    const snapshot = Object.fromEntries(index);
    this.indexWrites = this.indexWrites.then(() => this.kv.set(INDEX_KEY, snapshot)).catch(() => undefined);
  }

  // ---------------------------------------------------------------- network

  private fail(key: string, missing: boolean): void {
    const attempts = (this.failed.get(key)?.attempts ?? 0) + 1;
    this.failed.delete(key);
    const delay = Math.min(RETRY_MS * 2 ** Math.min(attempts - 1, 20), MAX_RETRY_MS);
    this.failed.set(key, { until: missing ? null : this.now() + delay, attempts });
    if (this.failed.size > MAX_FAILURES) this.failed.delete(this.failed.keys().next().value as string);
  }

  private backingOff(key: string): boolean {
    const failure = this.failed.get(key);
    if (!failure) return false;
    return failure.until === null || failure.until > this.now();
  }

  private async acquire(): Promise<void> {
    if (this.requests < MAX_REQUESTS) {
      this.requests++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.requests--;
  }

  private async loadUncached(sha: string, url: string | null, key: string): Promise<string | null> {
    const cached = await this.cached(key);
    if (cached || url === null) return cached;
    const embedded = await this.cached(this.key(sha, null));
    if (this.backingOff(key)) {
      if (embedded) return embedded;
      throw new CoverUnavailable();
    }
    await this.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new CoverUnavailable();
      const response = await this.fetchImpl(url, { redirect: 'error', signal: controller.signal });
      if (response.status === 404 || response.status === 410) throw new CoverUnavailable(true);
      // A compressed body's Content-Length is the encoded size, not the image's.
      const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
      const length = encoded ? 0 : Number(response.headers.get('content-length') ?? '') || 0;
      if (response.status !== 200 || length > MAX_COVER_BYTES) throw new CoverUnavailable();
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!COVER_CONTENT_TYPES.has(type)) throw new CoverUnavailable();
      const bytes = await readBounded(response, MAX_COVER_BYTES, controller);
      if (length > 0 && bytes.length !== length) throw new CoverUnavailable();
      const sniffed = coverType(bytes);
      if (!sniffed) throw new CoverUnavailable();
      const blob = new Blob([bytes as BlobPart], { type: sniffed });
      this.failed.delete(key);
      const stored = await this.kv.set(key, blob).then(
        () => true,
        () => false,
      );
      const objectUrl = this.remember(key, blob);
      if (stored) await this.recordStored(key, blob.size);
      return objectUrl;
    } catch (error) {
      this.fail(key, error instanceof CoverUnavailable && error.missing);
      if (embedded) return embedded;
      throw error instanceof CoverUnavailable ? error : new CoverUnavailable();
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }
}

/** Reads a body, stopping as soon as it exceeds `max` bytes (mobile streams with the same bound). */
async function readBounded(response: Response, max: number, controller: AbortController): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new CoverUnavailable();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw new CoverUnavailable();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
