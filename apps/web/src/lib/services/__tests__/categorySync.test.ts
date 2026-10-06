import { describe, expect, test } from 'bun:test';
import type { SyncResponse } from '../api';
import { CategoryStoreImpl } from '../categories';
import { ApiError } from '../contract';
import { HighlightStoreImpl } from '../highlights';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl } from '../library';
import { isoOrder } from '../models';
import { SettingsStoreImpl } from '../settings';
import { CATEGORIES_RETRY_MS, SyncStoreImpl } from '../sync';
import { createMemoryLocks } from '../tabs';
import { Clock, ORIGIN, emptyResponse, fakeEnv } from './helpers';

// ---------------------------------------------------------------- fake API

interface Change {
  id: string;
  bookId: string;
  sha256: string;
  kind: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}

interface CategoryRow {
  id: string;
  name: string | null;
  color: string | null;
  createdAt: string | null;
  updatedAt: string;
  changeId: string;
  deleted: boolean;
  rev: number;
}

interface AssignmentRow {
  itemType: string;
  itemId: string;
  categoryId: string | null;
  updatedAt: string;
  changeId: string;
  rev: number;
}

/** The API's category rules (docs/categories.md), in memory. */
class FakeServer {
  categories = new Map<string, CategoryRow>();
  assignments = new Map<string, AssignmentRow>();
  rev = 0;
  /** Rows per pull response (the API uses 500). */
  pageSize = 500;
  rejectCategories = false;
  /** Runs while a request is in flight (after the server read it). */
  beforeResponse: (() => Promise<void>) | null = null;
  calls: Array<Record<string, unknown> & { changes: Change[] }> = [];

  private newer(at: string, id: string, row: { updatedAt: string; changeId: string } | undefined): boolean {
    return !row || isoOrder(at) > isoOrder(row.updatedAt) || (isoOrder(at) === isoOrder(row.updatedAt) && id > row.changeId);
  }

  sync(call: Record<string, unknown> & { changes: Change[] }): SyncResponse {
    this.calls.push(call);
    if (this.rejectCategories && ('categoriesSince' in call || call.changes.some((c) => c.kind.startsWith('category')))) {
      throw new ApiError('Sync request is invalid.', 'INVALID_SYNC', 400);
    }
    for (const c of call.changes) {
      if (c.kind === 'category') {
        expect(c.bookId).toBe('_categories');
        expect(c.sha256).toBe('0'.repeat(64));
        const id = String(c.payload.categoryId);
        const row = this.categories.get(id);
        if (row?.deleted || !this.newer(c.updatedAt, c.id, row)) continue;
        const deleted = c.payload.deleted === true;
        this.categories.set(id, {
          id,
          name: deleted ? (row?.name ?? null) : String(c.payload.name),
          color: deleted ? (row?.color ?? null) : String(c.payload.color),
          createdAt: deleted ? (row?.createdAt ?? null) : String(c.payload.createdAt),
          updatedAt: c.updatedAt,
          changeId: c.id,
          deleted,
          rev: ++this.rev,
        });
      } else if (c.kind === 'categoryItem') {
        expect(c.bookId).toBe('_categories');
        const key = `${c.payload.itemType}:${c.payload.itemId}`;
        if (!this.newer(c.updatedAt, c.id, this.assignments.get(key))) continue;
        this.assignments.set(key, {
          itemType: String(c.payload.itemType),
          itemId: String(c.payload.itemId),
          categoryId: (c.payload.categoryId as string | null) ?? null,
          updatedAt: c.updatedAt,
          changeId: c.id,
          rev: ++this.rev,
        });
      }
    }
    const response = emptyResponse();
    if ('categoriesSince' in call) {
      const since = Number(call.categoriesSince ?? 0);
      const rows = [
        ...[...this.categories.values()].map((r) => ({ kind: 'c' as const, r })),
        ...[...this.assignments.values()].map((r) => ({ kind: 'a' as const, r })),
      ]
        .filter((x) => x.r.rev > since)
        .sort((x, y) => x.r.rev - y.r.rev);
      const page = rows.slice(0, this.pageSize);
      response.categories = {
        items: page
          .filter((x) => x.kind === 'c')
          .map(({ r }) => {
            const c = r as CategoryRow;
            return { id: c.id, name: c.name, color: c.color, createdAt: c.createdAt, updatedAt: c.updatedAt, deleted: c.deleted, rev: c.rev };
          }),
        assignments: page
          .filter((x) => x.kind === 'a')
          .map(({ r }) => {
            const a = r as AssignmentRow;
            return { itemType: a.itemType, itemId: a.itemId, categoryId: a.categoryId, updatedAt: a.updatedAt, rev: a.rev };
          }),
        cursor: page.length ? page[page.length - 1]!.r.rev : since,
        more: rows.length > page.length,
      };
    }
    return response;
  }
}

// ---------------------------------------------------------------- devices

async function device(server: FakeServer, clock: Clock, kv = new MemoryKv()) {
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
  const highlights = new HighlightStoreImpl(kv, undefined, clock.now);
  await highlights.load();
  const categories = new CategoryStoreImpl(kv, undefined, clock.now);
  await categories.load();
  const client = {
    syncState: async (o: Record<string, unknown>) => {
      const response = server.sync(JSON.parse(JSON.stringify(o)) as Record<string, unknown> & { changes: Change[] });
      await server.beforeResponse?.();
      return response;
    },
    getBook: async () => {
      throw new Error('no books');
    },
  };
  const sync = new SyncStoreImpl({ kv, library, settings, highlights, categories, locks: createMemoryLocks(), env: fakeEnv(), now: clock.now, clientFor: () => client });
  await sync.load({ startTimers: false });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await sync.flush();
      await categories.flush();
    }
  };
  return {
    kv,
    categories,
    sync,
    settle,
    pending: () => sync.stored.origins[ORIGIN]?.pending ?? {},
    state: () => sync.stored.origins[ORIGIN]!,
    async cycle() {
      await settle();
      await sync.syncNow();
      await settle();
    },
  };
}

const book = (id: string) => ({ type: 'book' as const, id });
const ARTICLE = 'c'.repeat(32);

// ---------------------------------------------------------------- tests

describe('category sync', () => {
  test('edits queue in the outbox with the documented wire shapes, sent only by the scheduled cycle', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const programming = await a.categories.create('Programming', 'blue');
    await a.categories.assign(book('moby-dick'), programming.id);
    await a.categories.assign({ type: 'article', id: ARTICLE }, programming.id);
    await a.settle();
    expect(server.calls).toHaveLength(0); // Nothing is sent per action.
    const pending = a.pending();
    expect(Object.keys(pending).sort()).toEqual([`category:${programming.id}`, `categoryItem:article:${ARTICLE}`, 'categoryItem:book:moby-dick']);
    expect(pending[`category:${programming.id}`]).toMatchObject({
      bookId: '_categories',
      sha256: '0'.repeat(64),
      kind: 'category',
      updatedAt: programming.updatedAt,
      payload: { categoryId: programming.id, name: 'Programming', color: 'blue', createdAt: programming.createdAt, deleted: false },
    });
    expect(pending[`category:${programming.id}`]!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(pending['categoryItem:book:moby-dick']).toMatchObject({
      bookId: '_categories',
      sha256: '0'.repeat(64),
      kind: 'categoryItem',
      payload: { itemType: 'book', itemId: 'moby-dick', categoryId: programming.id },
    });

    await a.cycle();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.categoriesSince).toBeNull(); // Never pulled: the full set.
    expect(server.calls[0]!.changes).toHaveLength(3);
    expect(a.pending()).toEqual({});
    expect(a.state().categoryCursor).toBe(3);
    // Its own echo comes back without re-queueing anything.
    await a.cycle();
    expect(server.calls[1]!.categoriesSince).toBe(3);
    expect(server.calls[1]!.changes).toEqual([]);
    expect(a.pending()).toEqual({});
  });

  test('categories and assignments reach another device', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const c = await a.categories.create('Philosophy', 'purple');
    await a.categories.assign(book('emma'), c.id);
    await a.cycle();
    await b.cycle();
    expect(b.categories.getSnapshot().categories).toEqual([{ id: c.id, name: 'Philosophy', color: 'purple', createdAt: c.createdAt, updatedAt: c.updatedAt }]);
    expect(b.categories.categoryOf(book('emma'))?.id).toBe(c.id);
    expect(b.pending()).toEqual({});

    clock.advance(1000);
    await b.categories.update(c.id, { name: 'Thinking' });
    await b.cycle();
    await a.cycle();
    expect(a.categories.getSnapshot().categories[0]!.name).toBe('Thinking');
    expect(a.pending()).toEqual({});
  });

  test('deleting a category sends a tombstone and takes its items out of it', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const c = await a.categories.create('Sea', 'cyan');
    await a.categories.assign(book('moby-dick'), c.id);
    await a.categories.assign({ type: 'article', id: ARTICLE }, c.id);
    await a.cycle();
    await b.cycle();

    clock.advance(1000);
    await a.categories.remove(c.id);
    await a.settle();
    const pending = a.pending();
    expect(pending[`category:${c.id}`]!.payload).toEqual({ categoryId: c.id, deleted: true });
    expect(pending['categoryItem:book:moby-dick']!.payload).toEqual({ itemType: 'book', itemId: 'moby-dick', categoryId: null });
    expect(pending[`categoryItem:article:${ARTICLE}`]!.payload).toEqual({ itemType: 'article', itemId: ARTICLE, categoryId: null });
    await a.cycle();
    expect(server.categories.get(c.id)!.deleted).toBe(true);
    expect(server.assignments.get('book:moby-dick')!.categoryId).toBeNull();

    await b.cycle();
    expect(b.categories.getSnapshot().categories).toEqual([]);
    expect(b.categories.categoryOf(book('moby-dick'))).toBeNull();
    expect(b.categories.getSnapshot().assignments).toEqual({});
    expect(b.pending()).toEqual({});
  });

  test('a tombstone from elsewhere is final, and older pulls never undo pending local edits', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const c = await a.categories.create('Novels', 'amber');
    await a.categories.assign(book('emma'), c.id);
    await a.cycle();
    await b.cycle();

    // B deletes it; meanwhile A (offline) renames it and files another book.
    clock.advance(1000);
    await b.categories.remove(c.id);
    await b.cycle();
    clock.advance(1000);
    await a.categories.update(c.id, { name: 'Fiction' });
    await a.categories.assign(book('persuasion'), c.id);
    await a.cycle();
    expect(server.categories.get(c.id)!.deleted).toBe(true);
    expect(a.categories.getSnapshot().categories).toEqual([]);
    // Assignments to a deleted category are uncategorized.
    expect(a.categories.categoryOf(book('persuasion'))).toBeNull();
    await a.cycle();
    expect(a.pending()).toEqual({});

  });

  test('an edit made while a pull is in flight is not undone by it', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const poetry = await b.categories.create('Poetry', 'pink');
    const verse = await b.categories.create('Verse', 'lime');
    await b.cycle();
    await a.cycle();
    clock.advance(1000);
    await b.categories.assign(book('odes'), poetry.id);
    await b.cycle();

    // A files the book elsewhere while its request (which pulls B's older row) runs.
    server.beforeResponse = async () => {
      server.beforeResponse = null;
      clock.advance(1000);
      await a.categories.assign(book('odes'), verse.id);
    };
    await a.cycle();
    expect(server.calls[server.calls.length - 1]!.changes).toEqual([]);
    expect(a.categories.categoryOf(book('odes'))?.id).toBe(verse.id);
    expect(a.pending()['categoryItem:book:odes']!.payload.categoryId).toBe(verse.id);
    await a.cycle();
    expect(server.assignments.get('book:odes')!.categoryId).toBe(verse.id);
    expect(a.pending()).toEqual({});
    await b.cycle();
    expect(b.categories.categoryOf(book('odes'))?.id).toBe(verse.id);
  });

  test('pulls page through the cursor while the server has more', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const b = await device(server, clock);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      ids.push((await a.categories.create(`C${i}`, 'blue')).id);
    }
    for (let i = 0; i < 2; i++) await a.categories.assign(book(`book-${i}`), ids[2]!);
    await a.cycle();
    expect(server.rev).toBe(5);

    server.pageSize = 2;
    server.calls.length = 0;
    await b.cycle();
    expect(server.calls[0]!.categoriesSince).toBeNull();
    expect(b.state().categoryCursor).toBe(2);
    expect(b.categories.getSnapshot().categories.map((c) => c.name)).toEqual(['C0', 'C1']);
    await b.cycle();
    expect(server.calls[1]!.categoriesSince).toBe(2);
    // C2 arrived in this page with its first item; the second is on the next.
    expect(b.categories.itemsIn(ids[2]!)).toEqual([book('book-0')]);
    await b.cycle();
    expect(server.calls[2]!.categoriesSince).toBe(4);
    expect(b.state().categoryCursor).toBe(5);
    expect(b.categories.itemsIn(ids[2]!)).toHaveLength(2);
    expect(b.pending()).toEqual({});
  });

  test('a server without category sync keeps everything else syncing and retries in six hours', async () => {
    const server = new FakeServer();
    server.rejectCategories = true;
    const clock = new Clock();
    const a = await device(server, clock);
    const c = await a.categories.create('Later', 'gray');
    await a.categories.assign(book('emma'), c.id);
    await a.cycle();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).not.toHaveProperty('categoriesSince');
    expect(server.calls[1]!.changes).toEqual([]);
    // Highlights are not given up because of categories.
    expect(server.calls[1]).toHaveProperty('highlightsSince');
    expect(a.sync.getSnapshot().error).toBeNull();
    const until = a.state().categoriesUnsupportedUntil!;
    expect(isoOrder(until) / 1000).toBe(clock.now() + CATEGORIES_RETRY_MS);
    expect(Object.keys(a.pending()).sort()).toEqual([`category:${c.id}`, 'categoryItem:book:emma']);

    // Within six hours, category changes wait without another rejection.
    server.calls.length = 0;
    clock.advance(60 * 60_000);
    await a.cycle();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).not.toHaveProperty('categoriesSince');

    // After that, a deployed server takes them.
    server.rejectCategories = false;
    server.calls.length = 0;
    clock.advance(CATEGORIES_RETRY_MS);
    await a.cycle();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.categoriesSince).toBeNull();
    expect(server.calls[0]!.changes).toHaveLength(2);
    expect(a.pending()).toEqual({});
  });

  test('records the API would reject stay on this device', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const c = await a.categories.create('Imports', 'red');
    await a.categories.assign(book('Not A Valid Id'), c.id);
    await a.categories.assign({ type: 'article', id: 'short' }, c.id);
    await a.cycle();
    expect(server.calls[0]!.changes.map((x) => x.kind)).toEqual(['category']);
    expect(a.pending()).toEqual({});
    expect(a.categories.itemsIn(c.id)).toHaveLength(2);
  });

  test('a category made and deleted before syncing is never sent', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const c = await a.categories.create('Oops', 'red');
    await a.categories.remove(c.id);
    await a.cycle();
    expect(server.calls[0]!.changes).toEqual([]);
    expect(a.pending()).toEqual({});
  });

  test('the outbox and cursor survive a restart', async () => {
    const server = new FakeServer();
    const clock = new Clock();
    const a = await device(server, clock);
    const c = await a.categories.create('Kept', 'green');
    await a.cycle();
    await a.categories.assign(book('emma'), c.id);
    await a.settle();
    const restarted = await device(server, clock, a.kv);
    expect(Object.keys(restarted.pending())).toEqual(['categoryItem:book:emma']);
    expect(restarted.state().categoryCursor).toBe(1);
    expect(restarted.categories.categoryOf(book('emma'))?.name).toBe('Kept');
    await restarted.cycle();
    expect(server.calls[server.calls.length - 1]!.categoriesSince).toBe(1);
    expect(server.assignments.get('book:emma')!.categoryId).toBe(c.id);
  });
});
