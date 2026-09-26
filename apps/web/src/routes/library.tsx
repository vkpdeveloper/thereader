import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useApp } from '../lib/store';
import { ScreenHeader, Eyebrow, BookGridItem, StateMessage, ProgressBar } from '../components/ui';
import type { LibraryEntry } from '../lib/types';

type Filter = 'all' | 'downloaded' | 'inProgress';

function coverUrl(book: LibraryEntry['book'], base: string) {
  return book.coverUrl ? (base ? `${base.replace(/\/+$/, '')}${book.coverUrl}` : book.coverUrl) : null;
}

export default function Library() {
  const { library, settings } = useApp();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const sorted = useMemo(() => [...library].sort((a, b) => b.addedAt - a.addedAt), [library]);
  const current = sorted.find((e) => e.progress && e.progress.totalProgression < 0.995);
  const shown = useMemo(() => {
    return sorted.filter((e) => {
      if (filter === 'downloaded') return e.downloaded;
      if (filter === 'inProgress') return e.progress && e.progress.totalProgression < 0.995;
      return true;
    });
  }, [sorted, filter]);

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'downloaded', label: 'Downloaded' },
    { key: 'inProgress', label: 'In progress' },
  ];

  return (
    <div className="screen">
      <ScreenHeader title="Library" />

      {library.length === 0 ? (
        <StateMessage
          title="Nothing here yet."
          body="Browse the library and download a book. Downloads are kept in this browser for offline reading."
          action="Browse books"
          onAction={() => navigate({ to: '/app/browse' })}
        />
      ) : (
        <>
          {current && (
            <div style={{ marginBottom: 'var(--space-xl)' }}>
              <Eyebrow>Continue reading</Eyebrow>
              <Link to="/reader/$id" params={{ id: current.id }} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="card" style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
                  <div style={{ width: 64, flexShrink: 0 }}>
                    <img
                      src={coverUrl(current.book, settings.apiBaseUrl) ?? undefined}
                      alt=""
                      style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }}
                      onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="headline" style={{ marginBottom: 2 }}>{current.book.title}</p>
                    <p className="body-small">
                      {current.progress?.title ? `${current.book.author} · ${current.progress.title}` : current.book.author}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginTop: 'var(--space-md)' }}>
                      <ProgressBar value={current.progress?.totalProgression ?? 0} />
                      <span className="label-small">{Math.round((current.progress?.totalProgression ?? 0) * 100)}%</span>
                    </div>
                  </div>
                  <span style={{ color: 'var(--subtle)' }}>›</span>
                </div>
              </Link>
            </div>
          )}

          <div className="filter-row">
            {filters.map((f) => (
              <button
                key={f.key}
                className={`filter-link ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto' }} className="label-small">
              {shown.length}
            </span>
          </div>

          {shown.length === 0 ? (
            <StateMessage title="No books match." body="Try another filter." />
          ) : (
            <div className="grid" style={{ paddingBottom: 'var(--space-xxl)' }}>
              {shown.map((entry) => (
                <Link
                  key={entry.id}
                  to={entry.downloaded ? '/reader/$id' : '/book/$id'}
                  params={{ id: entry.id }}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <BookGridItem
                    book={entry.book}
                    entry={entry}
                    coverUrl={coverUrl(entry.book, settings.apiBaseUrl)}
                    onClick={() => {}}
                  />
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
