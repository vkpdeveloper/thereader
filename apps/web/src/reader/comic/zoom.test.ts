import { describe, expect, test } from 'bun:test';
import { computeSpreads, spreadGeometry, type PageSize, type Rect } from './layout';
import { spreadShading, turnSides, type TurnSides } from './turn';
import {
  clampZoom,
  contentBounds,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_ZOOM,
  FIT,
  isDoubleTap,
  isZoomed,
  MAX_ZOOM,
  panBy,
  pinchZoom,
  tapZone,
  toggleZoom,
  wheelZoomFactor,
  zoomAbout,
  zoomGeometry,
  zoomRect,
} from './zoom';

const W = 1440;
const H = 900;

/** The synthetic test comic: 14 pages, page 7 a double-page scan. */
const sizes = (wide: number[]) => (p: number): PageSize => (wide.includes(p) ? { width: 2000, height: 1500 } : { width: 1000, height: 1500 });

function turns(count: number, wide: number[]) {
  const size = sizes(wide);
  const spreads = computeSpreads(count, 'spread', (p) => wide.includes(p));
  return spreads.slice(1).map((hi, i) => {
    const lo = spreads[i]!;
    return turnSides(spreadGeometry(lo, W, H, size), spreadGeometry(hi, W, H, size));
  });
}

const all: TurnSides = { front: true, back: true, underLeft: true, underRight: true };

describe('turn sides', () => {
  // Spreads: [·1] [2 3] [4 5] [6 ·] [7 7] [8 9] [10 11] [12 13] [14 ·]
  const t = turns(14, [6]);

  test('every transition turns the side that has a page', () => {
    expect(t[0]).toEqual({ ...all, underLeft: false }); // cover → 2–3: nothing lies left of the cover
    expect(t[1]).toEqual(all); // 2–3 → 4–5
    expect(t[2]).toEqual({ ...all, underRight: false }); // 4–5 → 6 alone: nothing to uncover on the right
    expect(t[3]).toEqual({ ...all, front: false }); // 6 alone → wide 7: the leaf has no front
    expect(t[4]).toEqual(all); // wide 7 → 8–9: the scan's right half turns
    expect(t[7]).toEqual({ ...all, underRight: false }); // 12–13 → 14 alone
    expect(t).toHaveLength(8);
  });

  test('wide to wide, and a page alone before a run of scans', () => {
    // Spreads: [·1] [2 3] [4 ·] [5 5] [6 6] [7 8] [9 ·]
    const w = turns(9, [4, 5]);
    expect(w[2]).toEqual({ ...all, front: false });
    expect(w[3]).toEqual(all);
    expect(w[5]).toEqual({ ...all, underRight: false });
  });

  test('an empty face is unshaded and casts no shadow', () => {
    const noFront = { ...all, front: false };
    for (const p of [0.1, 0.3, 0.45]) {
      const s = spreadShading(p, noFront);
      expect(s.front).toBe(0);
      expect(s.castRight).toBe(0);
    }
    // Past upright the back (the scan's left half) comes down over the page alone, shaded and casting.
    const late = spreadShading(0.7, noFront);
    expect(late.back).toBeGreaterThan(0);
    expect(late.castLeft).toBeGreaterThan(0);
  });

  test('no shadow falls on an empty half', () => {
    const cover = { ...all, underLeft: false };
    expect(spreadShading(0.7, cover).castLeft).toBe(0);
    expect(spreadShading(0.3, cover).castRight).toBeGreaterThan(0);
    const alone = { ...all, underRight: false };
    expect(spreadShading(0.3, alone).castRight).toBe(0);
    expect(spreadShading(0.7, alone).castLeft).toBeGreaterThan(0);
  });

  test('a full spread casts on whichever half the leaf is over', () => {
    const early = spreadShading(0.25, all);
    expect(early.castRight).toBeGreaterThan(0);
    expect(early.castLeft).toBe(0);
    const late = spreadShading(0.75, all);
    expect(late.castLeft).toBeGreaterThan(0);
    expect(late.castRight).toBe(0);
    expect(spreadShading(0, all).castRight).toBe(0);
    expect(spreadShading(1, all).castLeft).toBeCloseTo(0);
  });
});

describe('zoom', () => {
  const stage = { width: 400, height: 800 };
  // A portrait page fitted to the phone's width, letterboxed vertically.
  const page: Rect = { x: 0, y: 100, width: 400, height: 600 };

  test('fit is the identity and stays exact', () => {
    expect(clampZoom(FIT, page, stage)).toEqual(FIT);
    expect(clampZoom({ scale: 1.0004, x: 3, y: 7 }, page, stage)).toEqual(FIT);
    expect(isZoomed(FIT)).toBe(false);
    expect(zoomRect(page, FIT)).toEqual(page);
  });

  test('zooming about a point keeps it under the finger', () => {
    const z = zoomAbout(FIT, 2, 200, 400, page, stage);
    expect(z.scale).toBe(2);
    // Content point (200, 400) is still drawn at (200, 400).
    expect(200 * z.scale + z.x).toBeCloseTo(200);
    expect(400 * z.scale + z.y).toBeCloseTo(400);
    expect(zoomAbout(z, 10, 200, 400, page, stage).scale).toBe(MAX_ZOOM);
    expect(zoomAbout(z, 0.1, 200, 400, page, stage)).toEqual(FIT);
  });

  test('a zoomed page cannot be dragged past its edges', () => {
    const z = zoomAbout(FIT, 2, 0, 400, page, stage);
    // Dragging far right pins the page's left edge to the stage's left edge.
    const right = panBy(z, 5000, 0, page, stage);
    expect(right.x).toBeCloseTo(0);
    const left = panBy(z, -5000, 0, page, stage);
    expect(left.x).toBeCloseTo(400 - 800);
    // Vertically the 1200 px tall page covers the stage: its top cannot drop below the stage's top.
    const down = panBy(z, 0, 5000, page, stage);
    expect(down.y).toBeCloseTo(-100 * 2);
    const up = panBy(z, 0, -5000, page, stage);
    expect(up.y).toBeCloseTo(800 - 700 * 2);
  });

  test('an axis still smaller than the stage stays wholly on screen', () => {
    const wide: Rect = { x: 0, y: 325, width: 400, height: 150 };
    const z = zoomAbout(FIT, 2, 200, 400, wide, stage);
    // 300 px tall: it may sit anywhere between the stage's top and bottom.
    expect(panBy(z, 0, -5000, wide, stage).y).toBeCloseTo(-325 * 2);
    expect(panBy(z, 0, 5000, wide, stage).y).toBeCloseTo(800 - 475 * 2);
  });

  test('a pinch scales by the fingers’ spread about their midpoint', () => {
    const z = pinchZoom(FIT, { x: 100, y: 300 }, 100, { x: 100, y: 300 }, 250, page, stage);
    expect(z.scale).toBeCloseTo(2.5);
    expect(100 * z.scale + z.x).toBeCloseTo(100);
    expect(300 * z.scale + z.y).toBeCloseTo(300);
    // Moving both fingers drags the page with them.
    const moved = pinchZoom(FIT, { x: 200, y: 400 }, 100, { x: 150, y: 380 }, 200, page, stage);
    expect(200 * moved.scale + moved.x).toBeCloseTo(150);
    expect(400 * moved.scale + moved.y).toBeCloseTo(380);
    // Pinching in past fit lands at fit.
    expect(pinchZoom(z, { x: 100, y: 300 }, 200, { x: 100, y: 300 }, 20, page, stage)).toEqual(FIT);
  });

  test('a double tap zooms in on the spot, and again back to fit', () => {
    const z = toggleZoom(FIT, 300, 500, page, stage);
    expect(z.scale).toBe(DOUBLE_TAP_ZOOM);
    expect(300 * z.scale + z.x).toBeCloseTo(300);
    expect(toggleZoom(z, 10, 10, page, stage)).toEqual(FIT);
  });

  test('wheel zoom is smooth for trackpads and bounded for mice', () => {
    expect(wheelZoomFactor(-4)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-4)).toBeLessThan(1.05);
    expect(wheelZoomFactor(4)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBe(1.25);
    expect(wheelZoomFactor(100)).toBe(0.8);
    expect(wheelZoomFactor(3, 1)).toBe(0.8);
  });

  test('zoomed geometry and bounds', () => {
    const g = spreadGeometry(computeSpreads(3, 'spread', () => false)[1]!, 1000, 500, () => ({ width: 300, height: 500 }));
    const bounds = contentBounds(g)!;
    expect(bounds).toEqual({ x: 200, y: 0, width: 600, height: 500 });
    const z = { scale: 2, x: -500, y: -250 };
    const zg = zoomGeometry(g, z);
    expect(zg.spine).toBe(500);
    expect(zg.left!.rect).toEqual({ x: -100, y: -250, width: 600, height: 1000 });
    expect(zoomGeometry(g, FIT)).toBe(g);
    expect(contentBounds({ spine: 0, left: null, right: null })).toBeNull();
  });
});

describe('taps', () => {
  test('outer thirds turn, the middle is for controls and zoom', () => {
    expect(tapZone(10, 390)).toBe('previous');
    expect(tapZone(380, 390)).toBe('next');
    expect(tapZone(195, 390)).toBe('centre');
    expect(tapZone(129, 390)).toBe('previous');
    expect(tapZone(261, 390)).toBe('next');
  });

  test('a double tap is quick and close', () => {
    const first = { t: 1000, x: 200, y: 400 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS - 10, x: 215, y: 420 })).toBe(true);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS + 10, x: 200, y: 400 })).toBe(false);
    expect(isDoubleTap(first, { t: 1100, x: 300, y: 400 })).toBe(false);
  });
});
