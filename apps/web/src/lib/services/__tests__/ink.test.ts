import { describe, expect, test } from 'bun:test';
import { InkStoreImpl, bookInkId, inkKey, isTextAnchor, type InkStroke } from '../ink';
import { MemoryKv } from '../kv';

const stroke = (id: string, createdAt: string, extra: Partial<InkStroke> = {}): InkStroke => ({
  id,
  tool: 'pen',
  color: '#ff5f57',
  size: 3.5,
  anchor: { block: 2, width: 600, height: 120 },
  points: [0, 0, 10, 5, 20, 0],
  createdAt,
  ...extra,
});

describe('ink store', () => {
  test('strokes are saved per page and read back by a new store', async () => {
    const kv = new MemoryKv();
    const store = new InkStoreImpl(kv);
    await store.open('article:a');
    expect(store.strokes('article:a')).toEqual([]);
    await store.add('article:a', [stroke('s1', '2026-10-06T10:00:00.000Z')]);
    await store.add('article:b', [stroke('s2', '2026-10-06T10:00:01.000Z')]);

    const reopened = new InkStoreImpl(kv);
    await reopened.open('article:a');
    expect(reopened.strokes('article:a').map((s) => s.id)).toEqual(['s1']);
    expect(reopened.strokes('article:a')[0]).toEqual(stroke('s1', '2026-10-06T10:00:00.000Z'));
  });

  test('a removed stroke put back (undo) returns to its place in drawing order', async () => {
    const store = new InkStoreImpl(new MemoryKv());
    await store.open('d');
    const [a, b, c] = [stroke('a', '2026-10-06T10:00:00.000Z'), stroke('b', '2026-10-06T10:00:01.000Z'), stroke('c', '2026-10-06T10:00:02.000Z')];
    await store.add('d', [a, b, c]);
    await store.remove('d', ['b']);
    expect(store.strokes('d').map((s) => s.id)).toEqual(['a', 'c']);
    await store.add('d', [b]);
    expect(store.strokes('d').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('the record goes once the last stroke is removed', async () => {
    const kv = new MemoryKv();
    const store = new InkStoreImpl(kv);
    await store.open('d');
    await store.add('d', [stroke('a', '2026-10-06T10:00:00.000Z')]);
    expect(kv.data.has(inkKey('d'))).toBe(true);
    await store.remove('d', ['a']);
    expect(kv.data.has(inkKey('d'))).toBe(false);
  });

  test('damaged strokes are skipped, the rest still load', async () => {
    const kv = new MemoryKv();
    await kv.set(inkKey('d'), {
      strokes: [
        stroke('ok', '2026-10-06T10:00:00.000Z'),
        { id: 'no-points', anchor: { block: 0, width: 1, height: 1 }, points: [] },
        { id: 'odd', anchor: { block: 0, width: 1, height: 1 }, points: [1, 2, 3] },
        stroke('bad-tool', '2026-10-06T10:00:01.000Z', { tool: 'laser' as never, color: 'red' }),
      ],
    });
    const store = new InkStoreImpl(kv);
    await store.open('d');
    const list = store.strokes('d');
    expect(list.map((s) => s.id)).toEqual(['ok', 'bad-tool']);
    // An unknown pen draws as a pen; an invalid colour falls back.
    expect(list[1]!.tool).toBe('pen');
    expect(list[1]!.color).toBe('#ededed');
  });

  test('strokes() is stable until the page changes', async () => {
    const store = new InkStoreImpl(new MemoryKv());
    await store.open('d');
    await store.add('d', [stroke('a', '2026-10-06T10:00:00.000Z')]);
    const first = store.strokes('d');
    expect(store.strokes('d')).toBe(first);
    await store.add('d', [stroke('b', '2026-10-06T10:00:01.000Z')]);
    expect(store.strokes('d')).not.toBe(first);
  });

  test('book strokes keep their text anchors through a save', async () => {
    const kv = new MemoryKv();
    const store = new InkStoreImpl(kv);
    const doc = bookInkId('abc123');
    await store.open(doc);
    const anchor = { href: 'OEBPS/ch1.xhtml', offset: 42, text: { before: 'It is a ', highlight: 'truth univer' }, height: 20 };
    await store.add(doc, [stroke('t', '2026-10-06T10:00:00.000Z', { anchor })]);
    const reopened = new InkStoreImpl(kv);
    await reopened.open(doc);
    const [saved] = reopened.strokes(doc);
    expect(saved!.anchor).toEqual(anchor);
    expect(isTextAnchor(saved!.anchor)).toBe(true);
  });

  test('a text anchor without an offset is dropped; one without its text still loads', async () => {
    const kv = new MemoryKv();
    await kv.set(inkKey('d'), {
      strokes: [
        { ...stroke('no-offset', '2026-10-06T10:00:00.000Z'), anchor: { href: 'ch.xhtml', height: 20 } },
        { ...stroke('bare', '2026-10-06T10:00:01.000Z'), anchor: { href: 'ch.xhtml', offset: 3, height: 20 } },
      ],
    });
    const store = new InkStoreImpl(kv);
    await store.open('d');
    expect(store.strokes('d').map((s) => s.id)).toEqual(['bare']);
    expect(store.strokes('d')[0]!.anchor).toEqual({ href: 'ch.xhtml', offset: 3, text: { before: '', highlight: '' }, height: 20 });
  });
});
