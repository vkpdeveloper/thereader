/**
 * Reading positions in the web article reader. Positions sync between devices
 * as an index into `article.blocks` plus how far into that block the reader
 * is, so blocks are found by the `data-block-index` marker renderArticleBlocks
 * puts on each, never by DOM structure: a block may render no element (an
 * empty paragraph) or a box-less wrapper (components).
 */

/** The reading line, just under the top bar. */
const readingLine = 64;

/** The article's top-level blocks in order; queried once and reused while connected. */
export function blockElements(body: HTMLElement, cache: { current: HTMLElement[] }): HTMLElement[] {
  const cached = cache.current;
  if (cached.length > 0 && cached[0]!.isConnected && body.contains(cached[0]!)) return cached;
  cache.current = Array.from(body.querySelectorAll<HTMLElement>('[data-block-index]'));
  return cache.current;
}

const blockIndex = (el: HTMLElement): number => Number(el.dataset.blockIndex) || 0;

/** A block's vertical extent; a box-less wrapper spans its children. */
function blockBox(el: HTMLElement): { top: number; bottom: number } {
  const first = el.classList.contains('article-block-contents') ? el.firstElementChild : el;
  const last = el.classList.contains('article-block-contents') ? el.lastElementChild : el;
  if (!first || !last) {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }
  return { top: first.getBoundingClientRect().top, bottom: last.getBoundingClientRect().bottom };
}

/**
 * Reading position as a fraction of the article's `count` top-level blocks:
 * the block crossing the reading line plus how far into it the line is (1 at
 * the end). Unlike a pixel fraction it survives font, margin and window
 * changes, and blocks whose rendering is skipped (content-visibility) only
 * need their estimated boxes.
 */
export function readPosition(blocks: HTMLElement[], count: number): number {
  if (blocks.length === 0 || count <= 0 || window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 2) return 1;
  if (blockBox(blocks[0]!).top >= readingLine) return 0;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blockBox(blocks[mid]!).bottom <= readingLine) lo = mid + 1;
    else hi = mid;
  }
  const box = blockBox(blocks[lo]!);
  const height = box.bottom - box.top;
  const within = height > 0 ? Math.min(1, Math.max(0, (readingLine - box.top) / height)) : 0;
  return Math.min(1, (blockIndex(blocks[lo]!) + within) / count);
}

export function scrollToPosition(blocks: HTMLElement[], count: number, position: number): void {
  if (position <= 0 || blocks.length === 0 || count <= 0) return window.scrollTo(0, 0);
  if (position >= 1) return window.scrollTo(0, document.documentElement.scrollHeight);
  const at = position * count;
  const target = Math.min(count - 1, Math.floor(at));
  // The marked block at or after the target (a block that rendered nothing has no marker).
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blockIndex(blocks[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  const el = blocks[lo]!;
  const box = blockBox(el);
  const within = blockIndex(el) === target ? at - target : 0;
  window.scrollTo(0, Math.round(window.scrollY + box.top + within * (box.bottom - box.top) - readingLine));
}
