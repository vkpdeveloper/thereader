import type { BlockAnchor } from '../../../lib/services/ink';

/**
 * Geometry for pen drawings over the article page: which block a stroke
 * belongs to, and where it is drawn today (from its block's box when it was
 * drawn and the box now). Paths and hit tests are in `lib/inkPaths.ts`.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The elements that hold a block's box: itself, or the children of a box-less wrapper (`display: contents`). */
export function boxElements(el: Element): Element[] {
  return el.classList.contains('article-block-contents') ? Array.from(el.children) : [el];
}

/** The box of a block (spanning a wrapper's children) relative to `origin`, the drawing surface's corner. */
export function anchorBox(el: Element, origin: { left: number; top: number }): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const part of boxElements(el)) {
    const r = part.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left)) return null;
  return { left: left - origin.left, top: top - origin.top, width: right - left, height: bottom - top };
}

/**
 * The block a stroke belongs to: the one whose vertical extent holds the
 * middle of the stroke, else the nearest. `boxes` are in reading order.
 */
export function pickAnchor<T>(boxes: { key: T; box: Box }[], midY: number): { key: T; box: Box } | null {
  let best: { key: T; box: Box } | null = null;
  let bestDistance = Infinity;
  for (const entry of boxes) {
    const { top, height } = entry.box;
    const distance = midY < top ? top - midY : midY > top + height ? midY - (top + height) : 0;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}

/** Points in surface coordinates -> points relative to the anchor, rounded to a tenth of a pixel. */
export function toAnchor(points: number[], box: Box): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0; i < points.length; i += 2) {
    out[i] = Math.round((points[i]! - box.left) * 10) / 10;
    out[i + 1] = Math.round((points[i + 1]! - box.top) * 10) / 10;
  }
  return out;
}

/**
 * A stroke's points on the surface today: offset to the anchor's current
 * corner and stretched by how much the anchor grew or shrank since drawing.
 */
export function placeStroke(stroke: { anchor: BlockAnchor; points: number[] }, box: Box): number[] {
  const sx = stroke.anchor.width > 0 && box.width > 0 ? box.width / stroke.anchor.width : 1;
  const sy = stroke.anchor.height > 0 && box.height > 0 ? box.height / stroke.anchor.height : 1;
  const p = stroke.points;
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 2) {
    out[i] = box.left + p[i]! * sx;
    out[i + 1] = box.top + p[i + 1]! * sy;
  }
  return out;
}

/** How far to slide a horizontal extent so it fits `[pad, width - pad]` (its start wins when it cannot fit). */
function shiftInto(min: number, max: number, width: number, pad: number): number {
  if (max > width - pad) return Math.max(width - pad - max, pad - min);
  return min < pad ? pad - min : 0;
}

function extent(points: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    min = Math.min(min, points[i]!);
    max = Math.max(max, points[i]!);
  }
  return [min, max];
}

/**
 * Keeps placed strokes on the page: a note written in a wide window's
 * margin would fall off a narrower one. Strokes sharing a `group` (one
 * margin beside one block: the letters of a note, its arrow) slide by the
 * same distance, so handwriting keeps its shape; others slide alone.
 */
export function keepInside(items: { group: string | null; points: number[] }[], width: number, pad = 4): number[][] {
  const groups = new Map<string, [number, number]>();
  for (const { group, points } of items) {
    if (group == null) continue;
    const [min, max] = extent(points);
    const g = groups.get(group);
    groups.set(group, g ? [Math.min(g[0], min), Math.max(g[1], max)] : [min, max]);
  }
  return items.map(({ group, points }) => {
    const [min, max] = (group != null && groups.get(group)) || extent(points);
    const shift = shiftInto(min, max, width, pad);
    return shift === 0 ? points : points.map((v, i) => (i % 2 === 0 ? v + shift : v));
  });
}

/** Which margin of its anchor a placed stroke sits in, if it lies wholly in one. */
export function marginOf(points: number[], box: Box): 'left' | 'right' | null {
  const [min, max] = extent(points);
  if (min >= box.left + box.width - 2) return 'right';
  if (max <= box.left + 2) return 'left';
  return null;
}
