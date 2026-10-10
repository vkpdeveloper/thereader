import type { SpreadGeometry } from './layout';

/**
 * Page-turn maths, shared by animated turns and turns that follow a finger.
 * A turn always runs between a lower spread and the next one: progress 0
 * shows the lower spread, 1 the higher. Turning back is the same turn played
 * in reverse, exactly as a paper leaf moves.
 */

/** Full turn length, ms. */
export const TURN_MS = 540;
/** A turn hurried along by a queued press. */
export const FAST_TURN_MS = 260;
/** Reduced-motion cross-fade, ms. */
export const FADE_MS = 180;

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface TurnShading {
  /** Leaf rotation about the hinge, degrees (0 → −maxAngle). */
  angle: number;
  /** Darkening of the leaf's front (0..1), strongest as it stands up. */
  front: number;
  /** Darkening of the leaf's back as it comes down. */
  back: number;
  /** Strength of the shadow the leaf casts on the page below; gone at both ends. */
  cast: number;
  /** Projected free edge of the leaf, in leaf widths from the hinge (1 → cos maxAngle). */
  edge: number;
}

/**
 * A spread's leaf turns 180° onto the facing half. A single page has nowhere
 * to land, so it turns 90°: edge-on, it has vanished, and no part of the turn
 * is spent off screen.
 */
export const SPREAD_ANGLE = 180;
export const SINGLE_ANGLE = 90;

export function turnShading(progress: number, maxAngle = SPREAD_ANGLE): TurnShading {
  const p = clamp01(progress);
  const radians = (p * maxAngle * Math.PI) / 180;
  const cos = Math.cos(radians);
  return {
    angle: -maxAngle * p,
    front: 0.55 * (1 - Math.max(0, cos)),
    back: 0.55 * (1 - Math.max(0, -cos)),
    cast: 0.6 * Math.sin(p * Math.PI),
    edge: cos,
  };
}

/**
 * Which parts of a spread turn show a page. The leaf's front is the lower
 * spread's right half and its back the higher spread's left half; beneath
 * lie the lower spread's left half and the higher spread's right half. A
 * spread with an empty half (a page alone on the left before a wide scan,
 * the cover alone on the right) leaves one of them empty.
 */
export interface TurnSides {
  front: boolean;
  back: boolean;
  underLeft: boolean;
  underRight: boolean;
}

export function turnSides(lo: SpreadGeometry, hi: SpreadGeometry): TurnSides {
  return { front: lo.right !== null, back: hi.left !== null, underLeft: lo.left !== null, underRight: hi.right !== null };
}

export interface SpreadShading extends Omit<TurnShading, 'cast'> {
  /** Shadow on the lower spread's left half (only while the back is up). */
  castLeft: number;
  /** Shadow on the higher spread's right half (only while the front is up). */
  castRight: number;
}

/**
 * A turn's shading with the empty parts left dark: an empty face is the
 * stage itself (black, unshaded), so it only hides what it passes over, and
 * nothing casts a shadow unless a page is both casting and receiving it.
 */
export function spreadShading(progress: number, sides: TurnSides, maxAngle = SPREAD_ANGLE): SpreadShading {
  const s = turnShading(progress, maxAngle);
  return {
    angle: s.angle,
    edge: s.edge,
    front: sides.front ? s.front : 0,
    back: sides.back ? s.back : 0,
    castRight: s.edge > 0 && sides.front && sides.underRight ? s.cast : 0,
    castLeft: s.edge < 0 && sides.back && sides.underLeft ? s.cast : 0,
  };
}

/**
 * Progress that keeps the leaf's free edge under the finger. `dx` is the
 * finger's travel (negative = leftwards) and `leafWidth` the leaf's width:
 * a spread's leaf edge crosses both halves, a single page's its own width.
 */
export function dragProgress(startProgress: number, dx: number, leafWidth: number, maxAngle = SPREAD_ANGLE): number {
  if (leafWidth <= 0) return startProgress;
  const max = (maxAngle * Math.PI) / 180;
  const startEdge = Math.cos(clamp01(startProgress) * max);
  const edge = Math.min(1, Math.max(Math.cos(max), startEdge + dx / leafWidth));
  return Math.acos(edge) / max;
}

/**
 * Where a released drag settles: a flick (px/ms, negative = leftwards) wins,
 * otherwise whichever end the leaf is nearer, biased towards finishing the
 * turn the drag started.
 */
export function releaseTarget(startProgress: number, progress: number, velocity: number): 0 | 1 {
  const forward = startProgress < 0.5;
  if (velocity < -0.35) return 1;
  if (velocity > 0.35) return 0;
  const moved = Math.abs(progress - startProgress);
  if (moved > 0.3) return forward ? 1 : 0;
  return forward ? (progress > 0.5 ? 1 : 0) : progress < 0.5 ? 0 : 1;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
