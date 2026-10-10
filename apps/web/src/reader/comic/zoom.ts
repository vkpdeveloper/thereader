import type { Rect, SpreadGeometry } from './layout';

/**
 * Zoom over the fitted spread, and how taps are read. Pure, so the gesture
 * maths is testable without a browser.
 *
 * A zoom maps a point `c` of the fitted spread to `c * scale + offset` on the
 * stage. Zoomed pages are laid out at their zoomed size (not scaled as a
 * bitmap), so the browser draws them from the full-resolution image.
 */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const FIT: Zoom = { scale: 1, x: 0, y: 0 };
export const MAX_ZOOM = 4;
/** Where a double tap (or double click) zooms to. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** One press of + or −. */
export const KEY_ZOOM_STEP = 1.5;
/** A second tap within this time and distance of the first is a double tap. */
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_SLOP = 40;

export function isZoomed(z: Zoom): boolean {
  return z.scale > 1.001;
}

/** The area the spread's pages cover (a wide page counts once). */
export function contentBounds(g: SpreadGeometry): Rect | null {
  const rects = [g.left?.rect, g.right?.rect].filter((r): r is Rect => !!r);
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Keeps the pages in view: a zoomed page larger than the stage cannot be
 * dragged past its edges, and one still smaller stays wholly on screen.
 * At (or below) fit the zoom is reset exactly.
 */
export function clampZoom(z: Zoom, bounds: Rect, stage: Size): Zoom {
  if (!isZoomed(z)) return FIT;
  const scale = Math.min(MAX_ZOOM, z.scale);
  return {
    scale,
    x: clampAxis(z.x, bounds.x, bounds.width, stage.width, scale),
    y: clampAxis(z.y, bounds.y, bounds.height, stage.height, scale),
  };
}

function clampAxis(offset: number, start: number, length: number, view: number, scale: number): number {
  const a = -start * scale; // the content's start on the view's start
  const b = view - (start + length) * scale; // the content's end on the view's end
  return Math.min(Math.max(a, b), Math.max(Math.min(a, b), offset));
}

/** Scales by `factor` about stage point (px, py), which stays where it is. */
export function zoomAbout(z: Zoom, factor: number, px: number, py: number, bounds: Rect, stage: Size): Zoom {
  const scale = Math.min(MAX_ZOOM, Math.max(1, z.scale * factor));
  const k = scale / z.scale;
  return clampZoom({ scale, x: px - (px - z.x) * k, y: py - (py - z.y) * k }, bounds, stage);
}

export function panBy(z: Zoom, dx: number, dy: number, bounds: Rect, stage: Size): Zoom {
  return clampZoom({ scale: z.scale, x: z.x + dx, y: z.y + dy }, bounds, stage);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Two-finger pinch: the content point first under the fingers' midpoint
 * stays under it, scaled by how far the fingers have spread.
 */
export function pinchZoom(start: Zoom, startMid: Point, startDistance: number, mid: Point, distance: number, bounds: Rect, stage: Size): Zoom {
  if (startDistance <= 0) return start;
  const scale = Math.min(MAX_ZOOM, Math.max(1, start.scale * (distance / startDistance)));
  const cx = (startMid.x - start.x) / start.scale;
  const cy = (startMid.y - start.y) / start.scale;
  return clampZoom({ scale, x: mid.x - cx * scale, y: mid.y - cy * scale }, bounds, stage);
}

/** A double tap zooms in on the point, or back out to fit. */
export function toggleZoom(z: Zoom, px: number, py: number, bounds: Rect, stage: Size): Zoom {
  return isZoomed(z) ? FIT : zoomAbout(FIT, DOUBLE_TAP_ZOOM, px, py, bounds, stage);
}

/**
 * Zoom factor for one ctrl/⌘ + wheel event (trackpad pinches arrive this
 * way too): small trackpad deltas zoom smoothly, a mouse notch by at most
 * a quarter.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.min(1.25, Math.max(0.8, Math.exp(-px * 0.01)));
}

/** Where a rect of the fitted spread is drawn under `z`. */
export function zoomRect(r: Rect, z: Zoom): Rect {
  return { x: r.x * z.scale + z.x, y: r.y * z.scale + z.y, width: r.width * z.scale, height: r.height * z.scale };
}

export function zoomGeometry(g: SpreadGeometry, z: Zoom): SpreadGeometry {
  if (!isZoomed(z)) return g;
  return {
    spine: g.spine * z.scale + z.x,
    left: g.left && { page: g.left.page, rect: zoomRect(g.left.rect, z) },
    right: g.right && { page: g.right.page, rect: zoomRect(g.right.rect, z) },
  };
}

/**
 * What a tap does by where it lands: the outer thirds turn at once, the
 * middle third shows the controls or, tapped twice, zooms.
 */
export function tapZone(x: number, width: number): 'previous' | 'next' | 'centre' {
  const f = width > 0 ? x / width : 0.5;
  return f < 1 / 3 ? 'previous' : f > 2 / 3 ? 'next' : 'centre';
}

export interface Tap {
  t: number;
  x: number;
  y: number;
}

export function isDoubleTap(first: Tap | null, second: Tap): boolean {
  return !!first && second.t - first.t <= DOUBLE_TAP_MS && Math.hypot(second.x - first.x, second.y - first.y) <= DOUBLE_TAP_SLOP;
}
