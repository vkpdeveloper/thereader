import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton, QuietButton } from '../components/buttons';
import { ArrowBackIcon, ArrowDownwardIcon, CheckIcon, CloseIcon, DeleteOutlineIcon } from '../components/icons';
import { ConfirmDialog } from '../components/overlay';
import { Eyebrow, LoadingLine, ProgressLine, StateMessage, Tag } from '../components/states';
import { downloadFraction, emptyDownload, formatBytes, formatDate, isDownloadActive, isDownloadReady } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { fetchBook, RemoteError } from '../lib/remote';
import { useServices, useStore } from '../lib/services/react';
import type { Book, LibraryEntry } from '../lib/types';

/** Back to wherever the user came from, or Library for a fresh deep link. */
export function useGoBack(fallback: '/library' | '/browse' = '/library') {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: fallback, replace: true });
  };
}

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
  const [confirming, setConfirming] = useState(false);
  const current = entry?.book ?? book;
  const d = entry?.download ?? emptyDownload;
  const origin = entry?.origin ?? services.settings.currentOrigin();
  const outdated = entry != null && entry.book.sha256 !== book.sha256 && isDownloadReady(d);
  // Removing a cloud download keeps its synced metadata; a cloud-only entry has nothing local to remove.
  const removable = entry != null && !isDownloadActive(d) && (d.status !== 'none' || services.imports.isPending(entry.id));

  const uploadPhase = !entry
    ? 'none'
    : services.imports.isUploading(entry.id)
      ? 'uploading'
      : services.imports.errorFor(entry.id) != null
        ? 'failed'
        : services.imports.isPending(entry.id)
          ? 'pending'
          : 'none';
  const keepMetadata = uploadPhase === 'none';
  const uploadNote =
    uploadPhase === 'uploading'
      ? ' The upload in progress will be cancelled.'
      : uploadPhase === 'none'
        ? ''
        : ' The waiting upload will be cancelled, so this book will not reach your other devices.';

  const remove = async () => {
    if (!entry) return;
    setConfirming(false);
    // Abort the upload before the bytes disappear; ids never queued are fine.
    await services.imports.cancelPending(entry.id);
    await services.library.remove(entry.id, { keepMetadata });
  };

  return (
    <div className="book-page">
      {topBar(
        removable ? (
          <IconButton icon={DeleteOutlineIcon} label="Remove download" tone="muted" tooltipSide="left" onClick={() => setConfirming(true)} />
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
              <p className="book-description">{current.description}</p>
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
      <ConfirmDialog
        open={confirming}
        title={isDownloadReady(d) || keepMetadata ? 'Remove download?' : 'Remove from library?'}
        body={
          (keepMetadata
            ? 'The file will be removed from this device. Your cloud book, reading position and reading time stay available.'
            : isDownloadReady(d)
              ? 'The file and your reading position for this book will be deleted from this device.'
              : 'This book and its reading position will be removed from your library. You can download it again from Browse.') +
          uploadNote
        }
        cancelLabel="Keep"
        confirmLabel="Remove"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function DownloadPanel({ book, entry, outdated }: { book: Book; entry: LibraryEntry | undefined; outdated: boolean }) {
  const services = useServices();
  const navigate = useNavigate();
  const d = entry?.download ?? emptyDownload;
  const lib = services.library;
  const read = () => entry && void navigate({ to: '/read/$entryId', params: { entryId: entry.id } });
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
            {outdated && <QuietButton label="Update" onClick={() => void lib.download(book)} />}
          </div>
        </>
      );
      break;
    case 'failed':
      inner = (
        <>
          <p className="t-body is-error">{d.error ?? 'Download failed.'}</p>
          <QuietButton className="download-primary" label="Try again" emphasis expand onClick={() => void lib.download(book)} />
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
            onClick={() => void lib.download(book)}
          />
        </>
      );
  }

  return <div className="download-panel">{inner}</div>;
}
