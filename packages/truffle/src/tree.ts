/**
 * A compact, mutable copy of the parsed page. The DOM is walked exactly once;
 * every later stage (metadata, scoring, cleaning, block conversion) works on
 * these plain objects. That keeps the hot paths free of DOM calls and makes the
 * Dart port line-for-line identical: only `fromDom` differs per platform.
 */

export class VText {
  readonly kind = 0 as const;
  parent: VElement | null = null;
  /** Cached `visibleLength(text)`; -1 until first asked. */
  private len = -1;
  private commaCount = 0;
  constructor(public text: string) {}

  get length(): number {
    if (this.len < 0) {
      this.len = visibleLength(this.text);
      this.commaCount = this.len > 0 ? countCommas(this.text) : 0;
    }
    return this.len;
  }

  get commas(): number {
    if (this.len < 0) void this.length;
    return this.commaCount;
  }
}

export class VElement {
  readonly kind = 1 as const;
  parent: VElement | null = null;
  children: VNode[] = [];
  /** Lowercase class + id, for pattern matching. */
  readonly matchString: string;
  readonly className: string;
  readonly id: string;

  /** Visible text length (whitespace runs count as one), excluding `skip` descendants. */
  textLen = 0;
  /** Text length inside links. */
  linkLen = 0;
  /** Commas (any script) in the text. */
  commas = 0;
  /** Readability-style content score, valid while `scored`. */
  score = 0;
  scored = false;
  /** Excluded from scoring and output (boilerplate, hidden). */
  skip = false;
  /** Cached: has a block-level descendant (-1 unknown, 0 no, 1 yes). */
  blockState = -1;
  /** Cached: data table (-1 unknown, 0 layout, 1 data). */
  tableState = -1;
  /** Cached: footnote list container (-1 unknown, 0 no, 1 yes). */
  notesState = -1;
  /** Set by content normalization: has a block-level descendant. */
  containsBlock = false;

  constructor(
    public tag: string,
    public attrs: Record<string, string>,
  ) {
    this.className = attrs['class'] ?? '';
    this.id = attrs['id'] ?? '';
    this.matchString = (this.className + ' ' + this.id).toLowerCase();
  }

  attr(name: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(this.attrs, name)) return null;
    const value = this.attrs[name];
    return value === undefined ? null : value;
  }

  hasClass(name: string): boolean {
    if (this.className.length === 0 || this.className.indexOf(name) < 0) return false;
    return (' ' + this.className.replace(/\s+/g, ' ') + ' ').indexOf(' ' + name + ' ') >= 0;
  }

  append(node: VNode): void {
    node.parent = this;
    this.children.push(node);
  }
}

export type VNode = VText | VElement;

export interface VDocument {
  root: VElement;
  head: VElement | null;
  body: VElement;
  /** Raw text of `<script type="application/ld+json">` blocks, in document order. */
  jsonLd: string[];
  /** Raw text of a Next.js `__NEXT_DATA__` script, if present. */
  nextData: string | null;
  /** `<base href>`, when the page declares one. */
  baseHref: string | null;
}

/** Elements dropped with their content while copying the DOM. */
const DROP = new Set([
  'script', 'style', 'template', 'canvas', 'object', 'embed', 'applet', 'param',
  'select', 'option', 'optgroup', 'textarea', 'button', 'datalist', 'dialog', 'map', 'area',
  'frame', 'frameset', 'noembed', 'portal', 'slot', 'meter', 'progress', 'output',
]);

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i;

/** Screen-reader-only text: never part of what a reader sees. */
const SR_ONLY = /(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|screenreader-only|a11y-hidden|hide-for-sr|u-hidden-visually|vh|offscreen|is-hidden|hidden-text)(?:\s|$)/;

function isHidden(el: Element, tag: string): boolean {
  const cls = el.getAttribute('class');
  if (cls !== null && cls.indexOf('mwe-math-mathml') >= 0) return false;
  // React streaming SSR parks finished Suspense boundaries in <div hidden id="S:n"> until JS swaps them in.
  if (el.hasAttribute('hidden') && tag !== 'input' && !/^S:\d+$/.test(el.id)) return true;
  const style = el.getAttribute('style');
  if (style !== null && HIDDEN_STYLE.test(style)) return true;
  if (cls !== null && SR_ONLY.test(cls)) return true;
  if (el.getAttribute('aria-hidden') === 'true') {
    // KaTeX and MathJax hide their visual copy; the MathML copy is read instead.
    // Decorative wrappers that still hold real images or long text stay.
    return !(cls !== null && /fallback-image|lazy|image|img|photo|figure|media/i.test(cls));
  }
  return false;
}

/** Copies a parsed document into a `VDocument`. Platform-specific (the Dart port uses package:html). */
export function fromDom(doc: Document): VDocument {
  const jsonLd: string[] = [];
  let nextData: string | null = null;
  let baseHref: string | null = null;
  let head: VElement | null = null;
  let body: VElement | null = null;

  function copy(el: Element, parent: VElement | null, inHead: boolean): VElement | null {
    const tag = el.localName;
    if (tag === 'script') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type === 'application/ld+json') {
        const text = el.textContent;
        if (text) jsonLd.push(text);
      } else if (el.id === '__NEXT_DATA__') {
        nextData = el.textContent;
      } else if (type.startsWith('math/tex') && parent !== null) {
        const math = new VElement('math-tex', { display: type.includes('mode=display') ? 'block' : 'inline' });
        math.append(new VText(el.textContent ?? ''));
        return math;
      }
      return null;
    }
    if (tag === 'base') {
      if (baseHref === null) baseHref = el.getAttribute('href');
      return null;
    }
    // <object type="image/svg+xml" data="chart.svg"> is an image (LaTeXML figures, old sites).
    if (tag === 'object' && !inHead && isImageObject(el)) {
      const img = new VElement('img', Object.assign(Object.create(null) as Record<string, string>, { src: el.getAttribute('data')!, alt: el.getAttribute('title') ?? '' }));
      const width = el.getAttribute('width');
      const height = el.getAttribute('height');
      if (width !== null) img.attrs['width'] = width;
      if (height !== null) img.attrs['height'] = height;
      return img;
    }
    if (DROP.has(tag)) return null;
    if (inHead && tag !== 'title' && tag !== 'meta' && tag !== 'link' && tag !== 'noscript') return null;
    // Streaming renderers (React 19, Next.js) emit <title>, <meta> and <link> inside <body>; keep them for metadata.
    if (tag === 'meta' || tag === 'link' || tag === 'title') {
      if (!inHead && tag === 'meta' && !el.hasAttribute('itemprop') && !el.hasAttribute('property') && !el.hasAttribute('name')) return null;
    } else if (!inHead && isHidden(el, tag)) {
      return null;
    }

    const attrs: Record<string, string> = {};
    const list = el.attributes;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      // An attribute named "__proto__" is an attribute, not the object's prototype.
      if (a.name === '__proto__') Object.defineProperty(attrs, a.name, { value: a.value, enumerable: true, writable: true, configurable: true });
      else attrs[a.name] = a.value;
    }
    const v = new VElement(tag, attrs);

    if (tag === 'math' || tag === 'svg') {
      // Kept as a leaf: math is serialized later; svg is dropped by the converter.
      v.append(new VText(el.textContent ?? ''));
      if (tag === 'math') {
        v.attrs['data-xml'] = serializeXml(el);
        const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation !== null && annotation.textContent) v.attrs['data-tex'] = annotation.textContent.trim();
      }
      return v;
    }

    const childInHead = inHead || tag === 'head';
    for (let child = el.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const text = (child as Text).data;
        if (text.length > 0) v.append(new VText(text));
      } else if (child.nodeType === 1) {
        const c = copy(child as Element, v, childInHead);
        if (c !== null) v.append(c);
      }
    }
    if (tag === 'head') head = v;
    else if (tag === 'body') body = v;
    return v;
  }

  const root = copy(doc.documentElement, null, false) ?? new VElement('html', {});
  if (body === null) {
    body = new VElement('body', {});
    root.append(body);
  }
  return { root, head, body, jsonLd, nextData, baseHref };
}

function isImageObject(el: Element): boolean {
  const data = el.getAttribute('data');
  if (data === null || data.length === 0) return false;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  return type.startsWith('image/') || type.length === 0 && /\.(?:svg|png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(data);
}

const XML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** MathML presentation elements kept in `mathml`. */
const MATHML_ELEMENTS = new Set([
  'math', 'semantics', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mrow', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror',
  'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts',
  'mprescripts', 'none', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maligngroup', 'malignmark', 'maction',
]);

/** Dropped from `mathml` with their content: alternative encodings, and code. */
const MATHML_DROP = new Set(['annotation', 'annotation-xml', 'script', 'style', 'template']);

/** MathML presentation and global attributes kept in `mathml` (plus `data-*`): no links, sources, handlers or styling. */
const MATHML_ATTRIBUTES = new Set([
  'accent', 'accentunder', 'actiontype', 'align', 'alttext', 'arg', 'bevelled', 'close', 'columnalign', 'columnlines',
  'columnspacing', 'columnspan', 'denomalign', 'depth', 'dir', 'display', 'displaystyle', 'encoding', 'equalcolumns',
  'equalrows', 'fence', 'form', 'frame', 'height', 'intent', 'largeop', 'linethickness', 'lspace', 'mathbackground',
  'mathcolor', 'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits', 'notation', 'numalign', 'open', 'rowalign',
  'rowlines', 'rowspacing', 'rowspan', 'rspace', 'scriptlevel', 'scriptminsize', 'scriptsizemultiplier', 'selection',
  'separator', 'separators', 'stretchy', 'subscriptshift', 'superscriptshift', 'symmetric', 'voffset', 'width',
]);

/**
 * Deterministic serialization of a MathML subtree (attributes in source
 * order, no namespaces). Only MathML elements and attributes are written;
 * anything else inside a formula (HTML in `<mtext>`, unknown tags) keeps only
 * its text, so the output is inert markup.
 */
function serializeXml(el: Element): string {
  const tag = el.localName;
  if (MATHML_DROP.has(tag)) return '';
  const kept = MATHML_ELEMENTS.has(tag);
  let out = '';
  if (kept) {
    out += '<' + tag;
    const list = el.attributes;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (!MATHML_ATTRIBUTES.has(a.name) && !/^data-[a-z0-9-]+$/.test(a.name)) continue;
      out += ' ' + a.name + '="' + a.value.replace(/[&<>"]/g, (c) => XML_ESCAPE[c]!) + '"';
    }
    out += '>';
  }
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 3) out += (child as Text).data.replace(/[&<>]/g, (c) => XML_ESCAPE[c]!);
    else if (child.nodeType === 1) out += serializeXml(child as Element);
  }
  return kept ? out + '</' + tag + '>' : out;
}

// ------------------------------------------------------------------ helpers

/** Raw concatenated text of a subtree (skipped nodes excluded). */
export function rawText(node: VNode): string {
  if (node.kind === 0) return node.text;
  if (node.skip) return '';
  let out = '';
  for (const child of node.children) out += rawText(child);
  return out;
}

/** Text of a subtree with whitespace collapsed and trimmed. */
export function textOf(node: VNode): string {
  return collapse(rawText(node));
}

export function collapse(text: string): string {
  return text.replace(/[\t\n\f\r ]+/g, ' ').trim();
}

/**
 * `text.split(separator)` for a sticky (`y`), group-free separator that opens with `\s*` or `\s+`: such a match
 * never starts inside a run of whitespace, only where the run starts, so the separator is tried only there. Tried
 * from every space of a long run (no-break spaces survive `collapse`), it would rescan the rest of the run each time.
 */
export function splitAtRuns(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (i !== start && /\s/.test(text[i - 1]!)) continue;
    separator.lastIndex = i;
    const m = separator.exec(text);
    if (m === null || m[0].length === 0) continue;
    parts.push(text.slice(start, i));
    start = i + m[0].length;
    i = start - 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Length of `text` as rendered: whitespace runs count as one character, edges trimmed. */
export function visibleLength(text: string): number {
  let n = 0;
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12) {
      if (!space) {
        n++;
        space = true;
      }
    } else {
      n++;
      space = false;
    }
  }
  return space && n > 0 ? n - 1 : n;
}

export function countCommas(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // , ، 、 ， ﹐ ﹑ ､ ⸲ ⸴ ⹁ ⹌ ⹎ ߸ ᠂ ᠈ ꓾ ꘍ ꛵ ︑
    if (c === 0x2c || c === 0x60c || c === 0x3001 || c === 0xff0c || c === 0xfe50 || c === 0xfe51 || c === 0xff64 || c === 0x2e32 || c === 0x2e34 || c === 0x2e41 || c === 0x2e4c || c === 0x2e4e || c === 0x7f8 || c === 0x1802 || c === 0x1808 || c === 0xa4fe || c === 0xa60d || c === 0xa6f5 || c === 0xfe11) n++;
  }
  return n;
}

/** Depth-first pre-order walk over elements. Return false from `visit` to skip children. */
export function walk(el: VElement, visit: (el: VElement) => boolean | void): void {
  if (visit(el) === false) return;
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.kind === 1) walk(child, visit);
  }
}

export function elements(el: VElement, tag: string): VElement[] {
  const out: VElement[] = [];
  walk(el, (e) => {
    if (e !== el && e.tag === tag) out.push(e);
  });
  return out;
}

export function firstElement(el: VElement, test: (e: VElement) => boolean): VElement | null {
  let found: VElement | null = null;
  walk(el, (e) => {
    if (found !== null) return false;
    if (e !== el && test(e)) {
      found = e;
      return false;
    }
    return true;
  });
  return found;
}

export function closest(el: VElement | null, test: (e: VElement) => boolean): VElement | null {
  for (let e = el; e !== null; e = e.parent) if (test(e)) return e;
  return null;
}

export function remove(node: VNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const i = parent.children.indexOf(node);
  if (i >= 0) parent.children.splice(i, 1);
  node.parent = null;
}

export function replaceWith(node: VNode, replacement: VNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const i = parent.children.indexOf(node);
  if (i < 0) return;
  parent.children[i] = replacement;
  replacement.parent = parent;
  node.parent = null;
}

export function isAncestor(ancestor: VElement, node: VNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) if (p === ancestor) return true;
  return false;
}
