import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton, QuietButton } from '../components/buttons';
import { Chip, TextField } from '../components/controls';
import {
  ArrowDownwardIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  ErrorOutlineIcon,
  InfoOutlineIcon,
  MenuBookIcon,
  TuneIcon,
} from '../components/icons';
import { ContextMenu, menuPoint, useContextMenu, type MenuItem, type MenuPoint } from '../components/overlay';
import { LoadingLine, ProgressRing, ScreenHeader, StateMessage } from '../components/states';
import { downloadFraction, formatBytes, isDownloadActive, isDownloadReady } from '../lib/format';
import { isTypingTarget, readLink, useDocumentTitle, useSentinel } from '../lib/hooks';
import { useServices, useStore } from '../lib/services/react';
import type { Book, LibraryEntry } from '../lib/types';

/** Browse the catalog: server-side search, local subject filter, paging. */
export function BrowseScreen() {
  useDocumentTitle('Browse');
  const services = useServices();
  const catalog = useStore(services.catalog);
  const lib = useStore(services.library);
  const navigate = useNavigate();
  const [query, setQuery] = useState(catalog.query);
  const [subject, setSubject] = useState<string | null>(null);
  const [onlyDownloaded, setOnlyDownloaded] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();

  // Loads an idle catalog, or refreshes the cached listing behind its items.
  useEffect(() => {
    void services.catalog.revalidate();
  }, [catalog.status, catalog.origin, services.catalog]);

  // `/` focuses search, like most desktop web apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useSentinel(sentinel, () => {
    const s = services.catalog.getSnapshot();
    if (s.status === 'ready' && s.hasMore && !s.isLoadingMore) void services.catalog.loadMore();
  });

  const setSearch = (value: string) => {
    setQuery(value);
    services.catalog.search(value);
  };

  const clearFilters = () => {
    setSubject(null);
    setOnlyDownloaded(false);
  };

  const origin = catalog.origin;
  const showMenu = menu.show;
  const openMenu = useCallback(
    (book: Book, at: MenuPoint) => {
      const entry = services.library.entryFor(book, origin);
      const d = entry?.download;
      const items: MenuItem[] = [];
      if (entry && services.library.canRead(entry.id)) {
        items.push({
          label: entry.progress == null ? 'Read' : 'Continue reading',
          icon: MenuBookIcon,
          onSelect: () => void navigate(readLink(entry)),
        });
      }
      items.push({
        label: 'Book details',
        icon: InfoOutlineIcon,
        onSelect: () => void navigate({ to: '/book/$id', params: { id: book.id } }),
      });
      if (entry && d && isDownloadActive(d)) {
        if (d.status !== 'verifying') {
          items.push({ label: 'Cancel download', icon: CloseIcon, onSelect: () => services.library.cancelDownload(entry.id) });
        }
      } else if (!d || !isDownloadReady(d)) {
        items.push({
          label: d?.status === 'failed' ? 'Try download again' : `Download · ${formatBytes(book.fileSize)}`,
          icon: ArrowDownwardIcon,
          // A failed entry retries from its own origin (the same one here).
          onSelect: () => void (entry ? services.library.downloadEntry(entry.id, book) : services.library.download(book, { origin })),
        });
      } else if (entry.book.sha256 !== book.sha256) {
        items.push({ label: 'Update to this edition', icon: ArrowDownwardIcon, onSelect: () => void services.library.downloadEntry(entry.id, book) });
      }
      showMenu({ ...at, label: book.title, items });
    },
    [services, origin, navigate, showMenu],
  );

  let items = catalog.items;
  if (subject) items = items.filter((b) => b.subjects.includes(subject));
  if (onlyDownloaded) {
    items = items.filter((b) => {
      const entry = services.library.entryFor(b, origin);
      return entry ? isDownloadReady(entry.download) : false;
    });
  }
  const filtered = subject != null || onlyDownloaded;

  let body;
  if (catalog.status === 'loading' || catalog.status === 'idle') {
    body = <LoadingLine label={`Contacting ${origin}`} />;
  } else if (catalog.status === 'error' && catalog.error) {
    const err = catalog.error;
    body = (
      <StateMessage
        title={err.isNetwork ? "Can't reach the API." : 'The API returned an error.'}
        body={`${err.message}\n${origin}${err.isNetwork ? '\n\nBooks already downloaded stay readable from Library.' : ''}`}
        error
        actionLabel="Try again"
        onAction={() => void services.catalog.refresh()}
        secondary={<QuietButton label="API settings" onClick={() => void navigate({ to: '/settings' })} />}
      />
    );
  } else if (items.length === 0) {
    const searching = catalog.query.length > 0;
    const pristine = !searching && !filtered;
    body = pristine ? (
      // Mobile says "Pull to refresh"; a desktop page offers the button instead.
      <StateMessage
        title="The catalog is empty."
        body={`Nothing is published at ${origin} yet.\nCheck again later, or point The Reader at another library API in Settings.`}
        actionLabel="Check again"
        onAction={() => void services.catalog.refresh()}
        secondary={<QuietButton label="API settings" onClick={() => void navigate({ to: '/settings' })} />}
      />
    ) : (
      <StateMessage
        title="No matches."
        body={filtered ? 'Try a different search or clear the filters.' : `Nothing in the catalog matches “${catalog.query}”. Try a different search.`}
        actionLabel={filtered ? 'Clear filters' : 'Clear search'}
        onAction={
          filtered
            ? clearFilters
            : () => {
                setSearch('');
                search.current?.focus();
              }
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="catalog-list">
          {items.map((book) => {
            const entry = services.library.entryFor(book, origin);
            return <CatalogRow key={book.id} book={book} entry={entry} origin={origin} onMenu={openMenu} />;
          })}
        </ul>
        {catalog.isLoadingMore ? (
          <LoadingLine />
        ) : catalog.error && catalog.cachedAt && !catalog.refreshing ? (
          // Offline with cached results: say so quietly instead of the error screen.
          <div className="load-more">
            <p className="t-body-sm" style={{ marginBottom: 'var(--space-sm)' }}>
              {catalog.error.isNetwork ? `Can't reach ${origin}.` : 'The API returned an error.'} Showing results saved{' '}
              {new Date(catalog.cachedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.
            </p>
            <QuietButton label="Try again" onClick={() => void services.catalog.refresh()} />
          </div>
        ) : catalog.hasMore ? (
          <div className="load-more">
            <QuietButton label="Load more" onClick={() => void services.catalog.loadMore()} />
          </div>
        ) : (
          <div className="list-end" />
        )}
      </>
    );
  }

  return (
    <div className="page-wide browse">
      <ScreenHeader
        title="Browse"
        size="sm"
        trailing={
          <>
            {catalog.refreshing && (
              <span style={{ display: 'grid', marginRight: 'var(--space-sm)' }}>
                <ProgressRing value={null} size={16} label="Refreshing the catalog" />
              </span>
            )}
            <IconButton icon={TuneIcon} label="Library API settings" tone="muted" tooltipSide="left" onClick={() => void navigate({ to: '/settings' })} />
          </>
        }
      />
      <div className="browse-controls">
        <TextField
          ref={search}
          type="search"
          search
          value={query}
          onValueChange={setSearch}
          onClear={() => {
            setSearch('');
            search.current?.focus();
          }}
          placeholder="Search title, author or subject"
          aria-label="Search title, author or subject"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              setSearch('');
            }
          }}
          trailing={<kbd className="kbd-hint" aria-hidden="true">/</kbd>}
        />
        {(catalog.subjects.length > 0 || lib.entries.length > 0) && (
          <div className="chip-row" role="group" aria-label="Filters">
            <Chip label="Downloaded" selected={onlyDownloaded} onClick={() => setOnlyDownloaded((v) => !v)} />
            {catalog.subjects.map((s) => (
              <Chip key={s} label={s} selected={subject === s} onClick={() => setSubject(subject === s ? null : s)} />
            ))}
          </div>
        )}
      </div>
      {body}
      <div ref={sentinel} aria-hidden="true" />
      <ContextMenu request={menu.request} onClose={menu.close} />
    </div>
  );
}

/** One catalog book. Memoised: only rows whose book or library entry changed re-render. */
const CatalogRow = memo(function CatalogRow({
  book,
  entry,
  origin,
  onMenu,
}: {
  book: Book;
  entry: LibraryEntry | undefined;
  origin: string;
  onMenu: (book: Book, at: MenuPoint) => void;
}) {
  const d = entry?.download;
  let trailing;
  if (d && isDownloadActive(d)) {
    trailing = <ProgressRing value={d.status === 'verifying' ? null : downloadFraction(d)} label="Downloading" />;
  } else if (d && isDownloadReady(d)) {
    trailing = (
      <span role="img" aria-label="Downloaded" className="row-check">
        <CheckIcon size={18} />
      </span>
    );
  } else if (d && d.status === 'failed') {
    trailing = (
      <span role="img" aria-label="Download failed" className="row-error">
        <ErrorOutlineIcon size={18} />
      </span>
    );
  } else {
    trailing = <ChevronRightIcon size={18} className="row-chevron" />;
  }
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    onMenu(book, menuPoint(e));
  };
  return (
    <li onContextMenu={onContextMenu}>
      <Link to="/book/$id" params={{ id: book.id }} className="catalog-row">
        <CoverArt book={book} origin={origin} width={40} />
        <div className="catalog-row-text">
          <div className="t-body-lg clamp-1">{book.title}</div>
          <div className="t-body-sm clamp-1">
            {[book.author, book.subjects[0], formatBytes(book.fileSize)].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="catalog-row-trailing">{trailing}</span>
      </Link>
    </li>
  );
});
