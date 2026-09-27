import { describe, expect, test } from 'bun:test';
import type { Book } from '../../types';
import { BookCache, bookCacheKey } from '../bookCache';
import { CATALOG_CACHE_CAP, catalogCacheKey, CatalogStoreImpl, SEARCH_DEBOUNCE_MS } from '../catalog';
import { ApiError, type ApiClient } from '../contract';
import { MemoryKv } from '../kv';
import { makeBook } from './helpers';

interface Call {
  origin: string;
  cursor: string | null | undefined;
  query: string | undefined;
}

function setup(kv: MemoryKv | null = null) {
  let origin = 'http://api.test';
  const calls: Call[] = [];
  let respond: (call: Call) => Promise<{ items: Book[]; nextCursor: string | null }> = async () => ({ items: [], nextCursor: null });
  const catalog = new CatalogStoreImpl(
    () => origin,
    (o) =>
      ({
        origin: o,
        listBooks: (options: { cursor?: string | null; query?: string }) => {
          const call = { origin: o, cursor: options.cursor, query: options.query };
          calls.push(call);
          return respond(call);
        },
      }) as unknown as ApiClient,
    kv,
    () => Date.parse('2026-09-27T10:00:00.000Z'),
  );
  return {
    catalog,
    calls,
    setOrigin: (o: string) => (origin = o),
    respond: (fn: typeof respond) => (respond = fn),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('catalog store', () => {
  test('pages with the cursor and lists subjects in code-unit order', async () => {
    const t = setup();
    t.respond(async (call) =>
      call.cursor
        ? { items: [makeBook({ id: 'c', subjects: ['apple'] })], nextCursor: null }
        : { items: [makeBook({ id: 'a', subjects: ['Sea', 'Whales'] }), makeBook({ id: 'b', subjects: ['Adventure', 'Sea'] })], nextCursor: 'n1' },
    );
    await t.catalog.refresh();
    let s = t.catalog.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.hasMore).toBe(true);
    await t.catalog.loadMore();
    s = t.catalog.getSnapshot();
    expect(t.calls.map((c) => c.cursor ?? null)).toEqual([null, 'n1']);
    expect(s.items.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(s.hasMore).toBe(false);
    expect(s.subjects).toEqual(['Adventure', 'Sea', 'Whales', 'apple']);
    await t.catalog.loadMore(); // no cursor: no request
    expect(t.calls).toHaveLength(2);
  });

  test('search is debounced to one request for the final query', async () => {
    const t = setup();
    t.catalog.search('m');
    t.catalog.search('mo');
    t.catalog.search('moby');
    expect(t.catalog.getSnapshot().query).toBe('moby');
    expect(t.calls).toHaveLength(0);
    await wait(SEARCH_DEBOUNCE_MS + 30);
    expect(t.calls.map((c) => c.query)).toEqual(['moby']);
  });

  test('a stale response never replaces a newer one', async () => {
    const t = setup();
    let release: () => void = () => {};
    t.respond(
      (call) =>
        new Promise((resolve) => {
          const page = { items: [makeBook({ id: call.query || 'all' })], nextCursor: null };
          if (call.query === 'slow') release = () => resolve(page);
          else resolve(page);
        }),
    );
    t.catalog.search('slow');
    await wait(SEARCH_DEBOUNCE_MS + 30);
    t.catalog.search('fast');
    await wait(SEARCH_DEBOUNCE_MS + 30);
    release();
    await wait(5);
    expect(t.catalog.getSnapshot().items.map((b) => b.id)).toEqual(['fast']);
  });

  test('errors: a failed load is an error state; a failed page keeps the items', async () => {
    const t = setup();
    t.respond(async () => {
      throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
    });
    await t.catalog.refresh();
    expect(t.catalog.getSnapshot().status).toBe('error');
    expect(t.catalog.getSnapshot().error?.code).toBe('NETWORK');

    t.respond(async (call) => {
      if (call.cursor) throw new TypeError('boom');
      return { items: [makeBook()], nextCursor: 'n' };
    });
    await t.catalog.refresh();
    await t.catalog.loadMore();
    const s = t.catalog.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.items).toHaveLength(1);
    expect(s.isLoadingMore).toBe(false);
    expect(s.error?.code).toBe('UNEXPECTED');
  });

  test('switching origin drops results and goes idle without a request', async () => {
    const t = setup();
    t.respond(async () => ({ items: [makeBook()], nextCursor: 'n' }));
    t.catalog.search('moby');
    await wait(SEARCH_DEBOUNCE_MS + 30);
    expect(t.calls).toHaveLength(1);
    t.setOrigin('http://other.test');
    t.catalog.originChanged();
    const s = t.catalog.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.items).toHaveLength(0);
    expect(s.origin).toBe('http://other.test');
    expect(s.query).toBe('moby');
    await wait(5);
    expect(t.calls).toHaveLength(1);
    await t.catalog.refresh();
    expect(t.calls[t.calls.length - 1]!.origin).toBe('http://other.test');
    expect(t.calls[t.calls.length - 1]!.query).toBe('moby');
  });
});

const OTHER = 'http://other.test';
const offline = async (): Promise<never> => {
  throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
};
const ids = (items: Book[]) => items.map((b) => b.id);

/** A kv holding a saved unfiltered listing for `origin`. */
async function savedKv(origin = 'http://api.test', items = [makeBook({ id: 'old' })], nextCursor: string | null = 'c1') {
  const kv = new MemoryKv();
  await kv.set(catalogCacheKey(origin), { origin, savedAt: '2026-09-01T00:00:00.000Z', nextCursor, items });
  return kv;
}

describe('catalog cache', () => {
  test('hydrates the saved listing without any request', async () => {
    const t = setup(await savedKv());
    await t.catalog.load();
    const s = t.catalog.getSnapshot();
    expect(s.status).toBe('ready');
    expect(ids(s.items)).toEqual(['old']);
    expect(s.subjects).toEqual(['Sea']);
    expect(s.hasMore).toBe(true);
    expect(s.cachedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(s.refreshing).toBe(false);
    await wait(5);
    expect(t.calls).toHaveLength(0);
  });

  test('revalidates once in the background and replaces the items quietly', async () => {
    const kv = await savedKv();
    const t = setup(kv);
    await t.catalog.load();
    let release: () => void = () => {};
    t.respond(() => new Promise((resolve) => (release = () => resolve({ items: [makeBook({ id: 'new' })], nextCursor: null }))));
    const seen: string[] = [];
    t.catalog.subscribe(() => {
      const s = t.catalog.getSnapshot();
      seen.push(`${s.status}:${ids(s.items).join(',')}`);
    });
    const done = t.catalog.revalidate();
    await wait(5);
    expect(t.catalog.getSnapshot().refreshing).toBe(true);
    expect(ids(t.catalog.getSnapshot().items)).toEqual(['old']);
    release();
    await done;
    const s = t.catalog.getSnapshot();
    expect(ids(s.items)).toEqual(['new']);
    expect(s.cachedAt).toBeNull();
    expect(s.refreshing).toBe(false);
    expect(s.hasMore).toBe(false);
    // Never an empty or loading list in between.
    expect(seen.every((x) => x.startsWith('ready:') && x.length > 'ready:'.length)).toBe(true);
    await t.catalog.revalidate(); // once per session
    expect(t.calls).toHaveLength(1);
    await t.catalog.flush();
    const stored = await kv.get<{ items: Book[]; nextCursor: string | null; savedAt: string }>(catalogCacheKey('http://api.test'));
    expect(ids(stored!.items)).toEqual(['new']);
    expect(stored!.nextCursor).toBeNull();
    expect(stored!.savedAt).toBe('2026-09-27T10:00:00.000Z');
  });

  test('offline revalidation keeps the cached items with a stale error', async () => {
    const t = setup(await savedKv());
    t.respond(offline);
    await t.catalog.revalidate();
    const s = t.catalog.getSnapshot();
    expect(t.calls).toHaveLength(1);
    expect(s.status).toBe('ready');
    expect(ids(s.items)).toEqual(['old']);
    expect(s.error?.isNetwork).toBe(true);
    expect(s.cachedAt).not.toBeNull();
    expect(s.refreshing).toBe(false);
    await t.catalog.revalidate(); // no retry loop
    expect(t.calls).toHaveLength(1);
  });

  test('a refresh before hydration still falls back to the cache', async () => {
    const t = setup(await savedKv());
    t.respond(offline);
    await t.catalog.refresh();
    const s = t.catalog.getSnapshot();
    expect(s.status).toBe('ready');
    expect(ids(s.items)).toEqual(['old']);
    expect(s.error?.code).toBe('NETWORK');
  });

  test('clearing a search shows the cached listing at once', async () => {
    const t = setup(await savedKv());
    t.respond(async (call) => ({ items: [makeBook({ id: call.query ? 'hit' : 'fresh' })], nextCursor: null }));
    await t.catalog.revalidate();
    t.catalog.search('moby');
    await wait(SEARCH_DEBOUNCE_MS + 30);
    expect(ids(t.catalog.getSnapshot().items)).toEqual(['hit']);
    t.catalog.search('');
    const s = t.catalog.getSnapshot();
    expect(s.query).toBe('');
    expect(s.status).toBe('ready');
    expect(ids(s.items)).toEqual(['fresh']);
    await wait(SEARCH_DEBOUNCE_MS + 30);
    expect(t.calls.map((c) => c.query)).toEqual(['', 'moby']); // already fresh: no request
  });

  test('switching origin shows that origin\'s cache, or goes idle', async () => {
    const kv = await savedKv();
    await kv.set(catalogCacheKey(OTHER), { origin: OTHER, savedAt: '2026-09-02T00:00:00.000Z', nextCursor: null, items: [makeBook({ id: 'other' })] });
    const t = setup(kv);
    await t.catalog.load();
    t.setOrigin(OTHER);
    t.catalog.originChanged();
    await t.catalog.load();
    expect(t.catalog.getSnapshot().origin).toBe(OTHER);
    expect(ids(t.catalog.getSnapshot().items)).toEqual(['other']);
    t.setOrigin('http://empty.test');
    t.catalog.originChanged();
    await t.catalog.load();
    expect(t.catalog.getSnapshot().status).toBe('idle');
    expect(t.catalog.getSnapshot().items).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  test('damaged or foreign caches are ignored', async () => {
    for (const value of [
      'garbage',
      { origin: 'http://api.test', savedAt: 'x', nextCursor: null, items: [makeBook()] },
      { origin: 'http://api.test', savedAt: '2026-09-01T00:00:00.000Z', nextCursor: 5, items: [makeBook()] },
      { origin: 'http://api.test', savedAt: '2026-09-01T00:00:00.000Z', nextCursor: null, items: [{ id: 'no-fields' }] },
      { origin: OTHER, savedAt: '2026-09-01T00:00:00.000Z', nextCursor: null, items: [makeBook()] },
    ]) {
      const kv = new MemoryKv();
      await kv.set(catalogCacheKey('http://api.test'), value);
      const t = setup(kv);
      await t.catalog.load();
      expect(t.catalog.getSnapshot().status).toBe('idle');
    }
  });

  test('loaded pages are saved up to the cap; searches are never saved', async () => {
    const kv = new MemoryKv();
    const t = setup(kv);
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => makeBook({ id: `b${from + i}` }));
    t.respond(async (call) => {
      if (call.query) return { items: [makeBook({ id: 'hit' })], nextCursor: null };
      const start = call.cursor ? Number(call.cursor) : 0;
      return { items: page(100, start), nextCursor: String(start + 100) };
    });
    await t.catalog.revalidate();
    await t.catalog.loadMore();
    await t.catalog.flush();
    type Stored = { items: Book[]; nextCursor: string | null };
    let stored = await kv.get<Stored>(catalogCacheKey('http://api.test'));
    expect(stored!.items).toHaveLength(200);
    expect(stored!.nextCursor).toBe('200');
    await t.catalog.loadMore(); // 300 > cap: the 200-item snapshot stays
    await t.catalog.flush();
    stored = await kv.get<Stored>(catalogCacheKey('http://api.test'));
    expect(stored!.items.length).toBeLessThanOrEqual(CATALOG_CACHE_CAP);
    expect(stored!.nextCursor).toBe('200');
    t.catalog.search('moby');
    await wait(SEARCH_DEBOUNCE_MS + 30);
    await t.catalog.flush();
    stored = await kv.get<Stored>(catalogCacheKey('http://api.test'));
    expect(stored!.items).toHaveLength(200);

    // A new session resumes paging from the saved cursor.
    const next = setup(kv);
    await next.catalog.load();
    expect(next.catalog.getSnapshot().items).toHaveLength(200);
  });
});

describe('book cache', () => {
  test('remembers the latest books per origin and skips damaged data', async () => {
    const kv = new MemoryKv();
    const cache = new BookCache(kv);
    for (let i = 0; i < 105; i++) await cache.remember('http://api.test', makeBook({ id: `b${i}` }));
    await cache.remember('http://api.test', makeBook({ id: 'b50', title: 'Again' }));
    expect((await cache.recall('http://api.test', 'b50'))?.title).toBe('Again');
    expect(await cache.recall('http://api.test', 'b0')).toBeNull(); // evicted
    expect(await cache.recall(OTHER, 'b50')).toBeNull();
    const stored = await kv.get<{ books: Book[] }>(bookCacheKey('http://api.test'));
    expect(stored!.books).toHaveLength(100);
    expect(stored!.books[0]!.id).toBe('b50');
    await kv.set(bookCacheKey(OTHER), { origin: OTHER, books: [{ bad: true }, makeBook({ id: 'ok' })] });
    expect((await cache.recall(OTHER, 'ok'))?.id).toBe('ok');
    await kv.set(bookCacheKey(OTHER), 'garbage');
    expect(await cache.recall(OTHER, 'ok')).toBeNull();
  });
});
