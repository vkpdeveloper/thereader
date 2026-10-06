import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { inlineText, type Article } from 'truffle';
import { ARTICLE_HIGHLIGHT_SHA, articleHighlightBookId, describeSpan, parseArticleLocator, resolveLocator, spanText, type ArticleSpan } from '../../../lib/articleAnchors';
import { useCanHover, useIsDesktop } from '../../../lib/hooks';
import { useServices, useStore } from '../../../lib/services/react';
import { highlightHues, highlightTint, parseHighlightColor, themeById, withAlpha } from '../../../lib/themes';
import { highlightColors, type ArticleSummary, type Highlight, type HighlightColor, type ReaderPreferences } from '../../../lib/types';
import { IconButton } from '../../buttons';
import { BorderColorIcon } from '../../icons';
import { Sheet } from '../../overlay';
import { FloatingBar, HighlightActions, NoteEditor, SelectionActions } from '../../reader/Floating';
import { HighlightsList } from '../../reader/panels';
import { useToast } from '../../toast';
import { ArticleText, highlightAt, paintsHighlights } from './dom';
import '../../reader/reader.css';
import './highlights.css';

const EMPTY: Highlight[] = [];
/** CSS highlight names: one per colour, a noted variant, and the one in focus. */
const paintName = (c: HighlightColor, noted: boolean) => `thereader-${c}${noted ? '-note' : ''}`;
const ACTIVE = 'thereader-active';
const ALL_NAMES = [...highlightColors.flatMap((c) => [paintName(c, false), paintName(c, true)]), ACTIVE];
/** Elements a jump scrolls to: the innermost block-level box holding the passage. */
const LANDING = 'p, li, h1, h2, h3, h4, h5, h6, dt, dd, pre, figcaption, td, th, blockquote, aside';

/** A rect kept in page coordinates, so the window can scroll under it. */
type PageRect = { x: number; y: number; width: number; height: number };
const toPage = (r: DOMRect): PageRect => ({ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });
const toViewport = (r: PageRect): DOMRect => new DOMRect(r.x - window.scrollX, r.y - window.scrollY, r.width, r.height);
const onScreen = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight;

interface SelectionState {
  span: ArticleSpan;
  /** What Copy puts on the clipboard: the selection as the browser reads it. */
  copy: string;
  rect: PageRect;
}

/**
 * Highlights and notes for the article reader, matching the book reader:
 * select text for the colour toolbar (below the selection on touch screens,
 * clear of the system menu), click or tap a highlight to recolour, annotate,
 * copy or delete it, and list every passage in a sheet (H).
 *
 * Highlights are painted with the CSS Custom Highlight API from Ranges over
 * React's own text nodes, so the article's DOM is never changed; the ranges
 * are found again whenever the page re-renders. Clicks are matched to a
 * highlight by the caret position under the pointer.
 */
export function useArticleHighlights({
  id,
  ready,
  bodyRef,
  prefs,
  reveal,
}: {
  id: string;
  ready: { article: Article; summary: ArticleSummary } | null;
  bodyRef: RefObject<HTMLDivElement>;
  prefs: ReaderPreferences;
  /** Scrolls to and flashes an element (article.tsx `flash`, far jumps included). */
  reveal: (el: HTMLElement) => void;
}): { button: ReactNode; layer: ReactNode; onKey: (e: KeyboardEvent) => boolean; busy: boolean } {
  const services = useServices();
  const toast = useToast();
  const desktop = useIsDesktop();
  const canHover = useCanHover();
  useStore(services.highlights);
  const items = ready ? services.highlights.forArticle(id) : EMPTY;

  const [selection, setSelection] = useState<SelectionState | null>(null);
  /** A highlight's actions; `editing` shows its note editor instead. */
  const [popover, setPopover] = useState<{ id: string; rect: PageRect; editing?: boolean } | null>(null);
  const [peek, setPeek] = useState<{ id: string; rect: PageRect } | null>(null);
  const [list, setList] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [landed, setLanded] = useState<string | null>(null);
  const [, setScrolled] = useState(0);

  const ranges = useRef(new Map<string, Range>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeId = popover?.id ?? landed;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  /** Set while the pointer is pressed on a floating bar, whose clicks may collapse the selection. */
  const inBar = useRef(false);

  const articleText = useCallback(() => {
    const body = bodyRef.current;
    return body && ready ? new ArticleText(body, ready.article.blocks.length) : null;
  }, [bodyRef, ready]);

  // ------------------------------------------------------------ painting

  const paint = useCallback(() => {
    if (!paintsHighlights) return;
    const groups = new Map<string, Range[]>();
    for (const h of itemsRef.current) {
      const range = ranges.current.get(h.id);
      if (!range) continue;
      const name = paintName(parseHighlightColor(h.color), !!h.note?.trim());
      const group = groups.get(name);
      if (group) group.push(range);
      else groups.set(name, [range]);
    }
    const active = activeRef.current ? ranges.current.get(activeRef.current) : undefined;
    if (active) groups.set(ACTIVE, [active]);
    for (const name of ALL_NAMES) {
      const group = groups.get(name);
      if (!group) {
        CSS.highlights.delete(name);
        continue;
      }
      const hl = new Highlight(...group);
      if (name === ACTIVE) hl.priority = 1;
      CSS.highlights.set(name, hl);
    }
  }, []);

  useEffect(
    () => () => {
      if (paintsHighlights) for (const name of ALL_NAMES) CSS.highlights.delete(name);
    },
    [],
  );

  // Find every passage in the page as drawn, and again whenever React (or a
  // late render: code colouring, math, typography) changes the article's text.
  useEffect(() => {
    const body = bodyRef.current;
    if (!ready || !body) return;
    let frame = 0;
    const resolve = () => {
      frame = 0;
      const doc = articleText();
      if (!doc) return;
      const next = new Map<string, Range>();
      for (const h of itemsRef.current) {
        const loc = parseArticleLocator(h.locator);
        const span = loc && resolveLocator(loc, doc.text, doc.count);
        const range = span && doc.range(span);
        if (range) next.set(h.id, range);
      }
      ranges.current = next;
      paint();
    };
    resolve();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(resolve);
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready, items, bodyRef, articleText, paint]);

  useEffect(() => paint(), [activeId, paint]);

  useEffect(() => {
    if (!landed) return;
    const t = window.setTimeout(() => setLanded(null), 1600);
    return () => window.clearTimeout(t);
  }, [landed]);

  const css = useMemo(() => {
    const colors = themeById(prefs.themeId).colors;
    const rules = highlightColors.map((c) => {
      const tint = highlightTint(c, colors);
      return (
        `::highlight(${paintName(c, false)}){background-color:${tint};}` +
        `::highlight(${paintName(c, true)}){background-color:${tint};text-decoration:underline dotted ${highlightHues[c]};text-decoration-thickness:2px;}`
      );
    });
    return rules.join('') + `::highlight(${ACTIVE}){background-color:${withAlpha(colors.ink, 0.14)};}`;
  }, [prefs.themeId]);

  // ------------------------------------------------------------ selection

  useEffect(() => {
    if (!ready) return;
    let timer = 0;
    let pressed = false;
    let touch = false;
    const check = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (!inBar.current) setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const doc = articleText();
      const span = doc?.span(range);
      if (!span) {
        setSelection(null);
        return;
      }
      setPopover(null);
      setPeek(null);
      setSelection({ span, copy: sel.toString(), rect: toPage(range.getBoundingClientRect()) });
    };
    const onChange = () => {
      window.clearTimeout(timer);
      // A mouse drag shows the bar once it ends; touch handles settle first.
      if (pressed) return;
      timer = window.setTimeout(check, touch ? 350 : 120);
    };
    const onDown = (e: PointerEvent) => {
      touch = e.pointerType !== 'mouse';
      inBar.current = !!(e.target as Element | null)?.closest?.('.floating-bar');
      pressed = e.pointerType === 'mouse' && e.button === 0 && !inBar.current;
    };
    const onUp = () => {
      if (!pressed) return;
      pressed = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 0);
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [ready, articleText]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);

  // ------------------------------------------------------------ clicks and hover

  useEffect(() => {
    const body = bodyRef.current;
    if (!ready || !body) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    let peekTimer = 0;
    let peekId: string | null = null;
    const ignored = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('a, button, input, summary, [data-fn], [data-zoom], [data-anchor]');

    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || ignored(e.target)) return;
      // The click that ends a drag selection is not a tap on a highlight.
      if (window.getSelection()?.isCollapsed === false) return;
      const hit = highlightAt(ranges.current, e.clientX, e.clientY);
      if (!hit) return;
      window.clearTimeout(peekTimer);
      setPeek(null);
      setSelection(null);
      setPopover({ id: hit.id, rect: toPage(hit.rect) });
    };

    // Mouse only: a pointer cursor over highlights, and a note shown after a short rest.
    const hover = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      const hit = ranges.current.size > 0 && !ignored(e.target) ? highlightAt(ranges.current, e.clientX, e.clientY) : null;
      setHovering(!!hit);
      const noted = hit && services.highlights.byId(hit.id)?.note?.trim() ? hit : null;
      if (noted?.id === peekId) return;
      window.clearTimeout(peekTimer);
      peekId = noted?.id ?? null;
      setPeek(null);
      if (noted) peekTimer = window.setTimeout(() => setPeek({ id: noted.id, rect: toPage(noted.rect) }), 350);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      last = e;
      if (!frame) frame = requestAnimationFrame(hover);
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(peekTimer);
      peekId = null;
      setHovering(false);
      setPeek(null);
    };
    body.addEventListener('click', onClick);
    if (canHover) {
      body.addEventListener('pointermove', onMove);
      body.addEventListener('pointerleave', onLeave);
    }
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(peekTimer);
      body.removeEventListener('click', onClick);
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerleave', onLeave);
    };
  }, [ready, bodyRef, canHover, services]);

  // A desktop popover closes on a press anywhere else (a press on another highlight then opens that one).
  useEffect(() => {
    if (!popover || !desktop) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('.floating-bar')) setPopover(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [popover, desktop]);

  // Floating bars follow the page while it scrolls; a note preview just goes.
  const floating = selection != null || popover != null || peek != null;
  useEffect(() => {
    if (!floating) return;
    let frame = 0;
    const onScroll = () => {
      setPeek(null);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setScrolled((n) => n + 1);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [floating]);

  // ------------------------------------------------------------ actions

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.show('Copied');
      } catch {
        toast.show("Couldn't copy.");
      }
    },
    [toast],
  );

  /** The heading of the section a block sits in, for the list. */
  const sectionTitle = useCallback(
    (block: number): string | null => {
      const blocks = ready?.article.blocks ?? [];
      for (let i = Math.min(block, blocks.length - 1); i >= 0; i--) {
        const b = blocks[i]!;
        if (b.type === 'heading') return inlineText(b.content).trim() || null;
      }
      return null;
    },
    [ready],
  );

  const createHighlight = useCallback(
    async (sel: SelectionState, color: HighlightColor, then?: 'note') => {
      const doc = articleText();
      if (!doc || !ready) return;
      clearSelection();
      const locator = describeSpan(sel.span, doc.text, doc.count, {
        articleId: id,
        href: ready.summary.url || `article:${id}`,
        title: sectionTitle(sel.span.startBlock),
      });
      try {
        const h = await services.highlights.create({
          bookId: articleHighlightBookId(id),
          sha256: ARTICLE_HIGHLIGHT_SHA,
          origin: services.settings.currentOrigin(),
          locator: locator as unknown as Record<string, unknown>,
          text: locator.text?.highlight ?? spanText(sel.span, doc.text),
          color,
        });
        if (then === 'note') setPopover({ id: h.id, rect: sel.rect, editing: true });
      } catch {
        toast.show("Couldn't save the highlight.");
      }
    },
    [articleText, clearSelection, id, ready, sectionTitle, services, toast],
  );

  /** Deletes at once (as in the book reader) and offers Undo, which restores the passage as a new highlight. */
  const deleteHighlight = useCallback(
    (h: Highlight) => {
      void services.highlights.delete(h.id);
      toast.show('Highlight deleted.', {
        action: {
          label: 'Undo',
          onClick: () =>
            void services.highlights
              .create({ bookId: h.bookId, sha256: h.sha256, origin: h.origin, locator: h.locator, text: h.text, color: h.color, note: h.note ?? null })
              .catch(() => toast.show("Couldn't restore the highlight.")),
        },
      });
    },
    [services, toast],
  );

  /** Scrolls to a passage (far jumps in long articles included) and marks it for a moment. */
  const openHighlight = useCallback(
    (h: Highlight) => {
      const range = ranges.current.get(h.id);
      const start = range?.startContainer;
      const from = start instanceof Element ? start : start?.parentElement;
      const block = from?.closest<HTMLElement>('[data-block-index]');
      if (!range || !from || !block) {
        toast.show("Couldn't find this passage in the article.");
        return;
      }
      let target = from.closest<HTMLElement>(LANDING);
      if (!target || !block.contains(target)) target = block;
      // A component's wrapper has no box of its own.
      if (target.classList.contains('article-block-contents')) target = (target.firstElementChild as HTMLElement | null) ?? target;
      reveal(target);
      setLanded(h.id);
    },
    [reveal, toast],
  );

  // ------------------------------------------------------------ keys

  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      if (popover) setPopover(null);
      else if (selection) clearSelection();
      else if (peek) setPeek(null);
      else return false;
      e.preventDefault();
      return true;
    }
    if (e.key === 'h') {
      e.preventDefault();
      setPopover(null);
      setList((v) => !v);
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------ render

  const defaultColor = parseHighlightColor(prefs.highlightColor);
  const popoverHighlight = popover ? services.highlights.byId(popover.id) : undefined;
  const peekHighlight = peek && !popover && !selection ? services.highlights.byId(peek.id) : undefined;

  /** Actions for a tapped highlight, or its note editor (as in the book reader). */
  const highlightPanel = (h: Highlight, compact: boolean) =>
    popover?.editing ? (
      <NoteEditor
        compact={compact}
        initial={h.note?.trim() ? h.note : null}
        quote={compact ? undefined : h.text}
        onCancel={() => setPopover((p) => (p ? { ...p, editing: false } : p))}
        onSave={(note) => {
          void services.highlights.setNote(h.id, note);
          setPopover(null);
        }}
      />
    ) : (
      <HighlightActions
        compact={compact}
        color={parseHighlightColor(h.color)}
        note={h.note?.trim() ? h.note : null}
        onRecolor={(c) => void services.highlights.recolor(h.id, c)}
        onNote={() => setPopover((p) => (p ? { ...p, editing: true } : p))}
        onCopy={() => {
          void copy(h.text);
          setPopover(null);
        }}
        onDelete={() => {
          setPopover(null);
          deleteHighlight(h);
        }}
      />
    );

  const selectionRect = selection ? toViewport(selection.rect) : null;
  const popoverRect = popover ? toViewport(popover.rect) : null;

  const button = (
    <IconButton
      icon={BorderColorIcon}
      label="Highlights"
      shortcut="H"
      aria-pressed={list}
      onClick={() => {
        setPopover(null);
        setList((v) => !v);
      }}
    />
  );

  const layer = (
    <>
      <style>{hovering ? `${css}.article-body{cursor:pointer}` : css}</style>
      {selection && selectionRect && onScreen(selectionRect) && (
        <FloatingBar rect={selectionRect} preferBelow={!canHover} label="Selection" onDismiss={clearSelection}>
          <SelectionActions
            defaultColor={defaultColor}
            onHighlight={(c) => void createHighlight(selection, c)}
            onNote={() => void createHighlight(selection, defaultColor, 'note')}
            onCopy={() => {
              void copy(selection.copy);
              clearSelection();
            }}
          />
        </FloatingBar>
      )}

      {popover && popoverHighlight && !popoverHighlight.deleted && desktop && popoverRect && (
        <FloatingBar rect={popoverRect} label="Highlight" layoutKey={popover.editing ? 'note' : 'actions'} onDismiss={() => setPopover(null)}>
          {highlightPanel(popoverHighlight, true)}
        </FloatingBar>
      )}
      {!desktop && (
        <Sheet open={!!(popover && popoverHighlight && !popoverHighlight.deleted)} onClose={() => setPopover(null)} label="Highlight">
          {popoverHighlight && highlightPanel(popoverHighlight, false)}
        </Sheet>
      )}

      {peek && peekHighlight?.note && <NotePeek rect={toViewport(peek.rect)} note={peekHighlight.note} />}

      <Sheet open={list} onClose={() => setList(false)} title="Highlights" fill>
        <div className="reader-panel-body">
          <HighlightsList
            items={items}
            onOpen={(h) => {
              setList(false);
              openHighlight(h);
            }}
            onDelete={deleteHighlight}
            onNote={(h, note) => void services.highlights.setNote(h.id, note)}
          />
        </div>
      </Sheet>
    </>
  );

  /** A selection bar, highlight popover or the list is open: other floating controls stay out of the way. */
  const busy = selection != null || popover != null || list;
  return { button, layer, onKey, busy };
}

/** A highlight's note, shown while the mouse rests on the passage; reading it needs no click. */
function NotePeek({ rect, note }: { rect: DOMRect; note: string }) {
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const above = rect.top - h - 8;
    const top = above > 64 ? above : Math.min(rect.bottom + 8, window.innerHeight - h - 8);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
    setPos({ left, top });
  }, [rect, note]);
  return (
    <div ref={card} className={pos ? 'article-note-peek is-shown' : 'article-note-peek'} style={pos ?? { left: -9999, top: -9999 }} role="tooltip">
      <p>{note}</p>
    </div>
  );
}
