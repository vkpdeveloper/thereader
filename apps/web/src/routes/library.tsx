import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CoverArt } from '../components/CoverArt';
import { IconButton } from '../components/buttons';
import {
  ArrowDownwardIcon,
  ChevronRightIcon,
  CloseIcon,
  DeleteOutlineIcon,
  InfoOutlineIcon,
  MenuBookIcon,
  MoreHorizIcon,
  UploadIcon,
} from '../components/icons';
import { ContextMenu, menuPoint, useContextMenu, type MenuItem, type MenuPoint } from '../components/overlay';
import { canRemove, removeLabel, useRemoveBook } from '../components/RemoveBook';
import { Eyebrow, LoadingLine, ProgressLine, ProgressRing, ScreenHeader, StateMessage, Tag } from '../components/states';
import { useToast } from '../components/toast';
import { importAccept } from '../lib/import/contract';
import { bookLink, readLink, useDocumentTitle, useElementWidth, useStorageInfo, whenIdle } from '../lib/hooks';
import { loadBook, loadReader } from './lazy';
import { downloadFraction, entryPercent, formatBytes, isDownloadActive, isDownloadReady } from '../lib/format';
import type { AppServices } from '../lib/services/contract';
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
  const menu = useContextMenu();
  const removal = useRemoveBook();
  const { info: storage } = useStorageInfo();
  const importingRef = useRef(false);

  /** Local copy, then straight to the book page; the upload is queued, not awaited. */
  const importFiles = async (files: File[]) => {
    if (importingRef.current || files.length === 0) return;
    importingRef.current = true;
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
    importingRef.current = false;
    setImporting(false);
    if (imported === 1 && last) void navigate(bookLink(last));
    else if (imported > 1) toast.show(`Imported ${imported} books.`);
  };
  const importLatest = useRef(importFiles);
  importLatest.current = importFiles;

  // Opening a book should not wait for its screen's code.
  useEffect(
    () =>
      whenIdle(() => {
        void loadReader();
        void loadBook();
      }),
    [],
  );

  // Drag and drop anywhere on the Library. Listeners are registered once.
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
      void importLatest.current(books);
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
  }, [toast]);

  // Stable across renders so memoised tiles don't re-render for unrelated changes.
  const showMenu = menu.show;
  const askRemove = removal.ask;
  const openMenu = useCallback(
    (entry: LibraryEntry, at: MenuPoint) => {
      showMenu({ ...at, label: entry.book.title, items: entryActions(services, entry, navigate, askRemove) });
    },
    [services, navigate, showMenu, askRemove],
  );

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
  // Mobile tags a store that may lose books ("Session only"); here that is
  // browser storage without the persistence grant, once something is saved.
  const atRisk = storage != null && !storage.persisted && storage.bookCount > 0;

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
            <div className="filter-links" role="group" aria-label="Filter books">
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  className={filter === f.id ? 'filter-link is-selected' : 'filter-link'}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="library-meta">
              {atRisk && (
                <Link
                  to="/settings"
                  hash="storage"
                  className="library-storage-tag"
                  title="The browser may clear downloads when space runs low. Keep them from Settings."
                >
                  <Tag color="var(--orange)">May be cleared</Tag>
                </Link>
              )}
              <span className="t-label-sm library-count tabular" aria-label={`${shown.length} ${shown.length === 1 ? 'book' : 'books'}`}>
                {shown.length}
              </span>
            </div>
          </div>
          <hr className="divider" />
          {shown.length === 0 ? <StateMessage title="No books match." body="Try another filter." /> : null}
          <div
            ref={grid}
            className="library-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            hidden={shown.length === 0}
          >
            {shown.map((entry) => (
              <GridItem key={entry.id} entry={entry} readable={services.library.canRead(entry.id)} onMenu={openMenu} />
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
      <ContextMenu request={menu.request} onClose={menu.close} />
      {removal.dialog}
    </div>
  );
}

/** Actions for a library book: the same ones its tile and book page offer. */
function entryActions(
  services: AppServices,
  entry: LibraryEntry,
  navigate: ReturnType<typeof useNavigate>,
  askRemove: (entry: LibraryEntry) => void,
): MenuItem[] {
  const d = entry.download;
  const items: MenuItem[] = [];
  if (services.library.canRead(entry.id)) {
    items.push({
      label: entry.progress == null ? 'Read' : 'Continue reading',
      icon: MenuBookIcon,
      onSelect: () => void navigate(readLink(entry)),
    });
  }
  items.push({ label: 'Book details', icon: InfoOutlineIcon, onSelect: () => void navigate(bookLink(entry)) });
  if (isDownloadActive(d)) {
    if (d.status !== 'verifying') {
      items.push({ label: 'Cancel download', icon: CloseIcon, onSelect: () => services.library.cancelDownload(entry.id) });
    }
  } else if (!isDownloadReady(d)) {
    items.push({
      label: d.status === 'failed' ? 'Try download again' : `Download · ${formatBytes(entry.book.fileSize)}`,
      icon: ArrowDownwardIcon,
      onSelect: () => void services.library.downloadEntry(entry.id),
    });
  }
  if (canRemove(services, entry)) {
    items.push({ label: `${removeLabel}…`, icon: DeleteOutlineIcon, danger: true, separated: true, onSelect: () => askRemove(entry) });
  }
  return items;
}

/** The single in-progress feature: cover, title, chapter, a thin progress line. */
function ContinueReading({ entry }: { entry: LibraryEntry }) {
  const percent = entryPercent(entry) ?? 0;
  const chapter = entry.progress?.locator.title;
  return (
    <section className="continue" aria-labelledby="continue-eyebrow">
      <Eyebrow id="continue-eyebrow">Continue reading</Eyebrow>
      <Link {...readLink(entry)} className="continue-card" aria-label={`Continue reading ${entry.book.title}`}>
        <CoverArt book={entry.book} origin={entry.origin} width={64} />
        <div className="continue-text">
          <div className="t-headline clamp-2">{entry.book.title}</div>
          <div className="t-body-sm clamp-1">{chapter ? `${entry.book.author} · ${chapter}` : entry.book.author}</div>
          <div className="continue-progress">
            <ProgressLine value={percent} label="Reading progress" />
            <span className="t-label-sm tabular">{Math.round(percent * 100)}%</span>
          </div>
        </div>
        <ChevronRightIcon size={18} className="continue-chevron" />
      </Link>
    </section>
  );
}

const longPressMs = 500;

const GridItem = memo(function GridItem({
  entry,
  readable,
  onMenu,
}: {
  entry: LibraryEntry;
  /** From the parent: early reading can start without the entry changing. */
  readable: boolean;
  onMenu: (entry: LibraryEntry, at: MenuPoint) => void;
}) {
  const navigate = useNavigate();
  const d = entry.download;
  const percent = entryPercent(entry);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const lastPointer = useRef<string>('mouse');

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

  // Touch keeps the mobile gesture: long-press opens the book page.
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType !== 'touch') return;
    cancelPress();
    const state = { x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    state.timer = window.setTimeout(() => {
      state.fired = true;
      void navigate(bookLink(entry));
    }, longPressMs);
    press.current = state;
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    // The long-press already navigated; swallow the click that ends it.
    if (press.current?.fired) {
      e.preventDefault();
      e.stopPropagation();
    }
    press.current = null;
  };
  // Mouse, pen and the keyboard menu key get the context menu.
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (lastPointer.current === 'touch') return;
    onMenu(entry, menuPoint(e));
  };

  const label = `${entry.book.title} by ${entry.book.author}`;
  return (
    <div
      className="grid-item"
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={onClickCapture}
    >
      <Link {...(readable ? readLink(entry) : bookLink(entry))} className="grid-link" aria-label={label}>
        <div className="grid-cover">
          <CoverArt book={entry.book} origin={entry.origin} />
        </div>
        <div className="grid-title t-title-sm clamp-2">{entry.book.title}</div>
        <div className="grid-author t-body-sm clamp-1">{entry.book.author}</div>
        <div className="grid-status-slot">{status}</div>
      </Link>
      <IconButton
        className="grid-more"
        icon={MoreHorizIcon}
        label="Book actions"
        aria-haspopup="menu"
        size={18}
        tooltipSide="left"
        onClick={(e) => onMenu(entry, menuPoint(e, 'below'))}
      />
    </div>
  );
});
