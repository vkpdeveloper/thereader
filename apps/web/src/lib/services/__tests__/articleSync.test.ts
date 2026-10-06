import { describe, expect, test } from 'bun:test';
import type { Article, ExtractOptions } from '@thereader/extract';
import type { SyncResponse } from '../api';
import {
  ArticleStoreImpl,
  MAX_ARTICLE_BODY_BYTES,
  articleBody,
  articleIdFor,
  articleKey,
  articleUrlKey,
  fractionFromPosition,
  positionFromFraction,
} from '../articles';
import { ApiError } from '../contract';
import { sha256Bytes, toHex } from '../hash';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl } from '../library';
import { isoOrder } from '../models';
import { SettingsStoreImpl } from '../settings';
import { SyncStoreImpl, articlePayload } from '../sync';
import { createMemoryLocks } from '../tabs';
import { Clock, ORIGIN, emptyResponse, fakeEnv } from './helpers';

// ---------------------------------------------------------------- fake API

interface Row {
  id: string;
  updatedAt: string;
  changeId: string;
  deleted: boolean;
  meta: Record<string, unknown>;
  position: Record<string, unknown> | null;
  positionUpdatedAt: string | null;
  positionChangeId: string | null;
  rev: number;
}

/** The API's article rules (LWW, tombstones, rev cursor), in memory. */
class FakeServer {
  rows = new Map<string, Row>();
  bodies = new Map<string, Uint8Array>();
  rev = 0;
  puts = 0;
  gets = 0;
  calls: Array<Record<string, unknown>> = [];
  /** Requests in arrival order: `sync` or `put`. */
  log: string[] = [];
  failPuts = false;
  failSync = false;
  rejectArticles = false;

  private newer(at: string, id: string, rowAt: string | null, rowId: string | null): boolean {
    return rowAt === null || isoOrder(at) > isoOrder(rowAt) || (isoOrder(at) === isoOrder(rowAt) && id > (rowId ?? ''));
  }

  sync(call: Record<string, unknown>): SyncResponse {
    if (this.failSync) throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
    this.calls.push(call);
    this.log.push('sync');
    const changes = call.changes as Array<{ id: string; kind: string; updatedAt: string; payload: Record<string, unknown> }>;
    if (this.rejectArticles && ('articlesSince' in call || changes.some((c) => c.kind.startsWith('article')))) {
      throw new ApiError('Sync request is invalid.', 'INVALID_SYNC', 400);
    }
    const ordered = [...changes].sort((a, b) => Number(a.kind === 'articleProgress') - Number(b.kind === 'articleProgress'));
    for (const c of ordered) {
      const id = String(c.payload.articleId);
      const row = this.rows.get(id);
      if (c.kind === 'article') {
        if (row && !this.newer(c.updatedAt, c.id, row.updatedAt, row.changeId)) continue;
        const deleted = c.payload.deleted === true;
        const resurrect = !deleted && row?.deleted;
        this.rows.set(id, {
          id,
          updatedAt: c.updatedAt,
          changeId: c.id,
          deleted,
          meta: deleted ? (row?.meta ?? {}) : c.payload,
          position: resurrect ? null : (row?.position ?? null),
          positionUpdatedAt: resurrect ? null : (row?.positionUpdatedAt ?? null),
          positionChangeId: resurrect ? null : (row?.positionChangeId ?? null),
          rev: ++this.rev,
        });
        // Like the Worker: a deletion drops a document no live article references.
        const sha = row?.meta.bodySha256;
        if (deleted && typeof sha === 'string' && ![...this.rows.values()].some((r) => !r.deleted && r.meta.bodySha256 === sha)) {
          this.bodies.delete(sha);
        }
      } else if (c.kind === 'articleProgress') {
        if (!row || row.deleted || !this.newer(c.updatedAt, c.id, row.positionUpdatedAt, row.positionChangeId)) continue;
        Object.assign(row, { position: c.payload.position, positionUpdatedAt: c.updatedAt, positionChangeId: c.id, rev: ++this.rev });
      }
    }
    const response = emptyResponse();
    if ('articlesSince' in call) {
      const since = Number(call.articlesSince ?? 0);
      const items = [...this.rows.values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev);
      response.articles = {
        items: items.map((r) => ({
          ...r.meta,
          id: r.id,
          position: r.position,
          positionUpdatedAt: r.positionUpdatedAt,
          updatedAt: r.updatedAt,
          deleted: r.deleted,
        })),
        cursor: items.length ? items[items.length - 1]!.rev : since,
        more: false,
      };
    }
    return response;
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    if (this.failPuts) throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
    this.puts++;
    this.log.push('put');
    if (toHex(sha256Bytes(bytes)) !== sha) throw new ApiError('mismatch', 'CHECKSUM_MISMATCH', 422);
    this.bodies.set(sha, bytes);
  }

  async get(sha: string): Promise<Uint8Array> {
    this.gets++;
    const bytes = this.bodies.get(sha);
    if (!bytes) throw new ApiError('Article document not found.', 'NOT_FOUND', 404);
    return bytes;
  }
}

// ---------------------------------------------------------------- devices

function fakeArticle(url: string, overrides: Partial<Article> = {}): Article {
  return {
    schema: 1,
    url,
    title: `Story at ${url}`,
    subtitle: null,
    byline: 'Ada Writer',
    authors: ['Ada Writer'],
    siteName: 'Example',
    publishedAt: '2026-10-01T08:00:00Z',
    modifiedAt: null,
    language: 'en',
    dir: 'ltr',
    excerpt: 'It begins.',
    leadImage: { src: 'https://cdn.example.org/lead.jpg', alt: '' },
    favicon: 'https://example.org/favicon.ico',
    wordCount: 900,
    readingMinutes: 4,
    blocks: Array.from({ length: 10 }, (_, i) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Paragraph ${i}` }] })),
    ...overrides,
  };
}

/** `pages` overrides what extraction returns for a URL. */
async function device(server: FakeServer, clock: Clock, kv = new MemoryKv(), pages: Record<string, Partial<Article>> = {}) {
  let pageFetches = 0;
  let extractions = 0;
  const settings = new SettingsStoreImpl(kv, ORIGIN, undefined, clock.now);
  await settings.load();
  const library = new LibraryStoreImpl({
    kv,
    books: new MemoryKv(),
    currentOrigin: () => settings.currentOrigin(),
    clientFor: () => ({ openDownload: async () => new Response(null, { status: 500 }) }),
    now: clock.now,
  });
  await library.load();
  const client = {
    syncState: async (o: Record<string, unknown>) => server.sync(JSON.parse(JSON.stringify(o)) as Record<string, unknown>),
    getBook: async () => {
      throw new Error('no books');
    },
    putArticleBody: (sha: string, bytes: Uint8Array) => server.put(sha, bytes),
    getArticleBody: (sha: string) => server.get(sha),
  };
  const articles = new ArticleStoreImpl({
    kv,
    currentOrigin: () => ORIGIN,
    now: clock.now,
    bodies: () => client,
    fetch: async (input: string) => {
      pageFetches++;
      const target = new URL(input).searchParams.get('url') ?? '';
      return new Response(`<p>${target}</p>`, { status: 200, headers: { 'Content-Type': 'text/html', 'X-Final-Url': target } });
    },
    parse: (html: string) => ({ html }) as unknown as Document,
    extract: (_doc: Document, o: ExtractOptions) => {
      extractions++;
      return fakeArticle(o.url, pages[o.url]);
    },
  });
  await articles.load();
  const sync = new SyncStoreImpl({ kv, library, settings, articles, locks: createMemoryLocks(), env: fakeEnv(), now: clock.now, clientFor: () => client });
  await sync.load({ startTimers: false });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await sync.flush();
      await articles.flush();
    }
  };
  return {
    kv,
    articles,
    sync,
    settle,
    counts: () => ({ pageFetches, extractions }),
    pending: () => sync.stored.origins[ORIGIN]?.pending ?? {},
    uploads: () => sync.stored.origins[ORIGIN]?.articleUploads ?? {},
    /** One sync cycle, plus the prefetch it starts. */
    async cycle() {
      await settle();
      await sync.syncNow();
      await settle();
    },
  };
}

// ---------------------------------------------------------------- tests

describe('article ids', () => {
  test('the same story gets the same id however its URL was written', () => {
    const id = articleIdFor('https://www.Example.com/a/b/?utm_source=x&id=2#top');
    expect(articleUrlKey('https://www.Example.com/a/b/?utm_source=x&id=2#top')).toBe('example.com/a/b?id=2');
    expect(id).toBe(toHex(sha256Bytes(new TextEncoder().encode('example.com/a/b?id=2'))).slice(0, 32));
    expect(articleIdFor('http://example.com/a/b?id=2')).toBe(id);
    expect(articleIdFor('https://example.com/a/b?id=3')).not.toBe(id);
    expect(articleIdFor('https://example.com/A/b?id=2')).not.toBe(id);
    // Shared vectors: `article_repository_sync_test.dart` checks the same ids.
    expect(id).toBe('a1059795a40b472d904b598e027d39a2');
    expect(articleIdFor('https://example.com/')).toBe('a379a6f6eeafb9a55e378c118034e275');
    expect(articleIdFor('https://blog.example.org/2026/10/story?ref=home&fbclid=1')).toBe('a505279b9eb30ca7b81c2a1c4b5ce03b');
    expect(articleIdFor('https://user@WWW.example.com:443/caf%C3%A9/')).toBe('e57c58164fa0fc9433461248091a8c90');
  });

  test('positions translate between block fractions and shared positions', () => {
    expect(positionFromFraction(0.35, 10)).toEqual({ block: 3, offset: 0.5, percent: 0.35 });
    expect(fractionFromPosition({ block: 3, offset: 0.5, percent: 0.2 }, 10)).toBe(0.35);
    expect(positionFromFraction(1, 10)).toEqual({ block: 9, offset: 1, percent: 1 });
    expect(fractionFromPosition({ block: 9, offset: 0.2, percent: 1 }, 10)).toBe(1);
    expect(positionFromFraction(0.4, undefined)).toEqual({ block: 0, offset: 0, percent: 0.4 });
    expect(fractionFromPosition({ block: 2, offset: 0, percent: 0.4 }, 0)).toBe(0.4);
  });
});

describe('article sync between devices', () => {
  test('a save syncs metadata and one upload; the other device reads it without fetching the page', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);

    const saved = await a.articles.add('https://example.com/story');
    expect(saved.id).toBe(articleIdFor('https://example.com/story'));
    expect(saved.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    await a.settle();
    expect(Object.keys(a.pending())).toEqual([`article:${saved.id}`]);
    expect(a.uploads()).toEqual({ [saved.id]: saved.bodySha256! });

    await a.cycle();
    expect(server.puts).toBe(1);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.articlesSince).toBe(0);
    expect(a.pending()).toEqual({});
    expect(a.uploads()).toEqual({});
    // Its own echo comes back without re-queueing anything.
    await a.cycle();
    expect(a.pending()).toEqual({});
    expect(server.puts).toBe(1);

    await b.cycle();
    const remote = b.articles.summary(saved.id)!;
    expect(remote).toMatchObject({ title: saved.title, url: saved.url, bodySha256: saved.bodySha256, readingMinutes: 4 });
    // Small documents download during the cycle, so they open offline.
    expect(server.gets).toBe(1);
    expect(b.articles.summary(saved.id)!.stored).toBe(true);
    expect(await b.articles.get(saved.id)).toEqual((await a.articles.get(saved.id))!);
    expect(b.counts()).toEqual({ pageFetches: 0, extractions: 0 });
    expect(b.pending()).toEqual({});
    expect(b.uploads()).toEqual({});
  });

  test('an article whose document is not uploaded yet stays pending, then opens', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    server.failPuts = true;
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    expect(server.calls).toHaveLength(1); // The failed upload did not block sync.
    expect(a.uploads()).toEqual({ [saved.id]: saved.bodySha256! });

    await b.cycle();
    expect(b.articles.summary(saved.id)!.stored).toBe(false);
    const error = await b.articles.get(saved.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PENDING');

    // The queue survives a restart of the saving device.
    const restarted = await device(server, clock, a.kv);
    server.failPuts = false;
    await restarted.cycle();
    expect(server.puts).toBe(1);
    expect(restarted.uploads()).toEqual({});
    expect((await b.articles.get(saved.id))?.title).toBe(saved.title);
    expect(b.articles.summary(saved.id)!.stored).toBe(true);
  });

  test('a damaged download is rejected', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    server.failPuts = true;
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    server.bodies.set(saved.bodySha256!, new TextEncoder().encode('{"schema":1}'));
    await b.cycle();
    expect(b.articles.summary(saved.id)!.stored).toBe(false);
    const error = await b.articles.get(saved.id).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(error?.code).toBe('BAD_RESPONSE');
  });

  test('deletions propagate, and saving again resurrects the article', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    await b.cycle();
    expect(b.articles.summary(saved.id)).toBeDefined();

    clock.advance(1000);
    await b.articles.remove(saved.id);
    await b.cycle();
    expect(server.rows.get(saved.id)!.deleted).toBe(true);
    expect(server.bodies.has(saved.bodySha256!)).toBe(false);
    await a.cycle();
    expect(a.articles.summary(saved.id)).toBeUndefined();
    expect(await a.kv.get(articleKey(saved.id))).toBeNull();
    expect(a.pending()).toEqual({});
    await b.cycle();
    expect(b.pending()).toEqual({});

    clock.advance(1000);
    const again = await a.articles.add('https://example.com/story');
    expect(again.id).toBe(saved.id);
    expect(a.counts().extractions).toBe(2);
    await a.cycle();
    expect(server.rows.get(saved.id)!.deleted).toBe(false);
    // Saving again uploads the document again.
    expect(server.puts).toBe(2);
    expect(server.bodies.has(again.bodySha256!)).toBe(true);
    await b.cycle();
    expect(b.articles.summary(saved.id)).toMatchObject({ id: saved.id, progress: null, stored: true });
    expect((await b.articles.get(saved.id))?.title).toBe(saved.title);
  });

  test('a document uploads only after the server accepted its save', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const saved = await a.articles.add('https://example.com/story');
    server.failSync = true;
    await a.cycle();
    expect(server.log).toEqual([]);
    expect(a.uploads()).toEqual({ [saved.id]: saved.bodySha256! });

    server.failSync = false;
    await a.cycle();
    expect(server.log).toEqual(['sync', 'put']);
    const [change] = server.calls[0]!.changes as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(change!.kind).toBe('article');
    expect(change!.payload.bodySha256).toBe(saved.bodySha256);
    expect(a.uploads()).toEqual({});
  });

  test('a deletion elsewhere wins over a position this device read meanwhile', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    await b.cycle();
    clock.advance(1000);
    await b.articles.remove(saved.id);
    await b.cycle();
    clock.advance(1000);
    await a.articles.saveProgress(saved.id, 0.6); // read on A before it heard of the delete
    await a.cycle();
    expect(a.articles.summary(saved.id)).toBeUndefined();
    expect(server.rows.get(saved.id)).toMatchObject({ deleted: true, position: null });
    await a.cycle();
    expect(a.pending()).toEqual({});
  });

  test('reading positions sync by time and never move backwards', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    await b.cycle();

    clock.advance(1000);
    await a.articles.saveProgress(saved.id, 0.35);
    await a.cycle();
    expect(server.rows.get(saved.id)!.position).toEqual({ block: 3, offset: 0.5, percent: 0.35 });
    await b.cycle();
    expect(b.articles.summary(saved.id)!.progress).toBe(0.35);
    expect(b.pending()).toEqual({});

    // B moves on later; A's older position (queued while offline) does not win.
    clock.advance(1000);
    await b.articles.saveProgress(saved.id, 0.8);
    clock.advance(-500);
    await a.articles.saveProgress(saved.id, 0.5);
    clock.advance(500);
    await b.cycle();
    await a.cycle();
    expect(server.rows.get(saved.id)!.position).toMatchObject({ percent: 0.8 });
    expect(a.articles.summary(saved.id)!.progress).toBe(0.8);
  });

  test('two devices saving the same story converge on one article', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const first = await a.articles.add('https://www.example.com/story/');
    clock.advance(1000);
    const second = await b.articles.add('http://example.com/story?utm_source=feed');
    expect(second.id).toBe(first.id);
    await a.cycle();
    await b.cycle();
    await a.cycle();
    expect(server.rows.size).toBe(1);
    expect(a.articles.summary(first.id)!.addedAt).toBe(b.articles.summary(first.id)!.addedAt);
    expect(a.pending()).toEqual({});
    expect(b.pending()).toEqual({});
  });

  test('an article too large to sync stays readable on this device and never blocks sync', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const huge = 'https://example.com/huge';
    const blocks = [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'x'.repeat(MAX_ARTICLE_BODY_BYTES) }] }];
    const a = await device(server, clock, new MemoryKv(), { [huge]: { blocks } });
    const b = await device(server, clock);
    const sent = () => server.calls.flatMap((c) => (c.changes as Array<{ payload: Record<string, unknown> }>).map((x) => x.payload.articleId));

    const big = await a.articles.add(huge);
    const small = await a.articles.add('https://example.com/story');
    expect(big.bodySize).toBeGreaterThan(MAX_ARTICLE_BODY_BYTES);
    await a.cycle();
    expect(sent()).toEqual([small.id]);
    expect(server.puts).toBe(1);
    expect(a.sync.getSnapshot().error).toBeNull();
    expect(a.sync.stored.origins[ORIGIN]!.articlesUnsupportedUntil).toBeUndefined();
    expect(a.pending()).toEqual({});
    expect(a.uploads()).toEqual({});
    expect((await a.articles.get(big.id))?.blocks).toEqual(blocks);

    // Its reading position and deletion stay here too.
    clock.advance(1000);
    await a.articles.saveProgress(big.id, 0.5);
    await a.cycle();
    clock.advance(1000);
    await a.articles.remove(big.id);
    await a.cycle();
    expect(sent()).toEqual([small.id]);
    expect(a.pending()).toEqual({});
    expect(a.articles.summary(big.id)).toBeUndefined();

    await b.cycle();
    expect([...b.articles.all].map((s) => s.id)).toEqual([small.id]);
  });

  test('a server without article sync keeps everything else syncing', async () => {
    const server = new FakeServer();
    server.rejectArticles = true;
    const clock = new Clock();
    const a = await device(server, clock);
    const saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).not.toHaveProperty('articlesSince');
    expect(a.sync.getSnapshot().error).toBeNull();
    expect(a.sync.stored.origins[ORIGIN]!.articlesUnsupportedUntil).toBeDefined();
    expect(Object.keys(a.pending())).toEqual([`article:${saved.id}`]);
  });

  test('articles saved before sync move to their URL id and record their hash', async () => {
    const kv = new MemoryKv();
    const article = fakeArticle('https://example.com/old');
    await kv.set('articles.v1', {
      items: [{ id: 'random123', url: article.url, urls: [article.url], title: article.title, siteName: 'Example', byline: null, excerpt: null, favicon: null, image: null, readingMinutes: 4, addedAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, progress: 0.5 }],
    });
    await kv.set(articleKey('random123'), { article });
    const server = new FakeServer();
    const a = await device(server, new Clock(), kv);
    const id = articleIdFor(article.url);
    expect(a.articles.summary('random123')).toBeUndefined();
    expect(a.articles.summary(id)).toMatchObject({ progress: 0.5, bodySha256: articleBody(article).sha256, blockCount: 10 });
    expect(await kv.get(articleKey('random123'))).toBeNull();
    expect((await a.articles.get(id))?.title).toBe(article.title);
  });

  test('the wire payload clips long text and drops what the API would reject', () => {
    const base = { id: 'a'.repeat(32), url: 'https://example.com/x', urls: [], title: 't'.repeat(1200), siteName: 'S', byline: null, excerpt: 'e'.repeat(3000), favicon: 'data:image/png;base64,' + 'A'.repeat(3000), image: 'javascript:x', readingMinutes: 0, addedAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, progress: null };
    const payload = articlePayload({ ...base, bodySha256: 'b'.repeat(64), bodySize: 100 })!;
    expect((payload.title as string).length).toBe(1000);
    expect((payload.excerpt as string).length).toBe(2000);
    expect(payload.favicon).toBeNull();
    expect(payload.leadImage).toBeNull();
    expect(payload.readingMinutes).toBe(1);
    expect(articlePayload({ ...base, bodySha256: 'b'.repeat(64), bodySize: MAX_ARTICLE_BODY_BYTES })).not.toBeNull();
    expect(articlePayload({ ...base, bodySha256: 'b'.repeat(64), bodySize: MAX_ARTICLE_BODY_BYTES + 1 })).toBeNull();
    expect(articlePayload({ ...base, url: 'ftp://x.example/y', bodySha256: 'b'.repeat(64), bodySize: 1 })).toBeNull();
  });
});
