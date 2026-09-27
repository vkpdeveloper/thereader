import { describe, expect, test } from 'bun:test';
import { CoverStoreImpl, MAX_OBJECT_URLS, type ObjectUrls } from '../covers';
import { MemoryKv } from '../kv';
import { Clock, makeBook } from './helpers';

const ORIGIN = 'http://api.test';
const png = (size = 32, seed = 0) => {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes[size - 1] = seed;
  return bytes;
};

class CountingKv extends MemoryKv {
  gets = 0;
  override async get<T>(key: string): Promise<T | null> {
    this.gets++;
    return super.get<T>(key);
  }
}

function fakeUrls(): ObjectUrls & { live: Set<string>; created: number } {
  let n = 0;
  const live = new Set<string>();
  return {
    live,
    get created() {
      return n;
    },
    create() {
      const url = `blob:test/${++n}`;
      live.add(url);
      return url;
    },
    revoke(url) {
      live.delete(url);
    },
  };
}

function setup(options: { kv?: MemoryKv; status?: number; body?: Uint8Array; maxStoredBytes?: number } = {}) {
  const kv = options.kv ?? new CountingKv();
  const clock = new Clock();
  const urls = fakeUrls();
  const fetched: string[] = [];
  let status = options.status ?? 200;
  let body = options.body ?? png();
  const store = new CoverStoreImpl(kv, (origin, path) => new URL(path, `${origin}/`).toString(), {
    now: clock.now,
    objectUrls: urls,
    maxStoredBytes: options.maxStoredBytes,
    fetch: async (url) => {
      fetched.push(url);
      await new Promise((r) => setTimeout(r, 1));
      return new Response(body as BlobPart, { status, headers: { 'content-type': 'image/png', 'content-length': String(body.length) } });
    },
  });
  return {
    kv,
    clock,
    urls,
    fetched,
    store,
    setStatus: (s: number) => (status = s),
    setBody: (b: Uint8Array) => (body = b),
  };
}

const withCover = (id = 'moby-dick', sha = 'a'.repeat(64)) => makeBook({ id, sha256: sha, coverUrl: `/v1/books/${id}/cover` });

describe('cover store', () => {
  test('one request and one object URL per cover, reused by every load', async () => {
    const t = setup();
    const book = withCover();
    const [a, b] = await Promise.all([t.store.load(book, ORIGIN), t.store.load(book, ORIGIN)]);
    expect(t.fetched).toEqual([`${ORIGIN}/v1/books/moby-dick/cover`]);
    expect(a).toBe(b);
    expect(await t.store.load(book, ORIGIN)).toBe(a);
    expect(t.store.peek(book, ORIGIN)).toBe(a);
    expect(t.urls.created).toBe(1);
  });

  test('a stored cover is read from storage and never requested again', async () => {
    const first = setup();
    await first.store.load(withCover(), ORIGIN);
    await first.store.flush();
    const second = setup({ kv: first.kv });
    const url = await second.store.load(withCover(), ORIGIN);
    expect(url).not.toBeNull();
    expect(second.fetched).toHaveLength(0);
  });

  test('books without a cover resolve null and later loads skip storage', async () => {
    const t = setup();
    const book = makeBook({ coverUrl: null });
    expect(t.store.peek(book, ORIGIN)).toBeUndefined();
    expect(await t.store.load(book, ORIGIN)).toBeNull();
    const kv = t.kv as CountingKv;
    const reads = kv.gets;
    expect(await t.store.load(book, ORIGIN)).toBeNull();
    expect(kv.gets).toBe(reads);
    expect(t.store.peek(book, ORIGIN)).toBeNull();
    expect(t.fetched).toHaveLength(0);
  });

  test('a missing cover is not retried; the embedded cover stands in', async () => {
    const t = setup({ status: 404 });
    const book = withCover();
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    t.clock.advance(24 * 60 * 60_000);
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    expect(t.fetched).toHaveLength(1);

    await t.store.storeEmbedded(book.sha256, new Blob([png(40, 7) as BlobPart]));
    const embedded = await t.store.load(book, ORIGIN);
    expect(embedded).not.toBeNull();
    expect(t.fetched).toHaveLength(1);
  });

  test('network failures back off, doubling from one minute', async () => {
    const t = setup({ status: 500 });
    const book = withCover();
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    expect(t.fetched).toHaveLength(1);
    t.clock.advance(61_000);
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    expect(t.fetched).toHaveLength(2);
    t.clock.advance(61_000); // second failure waits two minutes
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    expect(t.fetched).toHaveLength(2);
    t.setStatus(200);
    t.clock.advance(61_000);
    expect(await t.store.load(book, ORIGIN)).not.toBeNull();
    expect(t.fetched).toHaveLength(3);
  });

  test('reject drops an undecodable cover, revokes its URL and backs off', async () => {
    const t = setup();
    const book = withCover();
    const url = (await t.store.load(book, ORIGIN))!;
    await t.store.reject(book, ORIGIN);
    expect(t.urls.live.has(url)).toBe(false);
    expect(t.store.peek(book, ORIGIN)).toBeUndefined();
    await expect(t.store.load(book, ORIGIN)).rejects.toThrow();
    expect(t.fetched).toHaveLength(1);
    t.clock.advance(61_000);
    expect(await t.store.load(book, ORIGIN)).not.toBeNull();
    expect(t.fetched).toHaveLength(2);
  });

  test('object URLs past the limit are revoked, least recently used first', async () => {
    const t = setup();
    const shas = Array.from({ length: MAX_OBJECT_URLS + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    const first = makeBook({ sha256: shas[0], coverUrl: null });
    await t.store.storeEmbedded(shas[0]!, new Blob([png() as BlobPart]));
    await t.store.storeEmbedded(shas[1]!, new Blob([png() as BlobPart]));
    const firstUrl = await t.store.load(first, ORIGIN);
    for (const sha of shas.slice(2)) await t.store.storeEmbedded(sha, new Blob([png() as BlobPart]));
    expect(t.urls.live.size).toBe(MAX_OBJECT_URLS);
    // shas[0] was used after shas[1], so shas[1] went first.
    expect(t.urls.live.has(firstUrl!)).toBe(true);
    expect(t.store.peek(makeBook({ sha256: shas[1], coverUrl: null }), ORIGIN)).toBeUndefined();
  });

  test('storage is bounded, evicting the least recently used covers', async () => {
    const t = setup({ maxStoredBytes: 80 });
    const books = [1, 2, 3].map((i) => withCover(`b${i}`, String(i).repeat(64)));
    const urls: string[] = [];
    for (const book of books) {
      urls.push((await t.store.load(book, ORIGIN))!);
      t.clock.advance(1000);
    }
    await t.store.flush();
    const stored = (await t.kv.keys()).filter((k) => k.startsWith('cover:'));
    expect(stored).toHaveLength(3 - 1); // 3 x 32 bytes > 80
    expect(t.urls.live.has(urls[0]!)).toBe(false);
    expect(t.urls.live.has(urls[2]!)).toBe(true);
    const index = (await t.kv.get<Record<string, unknown>>('cover-index.v1'))!;
    expect(Object.keys(index).sort()).toEqual(stored.sort());
  });

  test('an oversized body is rejected', async () => {
    const big = png(4 * 1024 * 1024 + 10);
    const t = setup({ body: big });
    await expect(t.store.load(withCover(), ORIGIN)).rejects.toThrow();
    expect((await t.kv.keys()).filter((k) => k.startsWith('cover:'))).toHaveLength(0);
  });
});
