import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SearchMatch, TocEntry } from '../../reader/engine';
import { highlightHues, parseHighlightColor } from '../../lib/themes';
import type { Highlight, ReadingLocator } from '../../lib/types';
import { IconButton } from '../buttons';
import { TextField } from '../controls';
import { DeleteOutlineIcon, SearchIcon } from '../icons';
import { ProgressLine } from '../states';

/** Table of contents; the current chapter is set in the foreground colour. */
export function ContentsList({
  toc,
  currentHref,
  onOpen,
}: {
  toc: TocEntry[];
  currentHref: string | null;
  onOpen: (entry: TocEntry) => void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    active.current?.scrollIntoView({ block: 'center' });
  }, []);
  if (toc.length === 0) return <p className="panel-empty">This book has no table of contents.</p>;
  return (
    <ul className="toc-list">
      {toc.map((t, i) => {
        const isActive = currentHref != null && t.href.split('#')[0] === currentHref;
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

/** Every live highlight of the open edition, in reading order. */
export function HighlightsList({
  items,
  onOpen,
  onDelete,
}: {
  items: Highlight[];
  onOpen: (h: Highlight) => void;
  onDelete: (h: Highlight) => void;
}) {
  if (items.length === 0) return <p className="panel-empty">No highlights yet.</p>;
  return (
    <ul className="highlight-list">
      {items.map((h) => {
        const chapter = typeof h.locator.title === 'string' ? h.locator.title : null;
        return (
          <li key={h.id} className="highlight-item">
            <button type="button" className="highlight-open" onClick={() => onOpen(h)}>
              <span className="highlight-dot" style={{ background: highlightHues[parseHighlightColor(h.color)] }} />
              <span className="highlight-text">
                <span className="highlight-quote clamp-3">{h.text}</span>
                {chapter && <span className="t-label-sm clamp-1">{chapter}</span>}
              </span>
            </button>
            <IconButton icon={DeleteOutlineIcon} label="Delete highlight" tone="muted" size={18} tooltipSide="left" onClick={() => onDelete(h)} />
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
