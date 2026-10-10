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
import { dragProgress, easeInOut, easeOut, FADE_MS, FAST_TURN_MS, releaseTarget, SINGLE_ANGLE, SPREAD_ANGLE, TURN_MS, turnShading } from '../../reader/comic/turn';

export interface ComicStageHandle {
  next(): void;
  previous(): void;
  /** Jumps straight to the spread showing `page`, without a turn. */
  goTo(page: number): void;
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

interface Drag {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  /** Set once the gesture is a horizontal drag that turns a page. */
  turning: boolean;
  startProgress: number;
  /** Recent (time, x) samples for the release velocity. */
  samples: { t: number; x: number }[];
}

/**
 * The page surface: lays out the current spread, runs 3D page turns (or a
 * cross-fade with reduced motion) and turns pages from taps, swipes that
 * drag the leaf, the wheel and the reader's keys (through the handle).
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

  const leafWidth = useCallback((t: Turn): { hinge: number; width: number } => {
    const b = boxRef.current;
    if (!b) return { hinge: 0, width: 1 };
    const g = spreadGeometry(t.spreads[t.lo]!, b.width, b.height, (p) => book.size(p));
    if (t.mode === 'single') return { hinge: g.spine, width: g.right?.rect.width ?? b.width };
    return { hinge: g.spine, width: b.width - g.spine };
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
    const s = turnShading(p, t.mode === 'single' ? SINGLE_ANGLE : SPREAD_ANGLE);
    const { hinge, width } = leafWidth(t);
    el.style.setProperty('--angle', `${s.angle}deg`);
    el.style.setProperty('--front-shade', s.front.toFixed(3));
    el.style.setProperty('--back-shade', s.back.toFixed(3));
    el.style.setProperty('--cast-right', (s.edge > 0 ? s.cast : 0).toFixed(3));
    el.style.setProperty('--cast-left', (s.edge < 0 ? s.cast : 0).toFixed(3));
    el.style.setProperty('--spine', `${hinge.toFixed(1)}px`);
    el.style.setProperty('--edge-x', `${(hinge + s.edge * width).toFixed(1)}px`);
    // A single page ends edge-on; fading its last sliver keeps the hand-off clean.
    el.style.setProperty('--leaf-opacity', t.mode === 'single' ? String(Math.min(1, Math.max(0, (1 - p) / 0.12))) : '1');
  }, [leafWidth]);

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

  /** A press: turns now, or (mid-turn) hurries the turn along and queues one more. */
  const step = useCallback((dir: 1 | -1) => {
    if (drag.current?.turning) return;
    if (state.current.turn) {
      pending.current = Math.max(-6, Math.min(6, pending.current + dir));
      const a = animation.current;
      if (a) animateTo(a.to, FAST_TURN_MS, easeOut);
      return;
    }
    begin(dir, dir > 0 ? 1 : 0, TURN_MS);
  }, [animateTo, begin]);

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

  useImperativeHandle(ref, () => ({ next: () => step(1), previous: () => step(-1), goTo }), [step, goTo]);

  // Turning the phone (or resizing) mid-turn lands the turn first.
  useEffect(() => {
    if (state.current.turn && state.current.turn.mode !== mode) settle();
  }, [mode, settle]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // ------------------------------------------------------------ pointer

  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary || e.button > 0) return;
    if (drag.current) return;
    // A finger on a moving leaf catches it where it is.
    if (animation.current) {
      pending.current = 0;
      settle();
    }
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), turning: false, startProgress: 0, samples: [{ t: performance.now(), x: e.clientX }] };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    const now = performance.now();
    d.samples.push({ t: now, x: e.clientX });
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
      d.x0 = e.clientX;
      return;
    }
    const t = state.current.turn;
    if (!t) return;
    const { width } = leafWidth(t);
    paint(dragProgress(d.startProgress, dx, width, t.mode === 'single' ? SINGLE_ANGLE : SPREAD_ANGLE));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.turning) {
      const first = d.samples[0]!;
      const last = d.samples[d.samples.length - 1]!;
      const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const to = releaseTarget(d.startProgress, progress.current, velocity);
      animateTo(to, state.current.turn?.fade ? FADE_MS : TURN_MS * 0.8, easeOut);
      onActivity();
      return;
    }
    if (Number.isNaN(d.x0) || e.type === 'pointercancel') return;
    // A tap: outer thirds turn, the middle shows or hides the controls.
    const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    if (moved > 12 || performance.now() - d.t0 > 600) return;
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = (e.clientX - bounds.left) / bounds.width;
    if (x < 1 / 3) step(-1);
    else if (x > 2 / 3) step(1);
    else onTapCenter();
  };

  // The wheel (and two-finger trackpad swipes) turn one page per gesture.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let total = 0;
    let locked = false;
    let quiet = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      e.preventDefault();
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
  }, [step]);

  // ------------------------------------------------------------ render

  const sizeOf = (p: number) => book.size(p);
  let content: JSX.Element | null = null;
  if (box) {
    const geometry = (s: Spread | undefined) => (s ? spreadGeometry(s, box.width, box.height, sizeOf) : null);
    if (!turn) {
      content = <StaticSpread book={book} geometry={geometry(spreads[index])} spread={spreads[index]} />;
    } else {
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

function rectStyle(r: Rect, dx = 0): CSSProperties {
  return { left: r.x - dx, top: r.y, width: r.width, height: r.height };
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
 * spread's left half and the higher spread's right half.
 */
function SpreadTurn({ book, lo, hi, width, height }: { book: ComicBook; lo: SpreadGeometry; hi: SpreadGeometry; width: number; height: number }) {
  const spine = lo.spine;
  const leftBox: Rect = { x: 0, y: 0, width: spine, height };
  const rightBox: Rect = { x: spine, y: 0, width: width - spine, height };
  const gutterFor = (g: SpreadGeometry, side: 'left' | 'right') => (g.left && g.right && g.left.page === g.right.page ? undefined : side === 'left' ? 'right' : 'left');
  return (
    <>
      <Half book={book} content={lo.left} box={leftBox} gutter={gutterFor(lo, 'left')} className="is-under-left">
        <div className="comic-cast is-left" />
      </Half>
      <Half book={book} content={hi.right} box={rightBox} gutter={gutterFor(hi, 'right')} className="is-under-right">
        <div className="comic-cast is-right" />
      </Half>
      <div className="comic-leaf" style={rectStyle(rightBox)}>
        <div className="comic-face is-front">
          {lo.right && <PageView book={book} page={lo.right.page} rect={lo.right.rect} dx={spine} gutter={gutterFor(lo, 'right')} />}
          <div className="comic-shade is-front" />
        </div>
        <div className="comic-face is-back">
          {hi.left && <PageView book={book} page={hi.left.page} rect={hi.left.rect} dx={spine - rightBox.width} gutter={gutterFor(hi, 'left')} />}
          <div className="comic-shade is-back" />
        </div>
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
  return (
    <>
      <PageView key={under.page} book={book} page={under.page} rect={under.rect} />
      <div className="comic-cast-clip" style={{ ...rectStyle(under.rect), '--origin-x': `${under.rect.x}px` } as CSSProperties}>
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
