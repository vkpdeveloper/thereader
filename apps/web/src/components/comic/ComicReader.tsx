import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { inertProps, useCanHover, useDocumentTitle, useGoBack, useReducedMotion, useWakeLock, isTypingTarget } from '../../lib/hooks';
import { useServices, useStore } from '../../lib/services/react';
import type { BookFile } from '../../lib/services/contract';
import type { LibraryEntry, ReadingLocator } from '../../lib/types';
import { ComicBook } from '../../reader/comic/book';
import { comicKeyAction } from '../../reader/comic/keys';
import { firstPage, spreadLabel } from '../../reader/comic/layout';
import { comicLocator, pageForLocator } from '../../reader/comic/locator';
import { IconButton } from '../buttons';
import { CloseIcon, FullscreenExitIcon, FullscreenIcon } from '../icons';
import { hasOpenOverlay } from '../overlay';
import { LoadingLine, StateMessage } from '../states';
import { ComicStage, type ComicStageHandle, type ComicView } from './ComicStage';
import './comic.css';

const saveDebounceMs = 600;
const chromeHideMs = 3200;

/** "Downloading · 42%" while an early-read comic is still arriving. */
function downloadNote(entry: LibraryEntry | undefined): string | null {
  const d = entry?.download;
  if (!d || (d.status !== 'downloading' && d.status !== 'queued' && d.status !== 'verifying')) return null;
  const fraction = d.totalBytes ? d.receivedBytes / d.totalBytes : 0;
  return `Downloading · ${Math.floor(Math.min(1, fraction) * 100)}%`;
}

/**
 * The comic reader: the page stage under a minimal auto-hiding chrome (close,
 * title, page count, scrubber). Positions save through the same local
 * progress path as books, so they sync on the regular cycle; the reading
 * clock runs exactly as for books.
 */
export function ComicReader({ entryId }: { entryId: string }) {
  const services = useServices();
  const settings = useStore(services.settings);
  const lib = useStore(services.library);
  const reducedMotion = useReducedMotion();
  const canHover = useCanHover();
  const goBack = useGoBack();

  const stage = useRef<ComicStageHandle>(null);
  const session = useRef<LibraryEntry | null>(null);
  const bookRef = useRef<ComicBook | null>(null);
  const locatorRef = useRef<ReadingLocator | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const stopReading = useRef<((message: string) => void) | null>(null);

  const [opened, setOpened] = useState<{ book: ComicBook; initialPage: number; provisional: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ComicView | null>(null);
  const [chrome, setChrome] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState<boolean | null>(
    typeof document !== 'undefined' && document.fullscreenEnabled ? !!document.fullscreenElement : null,
  );

  const entry = lib.entries.find((e) => e.id === entryId) ?? session.current ?? undefined;
  useDocumentTitle(entry?.book.title ?? 'Reading');
  useWakeLock(settings.reader.keepAwake && opened != null);

  // ------------------------------------------------------------ progress

  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const loc = locatorRef.current;
    const e = session.current;
    if (loc && e) void services.library.saveProgress(e.id, loc, e.book.sha256);
  }, [services]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', saveNow);
    window.addEventListener('beforeunload', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveNow);
      window.removeEventListener('beforeunload', saveNow);
    };
  }, [saveNow]);

  const onView = useCallback(
    (v: ComicView) => {
      setView(v);
      const book = bookRef.current;
      const spread = v.spreads[v.index];
      if (!book || !spread) return;
      const page = firstPage(spread);
      if (locatorRef.current?.raw?.page === page && locatorRef.current.raw.pages === book.count) return;
      locatorRef.current = comicLocator(book.pages, page);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(saveNow, saveDebounceMs);
    },
    [saveNow],
  );

  // ------------------------------------------------------------ open / close

  useEffect(() => {
    let cancelled = false;
    let file: BookFile | null = null;
    let book: ComicBook | null = null;
    setError(null);
    setOpened(null);

    const teardown = () => {
      if (!book) return;
      window.clearTimeout(saveTimer.current);
      const loc = locatorRef.current;
      const e = session.current;
      if (loc && e) void services.library.saveProgress(e.id, loc, e.book.sha256);
      services.sync.endReading();
      book.destroy();
      book = null;
      bookRef.current = null;
    };
    stopReading.current = (message) => {
      teardown();
      file?.close();
      setOpened(null);
      setError(message);
    };

    (async () => {
      await services.ready;
      const e = services.library.entry(entryId);
      if (!e) throw new Error('This comic is not in your library.');
      if (!services.library.canRead(entryId)) throw new Error('This comic has not been downloaded.');
      file = await services.library.openFile(entryId);
      if (cancelled) {
        file.close();
        return;
      }
      const opened = await ComicBook.open(file);
      if (cancelled) {
        opened.destroy();
        return;
      }
      book = opened;
      bookRef.current = opened;
      session.current = e;
      const initialPage = pageForLocator(opened.pages, e.progress?.locator);
      locatorRef.current = null;
      setOpened({ book: opened, initialPage, provisional: file.provisional });
      if (!file.provisional) void opened.sniffSizes();
      void services.library.markOpened(e.id, e.book.sha256);
      services.sync.beginReading(e);
      if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) {
        Object.assign(window, { comicBook: opened, readerServices: services });
      }
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      stopReading.current = null;
      teardown();
      file?.close();
      file = null;
    };
  }, [entryId, services]);

  // Early reading: leave if the download stops or the edition changes underneath.
  useEffect(() => {
    const e = session.current;
    if (!opened?.provisional || !e) return;
    const current = services.library.entry(e.id);
    if (!services.library.canRead(e.id) || current?.book.sha256 !== e.book.sha256) {
      stopReading.current?.('The download stopped. Return to your library to retry.');
    }
  }, [opened, lib, services]);

  useEffect(() => {
    if (opened) services.sync.setReadingActive(true);
  }, [opened, services]);

  const close = useCallback(() => {
    saveNow();
    goBack();
  }, [saveNow, goBack]);

  // ------------------------------------------------------------ chrome

  const keepChrome = useRef(false);
  const showChrome = useCallback((autoHide = true) => {
    window.clearTimeout(hideTimer.current);
    setChrome(true);
    if (autoHide) {
      hideTimer.current = window.setTimeout(() => {
        if (!keepChrome.current) setChrome(false);
      }, chromeHideMs);
    }
  }, []);
  const hideChrome = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    setChrome(false);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  // ------------------------------------------------------------ keys

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e) => {
    if (hasOpenOverlay() || isTypingTarget(e.target)) return;
    const action = comicKeyAction(e);
    if (!action) return;
    // A focused button keeps Space and Enter. The scrubber does not keep its
    // arrows: after a scrub they turn pages again (assistive tech adjusts it
    // with modified keys, which pass through).
    const target = e.target as Element | null;
    if ((e.key === ' ' || e.key === 'Enter') && target?.closest?.('button, a, [role=button]')) return;
    e.preventDefault();
    const book = bookRef.current;
    switch (action) {
      case 'close':
        close();
        break;
      case 'next':
        stage.current?.next();
        break;
      case 'previous':
        stage.current?.previous();
        break;
      case 'first':
        stage.current?.goTo(0);
        break;
      case 'last':
        if (book) stage.current?.goTo(book.count - 1);
        break;
      case 'chrome':
        if (chrome) hideChrome();
        else showChrome(!canHover);
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
    }
  };
  useEffect(() => {
    // Capture phase, so nothing else on the page sees the reader's keys first.
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // ------------------------------------------------------------ render

  const book = opened?.book ?? null;
  const spread = view?.spreads[view.index];
  const current = spread ? firstPage(spread) : 0;
  const count = book?.count ?? 0;
  const label = spreadLabel(spread, count);
  const scrubLabel = scrub != null ? `Page ${scrub + 1} of ${count}` : label;
  const title = entry?.book.title ?? '';

  // The scrubber previews while it moves and jumps on release (pointer, touch or keys).
  const commitScrub = useRef<(page: number) => void>(() => undefined);
  commitScrub.current = (page) => {
    setScrub(null);
    keepChrome.current = false;
    stage.current?.goTo(page);
    showChrome(true);
  };
  const scrubInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = scrubInput.current;
    if (!input) return;
    const onCommit = () => commitScrub.current(Number(input.value) - 1);
    input.addEventListener('change', onCommit);
    return () => input.removeEventListener('change', onCommit);
  }, [book, count]);

  return (
    <div className="comic-reader">
      {book && (
        <ComicStage
          ref={stage}
          book={book}
          initialPage={opened!.initialPage}
          reducedMotion={reducedMotion}
          provisional={opened!.provisional}
          onView={onView}
          onTapCenter={() => (chrome ? hideChrome() : showChrome(!canHover))}
          onActivity={() => services.sync.noteReadingActivity()}
        />
      )}
      {!book && !error && (
        <div className="reader-state">
          <LoadingLine label="Opening" />
        </div>
      )}
      {error && (
        <div className="reader-state">
          <StateMessage title="Couldn't open this comic." body={error} error actionLabel="Back" onAction={close} />
        </div>
      )}
      {book && (
        <>
          <div
            className={chrome ? 'reader-top is-visible' : 'reader-top'}
            {...inertProps(!chrome)}
            onMouseEnter={() => (keepChrome.current = true)}
            onMouseLeave={() => {
              keepChrome.current = false;
              showChrome(true);
            }}
          >
            <IconButton icon={CloseIcon} label="Close comic" shortcut="Esc" onClick={close} />
            <div className="reader-top-title t-title-sm clamp-1">{title}</div>
            <div className="comic-top-page t-label-sm">{label}</div>
            {fullscreen !== null && (
              <IconButton
                className="desktop-only-flex"
                icon={fullscreen ? FullscreenExitIcon : FullscreenIcon}
                label={fullscreen ? 'Exit full screen' : 'Full screen'}
                shortcut="F"
                tooltipSide="left"
                onClick={toggleFullscreen}
              />
            )}
          </div>
          <div
            className={chrome ? 'reader-bottom comic-bottom is-visible' : 'reader-bottom comic-bottom'}
            {...inertProps(!chrome)}
            onMouseEnter={() => (keepChrome.current = true)}
            onMouseLeave={() => {
              keepChrome.current = false;
              showChrome(true);
            }}
          >
            {count > 1 && (
              <div
                className="comic-scrubber"
                onPointerDown={() => {
                  keepChrome.current = true;
                  window.clearTimeout(hideTimer.current);
                }}
              >
                <input
                  ref={scrubInput}
                  className="slider"
                  type="range"
                  min={1}
                  max={count}
                  step={1}
                  value={(scrub ?? current) + 1}
                  aria-label="Go to page"
                  aria-valuetext={scrubLabel}
                  style={{ '--slider-fill': `${(((scrub ?? current) / (count - 1)) * 100).toFixed(2)}%` } as CSSProperties}
                  onChange={(e) => setScrub(Number(e.target.value) - 1)}
                />
              </div>
            )}
            <div className="comic-scrub-label t-label-sm" aria-live="polite">
              {scrubLabel}
            </div>
          </div>
          {canHover && !chrome && <div className="reader-hover-strip" aria-hidden="true" onMouseEnter={() => showChrome(true)} />}
          {opened?.provisional && chrome && downloadNote(entry) && <div className="comic-download-note t-label-sm">{downloadNote(entry)}</div>}
          <div className={chrome ? 'reader-edge-progress' : 'reader-edge-progress is-visible'} aria-hidden="true">
            {count ? `${current + 1} / ${count}` : ''}
          </div>
        </>
      )}
    </div>
  );
}
