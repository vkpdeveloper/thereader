import { UI_ATTR } from '../enhance/dom';

/**
 * Text positions inside a rendered chapter. Offsets are into the raw
 * concatenation of the body's text nodes, i.e. the body's `textContent`
 * without reader UI — the same string Readium anchors text quotes against,
 * so quotes made here resolve on mobile and vice versa. Wrapping highlights
 * splits text nodes but never changes these offsets.
 */

const SKIP = new Set(['script', 'style', 'noscript', 'template']);

/** Reader UI and enhancer insertions (rendered formulas): not book text. */
function isUi(el: Element): boolean {
  return el.hasAttribute('data-reader-ui') || el.hasAttribute(UI_ATTR);
}

const IGNORABLE = /[\s­​‌‍﻿]/;

export class TextIndex {
  readonly nodes: Text[] = [];
  readonly starts: number[] = [];
  readonly text: string;
  private strippedText: string | null = null;
  private strippedMap: Int32Array | null = null;
  private lower: string | null = null;

  constructor(readonly root: Element) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n as Element;
          if (SKIP.has(el.localName.toLowerCase()) || isUi(el)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts: string[] = [];
    let pos = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      this.nodes.push(t);
      this.starts.push(pos);
      parts.push(t.data);
      pos += t.data.length;
    }
    this.text = parts.join('');
  }

  get length(): number {
    return this.text.length;
  }

  /** Text with whitespace and invisible characters removed, plus a map back to raw offsets. */
  stripped(): { text: string; map: Int32Array } {
    if (this.strippedText === null || this.strippedMap === null) {
      const map = new Int32Array(this.text.length);
      let out = '';
      let n = 0;
      const chunk: string[] = [];
      for (let i = 0; i < this.text.length; i++) {
        const c = this.text[i];
        if (IGNORABLE.test(c)) continue;
        chunk.push(c);
        map[n++] = i;
        if (chunk.length > 4096) {
          out += chunk.join('');
          chunk.length = 0;
        }
      }
      out += chunk.join('');
      this.strippedText = out;
      this.strippedMap = map.subarray(0, n);
    }
    return { text: this.strippedText, map: this.strippedMap };
  }

  strippedLower(): string {
    if (this.lower === null) {
      const text = this.stripped().text;
      const lower = text.toLowerCase();
      // Keep offsets aligned when a character lowercases to a different length.
      this.lower = lower.length === text.length ? lower : lowerPerUnit(text);
    }
    return this.lower;
  }

  /** Node index containing raw `offset` (the node that starts at or before it). */
  nodeAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  point(offset: number, preferEnd = false): { node: Text; offset: number } | null {
    if (this.nodes.length === 0) return null;
    const o = Math.max(0, Math.min(offset, this.text.length));
    let i = this.nodeAt(o);
    // An end boundary at a node start belongs to the end of the previous node.
    if (preferEnd && i > 0 && this.starts[i] === o) i -= 1;
    // Skip empty nodes for start boundaries.
    while (!preferEnd && i < this.nodes.length - 1 && o - this.starts[i] >= this.nodes[i].data.length) i += 1;
    const node = this.nodes[i];
    return { node, offset: Math.min(Math.max(0, o - this.starts[i]), node.data.length) };
  }

  range(start: number, end: number): Range | null {
    const a = this.point(start);
    const b = this.point(end, true);
    if (!a || !b) return null;
    const r = this.root.ownerDocument.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  }

  /** Raw offset of a DOM boundary point. */
  offsetOf(container: Node, offset: number): number {
    if (container.nodeType === Node.TEXT_NODE) {
      const i = this.nodes.indexOf(container as Text);
      if (i >= 0) return this.starts[i] + Math.min(offset, (container as Text).data.length);
    }
    // First indexed node at or after the boundary point.
    const probe = this.root.ownerDocument.createRange();
    try {
      probe.setStart(container, offset);
    } catch {
      return 0;
    }
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      // comparePoint: -1 if the node start is before the boundary.
      if (probe.comparePoint(this.nodes[mid], 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.nodes.length ? this.starts[lo] : this.text.length;
  }
}

export interface TextQuote {
  highlight: string;
  before?: string;
  after?: string;
}

export function stripText(s: string): string {
  let out = '';
  for (const c of s) if (!IGNORABLE.test(c)) out += c;
  return out;
}

/**
 * Finds a text quote in `index`, returning raw offsets. Whitespace is ignored
 * (Readium and the DOM disagree about it across block boundaries); among
 * several matches the one with the best before/after context wins, then the
 * one closest to `hint` (0..1 through the chapter).
 */
export function anchorQuote(
  index: TextIndex,
  quote: TextQuote,
  hint: number | null,
  positionOf?: (start: number, end: number) => number | null,
): { start: number; end: number } | null {
  const q = stripText(quote.highlight ?? '');
  if (!q) return null;
  const { text, map } = index.stripped();
  let hay = text;
  let needle = q;
  let starts = findAll(hay, needle);
  if (starts.length === 0) {
    hay = index.strippedLower();
    needle = lowerQuote(q);
    starts = findAll(hay, needle);
  }
  let length = needle.length;
  if (starts.length === 0 && needle.length > 24) {
    // The quote may have drifted (e.g. an edited edition); anchor on its head and tail.
    const head = needle.slice(0, 16);
    const tail = needle.slice(-16);
    for (const s of findAll(hay, head)) {
      const t = hay.indexOf(tail, s + head.length);
      if (t >= 0 && t + tail.length - s <= needle.length * 1.5) {
        starts.push(s);
        length = t + tail.length - s;
        break;
      }
    }
  }
  if (starts.length === 0) return null;

  let best = starts[0];
  if (starts.length > 1) {
    const before = lowerQuote(stripText(quote.before ?? ''));
    const after = lowerQuote(stripText(quote.after ?? ''));
    const lowerHay = index.strippedLower();
    const scored = starts.map((s) => {
      let score = 0;
      for (let i = 1; i <= Math.min(before.length, s, 64); i++) {
        if (before[before.length - i] !== lowerHay[s - i]) break;
        score++;
      }
      const e = s + length;
      for (let i = 0; i < Math.min(after.length, lowerHay.length - e, 64); i++) {
        if (after[i] !== lowerHay[e + i]) break;
        score++;
      }
      return { s, score };
    });
    const top = Math.max(...scored.map((x) => x.score));
    const tied = scored.filter((x) => x.score === top);
    if (tied.length === 1 || hint === null) best = tied[0].s;
    else {
      let bestDistance = Infinity;
      for (const t of tied) {
        const raw = map[t.s];
        const layout = tied.length <= 24 && positionOf ? positionOf(raw, map[t.s + length - 1] + 1) : null;
        const pos = layout ?? raw / Math.max(1, index.length);
        const d = Math.abs(pos - hint);
        if (d < bestDistance) {
          bestDistance = d;
          best = t.s;
        }
      }
    }
  }
  return { start: map[best], end: map[Math.min(best + length, map.length) - 1] + 1 };
}

function lowerPerUnit(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const l = s[i].toLowerCase();
    out += l.length === 1 ? l : s[i];
  }
  return out;
}

/** Lowercase that keeps every UTF-16 offset aligned with the input. */
export function lowerQuote(s: string): string {
  const l = s.toLowerCase();
  return l.length === s.length ? l : lowerPerUnit(s);
}

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 2000; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'th', 'thead', 'tfoot', 'tr', 'ul', 'body',
]);

/** Readable plain text of a body: blocks separated by spaces, whitespace collapsed. */
export function plainText(root: Element): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push((n as Text).data);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    const name = el.localName.toLowerCase();
    if (SKIP.has(name) || isUi(el)) return;
    const block = BLOCK.has(name);
    if (block) parts.push(' ');
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
    if (block) parts.push(' ');
  };
  walk(root);
  return parts.join('').replace(/[­​﻿]/g, '').replace(/\s+/g, ' ').trim();
}
