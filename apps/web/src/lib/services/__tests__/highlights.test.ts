import { describe, expect, test } from 'bun:test';
import { HighlightStoreImpl, MAX_HIGHLIGHT_NOTE } from '../highlights';
import { MemoryKv } from '../kv';
import { isoOrder } from '../models';
import { Clock, ORIGIN, addBook, emptyResponse, harness, makeBook } from './helpers';

const base = { bookId: 'b', sha256: 's', origin: 'o', text: 't', color: 'yellow' };
const at = (p: number) => ({ href: 'ch.xhtml', locations: { totalProgression: p } });

describe('highlight store', () => {
  test('notes can be set, edited and cleared; each edit moves the stamp forward', async () => {
    const clock = new Clock();
    const store = new HighlightStoreImpl(new MemoryKv(), undefined, clock.now);
    await store.load();
    const h = await store.create({ ...base, locator: at(0.1), note: '  ' });
    expect(h.note).toBeNull();

    await store.setNote(h.id, 'Call me Ishmael');
    const noted = store.byId(h.id)!;
    expect(noted.note).toBe('Call me Ishmael');
    expect(isoOrder(noted.updatedAt)).toBeGreaterThan(isoOrder(h.updatedAt));

    await store.recolor(h.id, 'green');
    expect(store.byId(h.id)!.note).toBe('Call me Ishmael');

    const stamp = store.byId(h.id)!.updatedAt;
    await store.setNote(h.id, 'Call me Ishmael'); // unchanged: no edit
    expect(store.byId(h.id)!.updatedAt).toBe(stamp);

    await store.setNote(h.id, 'x'.repeat(MAX_HIGHLIGHT_NOTE + 50));
    expect(store.byId(h.id)!.note).toHaveLength(MAX_HIGHLIGHT_NOTE);

    await store.setNote(h.id, '');
    expect(store.byId(h.id)!.note).toBeNull();

    await store.delete(h.id);
    await store.setNote(h.id, 'too late');
    expect(store.byId(h.id)!.note).toBeNull();
  });

  test('records survive a reload, a damaged one is skipped', async () => {
    const kv = new MemoryKv();
    const store = new HighlightStoreImpl(kv);
    await store.load();
    const h = await store.create({ ...base, locator: at(0.5), note: 'n' });
    await store.flush();
    const saved = (await kv.get<{ items: unknown[] }>('highlights.v1'))!;
    await kv.set('highlights.v1', { items: [...saved.items, { id: 'broken' }] });
    const again = new HighlightStoreImpl(kv);
    await again.load();
    expect(again.getSnapshot().all).toEqual([h]);
  });

  test('forEdition filters by edition, orders by position then creation, and is stable until a change', async () => {
    const clock = new Clock();
    const store = new HighlightStoreImpl(new MemoryKv(), undefined, clock.now);
    await store.load();
    const b = await store.create({ ...base, locator: at(0.5) });
    clock.advance(1);
    const a = await store.create({ ...base, locator: at(0.5) });
    const first = await store.create({ ...base, locator: { href: 'x' } });
    await store.create({ ...base, sha256: 'other', locator: at(0.1) });
    await store.create({ ...base, origin: 'elsewhere', locator: at(0.1) });
    const list = store.forEdition('o', 's');
    expect(list.map((h) => h.id)).toEqual([first.id, b.id, a.id]);
    expect(store.forEdition('o', 's')).toBe(list);
    await store.delete(b.id);
    const next = store.forEdition('o', 's');
    expect(next).not.toBe(list);
    expect(next.map((h) => h.id)).toEqual([first.id, a.id]);
  });

  test('remote copies win only when newer, notes and tombstones included', async () => {
    const clock = new Clock();
    const store = new HighlightStoreImpl(new MemoryKv(), undefined, clock.now);
    await store.load();
    const h = await store.create({ ...base, locator: at(0.2) });
    const newer = new Date(clock.ms + 5000).toISOString();
    expect(await store.applyRemote([{ ...h, note: 'from phone', updatedAt: newer }])).toBe(true);
    expect(store.byId(h.id)!.note).toBe('from phone');
    expect(await store.applyRemote([{ ...h, deleted: true, updatedAt: h.updatedAt }])).toBe(false);
    expect(store.byId(h.id)!.deleted).toBe(false);
    expect(await store.applyRemote([{ ...h, deleted: true, updatedAt: new Date(clock.ms + 6000).toISOString() }])).toBe(true);
    expect(store.forEdition('o', 's')).toHaveLength(0);
  });
});

describe('highlight sync', () => {
  test('notes and tombstones ride the outbox; a cleared note is sent without one', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    const created = await h.highlights.create({ bookId: book.id, sha256: book.sha256, origin: ORIGIN, locator: { href: 'a' }, text: 't', color: 'pink', note: 'why' });
    await h.settle();
    await h.sync.syncNow();
    const first = h.calls[0]!.changes.find((c) => c.kind === 'highlight')!;
    expect(first.payload.note).toBe('why');
    expect(first.payload.highlightId).toBe(created.id);
    expect(first.payload.deleted).toBe(false);

    await h.highlights.setNote(created.id, null);
    await h.settle();
    await h.sync.syncNow();
    const second = h.calls[1]!.changes.find((c) => c.kind === 'highlight')!;
    expect('note' in second.payload).toBe(false);

    await h.highlights.delete(created.id);
    await h.settle();
    await h.sync.syncNow();
    expect(h.calls[2]!.changes.find((c) => c.kind === 'highlight')!.payload.deleted).toBe(true);
  });

  test('pulled notes are stored without echoing them back', async () => {
    const book = makeBook();
    const h = await harness();
    await addBook(h, book);
    await h.settle();
    await h.sync.syncNow();
    h.setHandler(() => ({
      ...emptyResponse(),
      highlights: {
        cursor: 7,
        more: false,
        items: [
          {
            id: 'remote-1',
            bookId: book.id,
            sha256: book.sha256,
            locator: { href: 'a' },
            text: 'x',
            color: 'blue',
            note: 'phone note',
            createdAt: '2026-09-27T09:00:00.000Z',
            updatedAt: '2026-09-27T09:00:00.000Z',
            deleted: false,
          },
        ],
      },
    }));
    await h.sync.syncNow();
    expect(h.highlights.byId('remote-1')!.note).toBe('phone note');
    await h.settle();
    h.setHandler(() => emptyResponse());
    await h.sync.syncNow();
    expect(h.calls[h.calls.length - 1]!.highlightsSince).toBe(7);
    expect(h.calls[h.calls.length - 1]!.changes.filter((c) => c.kind === 'highlight')).toHaveLength(0);
  });
});
