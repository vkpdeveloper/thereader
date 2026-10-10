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
  /** Leaf rotation about the hinge, degrees (0 → −180). */
  angle: number;
  /** Darkening of the leaf's front (0..1), strongest as it stands up. */
  front: number;
  /** Darkening of the leaf's back as it comes down. */
  back: number;
  /** Strength of the shadow the leaf casts on the page below. */
  cast: number;
  /** Projected free edge of the leaf, in leaf widths from the hinge (1 → −1). */
  edge: number;
}

export function turnShading(progress: number): TurnShading {
  const p = clamp01(progress);
  const radians = p * Math.PI;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    angle: -180 * p,
    front: 0.55 * (1 - Math.max(0, cos)),
    back: 0.55 * (1 - Math.max(0, -cos)),
    cast: 0.6 * sin,
    edge: cos,
  };
}

/**
 * Progress that keeps the leaf's free edge under the finger. `dx` is the
 * finger's travel (negative = leftwards), `leafWidth` the leaf's width and
 * `gain` how many leaf widths a full drag covers (spreads cross both halves:
 * 1; a single page turns within its own width: 2).
 */
export function dragProgress(startProgress: number, dx: number, leafWidth: number, gain = 1): number {
  if (leafWidth <= 0) return startProgress;
  const startEdge = Math.cos(clamp01(startProgress) * Math.PI);
  const edge = Math.min(1, Math.max(-1, startEdge + (dx * gain) / leafWidth));
  return Math.acos(edge) / Math.PI;
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
