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

const RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const MAX_OBJECT_URLS = 300;
const MAX_REQUESTS = 3;

/**
 * Covers cached in IndexedDB so they render offline, keyed by the edition's
 * SHA-256 and cover URL like mobile `CoverCache`. Embedded covers from
 * imports are stored under the edition's `embedded` key and back up a
 * missing or unreachable network cover.
 */
export class CoverStoreImpl implements CoverStore {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Map<string, Failure>();
  private requests = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly resolveUrl: (origin: string, path: string) => string,
    options: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  private key(sha: string, url: string | null): string {
    return `cover:${sha256Hex(`${sha}\n${url ?? 'embedded'}`)}`;
  }

  load(book: Book, origin: string): Promise<string | null> {
    let url: string | null = null;
    if (book.coverUrl) {
      try {
        url = this.resolveUrl(origin, book.coverUrl);
      } catch {
        url = null;
      }
    }
    const key = this.key(book.sha256, url);
    const known = this.urls.get(key);
    if (known) return Promise.resolve(known);
    let running = this.pending.get(key);
    if (!running) {
      running = this.loadUncached(book.sha256, url, key).finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    return running;
  }

  /** Keeps an import's embedded cover so the book has artwork before and without upload. */
  async storeEmbedded(sha: string, blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = coverType(bytes);
    if (!type) throw new CoverUnavailable();
    const key = this.key(sha, null);
    const stored = new Blob([bytes], { type });
    await this.kv.set(key, stored);
    this.forget(key);
  }

  private async cached(key: string): Promise<string | null> {
    const known = this.urls.get(key);
    if (known) return known;
    const blob = await this.kv.get<Blob>(key).catch(() => null);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = coverType(bytes);
    if (!type) {
      await this.kv.remove(key).catch(() => undefined);
      return null;
    }
    return this.remember(key, blob.type === type ? blob : new Blob([bytes], { type }));
  }

  private remember(key: string, blob: Blob): string {
    this.forget(key);
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    while (this.urls.size > MAX_OBJECT_URLS) {
      const [oldest, oldUrl] = this.urls.entries().next().value as [string, string];
      this.urls.delete(oldest);
      URL.revokeObjectURL(oldUrl);
    }
    return url;
  }

  private forget(key: string): void {
    const url = this.urls.get(key);
    if (url) {
      this.urls.delete(key);
      URL.revokeObjectURL(url);
    }
  }

  private fail(key: string, missing: boolean): void {
    const attempts = (this.failed.get(key)?.attempts ?? 0) + 1;
    this.failed.delete(key);
    const delay = Math.min(RETRY_MS * 2 ** Math.min(attempts - 1, 20), MAX_RETRY_MS);
    this.failed.set(key, { until: missing ? null : this.now() + delay, attempts });
    if (this.failed.size > 256) this.failed.delete(this.failed.keys().next().value as string);
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
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new CoverUnavailable();
      const response = await this.fetchImpl(url, { redirect: 'error', signal: controller.signal });
      if (response.status === 404 || response.status === 410) throw new CoverUnavailable(true);
      // A compressed body's Content-Length is the encoded size, not the image's.
      const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
      const length = encoded ? 0 : Number(response.headers.get('content-length') ?? '');
      if (response.status !== 200 || length > MAX_COVER_BYTES) throw new CoverUnavailable();
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!COVER_CONTENT_TYPES.has(type)) throw new CoverUnavailable();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_COVER_BYTES || (length > 0 && bytes.length !== length)) throw new CoverUnavailable();
      const sniffed = coverType(bytes);
      if (!sniffed) throw new CoverUnavailable();
      const blob = new Blob([bytes], { type: sniffed });
      await this.kv.set(key, blob).catch(() => undefined);
      this.failed.delete(key);
      return this.remember(key, blob);
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
