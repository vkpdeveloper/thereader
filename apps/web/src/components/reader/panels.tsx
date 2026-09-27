import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SearchMatch, TocEntry } from '../../reader/engine';
import { highlightHues, parseHighlightColor } from '../../lib/themes';
import type { Highlight, ReadingLocator } from '../../lib/types';
import { IconButton } from '../buttons';
import { TextField } from '../controls';
import { CloseIcon, DeleteOutlineIcon, FormatListIcon, SearchIcon } from '../icons';
import { ProgressLine } from '../states';
import { NoteEditor, NoteIcon } from './Floating';

/**
 * The entry being read: of the entries in the current file, the last whose
 * title is the page's chapter title (a section inside the file), else the
 * file's first entry.
 */
function activeEntry(toc: TocEntry[], href: string | null, title: string | null): number {
  if (href == null) return -1;
  let first = -1;
  let titled = -1;
  toc.forEach((t, i) => {
    if (t.href.split('#')[0] !== href) return;
    if (first < 0) first = i;
    if (title != null && t.title === title) titled = i;
  });
  return titled >= 0 ? titled : first;
}

/** Table of contents; the entry being read is set in the foreground colour. */
export function ContentsList({
  toc,
  currentHref,
  currentTitle,
  onOpen,
}: {
  toc: TocEntry[];
  currentHref: string | null;
  currentTitle: string | null;
  onOpen: (entry: TocEntry) => void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  const activeIndex = useMemo(() => activeEntry(toc, currentHref, currentTitle), [toc, currentHref, currentTitle]);
  useLayoutEffect(() => {
    active.current?.scrollIntoView({ block: 'center' });
  }, []);
  if (toc.length === 0) return <p className="panel-empty">This book has no table of contents.</p>;
  return (
    <ul className="toc-list">
      {toc.map((t, i) => {
        const isActive = i === activeIndex;
        return (
          <li key={`${t.href}-${i}`}>
            <button
              ref={isActive ? active : undefined}
              type="button"
              className={isActive ? 'toc-item is-active' : 'toc-item'}
              style={{ paddingLeft: 20 + t.depth * 16 }}
              aria-current={isActive ? 'location' : undefined}
              onClick={() => onOpen(t)}
            >
              {t.title}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const CARD_WIDTH = 220;
const GAP = 40;
const AUTO_CLOSE_MS = 12000;

function bodyLeft(): number | null {
  const host = document.querySelector('.reader-host');
  const iframe = host?.querySelector('iframe') as HTMLIFrameElement | null;
  const body = iframe?.contentDocument?.body;
  if (!iframe || !body) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  return iframeRect.left + bodyRect.left;
}

/** Auto-collapsing floating TOC card for desktop web readers. */
export function FloatingToc({
  toc,
  currentHref,
  currentTitle,
  onOpen,
}: {
  toc: TocEntry[];
  currentHref: string | null;
  currentTitle: string | null;
  onOpen: (entry: TocEntry) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [contentLeft, setContentLeft] = useState<number | null>(null);
  const [entered, setEntered] = useState(false);
  const hoveredRef = useRef(false);
  const collapsedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const sections = useMemo(() => {
    if (!currentHref) return [];
    return toc.filter((t) => t.href.split('#')[0] === currentHref);
  }, [toc, currentHref]);

  const activeIndex = useMemo(() => activeEntry(sections, currentHref, currentTitle), [sections, currentHref, currentTitle]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback((ms = AUTO_CLOSE_MS) => {
    clearTimer();
    if (hoveredRef.current || collapsedRef.current) return;
    timerRef.current = window.setTimeout(() => {
      if (!hoveredRef.current) setCollapsed(true);
    }, ms);
  }, [clearTimer]);

  useLayoutEffect(() => {
    const measure = () => setContentLeft(bodyLeft());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [currentHref, currentTitle]);

  useEffect(() => {
    collapsedRef.current = collapsed;
    if (!collapsed && !hoveredRef.current) {
      startTimer();
    }
  }, [collapsed, startTimer]);

  useEffect(() => {
    setCollapsed(false);
    setEntered(false);
    clearTimer();
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [currentHref, clearTimer]);

  useEffect(() => {
    if (!collapsedRef.current && !hoveredRef.current) {
      startTimer();
    }
  }, [currentTitle, startTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  if (sections.length === 0) return null;

  const baseLeft = (contentLeft ?? 80) - GAP;

  if (collapsed) {
    const left = Math.max(12, baseLeft - 28);
    return (
      <button
        type="button"
        className="floating-toc-collapsed"
        style={{ left }}
        aria-label="Show table of contents"
        onMouseEnter={() => {
          setCollapsed(false);
        }}
        onFocus={() => setCollapsed(false)}
        onClick={() => setCollapsed(false)}
      >
        <FormatListIcon size={16} />
      </button>
    );
  }

  const left = Math.max(12, baseLeft - CARD_WIDTH);

  const handleOpen = (t: TocEntry) => {
    onOpen(t);
    startTimer(800);
  };

  return (
    <nav
      className={['floating-toc-card', !entered && 'is-entering'].filter(Boolean).join(' ')}
      style={{ left }}
      aria-label="Table of contents"
      onMouseEnter={() => {
        hoveredRef.current = true;
        clearTimer();
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
        startTimer();
      }}
      onFocus={() => {
        hoveredRef.current = true;
        clearTimer();
      }}
      onBlur={() => {
        hoveredRef.current = false;
        startTimer();
      }}
    >
      <div className="floating-toc-header">
        <span className="floating-toc-title">Sections</span>
        <button
          type="button"
          className="floating-toc-close"
          aria-label="Hide table of contents"
          onClick={() => setCollapsed(true)}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <ul className="floating-toc-list" role="list">
        {sections.map((t, i) => {
          const isActive = i === activeIndex;
          return (
            <li key={`${t.href}-${i}`} className="floating-toc-row" style={{ paddingLeft: t.depth * 12 }}>
              <button
                type="button"
                className={isActive ? 'floating-toc-item is-active' : 'floating-toc-item'}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => handleOpen(t)}
              >
                {t.title}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Every live highlight of the open edition, in reading order, with its note. */
export function HighlightsList({
  items,
  onOpen,
  onDelete,
  onNote,
}: {
  items: Highlight[];
  onOpen: (h: Highlight) => void;
  onDelete: (h: Highlight) => void;
  onNote: (h: Highlight, note: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (items.length === 0) return <p className="panel-empty">No highlights yet.</p>;
  return (
    <ul className="highlight-list">
      {items.map((h) => {
        const chapter = typeof h.locator.title === 'string' ? h.locator.title : null;
        const note = h.note?.trim() ? h.note : null;
        return (
          <li key={h.id} className="highlight-item">
            <button type="button" className="highlight-open" onClick={() => onOpen(h)}>
              <span className="highlight-dot" style={{ background: highlightHues[parseHighlightColor(h.color)] }} />
              <span className="highlight-text">
                <span className="highlight-quote clamp-3">{h.text}</span>
                {note && editing !== h.id && <span className="highlight-note clamp-3">{note}</span>}
                {chapter && <span className="t-label-sm clamp-1">{chapter}</span>}
              </span>
            </button>
            <div className="highlight-item-actions">
              <IconButton
                icon={NoteIcon}
                label={note ? 'Edit note' : 'Add note'}
                tone="muted"
                size={18}
                tooltipSide="left"
                aria-expanded={editing === h.id}
                onClick={() => setEditing((cur) => (cur === h.id ? null : h.id))}
              />
              <IconButton icon={DeleteOutlineIcon} label="Delete highlight" tone="muted" size={18} tooltipSide="left" onClick={() => onDelete(h)} />
            </div>
            {editing === h.id && (
              <NoteEditor
                initial={note}
                onCancel={() => setEditing(null)}
                onSave={(n) => {
                  setEditing(null);
                  onNote(h, n);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Full-text search of the open book; the match is bolded inside its excerpt. */
export function SearchBook({
  search,
  onOpen,
}: {
  search: (query: string, signal: AbortSignal) => Promise<SearchMatch[]>;
  onOpen: (locator: ReadingLocator, index: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError(null);
    setActive(null);
    try {
      const found = await search(q, c.signal);
      if (!c.signal.aborted) setMatches(found);
    } catch {
      if (!c.signal.aborted) setError('Search could not finish. Please try again.');
    } finally {
      if (controller.current === c) setBusy(false);
    }
  };

  return (
    <div className="search-book">
      <form
        className="search-book-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <TextField
          data-autofocus
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder="Search this book"
          aria-label="Search this book"
          enterKeyHint="search"
          autoComplete="off"
          trailing={<IconButton type="submit" icon={SearchIcon} label="Find text" size={18} tooltipSide="left" disabled={busy} />}
        />
      </form>
      {busy && <ProgressLine value={null} label="Searching" />}
      {error && <p className="panel-empty is-error">{error}</p>}
      {matches && !busy && matches.length === 0 && <p className="panel-empty">No matches.</p>}
      {matches && matches.length > 0 && (
        <>
          <p className="t-label-sm search-count" aria-live="polite">
            {matches.length === 1 ? '1 match' : `${matches.length} matches`}
          </p>
          <ul className="search-results">
            {matches.map((m, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={active === i ? 'search-result is-active' : 'search-result'}
                  onClick={() => {
                    setActive(i);
                    onOpen(m.locator, i);
                  }}
                >
                  <span className="clamp-3">
                    {m.before}
                    <strong>{m.match}</strong>
                    {m.after}
                  </span>
                  {m.locator.title && <span className="t-label-sm clamp-1">{m.locator.title}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
