import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton, QuietButton } from '../components/buttons';
import { ArrowBackIcon, ArrowDownwardIcon, CheckIcon, CloseIcon, DeleteOutlineIcon } from '../components/icons';
import { hasOpenOverlay } from '../components/overlay';
import { canRemove, removeLabel, useRemoveBook } from '../components/RemoveBook';
import { RichText } from '../components/RichText';
import { Eyebrow, LoadingLine, ProgressLine, StateMessage, Tag } from '../components/states';
import { downloadFraction, emptyDownload, formatBytes, formatDate, isDownloadReady } from '../lib/format';
import { isTypingTarget, readLink, useDocumentTitle, useGoBack } from '../lib/hooks';
import { fetchBook, RemoteError } from '../lib/remote';
import { useServices, useStore } from '../lib/services/react';
import type { Book, LibraryEntry } from '../lib/types';

// The reader route imports this from here; it now lives with the other hooks.
export { useGoBack } from '../lib/hooks';

/**
 * Book page: description, edition facts and one honest download control.
 * Removing a book lives in the top bar, away from the reading action, and
 * always asks first.
 */
export function BookScreen() {
  const { id } = useParams({ from: '/book/$id' });
  const { entry: entryParam } = useSearch({ from: '/book/$id' });
  const services = useServices();
  const lib = useStore(services.library);
  const catalog = useStore(services.catalog);
  useStore(services.settings);
  // Observed only so Remove can tell whether an upload is at stake.
  useStore(services.imports);
  const origin = services.settings.currentOrigin();
  const goBack = useGoBack();

  // Escape leaves the page (the app bar's back button), unless a dialog or field has it.
  const goBackLatest = useRef(goBack);
  goBackLatest.current = goBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || hasOpenOverlay() || isTypingTarget(e.target)) return;
      goBackLatest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pinned = entryParam ? lib.entries.find((e) => e.id === entryParam) : undefined;
  const catalogBook = catalog.origin === origin ? catalog.items.find((b) => b.id === id) : undefined;
  const byOrigin = lib.entries.find((e) => e.book.id === id && e.origin === origin);

  const [fetched, setFetched] = useState<{ book: Book | null; error: RemoteError | null; loading: boolean }>({
    book: null,
    error: null,
    loading: false,
  });
  const [attempt, setAttempt] = useState(0);
  const needsFetch = lib.loaded && !pinned && !catalogBook && !byOrigin;

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    setFetched({ book: null, error: null, loading: true });
    fetchBook(origin, id).then(
      (book) => !cancelled && setFetched({ book, error: null, loading: false }),
      (error) =>
        !cancelled &&
        setFetched({ book: null, error: error instanceof RemoteError ? error : new RemoteError(String(error), true), loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [needsFetch, origin, id, attempt]);

  // Mobile passes the entry's own book from Library (never "outdated") and
  // the catalog's latest edition from Browse.
  const resolved = pinned?.book ?? catalogBook ?? byOrigin?.book ?? fetched.book ?? null;
  const lastKnown = useRef<Book | null>(null);
  if (resolved) lastKnown.current = resolved;
  const book = resolved ?? (lastKnown.current?.id === id ? lastKnown.current : null);
  const entry: LibraryEntry | undefined = pinned ?? (book ? services.library.entryFor(book) : undefined);
  useDocumentTitle(book?.title ?? 'Book');

  const topBar = (trailing?: ReactNode) => (
    <div className="book-topbar">
      <IconButton icon={ArrowBackIcon} label="Back" tooltipSide="bottom" onClick={goBack} />
      <div className="book-topbar-trailing">{trailing}</div>
    </div>
  );

  if (!book) {
    return (
      <div className="book-page">
        {topBar()}
        <div className="book-layout is-single">
          {fetched.error ? (
            <StateMessage
              title={fetched.error.status === 404 ? 'This book is not in the catalog.' : "Couldn't load this book."}
              body={`${fetched.error.message}\n${origin}`}
              error
              actionLabel="Try again"
              onAction={() => setAttempt((a) => a + 1)}
            />
          ) : (
            <LoadingLine label="Loading" />
          )}
        </div>
      </div>
    );
  }

  return <BookDetail book={book} entry={entry} topBar={topBar} />;
}

function BookDetail({
  book,
  entry,
  topBar,
}: {
  book: Book;
  entry: LibraryEntry | undefined;
  topBar: (trailing?: ReactNode) => ReactNode;
}) {
  const services = useServices();
  const removal = useRemoveBook();
  const current = entry?.book ?? book;
  const d = entry?.download ?? emptyDownload;
  const origin = entry?.origin ?? services.settings.currentOrigin();
  const outdated = entry != null && entry.book.sha256 !== book.sha256 && isDownloadReady(d);

  return (
    <div className="book-page">
      {topBar(
        canRemove(services, entry) ? (
          <IconButton icon={DeleteOutlineIcon} label={removeLabel} tone="muted" tooltipSide="left" onClick={() => removal.ask(entry)} />
        ) : null,
      )}
      <article className="book-layout">
        <div className="book-cover">
          <CoverArt book={current} origin={origin} />
        </div>
        <div className="book-main">
          <h1 className="t-display-sm book-title">{current.title}</h1>
          <p className="t-body-lg book-author">{current.author}</p>
          <div className="tag-row">
            {current.subjects.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
            {current.language && <Tag>{current.language.toUpperCase()}</Tag>}
            <Tag>{formatBytes(current.fileSize)}</Tag>
          </div>
          <DownloadPanel book={book} entry={entry} outdated={outdated} />
          {current.description && (
            <section className="book-section">
              <Eyebrow as="h2">About</Eyebrow>
              <RichText className="book-description" source={current.description} />
            </section>
          )}
          <section className="book-section">
            <Eyebrow as="h2">Edition</Eyebrow>
            <dl className="facts">
              <dt>Version</dt>
              <dd>{current.version}</dd>
              <dt>Updated</dt>
              <dd>{formatDate(current.updatedAt)}</dd>
            </dl>
          </section>
        </div>
      </article>
      {removal.dialog}
    </div>
  );
}

function DownloadPanel({ book, entry, outdated }: { book: Book; entry: LibraryEntry | undefined; outdated: boolean }) {
  const services = useServices();
  const navigate = useNavigate();
  const d = entry?.download ?? emptyDownload;
  const lib = services.library;
  const read = () => entry && void navigate(readLink(entry));
  // An existing entry re-downloads from its own origin (mobile `sourceForEntry`);
  // `book` is the edition to fetch, newer than the entry's when outdated.
  const download = () => void (entry ? lib.downloadEntry(entry.id, book) : lib.download(book));
  const readLabel = entry?.progress == null ? 'Read' : 'Continue reading';

  let inner;
  switch (d.status) {
    case 'queued':
    case 'downloading':
    case 'verifying': {
      const label =
        d.status === 'verifying'
          ? 'Verifying SHA-256'
          : d.status === 'queued'
            ? 'Connecting'
            : `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes ?? book.fileSize)}`;
      // Readable once the opening slice is cached; "downloaded" waits for verification.
      const readable = entry != null && lib.canRead(entry.id);
      inner = (
        <>
          <div className="download-row">
            <span className="t-body" aria-live="polite">
              {label}
            </span>
            {d.status !== 'verifying' && entry && (
              <IconButton icon={CloseIcon} label="Cancel download" tooltipSide="left" onClick={() => lib.cancelDownload(entry.id)} />
            )}
          </div>
          <ProgressLine value={d.status === 'verifying' ? null : downloadFraction(d)} label="Download progress" />
          {readable && <QuietButton className="download-primary" label={readLabel} emphasis expand onClick={read} />}
        </>
      );
      break;
    }
    case 'ready':
      inner = (
        <>
          <div className="download-status">
            <CheckIcon size={16} className="download-check" />
            <span className={outdated ? 't-body-sm is-warn' : 't-body-sm'}>
              {d.error ?? (outdated ? 'Downloaded (an older edition).' : 'Saved and verified.')}
            </span>
          </div>
          <div className="download-actions">
            <QuietButton label={readLabel} emphasis expand onClick={read} />
            {outdated && <QuietButton label="Update" onClick={download} />}
          </div>
        </>
      );
      break;
    case 'failed':
      inner = (
        <>
          <p className="t-body is-error">{d.error ?? 'Download failed.'}</p>
          <QuietButton className="download-primary" label="Try again" emphasis expand onClick={download} />
        </>
      );
      break;
    default:
      inner = (
        <>
          <p className="t-body-sm">Saved offline and checksum-verified.</p>
          <QuietButton
            className="download-primary"
            label={`Download · ${formatBytes(book.fileSize)}`}
            icon={ArrowDownwardIcon}
            emphasis
            expand
            onClick={download}
          />
        </>
      );
  }

  return <div className="download-panel">{inner}</div>;
}
