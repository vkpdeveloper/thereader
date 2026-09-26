import { Link } from '@tanstack/react-router';
import type { Book, LibraryEntry, ReadingProgress } from '../lib/types';

export function ScreenHeader({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
      <h1 className="display-small">{title}</h1>
      {trailing && <div>{trailing}</div>}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <h2 className="eyebrow">{children}</h2>;
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function QuietButton({
  children,
  onClick,
  primary,
  expand,
  disabled,
  icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  expand?: boolean;
  disabled?: boolean;
  icon?: string;
}) {
  const className = `btn ${primary ? 'btn-primary' : 'btn-quiet'}`;
  const style = expand ? { width: '100%' } : undefined;
  return (
    <button className={className} style={style} onClick={onClick} disabled={disabled}>
      {icon && <span>{icon}</span>}
      {children}
    </button>
  );
}

export function StateMessage({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: React.ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="state-message">
      <p className="headline" style={{ marginBottom: 'var(--space-sm)', color: 'var(--fg)' }}>{title}</p>
      <p className="body" style={{ marginBottom: 'var(--space-md)' }}>{body}</p>
      {action && <QuietButton primary onClick={onAction}>{action}</QuietButton>}
    </div>
  );
}

export function LoadingLine({ label }: { label?: string }) {
  return (
    <div style={{ padding: 'var(--space-xl) 0', textAlign: 'center', color: 'var(--muted)' }}>
      <p className="body-small">{label ?? 'Loading'}…</p>
    </div>
  );
}

export function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="progress-bar">
      <i style={{ width: value == null ? '100%' : `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function CoverArt({ book, width, imageUrl }: { book: Book; width?: number | string; imageUrl: string | null }) {
  const style: React.CSSProperties = { width: width ?? '100%' };
  return (
    <div className="cover" style={style}>
      {imageUrl ? (
        <img src={imageUrl} alt={`Cover of ${book.title}`} onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      ) : (
        <div className="cover-placeholder">
          <span>{book.title.slice(0, 2).toUpperCase()}</span>
        </div>
      )}
    </div>
  );
}

function progressPercent(p?: ReadingProgress) {
  return p == null ? null : p.totalProgression;
}

export function BookGridItem({
  book,
  entry,
  coverUrl,
  onClick,
}: {
  book: Book;
  entry?: LibraryEntry;
  coverUrl: string | null;
  onClick: () => void;
}) {
  const pct = progressPercent(entry?.progress);
  let status: React.ReactNode;
  if (entry?.downloaded) {
    if (pct == null) status = <span className="label-small">Downloaded</span>;
    else if (pct >= 0.995) status = <span className="label-small" style={{ color: 'var(--green)' }}>Finished</span>;
    else status = <ProgressBar value={pct} />;
  } else {
    status = <span className="label-small">Not downloaded</span>;
  }
  return (
    <div onClick={onClick} style={{ cursor: 'pointer' }}>
      <CoverArt book={book} imageUrl={coverUrl} />
      <div style={{ marginTop: 'var(--space-sm)' }}>
        <p className="title" style={{ marginBottom: 2 }}>{book.title}</p>
        <p className="body-small" style={{ marginBottom: 6 }}>{book.author}</p>
        {status}
      </div>
    </div>
  );
}

export function BookListItem({
  book,
  entry,
  coverUrl,
  onClick,
}: {
  book: Book;
  entry?: LibraryEntry;
  coverUrl: string | null;
  onClick: () => void;
}) {
  return (
    <div className="list-item" onClick={onClick}>
      <div style={{ width: 40, flexShrink: 0 }}>
        <CoverArt book={book} width={40} imageUrl={coverUrl} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="title" style={{ marginBottom: 2 }}>{book.title}</p>
        <p className="body-small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {[book.author, book.subjects[0], formatBytes(book.fileSize)].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div style={{ flexShrink: 0 }}>
        {entry?.downloaded ? (
          <span style={{ color: 'var(--green)' }}>✓</span>
        ) : (
          <span style={{ color: 'var(--subtle)' }}>›</span>
        )}
      </div>
    </div>
  );
}

export function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`chip ${selected ? 'active' : ''}`} onClick={onClick}>
      {label}
    </button>
  );
}

export function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="btn btn-quiet btn-sm" style={{ marginBottom: 'var(--space-md)' }}>
      ← Back
    </Link>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
