import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { hasOpenOverlay } from '../overlay';
import { IconButton, QuietButton } from '../buttons';
import { ArrowDownwardIcon, ArrowUpwardIcon } from '../icons';
import { inertProps, isTypingTarget } from '../../lib/hooks';
import { blockElements, readPosition, scrollToPosition } from './position';
import { TopIntent, topIntentDefaults } from './topIntent';
import './backtop.css';

/** Further than this many viewports, jumps are instant: a long smooth scroll is slow and blurs the page. */
const smoothLimit = 3;
/** How long "Back to where you were" waits at the top. */
const returnMs = 6000;
/** Scrolling this many viewports away from the top dismisses it. */
const returnDrift = 0.3;
/** Keys that scroll the page; their runs are paging, not flinging. */
const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End']);
const userInput = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

let quietUntil = 0;

/**
 * Scrolls made by code (restoring the reading position, jumping to a
 * footnote or a highlight) are not the reader heading back: call this just
 * before one. The control stays hidden until the page has been still for a
 * moment, or the reader touches the wheel, the screen or a key.
 */
export function quietBackToTop(ms = 400): void {
  quietUntil = Math.max(quietUntil, performance.now() + ms);
}

/** Re-applies `apply` while blocks around the target render and settle, until the reader moves. */
function holdPosition(body: HTMLElement, apply: () => void): void {
  let moved = false;
  const onInput = () => {
    moved = true;
  };
  for (const type of userInput) window.addEventListener(type, onInput, { passive: true, once: true });
  const settle = new ResizeObserver(() => {
    if (!moved) apply();
  });
  settle.observe(body);
  window.setTimeout(() => {
    settle.disconnect();
    for (const type of userInput) window.removeEventListener(type, onInput);
  }, 1500);
}

type Mode = 'hidden' | 'top' | 'back';

/**
 * The article reader's way back to the top, built to stay out of the way: it
 * shows only when the reader heads back up on purpose far down the page, or
 * reaches the end (see TopIntent), sits in the right margin beside the
 * column (a small corner button on narrow screens) and fades after a short
 * rest. After the jump it offers "Back to where you were" in the same place
 * for a few seconds, returning by reading position so long articles whose
 * skipped blocks only have estimated heights land on the same paragraph.
 * Home does the same from the keyboard. Scroll handling is one passive,
 * frame-throttled listener that re-renders only when the control changes.
 */
export function BackToTop({
  body,
  count,
  blocked,
  reducedMotion,
}: {
  /** The article body, holding the `data-block-index` blocks. */
  body: RefObject<HTMLElement>;
  /** `article.blocks.length`. */
  count: number;
  /** A sheet, lightbox or preview is open. */
  blocked: boolean;
  reducedMotion: boolean;
}) {
  const [mode, setMode] = useState<Mode>('hidden');
  const current = useRef<Mode>('hidden');
  const intent = useRef<TopIntent | null>(null);
  const saved = useRef<{ position: number; landed: number } | null>(null);
  const blocksRef = useRef<HTMLElement[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const refocus = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const motion = useRef(reducedMotion);
  motion.current = reducedMotion;

  const show = (next: Mode) => {
    if (current.current === next) return;
    refocus.current = !!wrap.current?.contains(document.activeElement) && next !== 'hidden';
    current.current = next;
    setMode(next);
  };

  // Hides a revealed control after a rest, or the return offer after a few seconds; never while held.
  const arm = () => {
    window.clearTimeout(timer.current);
    if (current.current === 'hidden') return;
    const back = current.current === 'back';
    timer.current = window.setTimeout(
      () => {
        if (held.current) return;
        if (back) {
          saved.current = null;
          intent.current?.rest(window.scrollY, performance.now());
          show('hidden');
        } else if (intent.current && !intent.current.settle(performance.now())) show('hidden');
      },
      back ? returnMs : (intent.current?.idleMs ?? topIntentDefaults.idleMs),
    );
  };

  const jump = (top: number, smooth: boolean) => window.scrollTo({ top, behavior: smooth && !motion.current ? 'smooth' : 'instant' });

  const toTop = () => {
    const el = body.current;
    const y = window.scrollY;
    if (!el || y <= 0) return;
    const viewport = window.innerHeight;
    const near = y <= viewport * smoothLimit;
    saved.current = y > viewport * topIntentDefaults.hideDepth ? { position: readPosition(blockElements(el, blocksRef), count), landed: 0 } : null;
    quietBackToTop();
    jump(0, near);
    show(saved.current ? 'back' : 'hidden');
    arm();
  };

  const toSaved = () => {
    const el = body.current;
    const target = saved.current;
    saved.current = null;
    show('hidden');
    if (!el || !target) return;
    const viewport = window.innerHeight;
    const from = window.scrollY;
    const apply = () => {
      quietBackToTop();
      scrollToPosition(blockElements(el, blocksRef), count, target.position);
    };
    apply();
    const to = window.scrollY;
    if (Math.abs(to - from) <= viewport * smoothLimit && !motion.current) {
      // Measured by jumping there; scrolling back before the next paint shows nothing of it, then glide.
      window.scrollTo({ top: from, behavior: 'instant' });
      quietBackToTop(600);
      jump(to, true);
    } else holdPosition(el, apply);
    intent.current?.rest(window.scrollY, performance.now());
  };

  const actions = useRef({ toTop, arm });
  actions.current = { toTop, arm };

  useEffect(() => {
    const machine = new TopIntent(window.scrollY);
    intent.current = machine;
    let frame = 0;
    let keyT = 0;
    const measure = () => {
      frame = 0;
      const now = performance.now();
      const y = window.scrollY;
      const viewport = window.innerHeight;
      if (now < quietUntil) {
        // A programmatic scroll: keep quiet until it stops moving.
        quietUntil = Math.max(quietUntil, now + 160);
        machine.rest(y, now);
        if (current.current === 'top') show('hidden');
        if (current.current === 'back' && saved.current) saved.current.landed = y;
        return;
      }
      if (current.current === 'back') {
        if (saved.current && Math.abs(y - saved.current.landed) <= viewport * returnDrift) return;
        saved.current = null;
        machine.rest(y, now);
        show('hidden');
        return;
      }
      const visible = machine.update({
        y,
        t: now,
        viewport,
        max: document.documentElement.scrollHeight - viewport,
        keyboard: now - keyT < 700,
      });
      show(visible && !blockedRef.current ? 'top' : 'hidden');
      actions.current.arm();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const onResize = () => machine.rest(window.scrollY, performance.now());
    const onInput = (e: Event) => {
      if (e.defaultPrevented) return;
      quietUntil = 0;
      if (e instanceof KeyboardEvent && scrollKeys.has(e.key)) keyT = performance.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Home' || hasOpenOverlay() || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      actions.current.toTop();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    for (const type of userInput) window.addEventListener(type, onInput, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      for (const type of userInput) window.removeEventListener(type, onInput);
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
      window.clearTimeout(timer.current);
    };
  }, []);

  // A sheet, lightbox or preview opening puts the control (and the return offer) away.
  useEffect(() => {
    if (!blocked) return;
    saved.current = null;
    show('hidden');
  }, [blocked]);

  // Swapping the arrow for the return offer keeps keyboard focus on the control; it never takes focus otherwise.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    wrap.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [mode]);

  // The last visible face stays on while fading out.
  const face = useRef<Mode>('top');
  if (mode !== 'hidden') face.current = mode;
  const visible = mode !== 'hidden' && !blocked;
  const release = () => {
    held.current = false;
    arm();
  };

  return (
    <div
      ref={wrap}
      className={['article-backtop', visible && 'is-shown', face.current === 'back' && 'is-return'].filter(Boolean).join(' ')}
      {...inertProps(!visible)}
      onPointerEnter={() => (held.current = true)}
      onPointerLeave={release}
      onFocus={() => (held.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release();
      }}
    >
      {face.current === 'back' ? (
        <QuietButton icon={ArrowDownwardIcon} label="Back to where you were" onClick={toSaved} />
      ) : (
        <IconButton icon={ArrowUpwardIcon} label="Back to top" shortcut="Home" tooltipSide="top" size={18} onClick={toTop} />
      )}
    </div>
  );
}
