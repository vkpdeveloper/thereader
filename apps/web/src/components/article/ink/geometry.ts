import type { InkStroke, InkTool } from '../../../lib/services/ink';

/**
 * Geometry for pen drawings over the article page: where a stroke is drawn
 * today (from its anchor's box when it was drawn and the box now), smooth
 * SVG paths through the sampled points, and hit tests for the eraser.
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
export function placeStroke(stroke: InkStroke, box: Box): number[] {
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

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A smooth path through sampled points: quadratic curves between the
 * midpoints of successive samples, so the line passes near every sample
 * without corners. A single point becomes a dot.
 */
export function strokePath(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return '';
  const x0 = r1(points[0]!);
  const y0 = r1(points[1]!);
  if (n === 1) return `M${x0} ${y0}l0.01 0`;
  if (n === 2) return `M${x0} ${y0}L${r1(points[2]!)} ${r1(points[3]!)}`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2]!;
    const y = points[i * 2 + 1]!;
    const mx = (x + points[i * 2 + 2]!) / 2;
    const my = (y + points[i * 2 + 3]!) / 2;
    d += `Q${r1(x)} ${r1(y)} ${r1(mx)} ${r1(my)}`;
  }
  d += `L${r1(points[(n - 1) * 2]!)} ${r1(points[(n - 1) * 2 + 1]!)}`;
  return d;
}

/** Drops samples closer than `min` pixels to the last kept one (the last sample always stays). */
export function thin(points: number[], min = 1.5): number[] {
  if (points.length <= 4) return points;
  const out = [points[0]!, points[1]!];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i]! - out[out.length - 2]!;
    const dy = points[i + 1]! - out[out.length - 1]!;
    if (dx * dx + dy * dy >= min * min) out.push(points[i]!, points[i + 1]!);
  }
  out.push(points[points.length - 2]!, points[points.length - 1]!);
  return out;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/** Whether the point lies within `radius` of the polyline. */
export function nearStroke(points: number[], x: number, y: number, radius: number): boolean {
  if (points.length === 2) return Math.hypot(points[0]! - x, points[1]! - y) <= radius;
  for (let i = 0; i + 3 < points.length; i += 2) {
    if (segmentDistance(x, y, points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!) <= radius) return true;
  }
  return false;
}

/** Width actually drawn: the marker is a broad nib. */
export function lineWidth(tool: InkTool, size: number): number {
  return tool === 'marker' ? size * 4.5 : size;
}

/** SVG dash pattern: round caps on zero-length dashes make dots. */
export function dashArray(tool: InkTool, size: number): string | undefined {
  if (tool === 'dotted') return `0 ${r1(size * 2.4)}`;
  if (tool === 'dashed') return `${r1(size * 3.2)} ${r1(size * 2.6)}`;
  return undefined;
}
