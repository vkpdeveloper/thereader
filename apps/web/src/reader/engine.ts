import type { InkPen } from '../lib/inkPaths';
import type { InkStroke } from '../lib/services/ink';
import type { Highlight, ReaderPreferences, ReadingLocator } from '../lib/types';

/**
 * The EPUB engine boundary. UI code never touches engine internals; it calls
 * `openPublication` (implemented in `./epub/`) and works with `ReaderEngine`.
 */

export interface TocEntry {
  title: string;
  /** Container path, optionally with `#fragment`. */
  href: string;
  depth: number;
}

export interface PublicationInfo {
  title: string;
  author: string;
  language: string | null;
  toc: TocEntry[];
  spineCount: number;
  /** Page progression from the spine (`page-progression-direction`), as Readium reads it. */
  readingProgression: 'ltr' | 'rtl';
}

/** Paginated position inside the current chapter; a page is one screen (one spread on wide screens). */
export interface PageInfo {
  index: number;
  count: number;
}

/** Colours the engine paints with; resolved from the active theme preset. */
export interface EngineColors {
  paper: string;
  ink: string;
  muted: string;
  link: string;
  selection: string;
  /** Highlight colour key (`yellow`, ...) -> opaque CSS tint for this paper. */
  highlightTints: Record<string, string>;
}

export interface SelectionInfo {
  /** Readium-shaped locator: href, type, title, locations, text {before, highlight, after}. */
  locator: Record<string, unknown>;
  text: string;
  /** Bounding rect of the selection in the host window's viewport coordinates. */
  rect: DOMRect;
}

export interface SearchMatch {
  /** Text around the match; `match` is the matched substring inside it. */
  before: string;
  match: string;
  after: string;
  locator: ReadingLocator;
}

export interface EngineCallbacks {
  /** Fired whenever the visible position changes (debounce is the host's job). */
  onLocator(locator: ReadingLocator): void;
  /** Non-empty text selection finished, or cleared (null). */
  onSelection(selection: SelectionInfo | null): void;
  /** A drawn highlight was clicked; rect in host viewport coordinates. */
  onHighlightClick(id: string, rect: DOMRect): void;
  /** Click on the page that was not a link, selection or highlight. `x` is 0..1 across the reader. */
  onTap(x: number): void;
  /** Links leaving the book (http, https, mailto, tel). */
  onExternalLink(url: string): void;
  /** A hovered or focused external HTTPS link inside the book frame. */
  onLinkHover(link: { url: string; rect: DOMRect } | null): void;
  /** User scrolls or swipes the reading surface. */
  onReadingGesture(): void;
  /** Pointer position in the host viewport while over the reading frame. */
  onReadingPointer(y: number): void;
  /** Keydown inside the book frame, forwarded so host shortcuts keep working. */
  onKey(event: KeyboardEvent): void;
  /**
   * Input inside the book frame (keys, pointer, wheel, touch), at most every
   * few seconds. The page's own input never reaches the host's document, so
   * this keeps the reading clock from taking the reader for idle.
   */
  onActivity(): void;
}

/**
 * Random-access EPUB bytes: the library's `BookFile`. `provisional` files
 * are still downloading (reads wait for missing bytes), so the engine does
 * not preload neighbouring chapters from them.
 */
export interface BookBytes {
  readonly size: number;
  readonly provisional: boolean;
  read(start: number, end: number): Promise<Uint8Array>;
  slice(start: number, end: number, type?: string): Promise<Blob>;
  close(): void;
}

export interface OpenOptions {
  /** The book. The engine owns it from here and closes it on `destroy` (or a failed open). */
  file: BookBytes;
  container: HTMLElement;
  prefs: ReaderPreferences;
  colors: EngineColors;
  /** Saved position (may come from mobile: `readium` or `dart`); null opens at the start. */
  initial: ReadingLocator | null;
  callbacks: EngineCallbacks;
}

export interface ReaderEngine {
  readonly info: PublicationInfo;
  /**
   * Current position, or null before the first layout. Reading it (e.g. to
   * save) also anchors the position to the first visible text, in a
   * Readium-shaped `raw`, so a reopen lands on the same words at any size.
   */
  readonly locator: ReadingLocator | null;
  /** Paginated flow only; null when scrolling or fixed-layout. */
  readonly page: PageInfo | null;
  goTo(locator: ReadingLocator): Promise<void>;
  goToHref(href: string): Promise<void>;
  /** Next page (paginated) or next screenful (scrolled); crosses chapters. False at the end. */
  next(): Promise<boolean>;
  previous(): Promise<boolean>;
  nextChapter(): Promise<boolean>;
  previousChapter(): Promise<boolean>;
  toChapterStart(): Promise<void>;
  /** Scrolled flow: scrolls by a fraction of the screen (negative = up). Paginated: turns a page. */
  scrollBy(screens: number): void;
  applyPreferences(prefs: ReaderPreferences, colors: EngineColors): void;
  /** Replaces the drawn highlights (live ones only). */
  setHighlights(highlights: Highlight[]): void;
  /**
   * Pen drawings: every stroke of this book. The current chapter's are
   * drawn inside the page, so they turn and scroll with its text, and are
   * placed again whenever a chapter is shown or laid out.
   */
  setInk(strokes: InkStroke[]): void;
  /** A host viewport point in ink coordinates (the chapter document's); null off the page. */
  inkPoint(x: number, y: number): [number, number] | null;
  /** Shows a stroke being drawn (ink coordinates), or clears it. */
  drawLiveInk(points: number[] | null, pen: InkPen): void;
  /** Anchors a finished stroke (ink coordinates) to the chapter text nearest it. */
  anchorInk(points: number[]): Pick<InkStroke, 'anchor' | 'points'> | null;
  /** Drawn strokes passing within `reach` host pixels (beyond their half width) of an ink point. */
  inkHits(x: number, y: number, reach: number): InkStroke[];
  /** Drawn strokes on the page in view. */
  inkOnScreen(): InkStroke[];
  /** A wheel turned over a layer above the page (the pen's): pages turn or the chapter scrolls as if over the page. */
  wheel(event: WheelEvent): void;
  /** Scrolled flow: scrolls by pixels at once (a finger dragging under the pen). */
  panBy(dy: number): void;
  search(query: string, signal?: AbortSignal): Promise<SearchMatch[]>;
  clearSelection(): void;
  /** Re-layout after the container size changed. */
  resize(): void;
  destroy(): void;
}

export type OpenPublication = (options: OpenOptions) => Promise<ReaderEngine>;
