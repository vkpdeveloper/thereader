/**
 * Comic page layout (docs/comics.md, "Layout and motion"): which pages share
 * the screen, and where each sits. Pure, so spreads can be recomputed when
 * page sizes become known or the viewport turns without losing the page.
 */

export type ComicMode = 'single' | 'spread';

/** Natural pixel size of a page image; unknown pages are treated as portrait. */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * What one screen shows. `pair` has a slot each side of the spine (either may
 * be empty: the cover stands alone on the right, a trailing page alone on the
 * left); `wide` is a double-page scan across the whole spread; `single` is a
 * page on its own in single-page mode.
 */
export type Spread =
  | { kind: 'pair'; left: number | null; right: number | null }
  | { kind: 'wide'; page: number }
  | { kind: 'single'; page: number };

/** Phones in portrait read one page at a time: narrower than 768 px and taller than wide. */
export function modeForViewport(width: number, height: number): ComicMode {
  return width < 768 && height > width ? 'single' : 'spread';
}

/** A page wider than it is tall is a double-page scan. */
export function isWide(size: PageSize | null | undefined): boolean {
  return !!size && size.width > size.height;
}

export function computeSpreads(count: number, mode: ComicMode, wide: (page: number) => boolean): Spread[] {
  const spreads: Spread[] = [];
  if (mode === 'single') {
    for (let page = 0; page < count; page++) spreads.push({ kind: 'single', page });
    return spreads;
  }
  let page = 0;
  if (count > 0 && !wide(0)) {
    spreads.push({ kind: 'pair', left: null, right: 0 });
    page = 1;
  }
  while (page < count) {
    if (wide(page)) {
      spreads.push({ kind: 'wide', page });
      page += 1;
    } else if (page + 1 < count && !wide(page + 1)) {
      spreads.push({ kind: 'pair', left: page, right: page + 1 });
      page += 2;
    } else {
      // A page without a partner (the last one, or one before a wide scan) stands on the left.
      spreads.push({ kind: 'pair', left: page, right: null });
      page += 1;
    }
  }
  return spreads;
}

/** Pages a spread shows, left to right. */
export function spreadPages(spread: Spread): number[] {
  if (spread.kind !== 'pair') return [spread.page];
  return [spread.left, spread.right].filter((p): p is number => p !== null);
}

/** The first page visible (the left page of a spread): what the locator records. */
export function firstPage(spread: Spread): number {
  return spreadPages(spread)[0]!;
}

/** Index of the spread showing `page` (clamped into range). */
export function spreadIndexOf(spreads: Spread[], page: number): number {
  if (spreads.length === 0) return 0;
  let lo = 0;
  let hi = spreads.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (firstPage(spreads[mid]!) <= page) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** "Page 3 of 20", or "4–5 of 20" for a two-page spread. */
export function spreadLabel(spread: Spread | undefined, count: number): string {
  if (!spread) return '';
  const pages = spreadPages(spread);
  return pages.length > 1 ? `${pages[0]! + 1}–${pages[pages.length - 1]! + 1} of ${count}` : `Page ${pages[0]! + 1} of ${count}`;
}

// ---------------------------------------------------------------- geometry

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Portrait comic page shape assumed until a page's real size is known. */
export const DEFAULT_ASPECT = 0.66;

function aspectOf(size: PageSize | null | undefined): number {
  return size && size.width > 0 && size.height > 0 ? size.width / size.height : DEFAULT_ASPECT;
}

/** `aspect` fitted (contain) inside `box`, aligned horizontally as asked and centred vertically. */
export function fitRect(aspect: number, box: Rect, align: 'start' | 'center' | 'end'): Rect {
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  const free = box.width - width;
  const x = box.x + (align === 'start' ? 0 : align === 'end' ? free : free / 2);
  return { x, y: box.y + (box.height - height) / 2, width, height };
}

export type Side = 'left' | 'right';

/** One half of a spread: the page drawn there and its rect in stage coordinates (a wide page's rect spans both halves). */
export interface HalfContent {
  page: number;
  rect: Rect;
}

export interface SpreadGeometry {
  /** x of the spine (spreads) or of the page's left edge (single), the hinge of a turn. */
  spine: number;
  left: HalfContent | null;
  right: HalfContent | null;
}

/**
 * Where a spread's pages sit in a `width` × `height` stage. In spread mode
 * each page fits its half and touches the spine; a wide page fits the whole
 * stage and is shared by both halves. A single page fits the stage, centred,
 * and is reported as its `right` half (the side that turns forwards).
 */
export function spreadGeometry(spread: Spread, width: number, height: number, size: (page: number) => PageSize | null): SpreadGeometry {
  const stage: Rect = { x: 0, y: 0, width, height };
  if (spread.kind === 'single') {
    const rect = fitRect(aspectOf(size(spread.page)), stage, 'center');
    return { spine: rect.x, left: null, right: { page: spread.page, rect } };
  }
  const spine = width / 2;
  if (spread.kind === 'wide') {
    const rect = fitRect(aspectOf(size(spread.page)), stage, 'center');
    return { spine, left: { page: spread.page, rect }, right: { page: spread.page, rect } };
  }
  const leftBox: Rect = { x: 0, y: 0, width: spine, height };
  const rightBox: Rect = { x: spine, y: 0, width: width - spine, height };
  return {
    spine,
    left: spread.left === null ? null : { page: spread.left, rect: fitRect(aspectOf(size(spread.left)), leftBox, 'end') },
    right: spread.right === null ? null : { page: spread.right, rect: fitRect(aspectOf(size(spread.right)), rightBox, 'start') },
  };
}
