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
  /** Keydown inside the book frame, forwarded so host shortcuts keep working. */
  onKey(event: KeyboardEvent): void;
}

export interface OpenOptions {
  /** Verified EPUB bytes. */
  data: Blob;
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
  search(query: string, signal?: AbortSignal): Promise<SearchMatch[]>;
  clearSelection(): void;
  /** Re-layout after the container size changed. */
  resize(): void;
  destroy(): void;
}

export type OpenPublication = (options: OpenOptions) => Promise<ReaderEngine>;
