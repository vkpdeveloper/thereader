import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton, QuietButton } from '../components/buttons';
import { Chip, TextField } from '../components/controls';
import { CheckIcon, ChevronRightIcon, ErrorOutlineIcon, TuneIcon } from '../components/icons';
import { LoadingLine, ProgressRing, ScreenHeader, StateMessage } from '../components/states';
import { downloadFraction, formatBytes, isDownloadActive, isDownloadReady } from '../lib/format';
import { isTypingTarget, useDocumentTitle, useSentinel } from '../lib/hooks';
import { useServices, useStore } from '../lib/services/react';
import type { Book } from '../lib/types';

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

  useEffect(() => {
    if (catalog.status === 'idle') void services.catalog.refresh();
  }, [catalog.status, services.catalog]);

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

  let items = catalog.items;
  if (subject) items = items.filter((b) => b.subjects.includes(subject));
  if (onlyDownloaded) {
    items = items.filter((b) => {
      const entry = services.library.entryFor(b);
      return entry ? isDownloadReady(entry.download) : false;
    });
  }
  const filtered = subject != null || onlyDownloaded;

  let body;
  if (catalog.status === 'loading' || catalog.status === 'idle') {
    body = <LoadingLine label={`Contacting ${catalog.origin}`} />;
  } else if (catalog.status === 'error' && catalog.error) {
    const err = catalog.error;
    body = (
      <StateMessage
        title={err.isNetwork ? "Can't reach the API." : 'The API returned an error.'}
        body={`${err.message}\n${catalog.origin}${err.isNetwork ? '\n\nBooks already downloaded stay readable from Library.' : ''}`}
        error
        actionLabel="Try again"
        onAction={() => void services.catalog.refresh()}
      />
    );
  } else if (items.length === 0) {
    const pristine = catalog.query.length === 0 && !filtered;
    body = (
      <StateMessage
        title={pristine ? 'The catalog is empty.' : 'No matches.'}
        body={
          pristine
            ? `Nothing is published at ${catalog.origin} yet.\nRefresh, or change the API in Settings.`
            : 'Try a different search or clear the filters.'
        }
        actionLabel={filtered ? 'Clear filters' : pristine ? 'Refresh' : undefined}
        onAction={
          filtered
            ? () => {
                setSubject(null);
                setOnlyDownloaded(false);
              }
            : pristine
              ? () => void services.catalog.refresh()
              : undefined
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="catalog-list">
          {items.map((book) => (
            <CatalogRow key={book.id} book={book} />
          ))}
        </ul>
        {catalog.isLoadingMore ? (
          <LoadingLine />
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
        trailing={<IconButton icon={TuneIcon} label="Library API settings" tone="muted" tooltipSide="left" onClick={() => void navigate({ to: '/settings' })} />}
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
    </div>
  );
}

function CatalogRow({ book }: { book: Book }) {
  const services = useServices();
  const catalog = useStore(services.catalog);
  const entry = services.library.entryFor(book);
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
  return (
    <li>
      <Link to="/book/$id" params={{ id: book.id }} className="catalog-row">
        <CoverArt book={book} origin={catalog.origin} width={40} />
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
}
