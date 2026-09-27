import { describe, expect, test } from 'bun:test';
import type { Book } from '../../types';
import { CatalogStoreImpl, SEARCH_DEBOUNCE_MS } from '../catalog';
import { ApiError, type ApiClient } from '../contract';
import { makeBook } from './helpers';

interface Call {
  origin: string;
  cursor: string | null | undefined;
  query: string | undefined;
}

function setup() {
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
