import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useApp } from '../lib/store';
import { Eyebrow, Tag, QuietButton, LoadingLine, StateMessage, formatBytes } from '../components/ui';
import type { Book } from '../lib/types';

function coverUrl(book: Book, base: string) {
  return book.coverUrl ? (base ? `${base.replace(/\/+$/, '')}${book.coverUrl}` : book.coverUrl) : null;
}

export default function BookDetail() {
  const { id } = useParams({ from: '/book/$id' });
  const { getBookById, getEntry, download, remove, settings } = useApp();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const entry = getEntry(id);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getBookById(id)
      .then(setBook)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id, getBookById]);

  const handleDownload = async (b: Book) => {
    setDownloading(true);
    setProgress(0);
    try {
      await download(b, setProgress);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('Remove this book from your library?')) return;
    await remove(id);
  };

  if (loading) return <LoadingLine label="Loading book" />;
  if (error || !book) return (
    <div className="screen">
      <StateMessage title="Couldn't load this book." body={error ?? 'Not found.'} />
    </div>
  );

  const outdated = entry?.downloaded && entry.book.sha256 !== book.sha256;
  const downloaded = entry?.downloaded && !outdated;

  return (
    <div className="screen">
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => window.history.back()}
        style={{ marginBottom: 'var(--space-md)' }}
      >
        ← Back
      </button>

      <div style={{ textAlign: 'center', marginBottom: 'var(--space-lg)' }}>
        <div style={{ width: 120, margin: '0 auto' }}>
          <img
            src={coverUrl(book, settings.apiBaseUrl) ?? undefined}
            alt=""
            style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover', borderRadius: 'var(--radius-md)' }}
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        </div>
      </div>

      <h1 className="display-small" style={{ marginBottom: 'var(--space-xs)' }}>{book.title}</h1>
      <p className="body-large" style={{ color: 'var(--muted)', marginBottom: 'var(--space-md)' }}>{book.author}</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', marginBottom: 'var(--space-lg)' }}>
        {book.subjects.map((s) => <Tag key={s}>{s}</Tag>)}
        <Tag>{book.language.toUpperCase()}</Tag>
        <Tag>{formatBytes(book.fileSize)}</Tag>
      </div>

      <div className="card" style={{ marginBottom: 'var(--space-xl)' }}>
        {downloading ? (
          <>
            <p className="body">{formatBytes(Math.round(progress * book.fileSize))} of {formatBytes(book.fileSize)}</p>
            <div style={{ margin: 'var(--space-sm) 0' }}>
              <progress value={progress} max={1} style={{ width: '100%' }} />
            </div>
          </>
        ) : downloaded ? (
          <>
            <p className="body-small" style={{ color: 'var(--green)', marginBottom: 'var(--space-md)' }}>
              ✓ Saved and verified.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <Link to="/reader/$id" params={{ id: book.id }} style={{ flex: 1 }}>
                <QuietButton primary expand>{entry?.progress ? 'Continue reading' : 'Read'}</QuietButton>
              </Link>
              {entry && (
                <QuietButton onClick={handleRemove}>Remove</QuietButton>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="body-small" style={{ marginBottom: 'var(--space-md)' }}>
              Browser preview: download this book to read offline.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <QuietButton primary expand onClick={() => handleDownload(book)}>
                Download · {formatBytes(book.fileSize)}
              </QuietButton>
              {entry?.downloaded && (
                <QuietButton onClick={handleRemove}>Remove</QuietButton>
              )}
            </div>
          </>
        )}
      </div>

      {book.description && (
        <>
          <Eyebrow>About</Eyebrow>
          <p className="body-large" style={{ fontFamily: 'var(--font-serif)', lineHeight: 1.55, marginBottom: 'var(--space-xl)' }}>
            {book.description}
          </p>
        </>
      )}

      <Eyebrow>Edition</Eyebrow>
      <div className="body-small" style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 'var(--space-sm)' }}>
        <span style={{ color: 'var(--muted)' }}>Version</span>
        <span>{book.version}</span>
        <span style={{ color: 'var(--muted)' }}>Updated</span>
        <span>{new Date(book.updatedAt).toLocaleDateString()}</span>
        <span style={{ color: 'var(--muted)' }}>SHA-256</span>
        <span style={{ wordBreak: 'break-all' }}>{book.sha256}</span>
      </div>
    </div>
  );
}
