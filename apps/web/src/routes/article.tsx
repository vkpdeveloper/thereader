import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import type { Article } from 'truffle';
import { SiteIcon } from '../components/ArticleRow';
import { renderArticleBlocks } from '../components/article/Blocks';
import { FootnotePreview, footnotePeekHtml, type FootnotePeek } from '../components/article/FootnotePreview';
import { blockElements, readPosition, scrollToPosition } from '../components/article/position';
import { Lightbox, type ZoomedImage } from '../components/article/Lightbox';
import { safeHref } from '../components/article/media';
import { useArticleLinkPreview } from '../components/article/useArticleLinkPreview';
import { IconButton, QuietButton } from '../components/buttons';
import { ArrowBackIcon, OpenInNewIcon, TextFieldsIcon } from '../components/icons';
import { hasOpenOverlay, Sheet } from '../components/overlay';
import { FontPicker, TypographyPanel } from '../components/reader/TypographyPanel';
import { LoadingLine, StateMessage } from '../components/states';
import { useToast } from '../components/toast';
import { fontStack, resolveFontFamily } from '../lib/fonts';
import { isTypingTarget, useDocumentTitle, useGoBack, useReducedMotion, useWakeLock } from '../lib/hooks';
import { useServices, useStore } from '../lib/services/react';
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type ArticleSummary } from '../lib/types';
import '../components/article/article.css';

const saveDelayMs = 800;
/** Scrolling past this hides the top bar until the reader scrolls back up. */
const barHideOffset = 120;

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; article: Article; summary: ArticleSummary };

/** "October 3, 2026" in the reader's locale. */
function formatPublished(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/**
 * Jumps to a far element in a long article. Blocks skipped by
 * content-visibility only have estimated heights, so a smooth scroll aims at
 * a moving target; instead jump at once, then keep the element centred while
 * the blocks around it render, until it holds still or the reader scrolls.
 */
function revealFar(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' });
  let frames = 0;
  let still = 0;
  let last = el.getBoundingClientRect().top;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  for (const type of events) window.addEventListener(type, cancel, { passive: true, once: true });
  const settle = () => {
    const top = el.getBoundingClientRect().top;
    if (Math.abs(top - last) > 1) {
      el.scrollIntoView({ block: 'center' });
      still = 0;
    } else still++;
    last = el.getBoundingClientRect().top;
    if (!cancelled && still < 6 && ++frames < 90) requestAnimationFrame(settle);
    else for (const type of events) window.removeEventListener(type, cancel);
  };
  requestAnimationFrame(settle);
}

/**
 * A saved web article, read from IndexedDB and drawn with the reader's
 * typography and theme. The page scrolls the window; the reading position is
 * saved (throttled, and on exit) and restored on open. The top bar hides
 * while scrolling down and returns on the way up. Very long articles skip
 * rendering off-screen blocks (content-visibility).
 */
export function ArticleScreen() {
  const { id } = useParams({ from: '/article/$id' });
  const services = useServices();
  const { reader: prefs } = useStore(services.settings);
  const goBack = useGoBack();
  const toast = useToast();
  const reducedMotion = useReducedMotion();

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [panel, setPanel] = useState<'typography' | 'fonts' | null>(null);
  const [zoom, setZoom] = useState<ZoomedImage | null>(null);
  const [peek, setPeek] = useState<FootnotePeek | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const [bar, setBar] = useState({ hidden: false, titled: false });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const progressFill = useRef<HTMLDivElement>(null);
  const fraction = useRef<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const lastRef = useRef<HTMLElement | null>(null);
  const blocksRef = useRef<HTMLElement[]>([]);

  const ready = loaded.status === 'ready' ? loaded : null;
  useDocumentTitle(ready?.article.title ?? 'Article');
  useWakeLock(prefs.keepAwake && ready != null);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    fraction.current = null;
    (async () => {
      await services.ready;
      const summary = services.articles.summary(id);
      if (!summary) throw new Error('This article is not in your library.');
      const article = await services.articles.get(id);
      if (!article) throw new Error('The saved copy is missing. Remove the article and add it again from its link.');
      if (cancelled) return;
      setLoaded({ status: 'ready', article, summary });
      void services.articles.markOpened(id);
    })().catch((e: unknown) => {
      if (!cancelled) setLoaded({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [id, services]);

  // ------------------------------------------------------------ progress

  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (fraction.current != null) void services.articles.saveProgress(id, fraction.current);
  }, [id, services]);

  const close = useCallback(() => {
    saveNow();
    goBack();
  }, [saveNow, goBack]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveNow);
      saveNow();
    };
  }, [saveNow]);

  // One rAF-throttled scroll handler: progress line (no re-render), bar state on change only, throttled save.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let lastY = window.scrollY;
    let hidden = false;
    let titled = false;
    const measure = () => {
      frame = 0;
      const body = bodyRef.current;
      if (!titleRef.current?.isConnected || !body) return;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      fraction.current = readPosition(blockElements(body, blocksRef), ready.article.blocks.length);
      if (progressFill.current) progressFill.current.style.transform = `scaleX(${max <= 0 ? 1 : Math.min(1, Math.max(0, y / max))})`;
      const nextHidden = y <= barHideOffset ? false : y > lastY + 4 ? true : y < lastY - 4 ? false : hidden;
      const nextTitled = titleRef.current.getBoundingClientRect().bottom < 56;
      lastY = y;
      if (nextHidden !== hidden || nextTitled !== titled) {
        hidden = nextHidden;
        titled = nextTitled;
        setBar({ hidden, titled });
      }
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(saveNow, saveDelayMs);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ready, saveNow]);

  // Restore the saved position before paint, then hold it while skipped blocks
  // near it render and web fonts settle, unless the reader moves first.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!ready || !body) return;
    const target = ready.summary.progress ?? 0;
    const count = ready.article.blocks.length;
    const apply = () => scrollToPosition(blockElements(body, blocksRef), count, target);
    apply();
    if (target <= 0) return;
    let moved = false;
    const onInput = () => {
      moved = true;
    };
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    for (const type of events) window.addEventListener(type, onInput, { passive: true, once: true });
    const settle = new ResizeObserver(() => {
      if (!moved) apply();
    });
    settle.observe(body);
    const stop = window.setTimeout(() => settle.disconnect(), 2000);
    void document.fonts?.ready.then(() => {
      if (!moved) apply();
    });
    return () => {
      settle.disconnect();
      window.clearTimeout(stop);
      for (const type of events) window.removeEventListener(type, onInput);
    };
  }, [ready]);

  // ------------------------------------------------------------ keys

  const stepFontSize = useCallback(
    (delta: number) =>
      void services.settings.updateReader((r) => ({
        ...r,
        fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(r.fontSize) + delta)),
      })),
    [services],
  );

  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e) => {
    if (hasOpenOverlay() || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (peek) setPeek(null);
      else if (panel) setPanel(null);
      else close();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      stepFontSize(1);
    } else if (e.key === '-') {
      e.preventDefault();
      stepFontSize(-1);
    } else if (e.key === 'a') {
      e.preventDefault();
      setPanel((p) => (p ? null : 'typography'));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ------------------------------------------------------------ footnote previews

  // A mouse resting on a reference shows its note; leaving (with a grace period to reach the preview), scrolling or a click hides it.
  const showPeek = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || !ready) return;
    const ref = (e.target as Element).closest<HTMLElement>('[data-fn]');
    if (!ref?.dataset.fn) return;
    window.clearTimeout(peekTimer.current);
    const id = ref.dataset.fn;
    if (peek?.id === id) return;
    peekTimer.current = window.setTimeout(() => {
      const html = footnotePeekHtml(id);
      if (html && ref.isConnected) setPeek({ id, html, anchor: ref.getBoundingClientRect(), dir: ready.article.dir, lang: ready.article.language ?? undefined });
    }, peek ? 0 : 280);
  };
  const hidePeek = (delay = 160) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(null), delay);
  };
  const keepPeek = () => window.clearTimeout(peekTimer.current);
  useEffect(() => {
    if (!peek) return;
    const hide = () => setPeek(null);
    window.addEventListener('scroll', hide, { passive: true, once: true });
    return () => window.removeEventListener('scroll', hide);
  }, [peek]);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  const linkPreview = useArticleLinkPreview(bodyRef, ready?.article.url ?? null, () => setPeek(null));

  // ------------------------------------------------------------ in-article clicks

  const flash = useCallback(
    (el: HTMLElement | null, focus: HTMLElement | null) => {
      if (!el) return;
      if (Math.abs(el.getBoundingClientRect().top) > window.innerHeight * 2 && bodyRef.current?.classList.contains('is-long')) {
        revealFar(el);
      } else {
        el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
      }
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
      focus?.focus({ preventScroll: true });
    },
    [reducedMotion],
  );

  const onArticleClick = (e: ReactMouseEvent) => {
    const target = e.target as Element;
    if (peek) {
      window.clearTimeout(peekTimer.current);
      setPeek(null);
    }
    const zoomed = target.closest<HTMLElement>('[data-zoom]');
    if (zoomed?.dataset.zoom) {
      e.preventDefault();
      setZoom({ src: zoomed.dataset.zoom, alt: zoomed.dataset.alt ?? '' });
      return;
    }
    const ref = target.closest<HTMLElement>('[data-fn]');
    if (ref?.dataset.fn) {
      e.preventDefault();
      lastRef.current = ref;
      const note = document.getElementById(`fn-${ref.dataset.fn}`);
      flash(note, note?.querySelector<HTMLElement>('[data-fnback]') ?? null);
      return;
    }
    const back = target.closest<HTMLElement>('[data-fnback]');
    if (back?.dataset.fnback) {
      e.preventDefault();
      const id = back.dataset.fnback;
      const origin = lastRef.current?.isConnected && lastRef.current.dataset.fn === id ? lastRef.current : document.getElementById(`fnref-${id}`);
      flash(origin, origin);
      return;
    }
    const anchor = target.closest<HTMLElement>('[data-anchor]');
    if (anchor?.dataset.anchor && ready) {
      e.preventDefault();
      const link = `${ready.article.url.split('#')[0]}#${anchor.dataset.anchor}`;
      void navigator.clipboard.writeText(link).then(
        () => toast.show('Link to this section copied.'),
        () => toast.show("Couldn't copy the link."),
      );
    }
  };

  // ------------------------------------------------------------ render

  const family = resolveFontFamily(prefs);
  const factor = 0.8 + Math.min(Math.max(prefs.marginScale, 0.2), 3) * 0.6;
  const measurePx = Math.ceil((prefs.fontSize * 47.6) / factor / 40) * 40;
  const pad = Math.round(22 * factor);
  const sizes = `(min-width: ${measurePx + pad * 2}px) ${measurePx}px, calc(100vw - ${pad * 2}px)`;
  const style = {
    '--article-font': fontStack(family),
    '--article-size': `${prefs.fontSize}px`,
    '--article-leading': String(prefs.lineHeight),
    '--article-measure': `${(47.6 / factor).toFixed(2)}em`,
    '--article-pad': `${pad}px`,
  } as CSSProperties;

  const body = useMemo(() => (ready ? renderArticleBlocks(ready.article.blocks, { sizes, seenRefs: new Set() }) : null), [ready, sizes]);

  if (!ready) {
    return (
      <div className="article-page" style={style}>
        <div className="article-state">
          {loaded.status === 'error' ? (
            <StateMessage title="Couldn't open this article." body={loaded.message} error actionLabel="Back" onAction={close} />
          ) : (
            <LoadingLine label="Opening" />
          )}
        </div>
      </div>
    );
  }

  const { article } = ready;
  const original = safeHref(article.url);
  // Byline in the article's language, date and length in the reader's: each part isolated so mixed scripts keep their order.
  const meta = [article.byline, formatPublished(article.publishedAt), `${article.readingMinutes} min read`].filter((part): part is string => !!part);

  return (
    <div className="article-page" style={style}>
      <div className="article-progress" aria-hidden="true">
        <div ref={progressFill} className="article-progress-fill" />
      </div>
      <div className={['article-bar', bar.hidden && !panel && 'is-hidden', bar.titled && 'is-titled'].filter(Boolean).join(' ')}>
        <IconButton icon={ArrowBackIcon} label="Back to Library" shortcut="Esc" onClick={close} />
        <div className={bar.titled ? 'article-bar-title is-shown' : 'article-bar-title'} aria-hidden={!bar.titled}>
          <SiteIcon src={article.favicon} size={14} />
          <span className="t-title-sm clamp-1">{article.title}</span>
        </div>
        {original && (
          <a className="icon-button" href={original} target="_blank" rel="noopener noreferrer" aria-label="Open original" data-tooltip="Open original">
            <OpenInNewIcon size={20} />
          </a>
        )}
        <IconButton
          icon={TextFieldsIcon}
          label="Typography"
          shortcut="A"
          tooltipSide="left"
          aria-pressed={panel != null}
          onClick={() => setPanel((p) => (p ? null : 'typography'))}
        />
      </div>

      <article
        className={prefs.justify ? 'article is-justified' : 'article'}
        dir={article.dir}
        lang={article.language ?? undefined}
        onClick={onArticleClick}
        onPointerOver={showPeek}
        onPointerOut={(e) => {
          if ((e.target as Element).closest('[data-fn]')) hidePeek();
        }}
      >
        <header className="article-header">
          {original ? (
            <a className="article-site" href={original} target="_blank" rel="noopener noreferrer">
              <SiteIcon src={article.favicon} size={16} />
              <span>{ready.summary.siteName}</span>
            </a>
          ) : (
            <div className="article-site">
              <SiteIcon src={article.favicon} size={16} />
              <span>{ready.summary.siteName}</span>
            </div>
          )}
          <h1 ref={titleRef} className="article-title">
            {article.title}
          </h1>
          {article.subtitle && <p className="article-subtitle">{article.subtitle}</p>}
          <div className="article-meta">
            <span>
              {meta.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && ' · '}
                  <bdi>{part}</bdi>
                </Fragment>
              ))}
            </span>
            {original && (
              <a className="article-original" href={original} target="_blank" rel="noopener noreferrer">
                Open original
                <OpenInNewIcon size={13} />
              </a>
            )}
          </div>
        </header>
        <div ref={bodyRef} className={article.blocks.length > 120 || article.wordCount > 5000 ? 'article-body is-long' : 'article-body'}>
          {body}
        </div>
        <footer className="article-end">
          <hr className="article-rule" />
          <div className="article-end-actions">
            {original && (
              <a className="quiet-button" href={original} target="_blank" rel="noopener noreferrer">
                <OpenInNewIcon size={16} />
                <span>Open original</span>
              </a>
            )}
            <QuietButton label="Back to Library" onClick={close} />
          </div>
        </footer>
      </article>

      <Sheet open={panel != null} onClose={() => setPanel(null)} title="Typography">
        <div className="reader-panel-body">
          {panel === 'fonts' ? <FontPicker onBack={() => setPanel('typography')} /> : <TypographyPanel article onFonts={() => setPanel('fonts')} />}
        </div>
      </Sheet>
      <Lightbox image={zoom} onClose={() => setZoom(null)} />
      {peek && <FootnotePreview key={peek.id} peek={peek} onEnter={keepPeek} onLeave={() => hidePeek()} />}
      {linkPreview}
    </div>
  );
}
