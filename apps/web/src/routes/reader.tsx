import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { hasOpenOverlay, Sheet } from '../components/overlay';
import { BottomChrome, EdgeProgress, TopChrome, ToChapterStart, type ReaderPanel } from '../components/reader/ReaderChrome';
import { ContentsList, HighlightsList, SearchBook } from '../components/reader/panels';
import { FontPicker, TypographyPanel } from '../components/reader/TypographyPanel';
import { FloatingBar, HighlightActions, SelectionActions } from '../components/reader/Floating';
import { LoadingLine, StateMessage } from '../components/states';
import { useToast } from '../components/toast';
import { useCanHover, useDocumentTitle, useIsDesktop, useWakeLock, isTypingTarget } from '../lib/hooks';
import { engineColors, parseHighlightColor } from '../lib/themes';
import { useServices, useStore } from '../lib/services/react';
import type { Highlight, HighlightColor, LibraryEntry, ReaderPreferences, ReadingLocator } from '../lib/types';
import type { EngineCallbacks, ReaderEngine, SelectionInfo } from '../reader/engine';
import { useGoBack } from './book';

const saveDebounceMs = 600;

const panelTitles: Record<ReaderPanel, string> = {
  contents: 'Contents',
  highlights: 'Highlights',
  search: 'Search',
  typography: 'Typography',
};

/**
 * The reading surface. Chrome is hidden by default and revealed with a click
 * in the middle of the page; position is saved continuously and on exit.
 * On desktop the tools open as side panels that keep the page readable.
 */
export function ReaderScreen() {
  const { entryId } = useParams({ from: '/read/$entryId' });
  const services = useServices();
  const settings = useStore(services.settings);
  const lib = useStore(services.library);
  const highlightsSnapshot = useStore(services.highlights);
  const desktop = useIsDesktop();
  const canHover = useCanHover();
  const toast = useToast();
  const goBack = useGoBack();

  const stage = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ReaderEngine | null>(null);
  const session = useRef<LibraryEntry | null>(null);
  const appliedPrefs = useRef<ReaderPreferences | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const hoverReveal = useRef(false);

  const [engine, setEngine] = useState<ReaderEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locator, setLocator] = useState<ReadingLocator | null>(null);
  const [chrome, setChrome] = useState(false);
  const [panel, setPanel] = useState<ReaderPanel | null>(null);
  const [fontPicker, setFontPicker] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [popover, setPopover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [fullscreen, setFullscreen] = useState<boolean | null>(
    typeof document !== 'undefined' && document.fullscreenEnabled ? !!document.fullscreenElement : null,
  );

  const entry = lib.entries.find((e) => e.id === entryId) ?? session.current ?? undefined;
  useDocumentTitle(entry?.book.title ?? 'Reading');
  useWakeLock(settings.reader.keepAwake && engine != null);

  // ------------------------------------------------------------ progress

  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const loc = engineRef.current?.locator;
    const e = session.current;
    if (loc && e) void services.library.saveProgress(e.id, loc, e.book.sha256);
  }, [services]);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveNow, saveDebounceMs);
  }, [saveNow]);

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

  // ------------------------------------------------------------ actions

  const clearFloating = useCallback(() => {
    setPopover(null);
    if (selection) {
      engineRef.current?.clearSelection();
      setSelection(null);
    }
  }, [selection]);

  const togglePanel = useCallback((p: ReaderPanel) => {
    setFontPicker(false);
    setPanel((cur) => (cur === p ? null : p));
  }, []);

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

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.show('Copied');
      } catch {
        toast.show("Couldn't copy.");
      }
    },
    [toast],
  );

  /** Mobile `_createHighlight`: borrow position and chapter from the page when the selection lacks them. */
  const createHighlight = useCallback(
    async (sel: SelectionInfo, color: HighlightColor) => {
      const e = session.current;
      if (!e) return;
      const here = engineRef.current?.locator ?? null;
      const locator: Record<string, unknown> = { ...sel.locator };
      const locations: Record<string, unknown> = { ...((locator.locations as Record<string, unknown> | undefined) ?? {}) };
      if (locations.totalProgression == null && here?.totalProgression != null) locations.totalProgression = here.totalProgression;
      locator.locations = locations;
      if (locator.title == null && here?.title != null) locator.title = here.title;
      engineRef.current?.clearSelection();
      setSelection(null);
      try {
        await services.highlights.create({
          bookId: e.book.id,
          sha256: e.book.sha256,
          origin: e.origin,
          locator,
          text: sel.text,
          color,
        });
      } catch {
        toast.show("Couldn't save the highlight.");
      }
    },
    [services, toast],
  );

  /** Mobile `_openHighlights`: jump with a Readium-shaped locator. */
  const openHighlight = useCallback((h: Highlight) => {
    const locations = (h.locator.locations as Record<string, unknown> | undefined) ?? {};
    const target: ReadingLocator = {
      href: typeof h.locator.href === 'string' ? h.locator.href : '',
      progression: typeof locations.progression === 'number' ? locations.progression : 0,
      totalProgression: typeof locations.totalProgression === 'number' ? locations.totalProgression : null,
      title: typeof h.locator.title === 'string' ? h.locator.title : null,
      engine: 'readium',
      raw: h.locator,
    };
    void engineRef.current?.goTo(target);
  }, []);

  const closeBook = useCallback(() => {
    saveNow();
    goBack();
  }, [saveNow, goBack]);

  // ------------------------------------------------------------ engine callbacks

  const handleKey = (e: KeyboardEvent, fromFrame: boolean) => {
    if (hasOpenOverlay()) return;
    if (!fromFrame && isTypingTarget(e.target)) return;
    const eng = engineRef.current;
    const key = e.key;
    const mod = e.metaKey || e.ctrlKey;
    const inPanel = !fromFrame && !!panelRef.current?.contains(e.target as Node);
    const handled = () => e.preventDefault();

    if (key === 'Escape') {
      handled();
      if (popover || selection) clearFloating();
      else if (fontPicker) setFontPicker(false);
      else if (panel) setPanel(null);
      else if (chrome) setChrome(false);
      else closeBook();
      return;
    }
    if (mod && !e.altKey && key.toLowerCase() === 'f') {
      handled();
      setFontPicker(false);
      setPanel('search');
      return;
    }
    if (mod && key === ',') {
      handled();
      togglePanel('typography');
      return;
    }
    if (mod || e.altKey || !eng) return;
    if (inPanel) return;
    switch (key) {
      case 'ArrowRight':
      case 'PageDown':
        handled();
        void eng.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        handled();
        void eng.previous();
        break;
      case ' ':
        handled();
        void (e.shiftKey ? eng.previous() : eng.next());
        break;
      case 'Home':
        handled();
        void eng.toChapterStart();
        break;
      case 't':
      case 'c':
        handled();
        togglePanel('contents');
        break;
      case 'h':
        handled();
        togglePanel('highlights');
        break;
      case '/':
        handled();
        setFontPicker(false);
        setPanel('search');
        break;
      case 'a':
        handled();
        togglePanel('typography');
        break;
      case 'f':
        handled();
        toggleFullscreen();
        break;
    }
  };

  const handlers = useRef<EngineCallbacks>(null as unknown as EngineCallbacks);
  handlers.current = {
    onLocator(loc) {
      setLocator(loc);
      scheduleSave();
    },
    onSelection(sel) {
      setPopover(null);
      setSelection(sel);
    },
    onHighlightClick(id, rect) {
      setSelection(null);
      setPopover({ id, rect });
    },
    onTap(x) {
      if (selection || popover) {
        clearFloating();
        return;
      }
      const eng = engineRef.current;
      if (eng && settings.reader.flow === 'paginated' && x < 0.3) void eng.previous();
      else if (eng && settings.reader.flow === 'paginated' && x > 0.7) void eng.next();
      else {
        hoverReveal.current = false;
        setChrome((v) => !v);
      }
    },
    onExternalLink(url) {
      if (/^https?:/i.test(url)) {
        const w = window.open(url, '_blank', 'noopener,noreferrer');
        if (!w) toast.show("Couldn't open link.");
      } else {
        window.location.href = url;
      }
    },
    onKey(e) {
      handleKey(e, true);
    },
  };

  // Keys typed on the page itself (the frame forwards its own through onKey).
  const hostKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  hostKey.current = (e) => handleKey(e, false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => hostKey.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ------------------------------------------------------------ open / close

  useEffect(() => {
    let cancelled = false;
    let opened: ReaderEngine | null = null;
    const container = stage.current;
    if (!container) return;
    // Each open gets its own host, so an open cancelled by a fast remount can never paint over the next.
    const host = document.createElement('div');
    host.className = 'reader-host';
    container.appendChild(host);
    setError(null);
    setEngine(null);

    (async () => {
      await services.ready;
      const e = services.library.entry(entryId);
      if (!e) throw new Error('This book is not in your library.');
      if (!services.library.canRead(entryId)) throw new Error('This book has not been downloaded.');
      const data = await services.library.openForReading(entryId);
      const { openPublication } = await import('../reader/epub');
      if (cancelled) return;
      const prefs = services.settings.getSnapshot().reader;
      const callbacks: EngineCallbacks = {
        onLocator: (l) => handlers.current.onLocator(l),
        onSelection: (s) => handlers.current.onSelection(s),
        onHighlightClick: (id, r) => handlers.current.onHighlightClick(id, r),
        onTap: (x) => handlers.current.onTap(x),
        onExternalLink: (u) => handlers.current.onExternalLink(u),
        onKey: (k) => handlers.current.onKey(k),
      };
      const eng = await openPublication({
        data,
        container: host,
        prefs,
        colors: engineColors(prefs.themeId),
        initial: e.progress?.locator ?? null,
        callbacks,
      });
      if (cancelled) {
        eng.destroy();
        return;
      }
      opened = eng;
      engineRef.current = eng;
      session.current = e;
      appliedPrefs.current = prefs;
      setEngine(eng);
      setLocator(eng.locator);
      void services.library.markOpened(e.id, e.book.sha256);
      services.sync.beginReading(e);
      eng.setHighlights(services.highlights.forEdition(e.origin, e.book.sha256));
      // Record the opening position so "Continue reading" appears at once.
      if (eng.locator) scheduleSave();
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      if (opened) {
        window.clearTimeout(saveTimer.current);
        const loc = opened.locator;
        const e = session.current;
        if (loc && e) void services.library.saveProgress(e.id, loc, e.book.sha256);
        services.sync.endReading();
        opened.destroy();
      }
      engineRef.current = null;
      host.remove();
    };
    // Reopen only for another book; everything else flows through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, services]);

  // Preferences (including theme changes arriving from sync) re-apply live.
  useEffect(() => {
    if (!engine || appliedPrefs.current === settings.reader) return;
    appliedPrefs.current = settings.reader;
    engine.applyPreferences(settings.reader, engineColors(settings.reader.themeId));
  }, [engine, settings.reader]);

  // Highlights come from the local store; sync refreshes it on its own schedule.
  const sessionEntry = session.current;
  const editionHighlights = engine && sessionEntry ? services.highlights.forEdition(sessionEntry.origin, sessionEntry.book.sha256) : [];
  useEffect(() => {
    const e = session.current;
    if (engine && e) engine.setHighlights(services.highlights.forEdition(e.origin, e.book.sha256));
  }, [engine, highlightsSnapshot, services]);

  // Re-layout whenever the page area changes size (window, side panel).
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !engine) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => engine.resize());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [engine]);

  // ------------------------------------------------------------ render

  const title = entry?.book.title ?? '';
  const popoverHighlight = popover ? services.highlights.byId(popover.id) : undefined;
  const defaultColor = parseHighlightColor(settings.reader.highlightColor);
  const closeOnMobile = () => {
    if (!desktop) setPanel(null);
  };

  const panelBody = (p: ReaderPanel) => {
    if (!engine || !sessionEntry) return null;
    switch (p) {
      case 'contents':
        return (
          <ContentsList
            toc={engine.info.toc}
            currentHref={locator?.href ?? null}
            onOpen={(t) => {
              closeOnMobile();
              void engine.goToHref(t.href);
            }}
          />
        );
      case 'highlights':
        return (
          <HighlightsList
            items={editionHighlights}
            onOpen={(h) => {
              closeOnMobile();
              openHighlight(h);
            }}
            onDelete={(h) => void services.highlights.delete(h.id)}
          />
        );
      case 'search':
        return (
          <SearchBook
            search={(q, signal) => engine.search(q, signal)}
            onOpen={(loc) => {
              closeOnMobile();
              void engine.goTo(loc);
            }}
          />
        );
      case 'typography':
        return fontPicker ? <FontPicker onBack={() => setFontPicker(false)} /> : <TypographyPanel onFonts={() => setFontPicker(true)} />;
    }
  };

  const panelSheet = (
    <Sheet
      open={panel != null && engine != null}
      onClose={() => {
        setFontPicker(false);
        setPanel(null);
      }}
      title={panel ? (panel === 'typography' && fontPicker ? 'Typography' : panelTitles[panel]) : undefined}
      docked
      fill={panel === 'contents' || panel === 'highlights' || panel === 'search'}
    >
      <div ref={panelRef} className="reader-panel-body" key={panel ?? 'none'}>
        {panel && panelBody(panel)}
      </div>
    </Sheet>
  );

  return (
    <div className="reader" data-flow={settings.reader.flow}>
      <div className="reader-row">
        <div className="reader-stage-wrap">
          <div ref={stage} className="reader-stage" />
          {!engine && !error && (
            <div className="reader-state">
              <LoadingLine label="Opening" />
            </div>
          )}
          {error && (
            <div className="reader-state">
              <StateMessage title="Couldn't open this book." body={error} error actionLabel="Back" onAction={closeBook} />
            </div>
          )}
          {engine && (
            <>
              {canHover && !chrome && (
                <div
                  className="reader-hover-strip"
                  aria-hidden="true"
                  onMouseEnter={() => {
                    hoverReveal.current = true;
                    setChrome(true);
                  }}
                />
              )}
              <TopChrome
                visible={chrome}
                title={title}
                panel={panel}
                onClose={closeBook}
                onPanel={togglePanel}
                fullscreen={fullscreen}
                onFullscreen={toggleFullscreen}
                onMouseLeave={() => {
                  if (hoverReveal.current) {
                    hoverReveal.current = false;
                    setChrome(false);
                  }
                }}
              />
              <BottomChrome
                visible={chrome}
                locator={locator}
                onPrevious={() => void engine.previous()}
                onNext={() => void engine.next()}
              />
              <EdgeProgress visible={!chrome} locator={locator} />
              <ToChapterStart chromeVisible={chrome} locator={locator} onPress={() => void engine.toChapterStart()} />
            </>
          )}
        </div>
        {desktop && panelSheet}
      </div>
      {!desktop && panelSheet}

      {selection && (
        <FloatingBar rect={selection.rect} preferBelow={!canHover} label="Selection" onDismiss={clearFloating}>
          <SelectionActions
            defaultColor={defaultColor}
            onHighlight={(c) => void createHighlight(selection, c)}
            onCopy={() => {
              void copy(selection.text);
              clearFloating();
            }}
          />
        </FloatingBar>
      )}

      {popover && popoverHighlight && !popoverHighlight.deleted && desktop && (
        <FloatingBar rect={popover.rect} label="Highlight" onDismiss={() => setPopover(null)}>
          <HighlightActions
            compact
            color={parseHighlightColor(popoverHighlight.color)}
            onRecolor={(c) => void services.highlights.recolor(popoverHighlight.id, c)}
            onCopy={() => {
              void copy(popoverHighlight.text);
              setPopover(null);
            }}
            onDelete={() => {
              setPopover(null);
              void services.highlights.delete(popoverHighlight.id);
            }}
          />
        </FloatingBar>
      )}
      {!desktop && (
        <Sheet open={!!(popover && popoverHighlight && !popoverHighlight.deleted)} onClose={() => setPopover(null)} label="Highlight">
          {popoverHighlight && (
            <HighlightActions
              color={parseHighlightColor(popoverHighlight.color)}
              onRecolor={(c) => void services.highlights.recolor(popoverHighlight.id, c)}
              onCopy={() => {
                void copy(popoverHighlight.text);
                setPopover(null);
              }}
              onDelete={() => {
                setPopover(null);
                void services.highlights.delete(popoverHighlight.id);
              }}
            />
          )}
        </Sheet>
      )}
    </div>
  );
}
