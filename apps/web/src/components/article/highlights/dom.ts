import { normalizeSpan, type ArticleSpan, type BlockText } from '../../../lib/articleAnchors';

/**
 * The bridge between article highlight anchors (block index + text offsets,
 * lib/articleAnchors.ts) and the page React drew. Read-only: nothing here
 * changes the article's DOM; highlights are painted with the CSS Custom
 * Highlight API from the Ranges built here.
 */

/**
 * Text that is not the article's: controls, the code block's bar, heading
 * links, footnote return arrows, alt text standing in for a broken image, and
 * math (TeX until it converts, MathML after). Skipped so offsets mean the
 * same on every device and after every late render.
 */
const SKIP = 'button, .article-code-bar, .article-anchor, .article-fn-back, .article-image-missing, .article-math, [data-hl-skip]';

interface BlockInfo {
  el: HTMLElement;
  nodes: Text[];
  /** Offset of each node in the block's text. */
  starts: number[];
  text: string;
}

/**
 * The article's top-level blocks as drawn now, by `data-block-index`, with
 * each block's text walked on first use. Build a fresh one whenever the page
 * may have changed.
 */
export class ArticleText {
  private readonly elements = new Map<number, HTMLElement>();
  private readonly infos = new Map<number, BlockInfo | null>();
  readonly count: number;

  constructor(
    readonly body: HTMLElement,
    count: number,
  ) {
    this.count = count;
    for (const el of Array.from(body.querySelectorAll<HTMLElement>('[data-block-index]'))) {
      this.elements.set(Number(el.dataset.blockIndex) || 0, el);
    }
  }

  element(index: number): HTMLElement | undefined {
    return this.elements.get(index);
  }

  private info(index: number): BlockInfo | null {
    let info = this.infos.get(index);
    if (info !== undefined) return info;
    const el = this.elements.get(index);
    info = el ? walk(el) : null;
    this.infos.set(index, info);
    return info;
  }

  /** For lib/articleAnchors: a block's text, null when it has none. */
  readonly text: BlockText = (index) => this.info(index)?.text || null;

  /** The Range a span covers, or null if its blocks are gone. */
  range(span: ArticleSpan): Range | null {
    const a = this.info(span.startBlock);
    const b = this.info(span.endBlock);
    if (!a || !b) return null;
    const start = point(a, span.start, false);
    const end = point(b, span.end, true);
    if (!start || !end) return null;
    const range = this.body.ownerDocument.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    return range;
  }

  /** The article passage a DOM range (a selection) covers, clipped to the body; null when it holds no article text. */
  span(range: Range): ArticleSpan | null {
    if (!range.intersectsNode(this.body)) return null;
    const blocks = [...this.elements.entries()].sort((x, y) => x[0] - y[0]);
    if (blocks.length === 0) return null;
    const startAt = this.locate(range.startContainer, range.startOffset, blocks, false);
    const endAt = this.locate(range.endContainer, range.endOffset, blocks, true);
    if (!startAt || !endAt) return null;
    return normalizeSpan({ startBlock: startAt[0], start: startAt[1], endBlock: endAt[0], end: endAt[1] }, this.text, this.count);
  }

  /**
   * A boundary point as block index and offset. A point outside every block
   * (between blocks, or before or after the body) moves to the next block's
   * start, or for an end, to the previous block's end.
   */
  private locate(node: Node, offset: number, blocks: [number, HTMLElement][], isEnd: boolean): [number, number] | null {
    const holder = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-block-index]');
    if (holder && this.body.contains(holder)) {
      const index = Number(holder.dataset.blockIndex) || 0;
      const info = this.info(index);
      return info ? [index, offsetOf(info, node, offset)] : [index, 0];
    }
    const probe = this.body.ownerDocument.createRange();
    probe.setStart(node, offset);
    if (!isEnd) {
      for (const [index, el] of blocks) if (probe.comparePoint(el, 0) >= 0) return [index, 0];
      return null;
    }
    for (let i = blocks.length - 1; i >= 0; i--) {
      const [index, el] = blocks[i]!;
      if (probe.comparePoint(el, el.childNodes.length) <= 0) return [index, this.info(index)?.text.length ?? 0];
    }
    return null;
  }
}

function walk(el: HTMLElement): BlockInfo {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  return { el, nodes, starts, text };
}

/** A text offset as a DOM point; an end prefers the earlier node at a seam, a start the later. */
function point(info: BlockInfo, offset: number, isEnd: boolean): [Node, number] | null {
  const { nodes, starts } = info;
  if (nodes.length === 0) return null;
  for (let i = 0; i < nodes.length; i++) {
    const from = starts[i]!;
    const to = from + nodes[i]!.data.length;
    if (isEnd ? offset <= to : offset < to) return [nodes[i]!, Math.max(0, offset - from)];
  }
  const last = nodes[nodes.length - 1]!;
  return [last, last.data.length];
}

/** A DOM point inside a block as an offset into its text (skipped text counts as nothing). */
function offsetOf(info: BlockInfo, node: Node, offset: number): number {
  const probe = info.el.ownerDocument.createRange();
  probe.setStart(node, offset);
  for (let i = 0; i < info.nodes.length; i++) {
    const n = info.nodes[i]!;
    if (n === node) return info.starts[i]! + Math.min(offset, n.data.length);
    // The first text node after the point: the point sits right before it.
    if (probe.comparePoint(n, 0) > 0) return info.starts[i]!;
  }
  return info.text.length;
}

/** The caret position under a viewport point (standard API, or WebKit's older one). */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** The line box of `range` under a viewport point, if any (a little slack around glyphs). */
export function rectAt(range: Range, x: number, y: number): DOMRect | null {
  for (const r of Array.from(range.getClientRects())) {
    if (r.width > 0 && x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return r;
  }
  return null;
}

/**
 * The highlight under a viewport point: the caret there must fall inside its
 * range and the point on one of its line boxes (a click in the margin past
 * a line's end puts the caret inside, but not on the text). The shortest
 * wins where highlights overlap.
 */
export function highlightAt(ranges: Map<string, Range>, x: number, y: number): { id: string; rect: DOMRect } | null {
  const caret = caretAt(x, y);
  if (!caret) return null;
  let best: { id: string; rect: DOMRect; length: number } | null = null;
  for (const [id, range] of ranges) {
    try {
      if (!range.isPointInRange(caret.node, caret.offset)) continue;
    } catch {
      continue; // A point in another document or a doctype.
    }
    const rect = rectAt(range, x, y);
    if (!rect) continue;
    const length = range.toString().length;
    if (!best || length < best.length) best = { id, rect, length };
  }
  return best && { id: best.id, rect: best.rect };
}

/** Whether the browser paints CSS Custom Highlights (Chrome 105, Safari 17.2, Firefox 140). */
export const paintsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
