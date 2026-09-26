import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton } from '../components/buttons';
import { ChevronRightIcon, MoreHorizIcon, UploadIcon } from '../components/icons';
import { Eyebrow, LoadingLine, ProgressLine, ProgressRing, ScreenHeader, StateMessage } from '../components/states';
import { useToast } from '../components/toast';
import { importAccept } from '../lib/import/contract';
import { useDocumentTitle, useElementWidth } from '../lib/hooks';
import { downloadFraction, entryPercent, isDownloadActive, isDownloadReady } from '../lib/format';
import { useServices, useStore } from '../lib/services/react';
import type { LibraryEntry } from '../lib/types';

type Filter = 'all' | 'downloaded' | 'inProgress';

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'downloaded', label: 'Downloaded' },
  { id: 'inProgress', label: 'In progress' },
];

const importExtensions = /\.(epub|mobi|azw3?|prc)$/i;

/** Mobile breakpoints (2/3/4/5 by width) measured on the content column, plus 6 on wide desktops. */
function columnsFor(width: number): number {
  if (width >= 1100) return 6;
  if (width >= 860) return 5;
  if (width >= 560) return 4;
  if (width >= 380) return 3;
  return 2;
}

/** Book page for an entry; `?entry=` keeps imported and other-origin books addressable. */
export function bookLink(entry: LibraryEntry) {
  return { to: '/book/$id' as const, params: { id: entry.book.id }, search: { entry: entry.id } };
}

/**
 * Home: an editorial title, one continue-reading entry, then a cover-led grid
 * of everything you have. Works fully offline. Files can be imported with the
 * button or dropped anywhere on the page.
 */
export function LibraryScreen() {
  useDocumentTitle('Library');
  const services = useServices();
  const lib = useStore(services.library);
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [grid, gridWidth] = useElementWidth<HTMLDivElement>();

  /** Local copy, then straight to the book page; the upload is queued, not awaited. */
  const importFiles = async (files: File[]) => {
    if (importing || files.length === 0) return;
    setImporting(true);
    let last: LibraryEntry | null = null;
    let imported = 0;
    for (const file of files) {
      try {
        last = await services.imports.importFile(file);
        imported++;
      } catch (e) {
        toast.show(`Could not import that file. ${e instanceof Error ? e.message : String(e)}`, { durationMs: 6000 });
      }
    }
    setImporting(false);
    if (imported === 1 && last) void navigate(bookLink(last));
    else if (imported > 1) toast.show(`Imported ${imported} books.`);
  };

  // Drag and drop anywhere on the Library.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const books = files.filter((f) => importExtensions.test(f.name));
      if (books.length === 0) {
        toast.show('Could not import that file. Choose an EPUB or MOBI book.');
        return;
      }
      void importFiles(books);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  });

  const header = (
    <ScreenHeader
      title="Library"
      trailing={
        importing ? (
          <span className="icon-slot" role="status" aria-label="Importing book">
            <ProgressRing value={null} size={20} label="Importing book" />
          </span>
        ) : (
          <IconButton icon={UploadIcon} label="Import EPUB or MOBI" tooltipSide="left" onClick={() => picker.current?.click()} />
        )
      }
    />
  );

  const input = (
    <input
      ref={picker}
      type="file"
      accept={importAccept}
      multiple
      hidden
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        void importFiles(files);
      }}
    />
  );

  if (!lib.loaded) {
    return (
      <div className="page-wide">
        {header}
        <LoadingLine />
      </div>
    );
  }

  const all = [...lib.entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const current = lib.continueReading[0];
  const shown =
    filter === 'all'
      ? all
      : filter === 'downloaded'
        ? all.filter((e) => isDownloadReady(e.download))
        : all.filter((e) => e.progress != null && (entryPercent(e) ?? 0) < 0.995);
  const columns = columnsFor(gridWidth || 360);

  return (
    <div className="page-wide library">
      {input}
      {header}
      {all.length === 0 ? (
        <StateMessage
          title="Nothing here yet."
          body="Browse the library and download a book, or import an EPUB or MOBI from your files with the button above. You can also drop a file onto this page. Books are kept on this device for offline reading."
          actionLabel="Browse books"
          onAction={() => void navigate({ to: '/browse' })}
        />
      ) : (
        <>
          {current && <ContinueReading entry={current} />}
          <div className="library-filters">
            <div className="filter-links" role="tablist" aria-label="Filter books">
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={filter === f.id ? 'filter-link is-selected' : 'filter-link'}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="t-label-sm library-count" aria-label={`${shown.length} books`}>
              {shown.length}
            </span>
          </div>
          <hr className="divider" />
          {shown.length === 0 ? (
            <StateMessage title="No books match." body="Try another filter." />
          ) : null}
          <div
            ref={grid}
            className="library-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            hidden={shown.length === 0}
          >
            {shown.map((entry) => (
              <GridItem key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <UploadIcon size={28} />
            <div className="t-headline">Drop to import</div>
            <div className="t-body-sm">EPUB or MOBI. The book is copied to this device first.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The single in-progress feature: cover, title, chapter, a thin progress line. */
function ContinueReading({ entry }: { entry: LibraryEntry }) {
  const percent = entryPercent(entry) ?? 0;
  const chapter = entry.progress?.locator.title;
  return (
    <section className="continue" aria-labelledby="continue-eyebrow">
      <Eyebrow id="continue-eyebrow">Continue reading</Eyebrow>
      <Link
        to="/read/$entryId"
        params={{ entryId: entry.id }}
        className="continue-card"
        aria-label={`Continue reading ${entry.book.title}`}
      >
        <CoverArt book={entry.book} origin={entry.origin} width={64} />
        <div className="continue-text">
          <div className="t-headline clamp-2">{entry.book.title}</div>
          <div className="t-body-sm clamp-1">{chapter ? `${entry.book.author} · ${chapter}` : entry.book.author}</div>
          <div className="continue-progress">
            <ProgressLine value={percent} label="Reading progress" />
            <span className="t-label-sm">{Math.round(percent * 100)}%</span>
          </div>
        </div>
        <ChevronRightIcon size={18} className="continue-chevron" />
      </Link>
    </section>
  );
}

function GridItem({ entry }: { entry: LibraryEntry }) {
  const services = useServices();
  const navigate = useNavigate();
  const d = entry.download;
  const percent = entryPercent(entry);
  const readable = services.library.canRead(entry.id);

  let status;
  if (isDownloadReady(d)) {
    status =
      percent == null ? (
        <span className="grid-status">Downloaded</span>
      ) : percent >= 0.995 ? (
        <span className="grid-status is-finished">Finished</span>
      ) : (
        <ProgressLine value={percent} label="Reading progress" />
      );
  } else if (isDownloadActive(d)) {
    status = <ProgressLine value={d.status === 'verifying' ? null : downloadFraction(d)} label="Download progress" />;
  } else if (d.status === 'failed') {
    status = <span className="grid-status is-error">Download failed</span>;
  } else {
    status = <span className="grid-status">Not downloaded</span>;
  }

  // Mobile long-press opens details; here right-click or the ⋯ button does.
  const openDetails = (e?: ReactMouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    void navigate(bookLink(entry));
  };

  const body = (
    <>
      <div className="grid-cover">
        <CoverArt book={entry.book} origin={entry.origin} />
      </div>
      <div className="grid-title t-title-sm clamp-2">{entry.book.title}</div>
      <div className="grid-author t-body-sm clamp-1">{entry.book.author}</div>
      <div className="grid-status-slot">{status}</div>
    </>
  );

  return (
    <div className="grid-item" onContextMenu={openDetails}>
      {readable ? (
        <Link to="/read/$entryId" params={{ entryId: entry.id }} className="grid-link" aria-label={`${entry.book.title} by ${entry.book.author}`}>
          {body}
        </Link>
      ) : (
        <Link {...bookLink(entry)} className="grid-link" aria-label={`${entry.book.title} by ${entry.book.author}`}>
          {body}
        </Link>
      )}
      <IconButton className="grid-more" icon={MoreHorizIcon} label="Book details" size={18} tooltipSide="left" onClick={(e) => openDetails(e)} />
    </div>
  );
}
