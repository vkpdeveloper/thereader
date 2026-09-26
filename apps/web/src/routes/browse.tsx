import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useApp } from '../lib/store';
import { ScreenHeader, BookListItem, LoadingLine, StateMessage, Chip, QuietButton } from '../components/ui';
import type { Book } from '../lib/types';

function coverUrl(book: Book, base: string) {
  return book.coverUrl ? (base ? `${base.replace(/\/+$/, '')}${book.coverUrl}` : book.coverUrl) : null;
}

export default function Browse() {
  const {
    catalog,
    catalogLoading,
    catalogError,
    catalogHasMore,
    refreshCatalog,
    loadMoreCatalog,
    searchCatalog,
    library,
    settings,
  } = useApp();
  const [search, setSearch] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  const [onlyDownloaded, setOnlyDownloaded] = useState(false);

  useEffect(() => {
    refreshCatalog();
  }, []);

  const subjects = useMemo(
    () => Array.from(new Set(catalog.flatMap((b) => b.subjects))).sort(),
    [catalog],
  );

  const items = useMemo(() => {
    return catalog.filter((b) => {
      if (subject && !b.subjects.includes(subject)) return false;
      if (onlyDownloaded) return library.some((e) => e.id === b.id && e.downloaded);
      return true;
    });
  }, [catalog, subject, onlyDownloaded, library]);

  const onSearch = (value: string) => {
    setSearch(value);
    setSubject(null);
    searchCatalog(value);
  };

  return (
    <div className="screen">
      <ScreenHeader title="Browse" />
      <input
        className="input"
        type="search"
        placeholder="Search title, author or subject"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />

      {(subjects.length > 0 || library.length > 0) && (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', overflowX: 'auto', padding: 'var(--space-sm) 0' }}>
          <Chip
            label="Downloaded"
            selected={onlyDownloaded}
            onClick={() => setOnlyDownloaded((v) => !v)}
          />
          {subjects.map((s) => (
            <Chip
              key={s}
              label={s}
              selected={subject === s}
              onClick={() => setSubject((cur) => (cur === s ? null : s))}
            />
          ))}
        </div>
      )}

      {catalogLoading && items.length === 0 && <LoadingLine label="Contacting the API" />}

      {catalogError && items.length === 0 && (
        <StateMessage
          title="Can't reach the API."
          body={catalogError}
          action="Try again"
          onAction={refreshCatalog}
        />
      )}

      {!catalogLoading && !catalogError && items.length === 0 && (
        <StateMessage
          title={search || subject || onlyDownloaded ? 'No matches.' : 'The catalog is empty.'}
          body={search || subject || onlyDownloaded ? 'Try a different search or clear the filters.' : 'Nothing is published at this API yet.'}
          action={subject || onlyDownloaded ? 'Clear filters' : undefined}
          onAction={subject || onlyDownloaded ? () => { setSubject(null); setOnlyDownloaded(false); } : undefined}
        />
      )}

      <div style={{ marginTop: 'var(--space-md)' }}>
        {items.map((book) => (
          <Link
            key={book.id}
            to="/book/$id"
            params={{ id: book.id }}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <BookListItem
              book={book}
              entry={library.find((e) => e.id === book.id)}
              coverUrl={coverUrl(book, settings.apiBaseUrl)}
              onClick={() => {}}
            />
          </Link>
        ))}
      </div>

      {catalogHasMore && (
        <div style={{ padding: 'var(--space-md) 0', textAlign: 'center' }}>
          <QuietButton onClick={loadMoreCatalog} disabled={catalogLoading}>
            {catalogLoading ? 'Loading' : 'Load more'}
          </QuietButton>
        </div>
      )}
    </div>
  );
}
