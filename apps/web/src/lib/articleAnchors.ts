/**
 * Highlights in saved web articles. They live in the highlight store and
 * sync as ordinary `highlight` changes, pinned to the article rather than an
 * EPUB edition: `bookId` is `article-<article id>` and `sha256` a sentinel,
 * so they never match a book (docs/cloud-sync.md, "Article highlights").
 *
 * A passage is anchored to the article's top-level blocks (`article.blocks`,
 * found in the page by `data-block-index`): the first and last block and
 * UTF-16 offsets into each block's text, plus the quote with some context
 * around it in the Readium `text` shape. Offsets survive typography and
 * layout changes; when the text moved (a re-saved article, an image that
 * fell back to its alt text) the quote finds the passage again near where
 * it was. Everything here works on block texts, so it needs no DOM.
 */

/** The edition every article highlight uses; the article is in `bookId`. */
export const ARTICLE_HIGHLIGHT_SHA = '0'.repeat(64);

const BOOK_ID = /^article-([a-f0-9]{32})$/;
/** Characters of context kept on each side of the quote. */
const CONTEXT = 32;
/** Blocks searched on each side of the recorded ones before the whole article. */
const NEAR = 6;
/** Joins block texts in quotes and searches. */
const SEPARATOR = '\n';

export const articleHighlightBookId = (articleId: string): string => `article-${articleId}`;

/** The article a highlight belongs to, or null for a book highlight. */
export function articleIdOf(h: { bookId: string; sha256: string }): string | null {
  if (h.sha256 !== ARTICLE_HIGHLIGHT_SHA) return null;
  return BOOK_ID.exec(h.bookId)?.[1] ?? null;
}

/** A passage: from `start` in block `startBlock` to `end` in block `endBlock`. */
export interface ArticleSpan {
  startBlock: number;
  start: number;
  endBlock: number;
  end: number;
}

/**
 * Text of one top-level block as the reader draws it, or null when the block
 * has no text (renders nothing, an image, a rule). Callers cache it.
 */
export type BlockText = (index: number) => string | null;

/** The synced locator of an article highlight. */
export interface ArticleLocator {
  type: 'article';
  /** The article's URL; required of every highlight locator by the API. */
  href: string;
  articleId: string;
  block: number;
  start: number;
  endBlock: number;
  end: number;
  /** The section heading above the passage, for lists. */
  title?: string;
  /** Share of the article before the passage, for ordering (store `position`). */
  locations: { progression: number; totalProgression: number };
  /** The passage and context; may lose `before`/`after` (or all) to the API's size cap. */
  text?: { before?: string; highlight?: string; after?: string };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reads a stored locator; null when it is not a usable article locator. */
export function parseArticleLocator(raw: Record<string, unknown>): ArticleLocator | null {
  if (raw.type !== 'article' || typeof raw.href !== 'string' || typeof raw.articleId !== 'string') return null;
  const { block, start, end } = raw;
  const endBlock = raw.endBlock ?? block;
  if (!isInt(block) || !isInt(start) || !isInt(endBlock) || !isInt(end) || endBlock < block) return null;
  const loc = raw.locations as Record<string, unknown> | undefined;
  const progression = typeof loc?.totalProgression === 'number' ? loc.totalProgression : 0;
  const text = raw.text && typeof raw.text === 'object' ? (raw.text as Record<string, unknown>) : null;
  return {
    type: 'article',
    href: raw.href,
    articleId: raw.articleId,
    block,
    start,
    endBlock,
    end,
    title: str(raw.title),
    locations: { progression, totalProgression: progression },
    text: text ? { before: str(text.before), highlight: str(text.highlight), after: str(text.after) } : undefined,
  };
}

/**
 * Moves a span's ends off blocks without text and off block edges (a
 * selection that starts at the very end of one block starts in the next), so
 * equal passages always get equal spans. Null when nothing is left.
 */
export function normalizeSpan(span: ArticleSpan, text: BlockText, count: number): ArticleSpan | null {
  let { startBlock, start, endBlock, end } = span;
  for (;;) {
    const t = text(startBlock);
    if (t && start < t.length) break;
    if (++startBlock >= count) return null;
    start = 0;
  }
  for (;;) {
    const t = text(endBlock);
    if (t && end > 0) {
      end = Math.min(end, t.length);
      break;
    }
    if (--endBlock < 0) return null;
    end = text(endBlock)?.length ?? 0;
  }
  if (endBlock < startBlock || (endBlock === startBlock && end <= start)) return null;
  return { startBlock, start, endBlock, end };
}

/** The passage's text, blocks joined by a line break. */
export function spanText(span: ArticleSpan, text: BlockText): string {
  if (span.startBlock === span.endBlock) return (text(span.startBlock) ?? '').slice(span.start, span.end);
  const parts: string[] = [(text(span.startBlock) ?? '').slice(span.start)];
  for (let i = span.startBlock + 1; i < span.endBlock; i++) {
    const t = text(i);
    if (t) parts.push(t);
  }
  parts.push((text(span.endBlock) ?? '').slice(0, span.end));
  return parts.join(SEPARATOR);
}

/** Up to `n` characters before a point, reaching into earlier blocks. */
function before(block: number, offset: number, text: BlockText, n: number): string {
  let out = (text(block) ?? '').slice(Math.max(0, offset - n), offset);
  for (let i = block - 1; i >= 0 && out.length < n; i--) {
    const t = text(i);
    if (t) out = t.slice(Math.max(0, t.length - (n - out.length - 1))) + SEPARATOR + out;
  }
  return out.slice(-n);
}

/** Up to `n` characters after a point, reaching into later blocks. */
function after(block: number, offset: number, text: BlockText, count: number, n: number): string {
  let out = (text(block) ?? '').slice(offset, offset + n);
  for (let i = block + 1; i < count && out.length < n; i++) {
    const t = text(i);
    if (t) out = out + SEPARATOR + t.slice(0, n - out.length - 1);
  }
  return out.slice(0, n);
}

/**
 * The locator for a normalized span: offsets, the quote (at most
 * `maxQuote` characters; a longer passage is cut to that length first) with
 * context, and its share of the article for ordering.
 */
export function describeSpan(
  span: ArticleSpan,
  text: BlockText,
  count: number,
  info: { articleId: string; href: string; title?: string | null },
  maxQuote = 4000,
): ArticleLocator {
  let s = span;
  let quote = spanText(s, text);
  if (quote.length > maxQuote) {
    s = endAfter(s, maxQuote, text);
    quote = spanText(s, text);
  }
  const len = text(s.startBlock)?.length ?? 1;
  const progression = Math.min(1, Math.max(0, (s.startBlock + s.start / Math.max(1, len)) / Math.max(1, count)));
  return {
    type: 'article',
    href: info.href,
    articleId: info.articleId,
    block: s.startBlock,
    start: s.start,
    endBlock: s.endBlock,
    end: s.end,
    ...(info.title ? { title: info.title } : {}),
    locations: { progression, totalProgression: progression },
    text: { before: before(s.startBlock, s.start, text, CONTEXT), highlight: quote, after: after(s.endBlock, s.end, text, count, CONTEXT) },
  };
}

/** The span cut to its first `length` quote characters. */
function endAfter(span: ArticleSpan, length: number, text: BlockText): ArticleSpan {
  let left = length;
  let block = span.startBlock;
  let from = span.start;
  for (;;) {
    const t = text(block) ?? '';
    const stop = block === span.endBlock ? span.end : t.length;
    if (t && stop - from >= left) return { ...span, endBlock: block, end: from + left };
    if (t) left -= stop - from + SEPARATOR.length;
    if (left <= 0 || block >= span.endBlock) return { ...span, endBlock: block, end: stop };
    block++;
    from = 0;
  }
}

/** Length of the common suffix of two strings. */
function suffixMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of two strings. */
function prefixMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Block texts from `from` to `to` joined, with where each block starts. */
function joined(from: number, to: number, text: BlockText) {
  const segments: { block: number; at: number; length: number }[] = [];
  let all = '';
  for (let i = from; i <= to; i++) {
    const t = text(i);
    if (!t) continue;
    if (segments.length > 0) all += SEPARATOR;
    segments.push({ block: i, at: all.length, length: t.length });
    all += t;
  }
  return { all, segments };
}

/**
 * The best occurrence of the quote among blocks `from`..`to`: the one whose
 * context matches most, then the nearest to where it was. With `strict`, an
 * occurrence only counts when its context agrees or it is the only one.
 */
function search(loc: ArticleLocator, quote: string, from: number, to: number, text: BlockText, strict: boolean): ArticleSpan | null {
  const { all, segments } = joined(from, to, text);
  if (segments.length === 0) return null;
  const want = { before: loc.text?.before ?? '', after: loc.text?.after ?? '' };
  // Where the passage was, in this string's coordinates, for the distance tiebreak.
  const home = segments.find((s) => s.block >= loc.block);
  const expected = home ? home.at + (home.block === loc.block ? loc.start : 0) : all.length;
  let best: { at: number; score: number; distance: number } | null = null;
  let found = 0;
  for (let at = all.indexOf(quote); at >= 0 && found < 1000; at = all.indexOf(quote, at + 1)) {
    found++;
    const score =
      suffixMatch(all.slice(Math.max(0, at - want.before.length), at), want.before) +
      prefixMatch(all.slice(at + quote.length, at + quote.length + want.after.length), want.after);
    const distance = Math.abs(at - expected);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { at, score, distance };
  }
  if (!best || (strict && found > 1 && best.score === 0)) return null;
  const startAt = best.at;
  const endAt = best.at + quote.length;
  // The blocks holding each end; an end on a separator is put right by normalizeSpan.
  const first = lastSegment(segments, (at) => at <= startAt);
  const last = lastSegment(segments, (at) => at < endAt);
  return { startBlock: first.block, start: startAt - first.at, endBlock: last.block, end: Math.min(last.length, endAt - last.at) };
}

function lastSegment<T extends { at: number }>(segments: T[], test: (at: number) => boolean): T {
  let found = segments[0]!;
  for (const s of segments) if (test(s.at)) found = s;
  return found;
}

/**
 * Finds a stored passage in the article as drawn now: by its offsets when
 * the text there is still the quote, else by searching for the quote near
 * the recorded blocks, then anywhere in the article. Null when it is gone
 * (the highlight is kept, just not drawn).
 */
export function resolveLocator(loc: ArticleLocator, text: BlockText, count: number): ArticleSpan | null {
  const quote = loc.text?.highlight ?? '';
  const recorded: ArticleSpan = { startBlock: loc.block, start: loc.start, endBlock: loc.endBlock, end: loc.end };
  const startText = text(loc.block);
  const endText = text(loc.endBlock);
  const inRange = loc.endBlock < count && !!startText && !!endText && loc.start < startText.length && loc.end <= endText.length;
  if (inRange && (quote === '' || spanText(recorded, text) === quote)) return normalizeSpan(recorded, text, count);
  if (quote === '') return null;
  const near = search(loc, quote, Math.max(0, loc.block - NEAR), Math.min(count - 1, loc.endBlock + NEAR), text, false);
  if (near) return normalizeSpan(near, text, count);
  const anywhere = search(loc, quote, 0, count - 1, text, true);
  return anywhere ? normalizeSpan(anywhere, text, count) : null;
}
