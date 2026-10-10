import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ComicBook } from '../../reader/comic/book';
import {
  computeSpreads,
  firstPage,
  isWide,
  modeForViewport,
  spreadGeometry,
  spreadIndexOf,
  spreadPages,
  type ComicMode,
  type HalfContent,
  type Rect,
  type Spread,
  type SpreadGeometry,
} from '../../reader/comic/layout';
import {
  dragProgress,
  easeInOut,
  easeOut,
  FADE_MS,
  FAST_TURN_MS,
  releaseTarget,
  SINGLE_ANGLE,
  SPREAD_ANGLE,
  spreadShading,
  TURN_MS,
  turnSides,
  type TurnSides,
} from '../../reader/comic/turn';
import {
  clampZoom,
  contentBounds,
  DOUBLE_TAP_MS,
  FIT,
  isDoubleTap,
  isZoomed,
  KEY_ZOOM_STEP,
  panBy,
  pinchZoom,
  tapZone,
  toggleZoom,
  wheelZoomFactor,
  zoomAbout,
  zoomGeometry,
  type Point,
  type Size,
  type Tap,
  type Zoom,
} from '../../reader/comic/zoom';

export interface ComicStageHandle {
  /** Turns forwards (back to fit first when zoomed). */
  next(): void;
  previous(): void;
  /** Jumps straight to the spread showing `page`, without a turn. */
  goTo(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Back to fit; false when the page was not zoomed. */
  resetZoom(): boolean;
}

export interface ComicView {
  spreads: Spread[];
  index: number;
  mode: ComicMode;
}

/**
 * A turn between spread `lo` and spread `lo + 1`. `progress` (kept outside
 * React, written to the DOM each frame) runs 0 → 1 forwards and 1 → 0 back.
 */
interface Turn {
  lo: number;
  spreads: Spread[];
  mode: ComicMode;
  fade: boolean;
}

interface Animation {
  from: number;
  to: 0 | 1;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

/** One finger (or the mouse) from down to up, in stage coordinates. */
interface Drag {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  /** Set once the gesture is a horizontal drag that turns a page. */
  turning: boolean;
  /** The zoom when a drag over a zoomed page began: it pans instead of turning. */
  pan: Zoom | null;
  /** Set once a pan has moved: it is no longer a tap. */
  panned: boolean;
  /** Part of a pinch: never a tap or a turn. */
  pinched: boolean;
  startProgress: number;
  /** Recent (time, x) samples for the release velocity. */
  samples: { t: number; x: number }[];
}

/** Presses remembered during a turn; a held key's repeats beyond this are dropped. */
const MAX_QUEUED = 24;

const ALL_SIDES: TurnSides = { front: true, back: true, underLeft: true, underRight: true };

/** Movement before a drag over a zoomed page starts panning. */
const PAN_SLOP = 6;

/**
 * The page surface: lays out the current spread, runs 3D page turns (or a
 * cross-fade with reduced motion) and turns pages from taps, swipes that
 * drag the leaf, the wheel and the reader's keys (through the handle). It
 * zooms with pinches, a double tap or click in the middle, ctrl/⌘ + wheel
 * (trackpad pinches) and the reader's + / − keys; a zoomed page pans under
 * the finger and goes back to fit before any turn.
 */
export const ComicStage = forwardRef<
  ComicStageHandle,
  {
    book: ComicBook;
    initialPage: number;
    reducedMotion: boolean;
    /** A still-downloading comic only preloads its immediate neighbours. */
    provisional: boolean;
    onView: (view: ComicView) => void;
    onTapCenter: () => void;
    onActivity: () => void;
  }
>(function ComicStage({ book, initialPage, reducedMotion, provisional, onView, onTapCenter, onActivity }, ref) {
  const stageRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const version = useSyncExternalStore(book.subscribe, book.getVersion);

  /** The page the reader is on; spreads are recomputed around it, so layout changes never lose it. */
  const [anchor, setAnchor] = useState(initialPage);
  const [turn, setTurn] = useState<Turn | null>(null);
  const progress = useRef(0);
  const animation = useRef<Animation | null>(null);
  const frame = useRef(0);
  const pending = useRef(0);
  const drag = useRef<Drag | null>(null);
  const [kick, setKick] = useState(0);
  const [zoomState, setZoomState] = useState<Zoom>(FIT);
  /** The zoom as drawn, the fitted pages' bounds and the stage size, for event handlers. */
  const zoomView = useRef<{ zoom: Zoom; bounds: Rect | null; box: Size | null }>({ zoom: FIT, bounds: null, box: null });
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ start: Zoom; mid: Point; distance: number } | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const tapTimer = useRef(0);
  const tapCenter = useRef(onTapCenter);
  tapCenter.current = onTapCenter;

  const mode: ComicMode = box ? modeForViewport(box.width, box.height) : 'spread';
  // Sizes only reshape spreads between turns; a turn keeps the spreads it started with.
  const liveSpreads = useMemo(
    () => computeSpreads(book.count, mode, (p) => isWide(book.size(p))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book, mode, turn ? -1 : version],
  );
  const spreads = turn ? turn.spreads : liveSpreads;
  const index = spreadIndexOf(spreads, anchor);

  const state = useRef({ spreads, index, mode, turn, reducedMotion });
  state.current = { spreads, index, mode, turn, reducedMotion };

  // ------------------------------------------------------------ measuring

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((b) => (b && b.width === r.width && b.height === r.height ? b : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------ reporting and preloading

  useEffect(() => {
    if (!turn) onView({ spreads, index, mode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreads, index, mode, turn]);

  useEffect(() => {
    const radius = provisional ? 1 : 2;
    const order: number[] = [];
    const add = (i: number) => {
      const s = spreads[i];
      if (s) order.push(...spreadPages(s));
    };
    if (turn) {
      add(turn.lo);
      add(turn.lo + 1);
    }
    add(index);
    for (let d = 1; d <= radius; d++) {
      add(index + d);
      add(index - d);
    }
    book.want(order);
  }, [book, spreads, index, turn, provisional]);

  // ------------------------------------------------------------ drawing a turn

  const leafFrame = useCallback((t: Turn): { hinge: number; width: number; sides: TurnSides } => {
    const b = boxRef.current;
    if (!b) return { hinge: 0, width: 1, sides: ALL_SIDES };
    const size = (p: number) => book.size(p);
    const g = spreadGeometry(t.spreads[t.lo]!, b.width, b.height, size);
    if (t.mode === 'single') return { hinge: g.spine, width: g.right?.rect.width ?? b.width, sides: ALL_SIDES };
    const hi = spreadGeometry(t.spreads[t.lo + 1]!, b.width, b.height, size);
    return { hinge: g.spine, width: b.width - g.spine, sides: turnSides(g, hi) };
  }, [book]);
  const boxRef = useRef(box);
  boxRef.current = box;

  /** Writes one frame of the turn as custom properties the stylesheet reads. */
  const paint = useCallback((p: number) => {
    const el = spreadRef.current;
    const t = state.current.turn;
    if (!el || !t) return;
    progress.current = p;
    if (t.fade) {
      el.style.setProperty('--fade', String(p));
      return;
    }
    const { hinge, width, sides } = leafFrame(t);
    const s = spreadShading(p, sides, t.mode === 'single' ? SINGLE_ANGLE : SPREAD_ANGLE);
    el.style.setProperty('--angle', `${s.angle}deg`);
    el.style.setProperty('--front-shade', s.front.toFixed(3));
    el.style.setProperty('--back-shade', s.back.toFixed(3));
    el.style.setProperty('--cast-right', s.castRight.toFixed(3));
    el.style.setProperty('--cast-left', s.castLeft.toFixed(3));
    el.style.setProperty('--spine', `${hinge.toFixed(1)}px`);
    el.style.setProperty('--edge-x', `${(hinge + s.edge * width).toFixed(1)}px`);
    // A single page ends edge-on; fading its last sliver keeps the hand-off clean.
    el.style.setProperty('--leaf-opacity', t.mode === 'single' ? String(Math.min(1, Math.max(0, (1 - p) / 0.12))) : '1');
  }, [leafFrame]);

  const finish = useCallback((to: 0 | 1) => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    animation.current = null;
    const t = state.current.turn;
    if (!t) return;
    const target = t.spreads[to === 1 ? t.lo + 1 : t.lo];
    if (target) setAnchor(firstPage(target));
    setTurn(null);
    onActivity();
    setKick((k) => k + 1);
  }, [onActivity]);

  const run = useCallback(() => {
    const a = animation.current;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.start) / a.duration);
    paint(a.from + (a.to - a.from) * a.ease(t));
    if (t >= 1) finish(a.to);
    else frame.current = requestAnimationFrame(run);
  }, [paint, finish]);

  const animateTo = useCallback((to: 0 | 1, duration: number, ease: (t: number) => number) => {
    cancelAnimationFrame(frame.current);
    const from = progress.current;
    const span = Math.abs(to - from);
    animation.current = { from, to, start: performance.now(), duration: Math.max(90, duration * span), ease };
    frame.current = requestAnimationFrame(run);
  }, [run]);

  /** Completes a running turn at once (a new gesture, a jump, a resize). */
  const settle = useCallback(() => {
    const a = animation.current;
    if (a) finish(a.to);
    else if (state.current.turn && !drag.current?.turning) finish(progress.current >= 0.5 ? 1 : 0);
  }, [finish]);

  // A new turn starts at its first frame before it paints.
  const startAt = useRef<{ progress: number; to: 0 | 1 | null; duration: number } | null>(null);
  useLayoutEffect(() => {
    if (!turn) return;
    const start = startAt.current;
    startAt.current = null;
    paint(start?.progress ?? progress.current);
    if (start?.to != null) animateTo(start.to, start.duration, easeInOut);
  }, [turn, paint, animateTo]);

  /** Begins a turn from the current spread; `to` null leaves it for a drag to drive. */
  const begin = useCallback((dir: 1 | -1, to: 0 | 1 | null, duration: number): boolean => {
    const { spreads: sp, index: i, mode: m, reducedMotion: rm } = state.current;
    const lo = dir > 0 ? i : i - 1;
    if (lo < 0 || lo + 1 >= sp.length) return false;
    const fade = rm;
    startAt.current = { progress: dir > 0 ? 0 : 1, to, duration: fade ? FADE_MS : duration };
    progress.current = dir > 0 ? 0 : 1;
    setTurn({ lo, spreads: sp, mode: m, fade });
    return true;
  }, []);

  // ------------------------------------------------------------ zoom

  const updateZoom = useCallback((next: (z: Zoom, bounds: Rect, stage: Size) => Zoom) => {
    const { zoom, bounds, box: stage } = zoomView.current;
    if (!bounds || !stage || state.current.turn) return;
    const z = next(zoom, bounds, stage);
    // Events between two frames build on each other.
    zoomView.current.zoom = z;
    setZoomState(z);
  }, []);

  const resetZoom = useCallback((): boolean => {
    const was = isZoomed(zoomView.current.zoom);
    zoomView.current.zoom = FIT;
    setZoomState(FIT);
    return was;
  }, []);

  const zoomBy = useCallback(
    (factor: number) => updateZoom((z, bounds, stage) => zoomAbout(z, factor, stage.width / 2, stage.height / 2, bounds, stage)),
    [updateZoom],
  );

  // A new spread (or a turned phone) starts at fit.
  useLayoutEffect(() => {
    resetZoom();
  }, [anchor, mode, resetZoom]);

  /** A press: turns now, or (mid-turn) hurries the turn along and queues one more. */
  const step = useCallback((dir: 1 | -1) => {
    if (drag.current?.turning) return;
    resetZoom();
    if (state.current.turn) {
      pending.current = Math.max(-MAX_QUEUED, Math.min(MAX_QUEUED, pending.current + dir));
      const a = animation.current;
      if (a) animateTo(a.to, FAST_TURN_MS, easeOut);
      return;
    }
    begin(dir, dir > 0 ? 1 : 0, TURN_MS);
  }, [animateTo, begin, resetZoom]);

  // Queued presses play once the previous turn has landed; a long queue skips
  // ahead without animating and shows only the last turn.
  useEffect(() => {
    if (turn || pending.current === 0) return;
    const dir = pending.current > 0 ? 1 : -1;
    const queued = Math.abs(pending.current);
    if (queued > 2) {
      const target = spreads[Math.min(spreads.length - 1, Math.max(0, index + dir * (queued - 1)))];
      pending.current = dir;
      if (target) setAnchor(firstPage(target));
      setKick((k) => k + 1);
      return;
    }
    pending.current -= dir;
    if (!begin(dir, dir > 0 ? 1 : 0, FAST_TURN_MS)) pending.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kick, turn]);

  const goTo = useCallback((page: number) => {
    pending.current = 0;
    cancelAnimationFrame(frame.current);
    animation.current = null;
    drag.current = null;
    setTurn(null);
    setAnchor(Math.max(0, Math.min(book.count - 1, page)));
  }, [book]);

  useImperativeHandle(
    ref,
    () => ({
      next: () => step(1),
      previous: () => step(-1),
      goTo,
      zoomIn: () => zoomBy(KEY_ZOOM_STEP),
      zoomOut: () => zoomBy(1 / KEY_ZOOM_STEP),
      resetZoom,
    }),
    [step, goTo, zoomBy, resetZoom],
  );

  // Turning the phone (or resizing) mid-turn lands the turn first.
  useEffect(() => {
    if (state.current.turn && state.current.turn.mode !== mode) settle();
  }, [mode, settle]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(tapTimer.current);
    },
    [],
  );

  // ------------------------------------------------------------ pointer

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const newDrag = (id: number, at: Point, pan: Zoom | null, pinched: boolean): Drag => {
    const now = performance.now();
    return { id, x0: at.x, y0: at.y, t0: now, turning: false, pan, panned: false, pinched, startProgress: 0, samples: [{ t: now, x: at.x }] };
  };

  const fingers = (): [Point, Point] | null => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? [a, b] : null;
  };

  const cancelTap = () => {
    window.clearTimeout(tapTimer.current);
    lastTap.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const at = local(e);
    if (e.pointerType === 'touch') pointers.current.set(e.pointerId, at);
    if (pinch.current) return;
    // A second finger pinches, unless the first is already turning a leaf.
    const two = fingers();
    if (two) {
      if (drag.current?.turning || state.current.turn) return;
      if (drag.current) drag.current.pinched = true;
      cancelTap();
      pinch.current = { start: zoomView.current.zoom, mid: midpoint(two), distance: distance(two) };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (!e.isPrimary || e.button > 0) return;
    if (drag.current) return;
    // A finger on a moving leaf catches it where it is.
    if (animation.current) {
      pending.current = 0;
      settle();
    }
    const z = zoomView.current.zoom;
    drag.current = newDrag(e.pointerId, at, isZoomed(z) ? z : null, false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const at = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, at);
    const p = pinch.current;
    if (p) {
      const two = fingers();
      if (two) updateZoom((_, bounds, stage) => pinchZoom(p.start, p.mid, p.distance, midpoint(two), distance(two), bounds, stage));
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = at.x - d.x0;
    const dy = at.y - d.y0;
    if (d.pan) {
      if (!d.panned && Math.hypot(dx, dy) < PAN_SLOP) return;
      if (!d.panned) stageRef.current?.setAttribute('data-panning', 'true');
      d.panned = true;
      const from = d.pan;
      updateZoom((_, bounds, stage) => panBy(from, dx, dy, bounds, stage));
      return;
    }
    if (d.pinched) return;
    const now = performance.now();
    d.samples.push({ t: now, x: at.x });
    while (d.samples.length > 2 && now - d.samples[0]!.t > 100) d.samples.shift();
    if (!d.turning) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (state.current.turn) return;
      const dir = dx < 0 ? 1 : -1;
      if (!begin(dir, null, TURN_MS)) {
        drag.current = { ...d, turning: false, x0: Number.NaN };
        return;
      }
      d.turning = true;
      d.startProgress = dir > 0 ? 0 : 1;
      d.x0 = at.x;
      return;
    }
    const t = state.current.turn;
    if (!t) return;
    const { width } = leafFrame(t);
    paint(dragProgress(d.startProgress, dx, width, t.mode === 'single' ? SINGLE_ANGLE : SPREAD_ANGLE));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (fingers()) return;
      pinch.current = null;
      // The finger left behind pans the zoomed page; it never taps or turns.
      const [rest] = [...pointers.current.entries()];
      const z = zoomView.current.zoom;
      drag.current = rest ? newDrag(rest[0], rest[1], isZoomed(z) ? z : null, true) : null;
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    stageRef.current?.removeAttribute('data-panning');
    if (d.turning) {
      const first = d.samples[0]!;
      const last = d.samples[d.samples.length - 1]!;
      const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const to = releaseTarget(d.startProgress, progress.current, velocity);
      animateTo(to, state.current.turn?.fade ? FADE_MS : TURN_MS * 0.8, easeOut);
      onActivity();
      return;
    }
    if (d.pinched || d.panned || Number.isNaN(d.x0) || e.type === 'pointercancel') return;
    const at = local(e);
    if (Math.hypot(at.x - d.x0, at.y - d.y0) > 12 || performance.now() - d.t0 > 600) return;
    // A tap: the outer thirds turn at once; the middle shows or hides the
    // controls, or (tapped twice) zooms in on the spot or back out to fit.
    const zone = tapZone(at.x, zoomView.current.box?.width ?? 0);
    if (zone !== 'centre') {
      cancelTap();
      step(zone === 'next' ? 1 : -1);
      return;
    }
    const tap: Tap = { t: performance.now(), x: at.x, y: at.y };
    if (isDoubleTap(lastTap.current, tap)) {
      cancelTap();
      updateZoom((z, bounds, stage) => toggleZoom(z, tap.x, tap.y, bounds, stage));
      return;
    }
    cancelTap();
    lastTap.current = tap;
    tapTimer.current = window.setTimeout(() => {
      lastTap.current = null;
      tapCenter.current();
    }, DOUBLE_TAP_MS);
  };

  // The wheel (and two-finger trackpad swipes) turn one page per gesture;
  // over a zoomed page they pan, and with ctrl/⌘ (or a trackpad pinch) zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let total = 0;
    let locked = false;
    let quiet = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const at = local(e);
        updateZoom((z, bounds, stage) => zoomAbout(z, wheelZoomFactor(e.deltaY, e.deltaMode), at.x, at.y, bounds, stage));
        return;
      }
      if (isZoomed(zoomView.current.zoom)) {
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        updateZoom((z, bounds, stage) => panBy(z, -e.deltaX * k, -e.deltaY * k, bounds, stage));
        return;
      }
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => {
        locked = false;
        total = 0;
      }, 220);
      if (locked) return;
      total += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(total) < 40) return;
      locked = true;
      step(total > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(quiet);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, updateZoom]);

  // Safari sends trackpad pinches as gesture events, not ctrl + wheel. On
  // touch screens the fingers arrive as pointers, so these only stop the
  // browser zooming the whole app.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let start: Zoom | null = null;
    const onGesture = (e: Event) => {
      e.preventDefault();
      if (pointers.current.size > 0) return;
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (e.type === 'gesturestart') start = zoomView.current.zoom;
      else if (e.type === 'gestureend') start = null;
      else if (start) {
        const from = start;
        const at = local(g);
        updateZoom((_, bounds, stage) => zoomAbout(from, g.scale, at.x, at.y, bounds, stage));
      }
    };
    const types = ['gesturestart', 'gesturechange', 'gestureend'];
    for (const t of types) el.addEventListener(t, onGesture, { passive: false });
    return () => {
      for (const t of types) el.removeEventListener(t, onGesture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateZoom]);

  // ------------------------------------------------------------ render

  const sizeOf = (p: number) => book.size(p);
  let content: JSX.Element | null = null;
  let zoom = FIT;
  if (box) {
    const geometry = (s: Spread | undefined) => (s ? spreadGeometry(s, box.width, box.height, sizeOf) : null);
    if (!turn) {
      const fit = geometry(spreads[index]);
      const bounds = fit && contentBounds(fit);
      zoom = bounds ? clampZoom(zoomState, bounds, box) : FIT;
      zoomView.current = { zoom, bounds, box };
      content = <StaticSpread book={book} geometry={fit && zoomGeometry(fit, zoom)} spread={spreads[index]} />;
    } else {
      zoomView.current = { zoom: FIT, bounds: null, box };
      const lo = geometry(turn.spreads[turn.lo])!;
      const hi = geometry(turn.spreads[turn.lo + 1])!;
      content = turn.fade ? (
        <>
          <StaticSpread book={book} geometry={lo} spread={turn.spreads[turn.lo]} />
          <div className="comic-fade">
            <StaticSpread book={book} geometry={hi} spread={turn.spreads[turn.lo + 1]} />
          </div>
        </>
      ) : turn.mode === 'single' ? (
        <SingleTurn book={book} lo={lo} hi={hi} width={box.width} height={box.height} />
      ) : (
        <SpreadTurn book={book} lo={lo} hi={hi} width={box.width} height={box.height} />
      );
    }
  }

  const perspective = box ? Math.round(Math.max(box.width, box.height) * 1.8) : 2000;
  return (
    <div
      ref={stageRef}
      className="comic-stage"
      data-mode={mode}
      data-turning={turn ? 'true' : undefined}
      data-zoomed={isZoomed(zoom) ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={spreadRef} className="comic-spread" style={{ perspective: `${perspective}px` }}>
        {content}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- pieces

function midpoint([a, b]: [Point, Point]): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance([a, b]: [Point, Point]): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rectStyle(r: Rect, dx = 0): CSSProperties {
  return { left: r.x - dx, top: r.y, width: r.width, height: r.height };
}

/** A shadow only falls where the leaf is: its band runs the height of the leaf's page. */
function castBand(leaf: Rect): CSSProperties {
  return { top: leaf.y, bottom: 'auto', height: leaf.height };
}

/** One page image (or its quiet spinner) at `rect`, offset by `dx` into its parent. */
function PageView({ book, page, rect, dx = 0, gutter }: { book: ComicBook; page: number; rect: Rect; dx?: number; gutter?: 'left' | 'right' }) {
  const state = book.state(page);
  return (
    <div className={gutter ? `comic-page has-gutter-${gutter}` : 'comic-page'} style={rectStyle(rect, dx)}>
      {state?.status === 'ready' ? (
        <img src={state.image.url} alt={`Page ${page + 1}`} decoding="sync" draggable={false} />
      ) : state?.status === 'error' ? (
        <div className="comic-page-note t-label-sm">Couldn't load page {page + 1}</div>
      ) : (
        <div className="comic-spinner" role="status" aria-label={`Loading page ${page + 1}`} />
      )}
    </div>
  );
}

function StaticSpread({ book, geometry, spread }: { book: ComicBook; geometry: SpreadGeometry | null; spread: Spread | undefined }) {
  if (!geometry || !spread) return null;
  if (spread.kind !== 'pair') return <PageView key={geometry.right!.page} book={book} page={geometry.right!.page} rect={geometry.right!.rect} />;
  return (
    <>
      {geometry.left && <PageView key={geometry.left.page} book={book} page={geometry.left.page} rect={geometry.left.rect} gutter="right" />}
      {geometry.right && <PageView key={geometry.right.page} book={book} page={geometry.right.page} rect={geometry.right.rect} gutter="left" />}
    </>
  );
}

/** A clipped half of the stage showing `content` (a wide page shows just its half). */
function Half({ book, content, box, gutter, children, className }: { book: ComicBook; content: HalfContent | null; box: Rect; gutter?: 'left' | 'right'; children?: React.ReactNode; className?: string }) {
  return (
    <div className={['comic-half', className].filter(Boolean).join(' ')} style={rectStyle(box)}>
      {content && <PageView book={book} page={content.page} rect={content.rect} dx={box.x} gutter={gutter} />}
      {children}
    </div>
  );
}

/**
 * Spread turn: the leaf hinges on the spine. Its front is the lower spread's
 * right half, its back the higher spread's left half; beneath it lie the lower
 * spread's left half and the higher spread's right half. A face with no page
 * (the empty half beside a page standing alone) is the black of the stage:
 * it hides what it passes over and is never shaded, so the turn shows only
 * the pages that are there.
 */
function SpreadTurn({ book, lo, hi, width, height }: { book: ComicBook; lo: SpreadGeometry; hi: SpreadGeometry; width: number; height: number }) {
  const spine = lo.spine;
  const leftBox: Rect = { x: 0, y: 0, width: spine, height };
  const rightBox: Rect = { x: spine, y: 0, width: width - spine, height };
  const gutterFor = (g: SpreadGeometry, side: 'left' | 'right') => (g.left && g.right && g.left.page === g.right.page ? undefined : side === 'left' ? 'right' : 'left');
  return (
    <>
      <Half book={book} content={lo.left} box={leftBox} gutter={gutterFor(lo, 'left')} className="is-under-left">
        {lo.left && hi.left && <div className="comic-cast is-left" style={castBand(hi.left.rect)} />}
      </Half>
      <Half book={book} content={hi.right} box={rightBox} gutter={gutterFor(hi, 'right')} className="is-under-right">
        {hi.right && lo.right && <div className="comic-cast is-right" style={castBand(lo.right.rect)} />}
      </Half>
      <div className="comic-leaf" style={rectStyle(rightBox)}>
        {lo.right ? (
          <div className="comic-face is-front">
            <PageView book={book} page={lo.right.page} rect={lo.right.rect} dx={spine} gutter={gutterFor(lo, 'right')} />
            <div className="comic-shade is-front" />
          </div>
        ) : (
          <div className="comic-face is-front is-void" />
        )}
        {hi.left ? (
          <div className="comic-face is-back">
            <PageView book={book} page={hi.left.page} rect={hi.left.rect} dx={spine - rightBox.width} gutter={gutterFor(hi, 'left')} />
            <div className="comic-shade is-back" />
          </div>
        ) : (
          <div className="comic-face is-back is-void" />
        )}
      </div>
    </>
  );
}

/** Single-page turn: the lower page hinges on its left edge and swings away, uncovering the next. */
function SingleTurn({ book, lo, hi, width, height }: { book: ComicBook; lo: SpreadGeometry; hi: SpreadGeometry; width: number; height: number }) {
  const page = lo.right!;
  const under = hi.right!;
  const hinge = page.rect.x;
  const leafBox: Rect = { x: hinge, y: 0, width: Math.max(1, width - hinge), height };
  const backRect: Rect = { ...page.rect, x: hinge - page.rect.width };
  // The shadow falls on the page below only within the leaf's height (a wide page is shorter than a tall one).
  const top = Math.max(under.rect.y, page.rect.y);
  const bottom = Math.min(under.rect.y + under.rect.height, page.rect.y + page.rect.height);
  const castClip: Rect = { x: under.rect.x, y: top, width: under.rect.width, height: Math.max(0, bottom - top) };
  return (
    <>
      <PageView key={under.page} book={book} page={under.page} rect={under.rect} />
      <div className="comic-cast-clip" style={{ ...rectStyle(castClip), '--origin-x': `${under.rect.x}px` } as CSSProperties}>
        <div className="comic-cast is-single" />
      </div>
      <div className="comic-leaf is-single" style={rectStyle(leafBox)}>
        <div className="comic-face is-front">
          <PageView book={book} page={page.page} rect={page.rect} dx={hinge} />
          <div className="comic-shade is-front" style={rectStyle(page.rect, hinge)} />
        </div>
        <div className="comic-face is-back">
          <div className="comic-paper-back" style={rectStyle(backRect, hinge - leafBox.width)} />
          <div className="comic-shade is-back" style={rectStyle(backRect, hinge - leafBox.width)} />
        </div>
      </div>
    </>
  );
}
