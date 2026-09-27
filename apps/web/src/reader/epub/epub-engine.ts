import type { Highlight, ReaderPreferences, ReadingLocator } from '../../lib/types';
import type {
  EngineCallbacks,
  EngineColors,
  OpenOptions,
  PageInfo,
  PublicationInfo,
  ReaderEngine,
  SearchMatch,
  TocEntry,
} from '../engine';
import { parseMarkup, prepareChapter, type PreparedChapter } from './chapter';
import { clearMarks, drawMarks, type MarkSpan } from './marks';
import type { EpubPackage, SpineItem } from './package';
import { isExternal, normalizePath, resolveRef, safeDecode, splitHref } from './path';
import { Resources } from './resources';
import { computeGeometry, fontFaceCss, preferencesCss, type PageGeometry } from './styles';
import { anchorQuote, lowerQuote, plainText, TextIndex, type TextQuote } from './text';
import type { ZipArchive } from './zip';

type Target =
  | { kind: 'progression'; value: number }
  | { kind: 'offset'; value: number }
  | { kind: 'fragment'; id: string; fallback: number }
  /**
   * A text quote. `jump` goes to a found passage (search, highlight) and
   * leaves context above it; otherwise the quote is a saved position and
   * becomes the first line. `flash` briefly marks the passage.
   */
  | { kind: 'quote'; quote: TextQuote; progression: number | null; jump: boolean; flash: boolean }
  | { kind: 'end' };

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const CONTEXT = 120;
const SEARCH_CONTEXT = 60;
const MAX_SEARCH_RESULTS = 200;
const CACHE_SIZE = 5;
/** Characters of visible text kept in a saved position, enough to find it again. */
const POSITION_QUOTE = 48;
const TURN_MS = 200;

/** Scripts written right to left; a chapter in one of these reads RTL even without `dir`. */
const RTL_LANG = /^(ar|arc|ckb|dv|fa|he|iw|ku|ps|sd|ug|ur|yi)(-|$)/i;

const SHELL = (origin: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; ` +
  `img-src blob: data:; media-src blob: data:; font-src blob: data: ${origin}; style-src 'unsafe-inline' blob: data:">` +
  `<style id="reader-dir"></style><style id="reader-fonts"></style><style id="reader-prefs"></style><style id="reader-fixed"></style>` +
  `</head><body></body></html>`;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function abortError(): Error {
  return new DOMException('The search was aborted.', 'AbortError');
}

/** Yields to the event loop; unlike rAF or timers it is not paused in background tabs. */
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

export class EpubEngine implements ReaderEngine {
  readonly info: PublicationInfo;
  private base: ReadingLocator | null = null;

  private readonly res: Resources;
  private readonly cb: EngineCallbacks;
  private prefs: ReaderPreferences;
  private colors: EngineColors;
  private readonly wrapper: HTMLDivElement;
  private readonly frame: HTMLIFrameElement;
  private doc!: Document;
  private win!: Window;
  private geometry!: PageGeometry;

  private readonly linear: number[];
  private readonly sizeBefore = new Map<number, number>();
  private readonly totalSize: number;
  private readonly tocByPath = new Map<string, TocEntry[]>();
  private readonly tocSpine: { entry: TocEntry; spine: number }[] = [];

  private readonly cache = new Map<number, Promise<PreparedChapter>>();
  private readonly plainCache = new Map<number, string>();
  private current: PreparedChapter | null = null;
  private pageIndex = 0;
  private pageCount = 1;
  private index: TextIndex | null = null;
  private highlights: Highlight[] = [];
  private fragmentPositions = new Map<string, number | null>();

  /** Re-applied when images or fonts shift the layout, until the reader interacts. */
  private sticky: Target | null = null;
  private navToken = 0;
  private destroyed = false;
  private scrollFrame = 0;
  private scrollTimer = 0;
  private relayoutFrame = 0;
  private relayoutTimer = 0;
  private preloadTimer = 0;
  private selectionTimer = 0;
  private flashTimer = 0;
  private selectionKey: string | null = null;
  private pointerDown = false;
  private hadSelectionAtDown = false;
  private suppressTapUntil = 0;
  private wheelAccum = 0;
  private wheelLockUntil = 0;
  private touchStart: { x: number; y: number; t: number } | null = null;
  private programmaticScroll = false;
  /** Set when the base locator changed; `locator` then adds the text anchor on demand. */
  private anchorPending = false;
  private turnAnimation: Animation | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly zip: ZipArchive,
    private readonly pkg: EpubPackage,
    private readonly container: HTMLElement,
    options: OpenOptions,
  ) {
    this.info = pkg.info;
    this.cb = options.callbacks;
    this.prefs = options.prefs;
    this.colors = options.colors;
    this.res = new Resources(zip, pkg.manifestByHref);

    this.linear = pkg.spine.filter((s) => s.linear).map((s) => s.index);
    let acc = 0;
    for (const s of pkg.spine) {
      this.sizeBefore.set(s.index, acc);
      if (s.linear) acc += s.size;
    }
    this.totalSize = Math.max(1, acc);
    for (const entry of pkg.info.toc) {
      const path = splitHref(entry.href).path;
      let list = this.tocByPath.get(path);
      if (!list) this.tocByPath.set(path, (list = []));
      list.push(entry);
      const spine = this.spineIndexFor(entry.href);
      if (spine !== null) this.tocSpine.push({ entry, spine });
    }

    this.wrapper = document.createElement('div');
    this.wrapper.style.cssText =
      'position:relative;width:100%;height:100%;overflow:hidden;display:flex;justify-content:center;align-items:flex-start;';
    this.wrapper.style.background = this.colors.paper;
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.setAttribute('title', pkg.info.title);
    this.frame.style.cssText = 'border:0;display:block;flex:none;margin:0;padding:0;';
    this.frame.style.background = this.colors.paper;
    this.wrapper.append(this.frame);
    container.append(this.wrapper);
  }

  // ---------------------------------------------------------------- setup

  async start(initial: ReadingLocator | null): Promise<void> {
    await this.loadShell();
    // WebKit does not run listeners inside a sandboxed frame without
    // `allow-scripts` (https://bugs.webkit.org/show_bug.cgi?id=218086). Book
    // scripts stay off either way: they are stripped and the frame CSP is
    // `script-src 'none'`.
    if (!this.listenersWork()) {
      this.frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      await this.loadShell();
    }
    this.attachListeners();
    let spine = this.linear[0] ?? 0;
    let target: Target = { kind: 'progression', value: 0 };
    if (initial) {
      const resolved = this.resolveLocator(initial, false);
      if (resolved) [spine, target] = resolved;
    }
    await this.display(spine, target);
  }

  private loadShell(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.doc = this.frame.contentDocument!;
        this.win = this.frame.contentWindow!;
        this.doc.getElementById('reader-fonts')!.textContent = fontFaceCss(location.origin);
        resolve();
      };
      this.frame.addEventListener('load', done, { once: true });
      this.frame.srcdoc = SHELL(location.origin);
    });
  }

  private listenersWork(): boolean {
    let fired = false;
    const probe = () => {
      fired = true;
    };
    this.doc.addEventListener('reader-probe', probe);
    this.doc.dispatchEvent(new Event('reader-probe'));
    this.doc.removeEventListener('reader-probe', probe);
    return fired;
  }

  private attachListeners(): void {
    const doc = this.doc;
    const on = <K extends keyof DocumentEventMap>(
      type: K,
      fn: (e: DocumentEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      doc.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => doc.removeEventListener(type, fn as EventListener, opts));
    };
    on('click', (e) => this.onClick(e));
    on('keydown', (e) => {
      this.sticky = null;
      this.cb.onKey(e);
    });
    on('keyup', () => this.scheduleSelection(0));
    on('mousedown', (e) => {
      if (e.button !== 0) return;
      this.sticky = null;
      this.pointerDown = true;
      this.hadSelectionAtDown = this.hasSelection();
    });
    on('mouseup', () => {
      this.pointerDown = false;
      this.scheduleSelection(10);
      if (this.geometry?.mode === 'paginated') this.snapPage();
    });
    on('selectionchange', () => {
      if (!this.pointerDown) this.scheduleSelection(250);
    });
    on('scroll', () => this.onScroll(), { passive: true });
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('touchstart', (e) => this.onTouchStart(e), { passive: true });
    on('touchend', (e) => this.onTouchEnd(e), { passive: true });
    on('dragstart', (e) => e.preventDefault());
    // Images, SVG images and fonts can change the layout after display.
    on('load', () => this.scheduleRelayout(), { capture: true });
    const fonts = doc.fonts;
    if (fonts) {
      const onFonts = () => this.scheduleRelayout();
      fonts.addEventListener('loadingdone', onFonts);
      this.cleanup.push(() => fonts.removeEventListener('loadingdone', onFonts));
    }
  }

  // ---------------------------------------------------------------- spine

  private spineIndexFor(href: string): number | null {
    const target = normalizePath(safeDecode(splitHref(href).path));
    if (!target) return null;
    const spine = this.pkg.spine;
    const exact = spine.find((s) => s.href === target);
    if (exact) return exact.index;
    const lower = target.toLowerCase();
    const ci = spine.find((s) => s.href.toLowerCase() === lower);
    if (ci) return ci.index;
    const suffix = spine.find((s) => s.href.endsWith(`/${target}`)) ?? spine.find((s) => target.endsWith(`/${s.href}`));
    return suffix ? suffix.index : null;
  }

  private nextLinear(from: number): number | null {
    return this.linear.find((i) => i > from) ?? null;
  }

  private previousLinear(from: number): number | null {
    for (let k = this.linear.length - 1; k >= 0; k--) if (this.linear[k] < from) return this.linear[k];
    return null;
  }

  private chapter(index: number): Promise<PreparedChapter> {
    let p = this.cache.get(index);
    if (p) {
      // Refresh LRU order.
      this.cache.delete(index);
      this.cache.set(index, p);
      return p;
    }
    p = prepareChapter(this.zip, this.res, this.pkg.spine[index]);
    this.cache.set(index, p);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = [...this.cache.keys()].find((k) => k !== this.current?.index && k !== index);
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.res.release(oldest);
    }
    return p;
  }

  /** `jump`: a found passage (search result, highlight) rather than a saved reading position. */
  private resolveLocator(l: ReadingLocator, jump: boolean): [number, Target] | null {
    const raw = obj(l.raw);
    const locations = obj(raw?.locations);
    const text = obj(raw?.text);
    const spine = this.spineIndexFor(str(raw?.href) ?? l.href) ?? this.spineIndexFor(l.href);
    if (spine === null) return null;
    const progression = num(locations?.progression) ?? num(l.progression);
    const highlight = str(text?.highlight);
    if (highlight && highlight.trim()) {
      return [
        spine,
        {
          kind: 'quote',
          quote: { highlight, before: str(text?.before) ?? '', after: str(text?.after) ?? '' },
          progression,
          jump,
          flash: jump,
        },
      ];
    }
    const fragments = Array.isArray(locations?.fragments) ? (locations!.fragments as unknown[]) : [];
    const fragment = splitHref(str(raw?.href) ?? l.href).fragment ?? str(fragments[0]);
    if (fragment && !progression) return [spine, { kind: 'fragment', id: fragment, fallback: 0 }];
    return [spine, { kind: 'progression', value: clamp01(progression ?? 0) }];
  }

  // ---------------------------------------------------------------- display

  private async display(index: number, target: Target): Promise<void> {
    const token = ++this.navToken;
    if (!this.current || this.current.index !== index) {
      const chapter = await this.chapter(index);
      if (token !== this.navToken || this.destroyed) return;
      this.mount(chapter);
    }
    this.position(target);
    this.sticky = target.kind === 'quote' ? { ...target, flash: false } : target;
    this.emitLocator();
    this.schedulePreload();
  }

  private mount(chapter: PreparedChapter): void {
    const doc = this.doc;
    this.clearSelectionState();
    this.current = chapter;
    this.index = null;
    this.pageIndex = 0;
    this.fragmentPositions.clear();

    for (const s of Array.from(doc.head.querySelectorAll('style[data-book]'))) s.remove();
    const prefsStyle = doc.getElementById('reader-prefs')!;
    for (const s of chapter.styles) {
      const el = doc.createElement('style');
      el.setAttribute('data-book', '');
      if (s.media) el.setAttribute('media', s.media);
      el.textContent = s.css;
      doc.head.insertBefore(el, prefsStyle);
    }
    const html = doc.documentElement;
    for (const name of ['lang', 'dir', 'class']) html.removeAttribute(name);
    for (const [name, value] of chapter.htmlAttrs) html.setAttribute(name, value);
    // The page root's direction follows the book's progression (see preferencesCss);
    // the text keeps the chapter's own direction. Zero specificity: book CSS wins.
    const attr = (n: string) => chapter.htmlAttrs.find(([k]) => k === n)?.[1].trim().toLowerCase();
    const dir = attr('dir');
    const textDir = dir === 'rtl' || dir === 'ltr' ? dir : RTL_LANG.test(attr('lang') ?? this.info.language ?? '') ? 'rtl' : 'ltr';
    doc.getElementById('reader-dir')!.textContent = `:where(body:not([dir])){direction:${textDir};}`;

    const body = doc.importNode(chapter.body, true) as HTMLElement;
    html.replaceChild(body, doc.body);
    this.layout();
    this.drawHighlights();
  }

  /** Applies geometry and preference CSS to the mounted chapter. */
  private layout(): void {
    const width = Math.max(1, Math.floor(this.wrapper.clientWidth || this.container.clientWidth || 800));
    const height = Math.max(1, Math.floor(this.wrapper.clientHeight || this.container.clientHeight || 600));
    const fixed = this.pkg.fixedLayout;
    const g = computeGeometry(this.prefs, width, height, fixed);
    this.geometry = g;
    this.frame.style.width = `${g.width}px`;
    this.frame.style.height = `${g.height}px`;
    this.wrapper.style.background = this.colors.paper;
    this.frame.style.background = this.colors.paper;
    this.doc.getElementById('reader-prefs')!.textContent =
      preferencesCss(this.prefs, this.colors, g, this.pkg.rtl) + '\nhtml{scroll-behavior:auto !important;}';
    this.layoutFixed();
    this.ensureNextButton();
    this.fragmentPositions.clear();
    this.measure();
  }

  private layoutFixed(): void {
    const style = this.doc.getElementById('reader-fixed')!;
    if (this.geometry.mode !== 'fixed' || !this.current) {
      style.textContent = '';
      return;
    }
    let vp = this.current.viewport;
    if (!vp) {
      style.textContent = '';
      const se = this.scroller();
      vp = { width: Math.max(1, se.scrollWidth), height: Math.max(1, se.scrollHeight) };
    }
    const g = this.geometry;
    const scale = Math.min(g.width / vp.width, g.height / vp.height);
    const x = (g.width - vp.width * scale) / 2;
    const y = (g.height - vp.height * scale) / 2;
    style.textContent =
      `html{width:${vp.width}px !important;height:${vp.height}px !important;overflow:hidden !important;` +
      `transform-origin:0 0;transform:translate(${x}px,${y}px) scale(${scale});}` +
      `body{width:${vp.width}px;height:${vp.height}px;}`;
  }

  private ensureNextButton(): void {
    const body = this.doc.body;
    const existing = body.querySelector(':scope > [data-reader-ui].reader-next');
    const next = this.current ? this.nextLinear(this.current.index) : null;
    const want = this.geometry.mode === 'scrolled' && next !== null;
    if (!want) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const title = this.titleForSpine(next!);
    const wrap = this.doc.createElement('div');
    wrap.setAttribute('data-reader-ui', '');
    wrap.className = 'reader-next';
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-reader-next', '');
    button.textContent = title ? `Next chapter · ${title}` : 'Next chapter';
    wrap.append(button);
    body.append(wrap);
  }

  private scroller(): Element {
    return this.doc.scrollingElement ?? this.doc.documentElement;
  }

  private measure(): void {
    const html = this.doc.documentElement;
    let spacer = html.querySelector(':scope > [data-reader-ui].reader-spacer') as HTMLElement | null;
    if (this.geometry.mode !== 'paginated') {
      spacer?.remove();
      this.pageCount = 1;
      return;
    }
    spacer?.remove();
    const se = this.scroller();
    const w = this.geometry.width;
    this.pageCount = Math.max(1, Math.ceil(se.scrollWidth / w - 0.02));
    if (this.pageIndex >= this.pageCount) this.pageIndex = this.pageCount - 1;
    // The last column ends short of a full page; stretch the scrollable
    // width so the last page can scroll fully into place.
    spacer = this.doc.createElement('div');
    spacer.setAttribute('data-reader-ui', '');
    spacer.className = 'reader-spacer';
    spacer.style.cssText = `position:absolute;top:0;${this.rtl ? 'right' : 'left'}:${this.pageCount * w - 1}px;width:1px;height:1px;`;
    html.append(spacer);
  }

  /** Paginated right-to-left: pages run leftwards and scrollLeft goes negative. */
  private get rtl(): boolean {
    return this.pkg.rtl && this.geometry?.mode === 'paginated';
  }

  /** Paginated scroll offset along the reading direction (always >= 0). */
  private scrollAlong(): number {
    const x = this.scroller().scrollLeft;
    return this.rtl ? -x : x;
  }

  /** Paginated: distance of a rect's leading edge from the chapter's first page start. */
  private along(r: DOMRect): number {
    return this.rtl ? this.geometry.width - r.right + this.scrollAlong() : r.left + this.scrollAlong();
  }

  private setPage(page: number): void {
    this.pageIndex = Math.max(0, Math.min(page, this.pageCount - 1));
    const se = this.scroller();
    this.programmaticScroll = true;
    se.scrollLeft = (this.rtl ? -1 : 1) * this.pageIndex * this.geometry.width;
    se.scrollTop = 0;
    this.programmaticScroll = false;
  }

  private setScrollTop(y: number): void {
    const se = this.scroller();
    this.programmaticScroll = true;
    se.scrollTop = Math.max(0, y);
    this.programmaticScroll = false;
  }

  /** Paginated: the page holding a rect (frame viewport coordinates). */
  private pageForRect(r: DOMRect): number {
    return Math.max(0, Math.min(this.pageCount - 1, Math.floor((this.along(r) + 1) / this.geometry.width)));
  }

  private position(target: Target): void {
    const mode = this.geometry.mode;
    if (mode === 'fixed') {
      this.setScrollTop(0);
      if (target.kind === 'quote' && target.flash) this.flashQuote(target);
      return;
    }
    this.measure();
    switch (target.kind) {
      case 'progression':
        this.positionProgression(target.value);
        return;
      case 'end':
        if (mode === 'paginated') this.setPage(this.pageCount - 1);
        else this.setScrollTop(this.scroller().scrollHeight);
        return;
      case 'offset': {
        const rect = this.offsetRect(target.value);
        if (rect) this.positionRect(rect);
        return;
      }
      case 'fragment': {
        const el = this.fragmentElement(target.id);
        if (el) this.positionRect(el.getBoundingClientRect());
        else this.positionProgression(target.fallback);
        return;
      }
      case 'quote': {
        const found = this.anchor(target.quote, target.progression);
        if (!found) {
          this.positionProgression(target.progression ?? 0);
          return;
        }
        const range = this.textIndex().range(found.start, found.end);
        const rect = range ? firstRect(range) : null;
        if (rect) {
          if (mode === 'scrolled' && target.jump) {
            // Leave a little context above the match.
            this.setScrollTop(rect.top + this.scroller().scrollTop - this.geometry.height * 0.25);
          } else this.positionRect(rect);
        }
        if (target.flash && range) this.flash(range);
      }
    }
  }

  private positionProgression(p: number): void {
    const se = this.scroller();
    if (this.geometry.mode === 'paginated') this.setPage(Math.floor(clamp01(p) * this.pageCount + 1e-6));
    else this.setScrollTop(clamp01(p) * se.scrollHeight);
  }

  private positionRect(rect: DOMRect): void {
    if (this.geometry.mode === 'paginated') this.setPage(this.pageForRect(rect));
    else this.setScrollTop(rect.top + this.scroller().scrollTop);
  }

  private fragmentElement(id: string): Element | null {
    const body = this.doc.body;
    const el = this.doc.getElementById(id);
    if (el && body.contains(el)) return el;
    try {
      return body.querySelector(`[name="${CSS.escape(id)}"]`);
    } catch {
      return null;
    }
  }

  private offsetRect(offset: number): DOMRect | null {
    const idx = this.textIndex();
    const range = idx.range(offset, Math.min(offset + 1, idx.length));
    const rect = range ? firstRect(range) : null;
    if (rect) return rect;
    const point = idx.point(offset);
    const parent = point?.node.parentElement;
    return parent ? parent.getBoundingClientRect() : null;
  }

  // ---------------------------------------------------------------- positions

  private textIndex(): TextIndex {
    if (!this.index || this.index.root !== this.doc.body) this.index = new TextIndex(this.doc.body);
    return this.index;
  }

  private progression(): number {
    const g = this.geometry;
    if (!g || g.mode === 'fixed') return 0;
    if (g.mode === 'paginated') return this.pageCount > 0 ? clamp01(this.pageIndex / this.pageCount) : 0;
    const se = this.scroller();
    return se.scrollHeight > 0 ? clamp01(se.scrollTop / se.scrollHeight) : 0;
  }

  private totalProgression(spine: number, progression: number): number {
    const item = this.pkg.spine[spine];
    const before = this.sizeBefore.get(spine) ?? 0;
    return clamp01((before + (item?.linear ? progression * item.size : 0)) / this.totalSize);
  }

  /** Raw text offset of the first character visible at the top (or page start). */
  private firstVisibleOffset(): number | null {
    if (!this.current || !this.geometry || this.geometry.mode === 'fixed') return null;
    const idx = this.textIndex();
    const nodes = idx.nodes;
    if (nodes.length === 0) return null;
    const paginated = this.geometry.mode === 'paginated';
    const rtl = this.rtl;
    const w = this.geometry.width;
    const range = this.doc.createRange();
    const visibleAfterStart = (r: DOMRect) => (!paginated ? r.bottom > 1 : rtl ? r.left < w - 1 : r.right > 1);
    // Predicate for node i: its last line reaches into or past the viewport.
    const nodeTest = (i: number): boolean | null => {
      range.selectNodeContents(nodes[i]);
      const rects = range.getClientRects();
      if (rects.length === 0) return null;
      return visibleAfterStart(rects[rects.length - 1]);
    };
    const test = (i: number): boolean => {
      for (let k = i; k < Math.min(nodes.length, i + 64); k++) {
        const v = nodeTest(k);
        if (v !== null) return v;
      }
      return true;
    };
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(mid)) hi = mid;
      else lo = mid + 1;
    }
    // Skip to a node that actually renders.
    let i = lo;
    while (i < nodes.length - 1 && nodeTest(i) === null) i++;
    const node = nodes[i];
    const data = node.data;
    const charTest = (k: number): boolean => {
      range.setStart(node, k);
      range.setEnd(node, Math.min(k + 1, data.length));
      const rects = range.getClientRects();
      if (rects.length === 0) return false;
      return visibleAfterStart(rects[rects.length - 1]);
    };
    let a = 0;
    let b = data.length - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (charTest(mid)) b = mid;
      else a = mid + 1;
    }
    // Land on a visible character, not collapsed whitespace.
    while (a < data.length - 1 && /\s/.test(data[a])) a++;
    return idx.starts[i] + Math.max(0, a);
  }

  /** Layout position (0..1 through the chapter) of a text span. */
  private layoutPosition(start: number, end: number): number | null {
    const range = this.textIndex().range(start, end);
    const rect = range ? firstRect(range) : null;
    if (!rect) return null;
    const se = this.scroller();
    if (this.geometry.mode === 'paginated') return se.scrollWidth > 0 ? clamp01(this.along(rect) / se.scrollWidth) : null;
    return se.scrollHeight > 0 ? clamp01((rect.top + se.scrollTop) / se.scrollHeight) : null;
  }

  private anchor(quote: TextQuote, progression: number | null): { start: number; end: number } | null {
    const idx = this.textIndex();
    return anchorQuote(idx, quote, progression, (s, e) => this.layoutPosition(s, e));
  }

  // ---------------------------------------------------------------- titles and locators

  private titleForSpine(spine: number): string | null {
    const item = this.pkg.spine[spine];
    const entries = item ? this.tocByPath.get(item.href) : undefined;
    if (entries?.length) return entries[0].title;
    let best: { entry: TocEntry; spine: number } | null = null;
    for (const t of this.tocSpine) if (t.spine < spine && (!best || t.spine >= best.spine)) best = t;
    return best?.entry.title ?? null;
  }

  private fragmentPosition(id: string): number | null {
    if (this.fragmentPositions.has(id)) return this.fragmentPositions.get(id)!;
    const el = this.fragmentElement(id);
    let pos: number | null = null;
    if (el) {
      const r = el.getBoundingClientRect();
      const se = this.scroller();
      if (this.geometry.mode === 'paginated') {
        // Column index plus the fraction down that column.
        const step = this.geometry.width / this.geometry.columns;
        pos = Math.floor((this.along(r) + 1) / step) + clamp01(r.top / this.geometry.height);
      } else pos = r.top + se.scrollTop;
    }
    this.fragmentPositions.set(id, pos);
    return pos;
  }

  private currentTitle(): string | null {
    const ch = this.current;
    if (!ch) return null;
    const entries = this.tocByPath.get(ch.href);
    if (!entries?.length) return this.titleForSpine(ch.index);
    if (entries.length === 1 || this.geometry.mode === 'fixed') return entries[0].title;
    const paginated = this.geometry.mode === 'paginated';
    const here = paginated
      ? this.pageIndex * this.geometry.columns + 0.2
      : this.scroller().scrollTop + this.geometry.height * 0.2;
    let title: string | null = null;
    for (const e of entries) {
      const frag = splitHref(e.href).fragment;
      if (!frag) {
        if (title === null) title = e.title;
        continue;
      }
      const pos = this.fragmentPosition(frag);
      if (pos !== null && pos <= here) title = e.title;
    }
    return title ?? entries[0].title;
  }

  private emitLocator(): void {
    const ch = this.current;
    if (!ch || this.destroyed) return;
    const progression = this.progression();
    const locator: ReadingLocator = {
      href: ch.href,
      progression,
      totalProgression: this.totalProgression(ch.index, progression),
      title: this.currentTitle(),
      engine: 'web',
      raw: null,
    };
    this.base = locator;
    this.anchorPending = true;
    this.cb.onLocator(locator);
  }

  get locator(): ReadingLocator | null {
    if (this.anchorPending && this.base && !this.destroyed) {
      this.anchorPending = false;
      this.base = { ...this.base, raw: this.positionAnchor(this.base) };
    }
    return this.base;
  }

  /**
   * The base locator as a Readium locator plus the first visible words, so
   * the saved position survives another window size or font. Mobile reads
   * `href` + `progression` from non-Readium locators; the quote is extra.
   */
  private positionAnchor(base: ReadingLocator): Record<string, unknown> | null {
    const ch = this.current;
    if (!ch || ch.href !== base.href) return null;
    const raw: Record<string, unknown> = {
      href: ch.href,
      type: this.pkg.spine[ch.index].mediaType || 'application/xhtml+xml',
      title: base.title,
      locations: { progression: base.progression, totalProgression: base.totalProgression },
    };
    const offset = this.firstVisibleOffset();
    if (offset === null) return raw;
    const text = this.textIndex().text;
    const highlight = text.slice(offset, offset + POSITION_QUOTE);
    if (highlight.trim()) raw.text = { before: text.slice(Math.max(0, offset - POSITION_QUOTE), offset), highlight, after: '' };
    return raw;
  }

  get page(): PageInfo | null {
    if (!this.current || this.geometry?.mode !== 'paginated') return null;
    return { index: this.pageIndex, count: this.pageCount };
  }

  // ---------------------------------------------------------------- highlights

  private drawHighlights(): void {
    const ch = this.current;
    if (!ch) return;
    const body = this.doc.body;
    clearMarks(body);
    this.index = null;
    if (ch.failed || this.highlights.length === 0) return;
    const idx = this.textIndex();
    const spans: MarkSpan[] = [];
    for (const h of this.highlights) {
      const loc = obj(h.locator);
      if (!loc) continue;
      const href = str(loc.href);
      if (!href || this.spineIndexFor(href) !== ch.index) continue;
      const text = obj(loc.text);
      const quote: TextQuote = {
        highlight: str(text?.highlight) ?? h.text ?? '',
        before: str(text?.before) ?? '',
        after: str(text?.after) ?? '',
      };
      const found = anchorQuote(idx, quote, num(obj(loc.locations)?.progression), (s, e) => this.layoutPosition(s, e));
      if (!found) continue;
      const color = h.color in this.colors.highlightTints ? h.color : 'yellow';
      spans.push({ id: h.id, color, start: found.start, end: found.end });
    }
    drawMarks(idx, spans);
    this.index = null;
  }

  private flash(range: Range): void {
    try {
      const w = this.win as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (r: Range) => unknown };
      const registry = w.CSS?.highlights;
      if (!registry || !w.Highlight) return;
      registry.set('reader-flash', new w.Highlight(range));
      clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => registry.delete('reader-flash'), 1600);
    } catch {
      // Custom highlights are a nicety.
    }
  }

  private flashQuote(target: Extract<Target, { kind: 'quote' }>): void {
    const found = this.anchor(target.quote, target.progression);
    const range = found ? this.textIndex().range(found.start, found.end) : null;
    if (range) this.flash(range);
  }

  // ---------------------------------------------------------------- events

  private hasSelection(): boolean {
    const sel = this.win.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0;
  }

  private toHostRect(r: DOMRect): DOMRect {
    const fr = this.frame.getBoundingClientRect();
    const sx = this.frame.offsetWidth ? fr.width / this.frame.offsetWidth : 1;
    const sy = this.frame.offsetHeight ? fr.height / this.frame.offsetHeight : 1;
    return new DOMRect(fr.left + r.left * sx, fr.top + r.top * sy, r.width * sx, r.height * sy);
  }

  private onClick(e: MouseEvent): void {
    const node = e.target as Node | null;
    const target = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
    if (!target) return;
    const link = target.closest('a');
    const href = link ? link.getAttribute('href') ?? link.getAttributeNS(XLINK_NS, 'href') : null;
    if (link && href) {
      e.preventDefault();
      if (!this.hasSelection()) this.followLink(href);
      return;
    }
    if (target.closest('[data-reader-next]')) {
      e.preventDefault();
      void this.nextChapter();
      return;
    }
    const wasSelecting = this.hadSelectionAtDown;
    this.hadSelectionAtDown = false;
    if (this.hasSelection() || wasSelecting) return;
    const mark = target.closest('[data-hl-id]');
    if (mark) {
      this.cb.onHighlightClick(mark.getAttribute('data-hl-id')!, this.toHostRect(mark.getBoundingClientRect()));
      return;
    }
    if (e.detail > 1 || Date.now() < this.suppressTapUntil) return;
    const host = this.toHostRect(new DOMRect(e.clientX, e.clientY, 0, 0));
    const cr = this.container.getBoundingClientRect();
    this.cb.onTap(cr.width > 0 ? clamp01((host.left - cr.left) / cr.width) : 0.5);
  }

  private followLink(href: string): void {
    const trimmed = href.trim();
    if (/^(https?|mailto|tel):/i.test(trimmed)) {
      this.cb.onExternalLink(trimmed);
      return;
    }
    if (isExternal(trimmed) || !this.current) return;
    const r = resolveRef(this.current.href, trimmed);
    if (!r) return;
    void this.goToHref(r.fragment ? `${r.path}#${r.fragment}` : r.path);
  }

  private onScroll(): void {
    if (this.destroyed || !this.current) return;
    if (this.geometry.mode === 'paginated') {
      if (!this.programmaticScroll && !this.pointerDown && Math.abs(this.scrollAlong() - this.pageIndex * this.geometry.width) > 1) {
        this.snapPage();
      }
      return;
    }
    if (this.scrollFrame || this.scrollTimer) return;
    // rAF when visible; the timer keeps locators flowing if frames are paused.
    const run = () => {
      cancelAnimationFrame(this.scrollFrame);
      clearTimeout(this.scrollTimer);
      this.scrollFrame = 0;
      this.scrollTimer = 0;
      this.emitLocator();
    };
    this.scrollFrame = requestAnimationFrame(run);
    this.scrollTimer = window.setTimeout(run, 150);
  }

  /** Re-aligns to a page after the browser scrolled on its own (selection drag, focus). */
  private snapPage(): void {
    const page = Math.round(this.scrollAlong() / this.geometry.width);
    const changed = page !== this.pageIndex;
    this.setPage(page);
    if (changed) this.emitLocator();
  }

  private onWheel(e: WheelEvent): void {
    if (this.geometry?.mode !== 'paginated' || e.ctrlKey) {
      this.sticky = null;
      return;
    }
    e.preventDefault();
    this.sticky = null;
    const now = Date.now();
    // Horizontal swipes follow the page direction; wheels always read down as forward.
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? (this.rtl ? -e.deltaX : e.deltaX) : e.deltaY;
    if (now < this.wheelLockUntil) {
      // Trackpad momentum: keep the lock while events keep coming.
      this.wheelLockUntil = now + 180;
      return;
    }
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.wheelAccum += d * scale;
    if (Math.abs(this.wheelAccum) < 40) return;
    const forward = this.wheelAccum > 0;
    this.wheelAccum = 0;
    this.wheelLockUntil = now + 350;
    void (forward ? this.next() : this.previous());
  }

  private onTouchStart(e: TouchEvent): void {
    this.sticky = null;
    if (e.touches.length !== 1) {
      this.touchStart = null;
      return;
    }
    const t = e.touches[0];
    this.touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
  }

  private onTouchEnd(e: TouchEvent): void {
    this.scheduleSelection(60);
    const start = this.touchStart;
    this.touchStart = null;
    if (!start || this.geometry?.mode !== 'paginated' || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - start.t > 800 || this.hasSelection()) return;
    this.suppressTapUntil = Date.now() + 400;
    void (dx < 0 !== this.rtl ? this.next() : this.previous());
  }

  private scheduleRelayout(): void {
    if (this.relayoutFrame || this.relayoutTimer || this.destroyed) return;
    const run = () => {
      cancelAnimationFrame(this.relayoutFrame);
      clearTimeout(this.relayoutTimer);
      this.relayoutFrame = 0;
      this.relayoutTimer = 0;
      if (!this.current || this.destroyed) return;
      this.fragmentPositions.clear();
      if (this.geometry.mode === 'fixed') {
        this.layoutFixed();
        return;
      }
      this.measure();
      if (this.sticky) {
        this.position(this.sticky);
        this.emitLocator();
      } else if (this.geometry.mode === 'paginated') {
        this.setPage(this.pageIndex);
      }
    };
    this.relayoutFrame = requestAnimationFrame(run);
    this.relayoutTimer = window.setTimeout(run, 150);
  }

  private scheduleSelection(delay: number): void {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.reportSelection(), delay);
  }

  private clearSelectionState(): void {
    clearTimeout(this.selectionTimer);
    if (this.selectionKey !== null) {
      this.selectionKey = null;
      this.cb.onSelection(null);
    }
  }

  private reportSelection(): void {
    if (this.destroyed || !this.current) return;
    const sel = this.win.getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range || !this.doc.body.contains(range.commonAncestorContainer)) {
      this.clearSelectionState();
      return;
    }
    const idx = this.textIndex();
    const start = idx.offsetOf(range.startContainer, range.startOffset);
    const end = idx.offsetOf(range.endContainer, range.endOffset);
    const highlight = idx.text.slice(start, end);
    if (end <= start || !highlight.trim()) {
      this.clearSelectionState();
      return;
    }
    const key = `${this.current.index}:${start}:${end}`;
    const rect = range.getBoundingClientRect();
    if (key === this.selectionKey && this.pointerDown) return;
    this.selectionKey = key;
    const progression = this.layoutPosition(start, end) ?? this.progression();
    const ch = this.current;
    const locator: Record<string, unknown> = {
      href: ch.href,
      type: this.pkg.spine[ch.index].mediaType || 'application/xhtml+xml',
      title: this.currentTitle(),
      locations: { progression, totalProgression: this.totalProgression(ch.index, progression) },
      text: {
        before: idx.text.slice(Math.max(0, start - CONTEXT), start),
        highlight,
        after: idx.text.slice(end, end + CONTEXT),
      },
    };
    this.cb.onSelection({
      locator,
      text: sel!.toString().replace(/\s+/g, ' ').trim() || highlight.replace(/\s+/g, ' ').trim(),
      rect: this.toHostRect(rect),
    });
  }

  private schedulePreload(): void {
    clearTimeout(this.preloadTimer);
    const current = this.current?.index;
    if (current === undefined) return;
    this.preloadTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      const next = this.nextLinear(current);
      const prev = this.previousLinear(current);
      if (next !== null) void this.chapter(next);
      if (prev !== null) void this.chapter(prev);
    }, 250);
  }

  // ---------------------------------------------------------------- ReaderEngine

  async goTo(locator: ReadingLocator): Promise<void> {
    const resolved = this.resolveLocator(locator, true);
    if (!resolved) return;
    await this.display(resolved[0], resolved[1]);
  }

  async goToHref(href: string): Promise<void> {
    const spine = this.spineIndexFor(href);
    if (spine === null) return;
    const { fragment } = splitHref(href);
    await this.display(spine, fragment ? { kind: 'fragment', id: fragment, fallback: 0 } : { kind: 'progression', value: 0 });
  }

  async next(): Promise<boolean> {
    if (!this.current) return false;
    this.sticky = null;
    const mode = this.geometry.mode;
    if (mode === 'scrolled') {
      const se = this.scroller();
      if (se.scrollTop + se.clientHeight < se.scrollHeight - 2) {
        this.scrollBy(0.9);
        return true;
      }
      return this.nextChapter();
    }
    if (mode === 'paginated') {
      this.remeasure();
      if (this.pageIndex < this.pageCount - 1) {
        this.setPage(this.pageIndex + 1);
        this.turned(true);
        this.emitLocator();
        return true;
      }
    }
    const moved = await this.nextChapter();
    if (moved) this.turned(true);
    return moved;
  }

  async previous(): Promise<boolean> {
    if (!this.current) return false;
    this.sticky = null;
    const mode = this.geometry.mode;
    if (mode === 'paginated' && this.pageIndex > 0) {
      this.setPage(this.pageIndex - 1);
      this.turned(false);
      this.emitLocator();
      return true;
    }
    if (mode === 'scrolled' && this.scroller().scrollTop > 2) {
      this.scrollBy(-0.9);
      return true;
    }
    const prev = this.previousLinear(this.current.index);
    if (prev === null) return false;
    await this.display(prev, mode === 'fixed' ? { kind: 'progression', value: 0 } : { kind: 'end' });
    if (mode !== 'scrolled') this.turned(false);
    return true;
  }

  async nextChapter(): Promise<boolean> {
    if (!this.current) return false;
    const next = this.nextLinear(this.current.index);
    if (next === null) return false;
    await this.display(next, { kind: 'progression', value: 0 });
    return true;
  }

  async previousChapter(): Promise<boolean> {
    if (!this.current) return false;
    const prev = this.previousLinear(this.current.index);
    if (prev === null) return false;
    await this.display(prev, { kind: 'progression', value: 0 });
    return true;
  }

  async toChapterStart(): Promise<void> {
    if (this.current) await this.display(this.current.index, { kind: 'progression', value: 0 });
  }

  scrollBy(screens: number): void {
    if (!this.current || this.destroyed) return;
    if (this.geometry.mode !== 'scrolled') {
      void (screens > 0 ? this.next() : this.previous());
      return;
    }
    this.sticky = null;
    this.win.scrollBy({ top: this.scroller().clientHeight * screens, behavior: this.reducedMotion.matches ? 'auto' : 'smooth' });
  }

  /** Late images or fonts can lengthen a chapter between relayouts; the spacer keeps it from shrinking. */
  private remeasure(): void {
    if (this.scroller().scrollWidth > this.pageCount * this.geometry.width + 1) this.measure();
  }

  /** A short slide in the reading direction, so a page turn reads as one. Compositor-only. */
  private turned(forward: boolean): void {
    if (this.reducedMotion.matches || typeof this.frame.animate !== 'function') return;
    this.turnAnimation?.cancel();
    const dx = (forward !== this.rtl ? 1 : -1) * Math.min(24, Math.round(this.geometry.width * 0.02));
    this.turnAnimation = this.frame.animate(
      [
        { transform: `translateX(${dx}px)`, opacity: 0.6 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: TURN_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    );
  }

  applyPreferences(prefs: ReaderPreferences, colors: EngineColors): void {
    const keep = this.current ? this.keepTarget() : null;
    const flowChanged = prefs.flow !== this.prefs.flow;
    this.prefs = prefs;
    this.colors = colors;
    if (!this.current || !keep) return;
    if (flowChanged) this.doc.body.querySelector(':scope > [data-reader-ui].reader-next')?.remove();
    this.relayoutKeeping(keep);
  }

  resize(): void {
    // A hidden (zero-size) container would lose the position; wait for a real size.
    if (!this.current || this.destroyed || !this.wrapper.clientWidth || !this.wrapper.clientHeight) return;
    this.relayoutKeeping(this.keepTarget());
  }

  /**
   * What to hold on screen through a relayout. Until the reader moves, the
   * last target is kept, so a window drag or a run of size steps cannot
   * drift; after that, the first visible character.
   */
  private keepTarget(): Target {
    if (this.sticky) return this.sticky;
    const anchor = this.firstVisibleOffset();
    return anchor !== null ? { kind: 'offset', value: anchor } : { kind: 'progression', value: this.progression() };
  }

  private relayoutKeeping(target: Target): void {
    this.layout();
    this.position(target);
    this.sticky = target;
    this.emitLocator();
  }

  setHighlights(highlights: Highlight[]): void {
    this.highlights = highlights.filter((h) => !h.deleted);
    if (this.current) this.drawHighlights();
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchMatch[]> {
    const needle = query.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) return [];
    const out: SearchMatch[] = [];
    let sliceStart = performance.now();
    for (const spine of this.linear) {
      if (signal?.aborted || this.destroyed) throw abortError();
      const text = await this.plainTextFor(spine);
      if (signal?.aborted || this.destroyed) throw abortError();
      const lower = lowerQuote(text);
      const item = this.pkg.spine[spine];
      const title = this.titleForSpine(spine);
      for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
        const end = i + needle.length;
        const progression = text.length > 0 ? i / text.length : 0;
        const totalProgression = this.totalProgression(spine, progression);
        const match = text.slice(i, end);
        out.push({
          before: trimLeftWord(text.slice(Math.max(0, i - SEARCH_CONTEXT), i), i > SEARCH_CONTEXT),
          match,
          after: trimRightWord(text.slice(end, end + SEARCH_CONTEXT), end + SEARCH_CONTEXT < text.length),
          locator: {
            href: item.href,
            progression,
            totalProgression,
            title,
            engine: 'web',
            raw: {
              href: item.href,
              type: item.mediaType || 'application/xhtml+xml',
              title,
              locations: { progression, totalProgression },
              text: {
                before: text.slice(Math.max(0, i - CONTEXT), i),
                highlight: match,
                after: text.slice(end, end + CONTEXT),
              },
            },
          },
        });
        if (out.length >= MAX_SEARCH_RESULTS) return out;
      }
      // Stay responsive on long books.
      if (performance.now() - sliceStart > 12) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
    return out;
  }

  private async plainTextFor(spine: number): Promise<string> {
    const cached = this.plainCache.get(spine);
    if (cached !== undefined) return cached;
    let text = '';
    try {
      const item: SpineItem = this.pkg.spine[spine];
      const prepared = this.cache.get(spine);
      if (prepared) text = plainText((await prepared).body);
      else {
        const source = await this.zip.readText(item.href);
        if (source !== null) {
          const doc = parseMarkup(source, item.mediaType);
          const body = doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'body')[0] ?? doc.getElementsByTagName('body')[0];
          text = body ? plainText(body) : '';
        }
      }
    } catch {
      text = '';
    }
    this.plainCache.set(spine, text);
    return text;
  }

  clearSelection(): void {
    try {
      this.win?.getSelection()?.removeAllRanges();
    } catch {
      // Frame already gone.
    }
    this.clearSelectionState();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.navToken++;
    clearTimeout(this.preloadTimer);
    clearTimeout(this.selectionTimer);
    clearTimeout(this.flashTimer);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    clearTimeout(this.scrollTimer);
    if (this.relayoutFrame) cancelAnimationFrame(this.relayoutFrame);
    clearTimeout(this.relayoutTimer);
    for (const fn of this.cleanup) {
      try {
        fn();
      } catch {
        // The frame document may already be detached.
      }
    }
    this.cleanup.length = 0;
    this.turnAnimation?.cancel();
    this.wrapper.remove();
    this.cache.clear();
    this.plainCache.clear();
    this.current = null;
    this.index = null;
    this.res.destroy();
  }
}

function firstRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (const r of Array.from(rects)) if (r.width > 0 || r.height > 0) return r;
  const b = range.getBoundingClientRect();
  return b.width > 0 || b.height > 0 ? b : null;
}

function trimLeftWord(s: string, cut: boolean): string {
  if (!cut) return s;
  const i = s.search(/\s/);
  return i >= 0 && i < 20 ? s.slice(i + 1) : s;
}

function trimRightWord(s: string, cut: boolean): string {
  if (!cut) return s;
  const i = s.lastIndexOf(' ');
  return i > s.length - 20 ? s.slice(0, i) : s;
}
