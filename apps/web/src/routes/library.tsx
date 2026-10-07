import { memo, useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { AddArticleDialog } from '../components/AddArticleDialog';
import { BookcaseTile } from '../components/categories/Bookcase';
import { categoryActions, useDeleteCategory } from '../components/categories/categoryActions';
import { useCategoryDialog } from '../components/categories/CategoryDialog';
import { articleRef, bookRef, droppedItem, startItemDrag, useCategoryContents } from '../components/categories/model';
import type { Category } from '../lib/categories';
import { ArticleRow, ArticleThumb } from '../components/ArticleRow';
import { CoverArt } from '../components/CoverArt';
import { IconButton, QuietButton } from '../components/buttons';
import {
  AddIcon,
  ArrowDownwardIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DeleteOutlineIcon,
  InfoOutlineIcon,
  MenuBookIcon,
  MoreHorizIcon,
  OpenInNewIcon,
  UploadIcon,
} from '../components/icons';
import { ContextMenu, hasOpenOverlay, menuPoint, useContextMenu, type MenuItem, type MenuPoint } from '../components/overlay';
import { useRemoveArticle } from '../components/RemoveArticle';
import { canRemove, removeLabel, useRemoveBook } from '../components/RemoveBook';
import { Eyebrow, LoadingLine, ProgressLine, ProgressRing, ScreenHeader, StateMessage, Tag } from '../components/states';
import { useToast } from '../components/toast';
import { importAccept } from '../lib/import/contract';
import {
  articleLink,
  bookLink,
  isTypingTarget,
  readLink,
  useDocumentTitle,
  useElementWidth,
  useStorageInfo,
  whenIdle,
} from '../lib/hooks';
import { findArticleUrl } from '../lib/services/articles';
import { loadArticle, loadBook, loadReader } from './lazy';
import { downloadFraction, entryPercent, formatBytes, isDownloadActive, isDownloadReady } from '../lib/format';
import type { AppServices } from '../lib/services/contract';
import { useServices, useStore } from '../lib/services/react';
import type { ArticleSummary, LibraryEntry } from '../lib/types';


type Filter = 'all' | 'downloaded' | 'inProgress' | 'articles';

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'downloaded', label: 'Downloaded' },
  { id: 'inProgress', label: 'In progress' },
  { id: 'articles', label: 'Articles' },
];

const isUnfinished = (fraction: number | null) => (fraction ?? 0) < 0.995;

const importExtensions = /\.(epub|mobi|azw3?|prc)$/i;

/** Mobile breakpoints (2/3/4/5 by width) measured on the content column, plus 6 on wide desktops. */
export function columnsFor(width: number): number {
  if (width >= 1100) return 6;
  if (width >= 860) return 5;
  if (width >= 560) return 4;
  if (width >= 380) return 3;
  return 2;
}

/**
 * Home: an editorial title, one continue-reading entry, then a cover-led grid
 * of everything you have and the articles saved from links. Works fully
 * offline. Files can be imported with the button or dropped anywhere on the
 * page; a link pasted anywhere opens the add-article dialog.
 */
export function LibraryScreen() {
  useDocumentTitle('Library');
  const services = useServices();
  const lib = useStore(services.library);
  const articles = useStore(services.articles);
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [grid, gridWidth] = useElementWidth<HTMLDivElement>();
  const menu = useContextMenu();
  const removal = useRemoveBook();
  const articleRemoval = useRemoveArticle();
  const [addArticle, setAddArticle] = useState<{ open: boolean; url: string }>({ open: false, url: '' });
  const { info: storage } = useStorageInfo();
  const importingRef = useRef(false);
  const contents = useCategoryContents();
  const filing = useCategoryDialog();
  const deletion = useDeleteCategory();

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

  // Opening a book or article should not wait for its screen's code.
  const hasArticles = articles.items.length > 0;
  useEffect(
    () =>
      whenIdle(() => {
        void loadReader();
        void loadBook();
        if (hasArticles) void loadArticle();
      }),
    [hasArticles],
  );

  // A link pasted anywhere on the Library (outside text fields) opens the add dialog with it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (hasOpenOverlay() || isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const url = findArticleUrl(e.clipboardData?.getData('text/uri-list') || e.clipboardData?.getData('text/plain') || '');
      if (!url) return;
      e.preventDefault();
      setAddArticle({ open: true, url });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

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
  const fileMenu = filing.menuItems;
  const openMenu = useCallback(
    (entry: LibraryEntry, at: MenuPoint) => {
      const filingItems = fileMenu({ ...bookRef(entry), title: entry.book.title });
      showMenu({ ...at, label: entry.book.title, items: entryActions(services, entry, navigate, askRemove, filingItems) });
    },
    [services, navigate, showMenu, askRemove, fileMenu],
  );
  const askRemoveArticle = articleRemoval.ask;
  const openArticleMenu = useCallback(
    (article: ArticleSummary, at: MenuPoint) => {
      const filingItems = fileMenu({ ...articleRef(article), title: article.title });
      showMenu({ ...at, label: article.title, items: articleActions(article, navigate, askRemoveArticle, toast.show, filingItems) });
    },
    [navigate, showMenu, askRemoveArticle, toast.show, fileMenu],
  );
  const openCategoryMenu = (category: Category, e: ReactMouseEvent) =>
    showMenu({
      ...menuPoint(e),
      label: category.name,
      items: categoryActions(category, {
        open: () => void navigate({ to: '/library/category/$id', params: { id: category.id } }),
        edit: filing.edit,
        askDelete: deletion.ask,
      }),
    });
  const dropOnCategory = (category: Category, e: ReactDragEvent) => {
    const item = droppedItem(e);
    if (item) void filing.file(item, category.id);
  };
  const openAddArticle = () => setAddArticle({ open: true, url: '' });

  const header = (
    <ScreenHeader
      title="Library"
      trailing={
        importing ? (
          <span className="icon-slot" role="status" aria-label="Importing book">
            <ProgressRing value={null} size={20} label="Importing book" />
          </span>
        ) : (
          <div className="library-actions">
            <IconButton icon={AddIcon} label="Add article from link" onClick={openAddArticle} />
            <IconButton icon={UploadIcon} label="Import EPUB or MOBI" tooltipSide="left" onClick={() => picker.current?.click()} />
          </div>
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

  const addDialog = (
    <AddArticleDialog open={addArticle.open} initialUrl={addArticle.url} onClose={() => setAddArticle((a) => ({ ...a, open: false }))} />
  );

  if (!lib.loaded) {
    return (
      <div className="page-wide">
        {header}
        <LoadingLine />
        {addDialog}
      </div>
    );
  }

  const everything = [...lib.entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  // Filed items live in their category; the home shows the rest.
  const all = everything.filter((e) => !contents.isFiled(bookRef(e)));
  const looseArticles = articles.items.filter((a) => !contents.isFiled(articleRef(a)));
  const book = lib.continueReading[0];
  const article = articles.items
    .filter((a) => a.lastOpenedAt != null && isUnfinished(a.progress))
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))[0];
  const continueArticle = article && (!book || (article.lastOpenedAt ?? '') > (book.lastOpenedAt ?? '')) ? article : null;
  const shown =
    filter === 'all'
      ? all
      : filter === 'downloaded'
        ? all.filter((e) => isDownloadReady(e.download))
        : filter === 'inProgress'
          ? all.filter((e) => e.progress != null && isUnfinished(entryPercent(e)))
          : [];
  const shownArticles =
    filter === 'all' || filter === 'articles'
      ? looseArticles
      : filter === 'inProgress'
        ? looseArticles.filter((a) => a.lastOpenedAt != null && isUnfinished(a.progress))
        : [];
  const shownCount = shown.length + shownArticles.length;
  const countNoun = filter === 'articles' ? (shownCount === 1 ? 'article' : 'articles') : shownCount === 1 ? 'item' : 'items';
  const columns = columnsFor(gridWidth || 360);
  // Mobile tags a store that may lose books ("Session only"); here that is
  // browser storage without the persistence grant, once something is saved.
  const atRisk = storage != null && !storage.persisted && storage.bookCount > 0;

  return (
    <div className="page-wide library">
      {input}
      {header}
      {everything.length === 0 && articles.items.length === 0 ? (
        <StateMessage
          title="Nothing here yet."
          body="Browse the library and download a book, import an EPUB or MOBI with the upload button, or save any article from a link with the plus button. You can also drop a book file or paste a link onto this page. Everything is kept on this device for offline reading."
          actionLabel="Browse books"
          onAction={() => void navigate({ to: '/browse' })}
          secondary={<QuietButton label="Add article from link" icon={AddIcon} onClick={openAddArticle} />}
        />
      ) : (
        <>
          {continueArticle ? <ContinueArticle article={continueArticle} /> : book && <ContinueReading entry={book} />}
          {contents.categories.length > 0 && (
            <section className="library-categories" aria-labelledby="categories-eyebrow">
              <div className="library-categories-head">
                <Eyebrow as="h2" id="categories-eyebrow">
                  Categories
                </Eyebrow>
                <button type="button" className="library-categories-new" onClick={filing.create}>
                  <AddIcon size={14} />
                  New category
                </button>
              </div>
              <div className="bookcases">
                {contents.categories.map((c) => (
                  <BookcaseTile
                    key={c.id}
                    category={c}
                    items={contents.items.get(c.id) ?? []}
                    onMenu={openCategoryMenu}
                    onDropItem={dropOnCategory}
                  />
                ))}
              </div>
            </section>
          )}
          <div className="library-filters">
            <div className="filter-links" role="group" aria-label="Filter library">
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
              <span className="t-label-sm library-count tabular" aria-label={`${shownCount} ${countNoun}`}>
                {shownCount}
              </span>
            </div>
          </div>
          <hr className="divider" />
          {shownCount === 0 ? (
            filter === 'articles' ? (
              <StateMessage
                title="No articles yet."
                body="Save any article from its link with the plus button, or paste a link anywhere on this page."
                actionLabel="Add article from link"
                onAction={openAddArticle}
              />
            ) : filter === 'all' ? (
              <StateMessage
                title="Everything is filed."
                body="All your books and articles are in categories. New downloads, imports and saved articles show up here."
              />
            ) : (
              <StateMessage title="Nothing matches." body="Try another filter." />
            )
          ) : null}
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
          {shownArticles.length > 0 && (
            <section className="library-articles" aria-label="Articles">
              {shown.length > 0 && <Eyebrow as="h2">Articles</Eyebrow>}
              <ul className="article-list">
                {shownArticles.map((a) => (
                  <ArticleRow key={a.id} article={a} onMenu={openArticleMenu} />
                ))}
              </ul>
            </section>
          )}
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
      {articleRemoval.dialog}
      {filing.dialog}
      {deletion.dialog}
      {addDialog}
    </div>
  );
}

/** Actions for a saved article (context menu, long press and its ⋯ button). */
export function articleActions(
  article: ArticleSummary,
  navigate: ReturnType<typeof useNavigate>,
  askRemove: (article: ArticleSummary) => void,
  notify: (message: string) => void,
  filing: MenuItem[] = [],
): MenuItem[] {
  return [
    {
      label: article.progress == null ? 'Read' : 'Continue reading',
      icon: MenuBookIcon,
      onSelect: () => void navigate(articleLink(article)),
    },
    {
      label: 'Open original',
      icon: OpenInNewIcon,
      onSelect: () => {
        window.open(article.url, '_blank', 'noopener,noreferrer');
      },
    },
    {
      label: 'Copy link',
      icon: CopyIcon,
      onSelect: () =>
        void navigator.clipboard.writeText(article.url).then(
          () => notify('Link copied.'),
          () => notify("Couldn't copy the link."),
        ),
    },
    ...filing.map((item, i) => (i === 0 ? { ...item, separated: true } : item)),
    { label: 'Remove article…', icon: DeleteOutlineIcon, danger: true, separated: true, onSelect: () => askRemove(article) },
  ];
}

/** Actions for a library book: the same ones its tile and book page offer. */
export function entryActions(
  services: AppServices,
  entry: LibraryEntry,
  navigate: ReturnType<typeof useNavigate>,
  askRemove: (entry: LibraryEntry) => void,
  filing: MenuItem[] = [],
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
  items.push(...filing.map((item, i) => (i === 0 ? { ...item, separated: true } : item)));
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

/** The most recently opened unfinished article, in the same place and shape as a book. */
function ContinueArticle({ article }: { article: ArticleSummary }) {
  return (
    <section className="continue" aria-labelledby="continue-eyebrow">
      <Eyebrow id="continue-eyebrow">Continue reading</Eyebrow>
      <Link {...articleLink(article)} className="continue-card" aria-label={`Continue reading ${article.title}`}>
        <ArticleThumb article={article} shape="cover" />
        <div className="continue-text">
          <div className="t-headline clamp-2">{article.title}</div>
          <div className="t-body-sm clamp-1">{article.byline ? `${article.siteName} · ${article.byline}` : article.siteName}</div>
          <div className="continue-progress">
            <ProgressLine value={article.progress ?? 0} label="Reading progress" />
            <span className="t-label-sm tabular">{Math.round((article.progress ?? 0) * 100)}%</span>
          </div>
        </div>
        <ChevronRightIcon size={18} className="continue-chevron" />
      </Link>
    </section>
  );
}

const longPressMs = 500;

export const GridItem = memo(function GridItem({
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
      onDragStart={(e) => startItemDrag(e, { ...bookRef(entry), title: entry.book.title })}
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
