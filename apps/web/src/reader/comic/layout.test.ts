import { describe, expect, test } from 'bun:test';
import { computeSpreads, firstPage, fitRect, modeForViewport, spreadGeometry, spreadIndexOf, spreadLabel, spreadPages, type Spread } from './layout';

const none = () => false;
const wideAt = (...pages: number[]) => (p: number) => pages.includes(p);
const pagesOf = (spreads: Spread[]) => spreads.map(spreadPages);

describe('comic spreads', () => {
  test('the cover stands alone on the right, then pages pair', () => {
    const spreads = computeSpreads(7, 'spread', none);
    expect(spreads[0]).toEqual({ kind: 'pair', left: null, right: 0 });
    expect(pagesOf(spreads)).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
  });

  test('a trailing odd page stands alone on the left', () => {
    const spreads = computeSpreads(6, 'spread', none);
    expect(pagesOf(spreads)).toEqual([[0], [1, 2], [3, 4], [5]]);
    expect(spreads[3]).toEqual({ kind: 'pair', left: 5, right: null });
  });

  test('a wide page takes a spread alone and pairing continues after it', () => {
    expect(computeSpreads(8, 'spread', wideAt(3))).toEqual([
      { kind: 'pair', left: null, right: 0 },
      { kind: 'pair', left: 1, right: 2 },
      { kind: 'wide', page: 3 },
      { kind: 'pair', left: 4, right: 5 },
      { kind: 'pair', left: 6, right: 7 },
    ]);
  });

  test('an unpaired page before a wide page stands on the left', () => {
    expect(computeSpreads(6, 'spread', wideAt(2))).toEqual([
      { kind: 'pair', left: null, right: 0 },
      { kind: 'pair', left: 1, right: null },
      { kind: 'wide', page: 2 },
      { kind: 'pair', left: 3, right: 4 },
      { kind: 'pair', left: 5, right: null },
    ]);
  });

  test('a wide cover and consecutive wide pages', () => {
    expect(pagesOf(computeSpreads(5, 'spread', wideAt(0, 2, 3)))).toEqual([[0], [1], [2], [3], [4]]);
    expect(computeSpreads(5, 'spread', wideAt(0, 2, 3))[0]).toEqual({ kind: 'wide', page: 0 });
  });

  test('single-page mode shows every page alone', () => {
    const spreads = computeSpreads(4, 'single', wideAt(2));
    expect(spreads).toEqual([0, 1, 2, 3].map((page) => ({ kind: 'single', page })));
  });

  test('one page and no pages', () => {
    expect(pagesOf(computeSpreads(1, 'spread', none))).toEqual([[0]]);
    expect(computeSpreads(0, 'spread', none)).toEqual([]);
  });

  test('single pages only on narrow portrait viewports', () => {
    expect(modeForViewport(390, 844)).toBe('single');
    expect(modeForViewport(844, 390)).toBe('spread');
    expect(modeForViewport(767, 1000)).toBe('single');
    expect(modeForViewport(768, 1024)).toBe('spread');
    expect(modeForViewport(1440, 900)).toBe('spread');
    expect(modeForViewport(600, 600)).toBe('spread');
  });

  test('labels', () => {
    const spreads = computeSpreads(6, 'spread', none);
    expect(spreadLabel(spreads[0], 6)).toBe('Page 1 of 6');
    expect(spreadLabel(spreads[1], 6)).toBe('2–3 of 6');
    expect(spreadLabel(spreads[3], 6)).toBe('Page 6 of 6');
  });
});

describe('page ↔ spread mapping', () => {
  test('every page maps to the spread that shows it', () => {
    const spreads = computeSpreads(9, 'spread', wideAt(4));
    for (let page = 0; page < 9; page++) {
      expect(spreadPages(spreads[spreadIndexOf(spreads, page)]!)).toContain(page);
    }
    expect(spreadIndexOf(spreads, -3)).toBe(0);
    expect(spreadIndexOf(spreads, 99)).toBe(spreads.length - 1);
  });

  test('turning the phone keeps the page on screen', () => {
    const spreads = computeSpreads(10, 'spread', none);
    const single = computeSpreads(10, 'single', none);
    // Reading pages 3–4 in landscape, then portrait: the left page shows.
    const anchor = firstPage(spreads[spreadIndexOf(spreads, 3)]!);
    expect(anchor).toBe(3);
    expect(spreadPages(single[spreadIndexOf(single, anchor)]!)).toEqual([3]);
    // On page 4 in portrait, then landscape: the spread holding page 4.
    expect(spreadPages(spreads[spreadIndexOf(spreads, 4)]!)).toEqual([3, 4]);
  });

  test('a page found to be wide reshapes the spreads around the same page', () => {
    const before = computeSpreads(8, 'spread', none);
    const reading = firstPage(before[spreadIndexOf(before, 5)]!); // pages 5–6
    expect(reading).toBe(5);
    const after = computeSpreads(8, 'spread', wideAt(2));
    expect(pagesOf(after)).toEqual([[0], [1], [2], [3, 4], [5, 6], [7]]);
    expect(spreadPages(after[spreadIndexOf(after, reading)]!)).toEqual([5, 6]);
    // And when the page itself turns out wide, it is still the one shown.
    const self = computeSpreads(8, 'spread', wideAt(5));
    expect(spreadPages(self[spreadIndexOf(self, reading)]!)).toEqual([5]);
  });
});

describe('spread geometry', () => {
  const portrait = () => ({ width: 1000, height: 1500 });

  test('facing pages fit their halves and meet at the spine', () => {
    const g = spreadGeometry({ kind: 'pair', left: 1, right: 2 }, 1440, 900, portrait);
    expect(g.spine).toBe(720);
    expect(g.left!.rect.x + g.left!.rect.width).toBeCloseTo(720);
    expect(g.right!.rect.x).toBeCloseTo(720);
    expect(g.left!.rect.height).toBeCloseTo(900);
    expect(g.left!.rect.width).toBeCloseTo(600);
  });

  test('the cover sits right of the spine with the left half empty', () => {
    const g = spreadGeometry({ kind: 'pair', left: null, right: 0 }, 1440, 900, portrait);
    expect(g.left).toBeNull();
    expect(g.right!.rect.x).toBeCloseTo(720);
  });

  test('a wide page spans both halves, centred', () => {
    const g = spreadGeometry({ kind: 'wide', page: 3 }, 1440, 900, () => ({ width: 3000, height: 1500 }));
    expect(g.left).toEqual(g.right);
    expect(g.right!.rect).toEqual({ x: 0, y: 90, width: 1440, height: 720 });
  });

  test('a single page is centred and hinges on its left edge; unknown sizes are portrait', () => {
    const g = spreadGeometry({ kind: 'single', page: 0 }, 390, 844, () => null);
    expect(g.right!.rect.width).toBeCloseTo(390);
    expect(g.spine).toBeCloseTo(0);
    expect(g.right!.rect.height).toBeCloseTo(390 / 0.66);
  });

  test('fitRect contains and aligns', () => {
    expect(fitRect(2, { x: 0, y: 0, width: 100, height: 100 }, 'center')).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(fitRect(0.5, { x: 10, y: 0, width: 100, height: 100 }, 'end')).toEqual({ x: 60, y: 0, width: 50, height: 100 });
  });
});
