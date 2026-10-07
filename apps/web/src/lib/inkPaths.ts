import type { InkTool } from './services/ink';

/**
 * Drawing pen strokes, shared by the article reader and the book engine:
 * smooth SVG paths through sampled points, thinning, the pens' widths and
 * dash patterns, and hit tests for the eraser.
 */

/** The pen a stroke is drawn with. */
export interface InkPen {
  tool: InkTool;
  color: string;
  size: number;
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
