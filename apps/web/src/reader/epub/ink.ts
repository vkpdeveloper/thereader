import { dashArray, lineWidth, nearStroke, strokePath, type InkPen } from '../../lib/inkPaths';
import { isTextAnchor, type InkStroke, type TextAnchor } from '../../lib/services/ink';
import type { TextIndex, TextQuote } from './text';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The layer's own size in CSS pixels; its rendered width against this gives the page's scale (fixed layouts). */
const BOX = 100;
/** Characters of context kept with an anchor, to find it again if its offset drifts. */
const BEFORE = 24;
const HIGHLIGHT = 12;

/** What the layer needs from the engine. */
export interface InkHost {
  doc(): Document;
  frame: HTMLIFrameElement;
  /** The mounted chapter's text, or null before one is mounted. */
  index(): TextIndex | null;
  /** The mounted chapter's href. */
  href(): string | null;
  /** Whether a stroke's chapter href is the mounted chapter. */
  isCurrent(href: string): boolean;
  /** Finds a text quote in the mounted chapter. */
  find(quote: TextQuote): { start: number; end: number } | null;
}

interface Placed {
  stroke: InkStroke;
  /** Layer coordinates. */
  points: number[];
}

function important(el: Element & ElementCSSInlineStyle, css: Record<string, string>): void {
  for (const [name, value] of Object.entries(css)) el.style.setProperty(name, value, 'important');
}

function penStyle(path: SVGPathElement, pen: InkPen): void {
  const dash = dashArray(pen.tool, pen.size);
  important(path, {
    fill: 'none',
    stroke: pen.color,
    'stroke-width': `${lineWidth(pen.tool, pen.size)}px`,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'stroke-dasharray': dash ?? 'none',
    opacity: pen.tool === 'marker' ? '0.42' : '1',
    'mix-blend-mode': pen.tool === 'marker' ? 'screen' : 'normal',
    visibility: 'visible',
    display: 'inline',
  });
}

function firstRect(range: Range): DOMRect | null {
  for (const r of Array.from(range.getClientRects())) if (r.width > 0 || r.height > 0) return r;
  const b = range.getBoundingClientRect();
  return b.width > 0 || b.height > 0 ? b : null;
}

/**
 * Pen drawings inside a book's frame. The layer is an SVG positioned at
 * the document's origin, outside the chapter's body, so strokes scroll with
 * the text: page turns (horizontal scrolling of the paginated columns) and
 * scrolling carry them like the words they were drawn on, and other pages
 * clip them. Layer coordinates are therefore document coordinates.
 *
 * Each stroke is anchored to one character of its chapter (the text under
 * or nearest the stroke's middle) with points relative to that character's
 * box, and placed again from that box whenever the chapter is mounted or
 * laid out: on opening the book, on every chapter change, and after a
 * resize, a type change, or late images and fonts. The same layout puts a
 * stroke back exactly where it was drawn; another layout keeps it beside
 * its character, scaled with the line height.
 */
export class InkLayer {
  private svg: SVGSVGElement | null = null;
  private livePath: SVGPathElement | null = null;
  private strokes: InkStroke[] = [];
  private placed: Placed[] = [];

  constructor(private readonly host: InkHost) {}

  /** Every stroke of the book; the mounted chapter's are drawn. */
  set(strokes: InkStroke[]): void {
    this.strokes = strokes;
    this.redraw();
  }

  private layer(): SVGSVGElement {
    const doc = this.host.doc();
    if (this.svg?.isConnected && this.svg.ownerDocument === doc) return this.svg;
    const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('data-reader-ui', '');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'reader-ink');
    important(svg, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${BOX}px`,
      height: `${BOX}px`,
      'max-width': 'none',
      'max-height': 'none',
      margin: '0',
      padding: '0',
      border: '0',
      overflow: 'visible',
      'pointer-events': 'none',
      'z-index': '2147483647',
      display: 'block',
      visibility: 'visible',
      transform: 'none',
      background: 'transparent',
    });
    doc.documentElement.append(svg);
    this.svg = svg;
    this.livePath = null;
    return svg;
  }

  /** The layer's corner in frame viewport coordinates and its scale. */
  private frameOrigin(): { left: number; top: number; scale: number } {
    const r = this.layer().getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width > 0 ? r.width / BOX : 1 };
  }

  /** Host viewport -> frame viewport. */
  private toFrame(x: number, y: number): [number, number] {
    const frame = this.host.frame;
    const fr = frame.getBoundingClientRect();
    const sx = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
    const sy = frame.offsetHeight ? fr.height / frame.offsetHeight : 1;
    return [(x - fr.left) / sx, (y - fr.top) / sy];
  }

  /** A host viewport point in layer coordinates; null outside the page. */
  point(x: number, y: number): [number, number] | null {
    if (!this.host.index()) return null;
    const [fx, fy] = this.toFrame(x, y);
    const frame = this.host.frame;
    if (fx < 0 || fy < 0 || fx > frame.offsetWidth || fy > frame.offsetHeight) return null;
    const o = this.frameOrigin();
    return [(fx - o.left) / o.scale, (fy - o.top) / o.scale];
  }

  /** Host pixels in layer units (fixed layouts are scaled). */
  private hostToLayer(px: number): number {
    const frame = this.host.frame;
    const fs = frame.offsetWidth ? frame.getBoundingClientRect().width / frame.offsetWidth : 1;
    return px / (fs * this.frameOrigin().scale);
  }

  live(points: number[] | null, pen: InkPen): void {
    const svg = this.layer();
    if (!points) {
      this.livePath?.remove();
      this.livePath = null;
      return;
    }
    if (!this.livePath || this.livePath.parentNode !== svg) {
      this.livePath = svg.ownerDocument.createElementNS(SVG_NS, 'path') as SVGPathElement;
      svg.append(this.livePath);
    }
    penStyle(this.livePath, pen);
    this.livePath.setAttribute('d', strokePath(points));
  }

  // ------------------------------------------------------------ anchoring

  /** A character's box in layer coordinates, trying its neighbours when it has none (a collapsed space). */
  private charBox(idx: TextIndex, offset: number): { left: number; top: number; height: number } | null {
    const o = this.frameOrigin();
    for (const at of [offset, offset - 1, offset + 1, offset - 2, offset + 2]) {
      if (at < 0 || at >= idx.length) continue;
      const range = idx.range(at, at + 1);
      const r = range && firstRect(range);
      if (!r || r.height === 0) continue;
      return { left: (r.left - o.left) / o.scale, top: (r.top - o.top) / o.scale, height: r.height / o.scale };
    }
    return null;
  }

  /** The text offset under a frame viewport point, if the point is over (or right beside) text in the chapter. */
  private caretAt(idx: TextIndex, x: number, y: number): number | null {
    const doc = this.host.doc() as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === 'function') {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) ({ offsetNode: node, offset } = p);
    } else if (typeof doc.caretRangeFromPoint === 'function') {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !idx.root.contains(node)) return null;
    const at = idx.offsetOf(node, offset);
    return Math.min(Math.max(0, at), Math.max(0, idx.length - 1));
  }

  /**
   * The character nearest a frame viewport point on the page in view: the
   * one under it when there is one, else the closest line's nearest
   * character (a note in the margin anchors to the line beside it).
   */
  private nearestChar(idx: TextIndex, x: number, y: number): number | null {
    const frame = this.host.frame;
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    const under = this.caretAt(idx, x, y);
    if (under !== null) {
      const range = idx.range(under, Math.min(idx.length, under + 1));
      const r = range && firstRect(range);
      if (r && x >= r.left - r.height && x <= r.right + r.height && y >= r.top - r.height * 0.75 && y <= r.bottom + r.height * 0.75) return under;
    }
    // The closest visible line.
    const doc = this.host.doc();
    const range = doc.createRange();
    let best: DOMRect | null = null;
    let bestDistance = Infinity;
    for (const node of idx.nodes) {
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 || r.right < 0 || r.left > w || r.bottom < 0 || r.top > h) continue;
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (d < bestDistance) {
          bestDistance = d;
          best = r;
        }
      }
    }
    if (!best) return null;
    const cx = Math.min(Math.max(x, best.left + 0.5), best.right - 0.5);
    return this.caretAt(idx, cx, best.top + best.height / 2);
  }

  /** Anchors a finished stroke (layer coordinates) to the character under or nearest its middle. */
  anchor(points: number[]): Pick<InkStroke, 'anchor' | 'points'> | null {
    const idx = this.host.index();
    const href = this.host.href();
    if (!idx || !href || points.length < 2) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]!);
      maxX = Math.max(maxX, points[i]!);
      minY = Math.min(minY, points[i + 1]!);
      maxY = Math.max(maxY, points[i + 1]!);
    }
    const o = this.frameOrigin();
    const fx = o.left + ((minX + maxX) / 2) * o.scale;
    const fy = o.top + ((minY + maxY) / 2) * o.scale;
    const offset = idx.length > 0 ? this.nearestChar(idx, fx, fy) : null;
    const box = offset !== null ? this.charBox(idx, offset) : null;
    // A page without text (a full-page image) keeps the stroke where it was drawn.
    const base = box ?? { left: 0, top: 0, height: 0 };
    const anchor: TextAnchor = {
      href,
      offset: box && offset !== null ? offset : -1,
      text: box && offset !== null ? { before: idx.text.slice(Math.max(0, offset - BEFORE), offset), highlight: idx.text.slice(offset, offset + HIGHLIGHT) } : { before: '', highlight: '' },
      height: Math.round(base.height * 100) / 100,
    };
    const rel = points.map((v, i) => Math.round((v - (i % 2 === 0 ? base.left : base.top)) * 10) / 10);
    return { anchor, points: rel };
  }

  /** Where an anchor's character is now: its stored offset when the text there still matches, else found by its quote. */
  private locate(idx: TextIndex, anchor: TextAnchor): number | null {
    const { highlight, before } = anchor.text;
    if (anchor.offset >= 0 && anchor.offset < idx.length && (!highlight || idx.text.startsWith(highlight, anchor.offset))) return anchor.offset;
    if (!highlight.trim()) return null;
    return this.host.find({ highlight, before, after: '' })?.start ?? null;
  }

  // ------------------------------------------------------------ drawing

  /** Places and draws the mounted chapter's strokes again. */
  redraw(): void {
    const idx = this.host.index();
    const svg = this.layer();
    for (const child of Array.from(svg.childNodes)) if (child !== this.livePath) child.remove();
    this.placed = [];
    if (!idx) return;
    const doc = svg.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const stroke of this.strokes) {
      const anchor = stroke.anchor;
      if (!isTextAnchor(anchor) || !this.host.isCurrent(anchor.href)) continue;
      let base = { left: 0, top: 0, height: 0 };
      if (anchor.offset >= 0) {
        const at = this.locate(idx, anchor);
        const box = at !== null ? this.charBox(idx, at) : null;
        if (!box) continue;
        base = box;
      }
      const s = anchor.height > 0 && base.height > 0 ? base.height / anchor.height : 1;
      const points = stroke.points.map((v, i) => (i % 2 === 0 ? base.left : base.top) + v * s);
      const path = doc.createElementNS(SVG_NS, 'path') as SVGPathElement;
      penStyle(path, stroke);
      path.setAttribute('d', strokePath(points));
      path.setAttribute('data-ink-id', stroke.id);
      fragment.append(path);
      this.placed.push({ stroke, points });
    }
    svg.insertBefore(fragment, this.livePath?.parentNode === svg ? this.livePath : null);
  }

  /** Strokes passing within `reach` host pixels (beyond their own half width) of a layer point. */
  hits(x: number, y: number, reach: number): InkStroke[] {
    const r = this.hostToLayer(reach);
    return this.placed.filter((p) => nearStroke(p.points, x, y, lineWidth(p.stroke.tool, p.stroke.size) / 2 + r)).map((p) => p.stroke);
  }

  /** Strokes on the page in view. */
  onScreen(): InkStroke[] {
    if (this.placed.length === 0) return [];
    const o = this.frameOrigin();
    const frame = this.host.frame;
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    return this.placed
      .filter(({ points }) => {
        for (let i = 0; i < points.length; i += 2) {
          const x = o.left + points[i]! * o.scale;
          const y = o.top + points[i + 1]! * o.scale;
          if (x >= 0 && x <= w && y >= 0 && y <= h) return true;
        }
        return false;
      })
      .map((p) => p.stroke);
  }
}
