import type { Book } from '../types';
import { ApiError, type ApiClient, type CatalogSnapshot, type CatalogStore } from './contract';
import { Emitter } from './observable';

export const SEARCH_DEBOUNCE_MS = 250;

/** Remote catalog browsing: server-side search, paging and errors (mobile `CatalogRepository`). */
export class CatalogStoreImpl extends Emitter<CatalogSnapshot> implements CatalogStore {
  private nextCursor: string | null = null;
  private requestId = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly currentOrigin: () => string,
    private readonly clientFor: (origin: string) => ApiClient,
  ) {
    super(emptyCatalog(currentOrigin()));
  }

  /**
   * The configured API changed: drop the old origin's results and go idle
   * (mobile `replaceSource`). The browse screen loads an idle catalog when it
   * is shown, so switching origins elsewhere costs no request.
   */
  originChanged(): void {
    const origin = this.currentOrigin();
    if (origin === this.snapshot.origin) return;
    this.requestId++;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.nextCursor = null;
    this.emit({ ...emptyCatalog(origin), query: this.snapshot.query });
  }

  refresh(): Promise<void> {
    return this.load();
  }

  search(query: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (query !== this.snapshot.query) this.emit({ ...this.snapshot, query });
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  async loadMore(): Promise<void> {
    const s = this.snapshot;
    if (s.isLoadingMore || this.nextCursor === null || s.status !== 'ready') return;
    this.emit({ ...s, isLoadingMore: true });
    const id = ++this.requestId;
    try {
      const page = await this.clientFor(s.origin).listBooks({ cursor: this.nextCursor, query: s.query });
      if (id !== this.requestId) return;
      this.nextCursor = page.nextCursor;
      this.emit(withItems({ ...this.snapshot, isLoadingMore: false, hasMore: page.nextCursor !== null }, [...this.snapshot.items, ...page.items]));
    } catch (error) {
      if (id !== this.requestId) return;
      this.emit({ ...this.snapshot, isLoadingMore: false, error: asApiError(error) });
    }
  }

  private async load(): Promise<void> {
    const id = ++this.requestId;
    const origin = this.currentOrigin();
    this.nextCursor = null;
    this.emit({ ...this.snapshot, origin, status: 'loading', isLoadingMore: false, error: null, items: [], subjects: [], hasMore: false });
    try {
      const page = await this.clientFor(origin).listBooks({ query: this.snapshot.query });
      if (id !== this.requestId) return;
      this.nextCursor = page.nextCursor;
      this.emit(withItems({ ...this.snapshot, status: 'ready', hasMore: page.nextCursor !== null }, page.items));
    } catch (error) {
      if (id !== this.requestId) return;
      this.emit({ ...this.snapshot, status: 'error', error: asApiError(error) });
    }
  }
}

function emptyCatalog(origin: string): CatalogSnapshot {
  return { status: 'idle', items: [], query: '', subjects: [], hasMore: false, isLoadingMore: false, error: null, origin };
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
