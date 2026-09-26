import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Sets `document.title` to "<title> · The Reader" (or just the app name). */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · The Reader` : 'The Reader';
  }, [title]);
}

/** True once the element has come within `rootMargin` of the viewport (sticky). */
export function useInView<T extends Element>(ref: RefObject<T>, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** Calls `onVisible` every time the sentinel scrolls within `rootMargin`. */
export function useSentinel<T extends Element>(ref: RefObject<T>, onVisible: () => void, rootMargin = '400px'): void {
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
}

/**
 * Content-box width of an element, tracked with ResizeObserver. Returns a
 * callback ref so elements that mount later are still measured.
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/**
 * Keeps an element mounted through its exit transition: `mounted` stays true
 * for `ms` after `open` turns false; `shown` flips a frame after mount so CSS
 * transitions run on enter.
 */
export function usePresence(open: boolean, ms: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames so the closed state paints first; the timeout covers
      // hidden tabs, where animation frames never fire.
      let inner = 0;
      const show = () => setShown(true);
      const raf = requestAnimationFrame(() => (inner = requestAnimationFrame(show)));
      const fallback = window.setTimeout(show, 60);
      return () => {
        cancelAnimationFrame(raf);
        cancelAnimationFrame(inner);
        window.clearTimeout(fallback);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { mounted, shown };
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  );
}

/**
 * Modal focus handling: moves focus inside `ref` when active, keeps Tab
 * cycling within it, and restores the previous focus afterwards.
 */
export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T>, active: boolean, trap = true): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const initial = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(root)[0] ?? root;
    initial.focus({ preventScroll: true });
    if (!trap) {
      return () => {
        if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
      };
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref, active, trap]);
}

/** True when a key event comes from a text field, where shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return el.isContentEditable === true;
}

/** `inert` for hidden-but-mounted UI; React 18 needs the string form. */
export function inertProps(inert: boolean): Record<string, string> {
  return inert ? { inert: '' } : {};
}
