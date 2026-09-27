import type { Book } from '../types';
import { ApiError, type ApiClient, type CatalogSnapshot, type CatalogStore } from './contract';
import type { KeyValueStore } from './kv';
import { isRecord, parseBook } from './models';
import { Emitter, WriteQueue } from './observable';

export const SEARCH_DEBOUNCE_MS = 250;
/** Most catalog items kept on disk per origin (first page plus loaded pages). */
export const CATALOG_CACHE_CAP = 240;
const CACHE_PREFIX = 'catalog-cache.v1:';

export const catalogCacheKey = (origin: string): string => `${CACHE_PREFIX}${origin}`;

/** The unfiltered (empty query) listing of one origin, as last seen. */
interface Listing {
  items: Book[];
  nextCursor: string | null;
  savedAt: string;
  /** Fetched from the API during this session, not just read from disk. */
  fresh: boolean;
  /** Why the last background revalidation failed. */
  error: ApiError | null;
}

/**
 * Remote catalog browsing: server-side search, paging and errors (mobile
 * `CatalogRepository`). The unfiltered listing is kept on disk per origin so
 * Browse renders at once and revalidates with a single background request.
 */
export class CatalogStoreImpl extends Emitter<CatalogSnapshot> implements CatalogStore {
  private nextCursor: string | null = null;
  private requestId = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private listing: Listing | null = null;
  private hydration: Promise<void> | null = null;
  /** The unfiltered listing was requested from this origin this session. */
  private revalidated = false;
  private readonly writes = new WriteQueue();

  constructor(
    private readonly currentOrigin: () => string,
    private readonly clientFor: (origin: string) => ApiClient,
    private readonly kv: KeyValueStore | null = null,
    private readonly now: () => number = Date.now,
  ) {
    super(emptyCatalog(currentOrigin()));
  }

  /** Reads the current origin's cached listing from disk. Never touches the network. */
  load(): Promise<void> {
    return this.hydrate();
  }

  /**
   * The configured API changed: show the new origin's cached listing, or go
   * idle (mobile `replaceSource`). Browse revalidates when it is shown, so
   * switching origins elsewhere costs no request.
   */
  originChanged(): void {
    const origin = this.currentOrigin();
    if (origin === this.snapshot.origin) return;
    this.requestId++;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.nextCursor = null;
    this.listing = null;
    this.hydration = null;
    this.revalidated = false;
    this.emit({ ...emptyCatalog(origin), query: this.snapshot.query });
    void this.hydrate();
  }

  async refresh(): Promise<void> {
    // One quick disk read first, so a refresh never hides saved items.
    await this.hydrate();
    return this.fetchFirstPage();
  }

  async revalidate(): Promise<void> {
    const origin = this.snapshot.origin;
    await this.hydrate();
    const s = this.snapshot;
    if (s.origin !== origin) return;
    if (s.status === 'idle') return this.fetchFirstPage();
    if (s.status === 'ready' && s.query === '' && !s.refreshing && !this.revalidated) return this.fetchFirstPage();
  }

  search(query: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    // Clearing the search shows the unfiltered listing again without waiting.
    if (query === '' && this.listing && this.snapshot.status !== 'idle') {
      this.requestId++;
      this.showListing(this.listing, false);
      if (!this.revalidated) void this.fetchFirstPage();
      return;
    }
    if (query !== this.snapshot.query) this.emit({ ...this.snapshot, query });
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.fetchFirstPage();
    }, SEARCH_DEBOUNCE_MS);
  }

  async loadMore(): Promise<void> {
    const s = this.snapshot;
    if (s.isLoadingMore || s.refreshing || this.nextCursor === null || s.status !== 'ready') return;
    this.emit({ ...s, isLoadingMore: true });
    const id = ++this.requestId;
    try {
      const page = await this.clientFor(s.origin).listBooks({ cursor: this.nextCursor, query: s.query });
      if (id !== this.requestId) return;
      this.nextCursor = page.nextCursor;
      const items = [...this.snapshot.items, ...page.items];
      this.emit(withItems({ ...this.snapshot, isLoadingMore: false, hasMore: page.nextCursor !== null }, items));
      if (s.query === '' && this.listing) {
        this.listing = { ...this.listing, items, nextCursor: page.nextCursor };
        // Past the cap the stored cursor would no longer match the stored items.
        if (items.length <= CATALOG_CACHE_CAP) this.persist(s.origin, this.listing);
      }
    } catch (error) {
      if (id !== this.requestId) return;
      this.emit({ ...this.snapshot, isLoadingMore: false, error: asApiError(error) });
    }
  }

  /** Waits for queued cache writes (tests). */
  flush(): Promise<void> {
    return this.writes.flush();
  }

  private hydrate(): Promise<void> {
    return (this.hydration ??= this.hydrateFrom(this.snapshot.origin));
  }

  private async hydrateFrom(origin: string): Promise<void> {
    if (!this.kv) return;
    let listing: Listing | null = null;
    try {
      listing = parseCache(await this.kv.get<unknown>(catalogCacheKey(origin)), origin);
    } catch (error) {
      console.warn('Could not read the catalog cache', error);
    }
    // A fetch that finished first already holds newer data.
    if (!listing || origin !== this.snapshot.origin || this.listing) return;
    this.listing = listing;
    const s = this.snapshot;
    if (s.query !== '' || (s.status !== 'idle' && s.status !== 'loading')) return;
    // A first load already in flight becomes a background refresh of the cache.
    this.showListing(listing, s.status === 'loading');
  }

  private showListing(listing: Listing, refreshing: boolean): void {
    this.nextCursor = listing.nextCursor;
    this.emit(
      withItems(
        {
          ...this.snapshot,
          query: '',
          status: 'ready',
          hasMore: listing.nextCursor !== null,
          isLoadingMore: false,
          refreshing,
          cachedAt: listing.fresh ? null : listing.savedAt,
          error: refreshing ? null : listing.error,
        },
        listing.items,
      ),
    );
  }

  private async fetchFirstPage(): Promise<void> {
    const id = ++this.requestId;
    const origin = this.currentOrigin();
    const query = this.snapshot.query;
    const s = this.snapshot;
    // With the unfiltered listing on screen, refresh it behind the items.
    const quiet = query === '' && this.listing !== null && s.origin === origin && s.status === 'ready';
    if (query === '') this.revalidated = true;
    if (quiet) {
      this.showListing(this.listing!, true);
    } else {
      this.nextCursor = null;
      this.emit({
        ...s,
        origin,
        status: 'loading',
        isLoadingMore: false,
        refreshing: false,
        cachedAt: null,
        error: null,
        items: [],
        subjects: [],
        hasMore: false,
      });
    }
    try {
      const page = await this.clientFor(origin).listBooks({ query });
      if (id !== this.requestId) return;
      this.nextCursor = page.nextCursor;
      if (query === '') {
        this.listing = { items: page.items, nextCursor: page.nextCursor, savedAt: new Date(this.now()).toISOString(), fresh: true, error: null };
        this.persist(origin, this.listing);
      }
      this.emit(
        withItems(
          { ...this.snapshot, status: 'ready', hasMore: page.nextCursor !== null, refreshing: false, cachedAt: null, error: null },
          page.items,
        ),
      );
    } catch (error) {
      if (id !== this.requestId) return;
      const err = asApiError(error);
      // Offline with cached items (possibly shown by a late hydration): keep them.
      if (query === '' && this.listing && this.snapshot.status === 'ready') {
        this.listing = { ...this.listing, error: err };
        this.emit({ ...this.snapshot, refreshing: false, error: err });
      } else {
        this.emit({ ...this.snapshot, status: 'error', refreshing: false, error: err });
      }
    }
  }

  private persist(origin: string, listing: Listing): void {
    const kv = this.kv;
    if (!kv) return;
    const stored: StoredCatalog = {
      origin,
      savedAt: listing.savedAt,
      nextCursor: listing.nextCursor,
      items: listing.items.slice(0, CATALOG_CACHE_CAP),
    };
    // A truncated listing keeps no cursor: its next page is unknown.
    if (listing.items.length > CATALOG_CACHE_CAP) stored.nextCursor = null;
    void this.writes.run(() => kv.set(catalogCacheKey(origin), stored));
  }
}

interface StoredCatalog {
  origin: string;
  savedAt: string;
  nextCursor: string | null;
  items: Book[];
}

/** A stored listing, or null when it is missing, damaged or from another origin. */
function parseCache(value: unknown, origin: string): Listing | null {
  if (!isRecord(value) || value.origin !== origin || typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) return null;
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > CATALOG_CACHE_CAP) return null;
  if (value.nextCursor !== null && typeof value.nextCursor !== 'string') return null;
  try {
    const items = value.items.map(parseBook);
    return { items, nextCursor: value.nextCursor, savedAt: value.savedAt, fresh: false, error: null };
  } catch {
    return null;
  }
}

function emptyCatalog(origin: string): CatalogSnapshot {
  return { status: 'idle', items: [], query: '', subjects: [], hasMore: false, isLoadingMore: false, refreshing: false, cachedAt: null, error: null, origin };
}

function withItems(s: CatalogSnapshot, items: Book[]): CatalogSnapshot {
  // Code-unit order, like Dart's `List<String>.sort()` on mobile.
  const subjects = [...new Set(items.flatMap((b) => b.subjects))].sort();
  return { ...s, items, subjects };
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, 'UNEXPECTED');
}
