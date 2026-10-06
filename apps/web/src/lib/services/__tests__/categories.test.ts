import { describe, expect, test } from 'bun:test';
import { CategoryStoreImpl, cleanCategoryName, uuidV4 } from '../categories';
import { MemoryKv } from '../kv';
import { Clock } from './helpers';

const book = (id: string) => ({ type: 'book' as const, id });
const article = (id: string) => ({ type: 'article' as const, id });

async function store(kv = new MemoryKv(), clock = new Clock()) {
  const s = new CategoryStoreImpl(kv, undefined, clock.now);
  await s.load();
  return s;
}

describe('category store', () => {
  test('creates, renames, recolours and lists categories oldest first', async () => {
    const clock = new Clock();
    const s = await store(new MemoryKv(), clock);
    expect(s.getSnapshot()).toEqual({ loaded: true, categories: [], assignments: {} });

    const programming = await s.create('  Programming ', 'blue');
    expect(programming.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(programming).toMatchObject({ name: 'Programming', color: 'blue', createdAt: '2026-09-27T10:00:00.000Z' });
    clock.advance(1000);
    const philosophy = await s.create('Philosophy', 'purple');
    expect(s.getSnapshot().categories.map((c) => c.name)).toEqual(['Programming', 'Philosophy']);

    const before = s.getSnapshot();
    clock.advance(1000);
    await s.update(programming.id, { name: 'Code', color: 'green' });
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.categories[0]).toMatchObject({ id: programming.id, name: 'Code', color: 'green', updatedAt: '2026-09-27T10:00:02.000Z' });
    // Unchanged categories keep their objects.
    expect(after.categories[1]).toBe(before.categories[1]);
    expect(after.categories[1]!.id).toBe(philosophy.id);

    // A no-op edit publishes nothing.
    await s.update(programming.id, { name: ' Code ' });
    expect(s.getSnapshot()).toBe(after);
  });

  test('rejects invalid names with a message for people', async () => {
    const s = await store();
    await expect(s.create('   ', 'blue')).rejects.toThrow('Enter a name');
    await expect(s.create('x'.repeat(61), 'blue')).rejects.toThrow('at most 60');
    await expect(s.create('tab\there', 'blue')).rejects.toThrow('control characters');
    expect(cleanCategoryName(` ${'x'.repeat(60)} `)).toBe('x'.repeat(60));
    const c = await s.create('Fine', 'red');
    await expect(s.update(c.id, { name: '' })).rejects.toThrow('Enter a name');
    expect(s.getSnapshot().categories.map((x) => x.name)).toEqual(['Fine']);
  });

  test('assigns items, at most one category each, newest assignment first', async () => {
    const clock = new Clock();
    const s = await store(new MemoryKv(), clock);
    const a = await s.create('A', 'red');
    const b = await s.create('B', 'blue');
    await s.assign(book('moby-dick'), a.id);
    clock.advance(1000);
    await s.assign(article('f'.repeat(32)), a.id);
    clock.advance(1000);
    await s.assign(book('emma'), a.id);
    expect(s.itemsIn(a.id)).toEqual([book('emma'), article('f'.repeat(32)), book('moby-dick')]);
    expect(s.itemsIn(a.id)).toBe(s.itemsIn(a.id));
    expect(s.categoryOf(book('emma'))).toBe(s.getSnapshot().categories.find((c) => c.id === a.id)!);

    clock.advance(1000);
    await s.assign(book('moby-dick'), b.id);
    expect(s.itemsIn(a.id)).toEqual([book('emma'), article('f'.repeat(32))]);
    expect(s.itemsIn(b.id)).toEqual([book('moby-dick')]);
    expect(s.getSnapshot().assignments['book:moby-dick']).toEqual({ categoryId: b.id, assignedAt: '2026-09-27T10:00:03.000Z' });

    await s.assign(book('emma'), null);
    expect(s.categoryOf(book('emma'))).toBeNull();
    expect(s.getSnapshot().assignments['book:emma']).toBeUndefined();
    expect(s.categoryOf(book('never-filed'))).toBeNull();

    // Assigning to the same category again changes nothing (order included).
    const snap = s.getSnapshot();
    await s.assign(book('moby-dick'), b.id);
    expect(s.getSnapshot()).toBe(snap);

    await expect(s.assign(book('emma'), uuidV4())).rejects.toThrow('no longer exists');
  });

  test('deleting a category returns its items to the library home', async () => {
    const s = await store();
    const a = await s.create('A', 'red');
    const b = await s.create('B', 'blue');
    await s.assign(book('moby-dick'), a.id);
    await s.assign(book('emma'), b.id);
    await s.remove(a.id);
    expect(s.getSnapshot().categories.map((c) => c.id)).toEqual([b.id]);
    expect(s.categoryOf(book('moby-dick'))).toBeNull();
    expect(s.itemsIn(a.id)).toEqual([]);
    expect(s.assignment(book('moby-dick'))).toMatchObject({ categoryId: null });
    expect(s.category(a.id)).toMatchObject({ deleted: true });
    expect(s.categoryOf(book('emma'))?.id).toBe(b.id);
    // Deleted categories cannot be edited or filed into.
    await s.update(a.id, { name: 'Back' });
    expect(s.category(a.id)).toMatchObject({ name: 'A', deleted: true });
    await expect(s.assign(book('emma'), a.id)).rejects.toThrow();
  });

  test('persists across reloads, keeping tombstones', async () => {
    const kv = new MemoryKv();
    const s = await store(kv);
    const a = await s.create('A', 'red');
    const b = await s.create('B', 'blue');
    await s.assign(book('moby-dick'), a.id);
    await s.assign(article('a'.repeat(32)), b.id);
    await s.remove(b.id);
    await s.flush();

    const again = await store(kv);
    expect(again.getSnapshot()).toEqual(s.getSnapshot());
    expect(again.category(b.id)).toMatchObject({ deleted: true });
    expect(again.assignment(article('a'.repeat(32)))).toMatchObject({ categoryId: null });
  });

  test('a damaged record is skipped, not the whole store', async () => {
    const kv = new MemoryKv();
    const id = uuidV4();
    await kv.set('categories.v1', {
      categories: [{ id: 'nope' }, { id, name: 'Ok', color: 'magenta', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false }],
      assignments: [{ type: 'film', id: 'x' }, { type: 'book', id: 'emma', categoryId: id, updatedAt: '2026-01-02T00:00:00.000Z' }],
    });
    const s = await store(kv);
    // An unknown colour key (a newer build's) renders gray but is kept.
    expect(s.getSnapshot().categories).toEqual([{ id, name: 'Ok', color: 'gray', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(s.category(id)!.color).toBe('magenta');
    expect(s.itemsIn(id)).toEqual([book('emma')]);
  });

  test('edits move forward in time even if the clock goes back', async () => {
    const clock = new Clock();
    const s = await store(new MemoryKv(), clock);
    const a = await s.create('A', 'red');
    clock.advance(-60_000);
    await s.update(a.id, { name: 'B' });
    expect(s.category(a.id)!.updatedAt).toBe('2026-09-27T10:00:00.001Z');
  });

  test('pulled rows are last-write-wins, tombstones are final, unknown categories mean uncategorized', async () => {
    const clock = new Clock();
    const s = await store(new MemoryKv(), clock);
    const a = await s.create('Local', 'red');
    clock.advance(1000);
    await s.update(a.id, { name: 'Renamed here' });
    const older = { id: a.id, name: 'Old', color: 'blue', createdAt: a.createdAt, updatedAt: '2026-09-27T10:00:00.500Z', deleted: false };
    expect(await s.applyRemote({ categories: [older], assignments: [] })).toBe(false);
    expect(s.category(a.id)!.name).toBe('Renamed here');

    const newer = { ...older, name: 'From elsewhere', updatedAt: '2026-09-27T10:00:05.000Z' };
    await s.applyRemote({ categories: [newer], assignments: [] });
    expect(s.getSnapshot().categories[0]).toMatchObject({ name: 'From elsewhere', color: 'blue' });

    // An assignment to a category not pulled yet counts once it arrives.
    const later = uuidV4();
    await s.applyRemote({ categories: [], assignments: [{ type: 'book', id: 'emma', categoryId: later, updatedAt: '2026-09-27T10:00:01.000Z' }] });
    expect(s.categoryOf(book('emma'))).toBeNull();
    await s.applyRemote({
      categories: [{ id: later, name: 'Later', color: 'teal', createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T09:00:00.000Z', deleted: false }],
      assignments: [],
    });
    expect(s.categoryOf(book('emma'))?.name).toBe('Later');
    expect(s.getSnapshot().categories.map((c) => c.name)).toEqual(['Later', 'From elsewhere']);

    // An older tombstone still wins; a later live row cannot bring it back.
    await s.applyRemote({ categories: [{ id: later, name: '', color: 'gray', createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T08:00:00.000Z', deleted: true }], assignments: [] });
    expect(s.categoryOf(book('emma'))).toBeNull();
    expect(s.category(later)).toMatchObject({ deleted: true, name: 'Later' });
    await s.applyRemote({ categories: [{ id: later, name: 'Again', color: 'teal', createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', deleted: false }], assignments: [] });
    expect(s.category(later)).toMatchObject({ deleted: true });
    // Deleting elsewhere does not rewrite this device's assignments.
    expect(s.assignment(book('emma'))).toMatchObject({ categoryId: later });
  });

  test('tabs merge each other’s saves', async () => {
    const kv = new MemoryKv();
    const topics: Array<(t: string) => void> = [];
    const bus = { post: (t: string) => topics.forEach((h) => h(t)), listen: (h: (t: string) => void) => (topics.push(h), () => {}) };
    const one = new CategoryStoreImpl(kv, bus as never);
    const two = new CategoryStoreImpl(kv, bus as never);
    await one.load();
    await two.load();
    const c = await one.create('Shared', 'cyan');
    await one.flush();
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(two.getSnapshot().categories.map((x) => x.id)).toEqual([c.id]);
  });
});
