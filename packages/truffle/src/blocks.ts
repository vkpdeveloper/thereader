import { isCallout, isDataTableCached, isFootnotes } from './content';
import { detectLanguage, languageFromClass, normalizeLanguage } from './languages';
import { frameBlock, imageFrom, isDecorativeImage, isSmallImage, lazyVideo, mediaFromElement, socialProvider, TWEET } from './media';
import type { Block, Callout, Definition, Figure, Footnote, Image, Inline, ListItem, Mark, Table, TableCell, TableRow, TextRun } from './model';
import { collapse, collapseSpaces, firstElement, lowerCase, rawText, walk, type VElement, type VNode } from './tree';
import { resolveHttp, resolveUrl } from './url';

/** $$…$$ display TeX: the delimiters of `texMatches` that start with a dollar. */
const TEX_DOLLARS = /\$\$([^$]+?)\$\$/g;
/** The same plus $…$ inline, for pages that show they use TeX (never "$5 and $10"). */
const TEX_DOLLARS_ANY = /\$\$([^$]+?)\$\$|\$([^\s$\d](?:[^$\n]{0,300}?[^\s$\\])?)\$(?![\d\w])/g;

interface TexMatch {
  index: number;
  end: number;
  /** Where the formula between the delimiters starts and ends. */
  texStart: number;
  texEnd: number;
  display: boolean;
}

/** `text.indexOf(needle, from)` for a `from` that never decreases: each part of the text is searched once. */
function seeker(text: string, needle: string): (from: number) => number {
  let at = -2;
  return (from) => {
    if (at === -2 || (at >= 0 && at < from)) at = text.indexOf(needle, from);
    return at;
  };
}

/**
 * TeX left for MathJax/KaTeX, in order: $$…$$ and \[…\] display, \(…\) inline, and with `dollars`
 * also $…$ inline. What `/\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|…/g` finds, in
 * linear time: that regex scans to the end of the text from every unclosed `\[`, so the backslash
 * pairs are found with `indexOf` instead. Each call searches its own copy of the dollar pattern.
 */
function* texMatches(text: string, dollars: boolean): Generator<TexMatch> {
  const pattern = new RegExp(dollars ? TEX_DOLLARS_ANY : TEX_DOLLARS);
  const pairs = [
    { open: seeker(text, '\\['), close: seeker(text, '\\]'), display: true },
    { open: seeker(text, '\\('), close: seeker(text, '\\)'), display: false },
  ];
  // The first dollar match at or after `from` (null: none; undefined: not searched yet).
  let dollar: RegExpExecArray | null | undefined;
  let from = 0;
  for (;;) {
    if (dollar === undefined || (dollar !== null && dollar.index < from)) {
      pattern.lastIndex = from;
      dollar = pattern.exec(text);
    }
    let first: TexMatch | null = null;
    if (dollar !== null) {
      const end = dollar.index + dollar[0].length;
      const display = text.startsWith('$$', dollar.index);
      const delimiter = display ? 2 : 1;
      first = { index: dollar.index, end, texStart: dollar.index + delimiter, texEnd: end - delimiter, display };
    }
    for (const pair of pairs) {
      const open = pair.open(from);
      if (open < 0 || (first !== null && open > first.index)) continue;
      // `[\s\S]+?`: the first closing delimiter after at least one character. None means none for later openers either.
      const close = pair.close(open + 3);
      if (close >= 0) first = { index: open, end: close + 2, texStart: open + 2, texEnd: close, display: pair.display };
    }
    if (first === null) return;
    yield first;
    from = first.end;
  }
}

const MARK_ORDER: Mark[] = ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup', 'highlight', 'small', 'kbd'];

const TAG_MARK: Record<string, Mark> = Object.assign(Object.create(null) as Record<string, Mark>, {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', cite: 'italic', dfn: 'italic', var: 'italic', u: 'underline', ins: 'underline',
  s: 'strike', del: 'strike', strike: 'strike', code: 'code', tt: 'code', samp: 'code', kbd: 'kbd', sub: 'sub', sup: 'sup', mark: 'highlight', small: 'small',
} satisfies Record<string, Mark>);

const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label',
  'mark', 'math', 'math-tex', 'nobr', 'noscript', 'picture', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
  'sup', 'svg', 'time', 'tt', 'u', 'var', 'wbr', 'input', 'meta', 'link', 'source', 'track',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dd', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul', 'iframe', 'video', 'audio', 'summary', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'xmp', 'listing', 'plaintext',
]);

const BACKLINK = /(?:^|[\s_-])(?:footnote-backref|reversefootnote|footnote-back|footnote-return|mw-cite-backlink|backlink|fn-back|footnote-backlink|data-footnote-backref)(?:$|[\s_-])/;
const PERMALINK = /(?:^|[\s_-])(?:anchor|headerlink|hash-link|permalink|heading-link|anchorjs-link|header-anchor|heading-anchor|anchor-link|deep-link|direct-link|autolink|section-link|copy-link)(?:$|[\s_-])/;
const CAPTION_CLASS = /(?:^|[\s_-])(?:caption|wp-caption-text|figcaption|image-caption|photo-caption|img-caption|media-caption|caption-text|imagecaption|figure-caption|credit|image-credit|photo-credit)(?:$|[\s_-])/;
/** Any element whose class names it a caption or credit (`InlineImage-imageEmbedCaption`, `newsCaption`, `photo-credit`). */
const CAPTION_LIKE = /caption|credit/i;

const CREDIT_CLASS = /(?:^|[\s_-])(?:credit|credits|copyright|attribution|photographer|image-credit|photo-credit|source|byline)(?:$|[\s_-])/;
const FIGURE_LIKE = /(?:^|[\s_-])(?:wp-caption|wp-block-image|image-block|figure|photo|media-image|article-image|inline-image|image-container|image-wrapper|img-wrapper|picture)(?:$|[\s_-])/;
const CODE_TITLE = /(?:^|[\s_-])(?:code-?block-?title|code-?title|filename|file-name|codeblock-header|code-header|code-block-header|rehype-code-title|remark-code-title|highlight-title)(?:$|[\s_-])|codeblocktitle/;
const GUTTER = /(?:^|[\s_-])(?:line-?numbers?(?:-rows)?|linenos?|lineno|linenodiv|gutter|ln-num|hljs-ln-n|hljs-ln-numbers|rouge-gutter|blob-num|lnt|code-line-number|react-syntax-highlighter-line-number|line-num|linenumber|line-number-cell)(?:$|[\s_-])/;
/** Toolbars and labels that code highlighters put inside <pre> (language name, copy button). */
const CODE_CHROME = /(?:^|[\s_-])(?:code-toolbar|toolbar|code-language|code-lang|lang-label|language-label|language-tag|copy-button|copy-code|clipboard)(?:$|[\s_-])/;
const LINE_ELEMENT = /(?:^|[\s_-])(?:line|code-line|cm-line|ec-line|token-line|highlight-line|view-line|line-content)(?:$|[\s_-])/;
const ABSOLUTE = /position\s*:\s*absolute/i;
const PULL_QUOTE = /(?:^|[\s_-])(?:pullquote|pull-quote|wp-block-pullquote|pull_quote|blockquote--pull)(?:$|[\s_-])/;
/** Wikipedia's fallback image for a formula (the formula is read from its MathML). */
const MATH_FALLBACK_IMAGE = /mwe-math-fallback-image/;
const FOOTNOTE_CLASS = /(?:^|\s)footnote(?:\s|$)/;
/** Schemes a link keeps on its text. */
const LINK_SCHEME = /^(?:https?|mailto|tel):/i;
const PERMALINK_GLYPH = /^[#¶§🔗]?$/u;
const BOLD_STYLE = /font-weight\s*:\s*(?:bold|[6-9]00)/i;
const ITALIC_STYLE = /font-style\s*:\s*italic/i;
/** Zero-width characters, and private-use code points (icon-font glyphs that show as boxes without their font). */
const ZERO_WIDTH = /[\u200b\ufeff\u2060\ue000-\uf8ff]/g;
/** Anything but HTML whitespace. */
const VISIBLE = /[^\t\n\f\r ]/;

interface Ctx {
  marks: Mark[];
  href: string | null;
  /** `marks` in model order, made on first use and shared by the runs in this context (nothing mutates them). */
  sorted: Mark[] | null;
}

function context(marks: Mark[], href: string | null): Ctx {
  return { marks, href, sorted: null };
}

/** Builds inline content with whitespace normalized the way a browser renders it. */
class InlineBuilder {
  nodes: Inline[] = [];
  /** Consecutive line breaks with nothing visible between them. */
  breaks = 0;
  /** Id of an anchor that opens the current paragraph ("[<a name="f1n">1</a>] ..."). */
  anchor: string | null = null;
  /** An element starts or ends here: text on either side comes from different elements. */
  edge = false;

  constructor(
    private readonly converter: Converter,
    /** Paragraph mode: a double break ends the paragraph. */
    private readonly out: Block[] | null,
  ) {}

  text(value: string, ctx: Ctx): void {
    if (value.length === 0) return;
    const text = value.replace(ZERO_WIDTH, '');
    if (text.length === 0) return;
    if (this.converter.tex && (text.indexOf('$') >= 0 || text.indexOf('\\') >= 0) && ctx.marks.indexOf('code') < 0 && this.texRuns(text, ctx)) return;
    this.plain(text, ctx);
  }

  private plain(text: string, ctx: Ctx): void {
    if (this.edge) {
      this.edge = false;
      // Two elements shown as separate lines ("…Western Australia.<small>Photograph: …"): never one glued word.
      const last = this.nodes[this.nodes.length - 1];
      if (last !== undefined && last.type === 'text' && endsSentence(last.text) && CAPITAL.test(text) && ctx.marks.indexOf('code') < 0 && (last.marks === undefined || last.marks.indexOf('code') < 0)) {
        last.text += ' ';
      }
    }
    if (this.breaks > 0 && !VISIBLE.test(text)) return;
    this.breaks = 0;
    const run: TextRun = { type: 'text', text };
    if (ctx.marks.length > 0) run.marks = ctx.sorted ??= sortMarks(ctx.marks);
    if (ctx.href !== null) run.href = ctx.href;
    this.nodes.push(run);
  }

  /**
   * Splits TeX written for a client-side renderer out of `text` as math; false when there is none.
   * `texMatches` searches its own copy of the shared pattern, and the text around the formulas
   * (which holds no formula) is added as is, so no call can move another's search.
   */
  private texRuns(text: string, ctx: Ctx): boolean {
    let at = 0;
    for (const m of texMatches(text, this.converter.dollars)) {
      if (m.index > at) this.plain(text.slice(at, m.index), ctx);
      const tex = text.slice(m.texStart, m.texEnd).trim();
      if (tex.length > 0) {
        const node: Inline = { type: 'math', tex, text: tex };
        if (m.display) this.converter.displayMath.add(node);
        this.push(node);
      }
      at = m.end;
    }
    if (at === 0) return false;
    if (at < text.length) this.plain(text.slice(at), ctx);
    return true;
  }

  lineBreak(): void {
    this.edge = false;
    this.breaks++;
    if (this.breaks >= 2 && this.out !== null) {
      this.flush();
      this.breaks = 2;
      return;
    }
    this.nodes.push({ type: 'break' });
  }

  push(node: Inline): void {
    this.edge = false;
    this.breaks = 0;
    // Display math is a block of its own: the sentence around it continues in the next paragraph.
    if (node.type === 'math' && this.out !== null && this.converter.displayMath.has(node)) {
      this.flush();
      const block = { type: 'math' } as Block & { type: 'math' };
      if (node.tex !== undefined) block.tex = node.tex;
      if (node.mathml !== undefined) block.mathml = node.mathml;
      block.text = node.text;
      this.out.push(block);
      return;
    }
    this.nodes.push(node);
  }

  /** Paragraph mode: emits the collected paragraph (or a display formula) and starts a new one. */
  flush(): void {
    if (this.out === null) return;
    const content = normalizeInlines(this.nodes);
    const anchor = this.anchor;
    this.nodes = [];
    this.breaks = 0;
    this.anchor = null;
    if (content.length === 0) return;
    if (anchor !== null && this.converter.anchoredNote(anchor, content, this.out)) return;
    this.out.push({ type: 'paragraph', content });
  }

  result(): Inline[] {
    return normalizeInlines(this.nodes);
  }
}

function sortMarks(marks: Mark[]): Mark[] {
  const out: Mark[] = [];
  for (const m of MARK_ORDER) if (marks.indexOf(m) >= 0) out.push(m);
  return out;
}

function sameFormat(a: TextRun, b: TextRun): boolean {
  if (a.href !== b.href) return false;
  const am = a.marks;
  const bm = b.marks;
  // No marks and an empty list are the same.
  const n = am === undefined ? 0 : am.length;
  if (n !== (bm === undefined ? 0 : bm.length)) return false;
  for (let i = 0; i < n; i++) if (am![i] !== bm![i]) return false;
  return true;
}

/** Collapses whitespace across runs, trims around breaks and block edges, merges equal runs. */
export function normalizeInlines(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  let spaceBefore = true;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type === 'text') {
      let text = collapseSpaces(node.text);
      if (spaceBefore && text.charCodeAt(0) === 32) text = text.slice(1);
      if (text.length === 0) continue;
      spaceBefore = text.charCodeAt(text.length - 1) === 32;
      const last = out[out.length - 1];
      if (last !== undefined && last.type === 'text' && sameFormat(last, node)) {
        last.text += text;
      } else {
        const run: TextRun = { type: 'text', text };
        if (node.marks !== undefined) run.marks = node.marks;
        if (node.href !== undefined) run.href = node.href;
        out.push(run);
      }
    } else if (node.type === 'break') {
      trimEnd(out);
      if (out.length === 0 || out[out.length - 1]!.type === 'break') continue;
      out.push(node);
      spaceBefore = true;
    } else {
      out.push(node);
      spaceBefore = false;
    }
  }
  trimEnd(out);
  while (out.length > 0 && out[out.length - 1]!.type === 'break') {
    out.pop();
    trimEnd(out);
  }
  // A run of only spaces between two breaks or at the start carries nothing.
  for (let i = 0; i < out.length; i++) {
    const n = out[i]!;
    if (n.type === 'text' && n.text.length === 0) return out.filter((n) => n.type !== 'text' || n.text.length > 0);
  }
  return out;
}

/** Drops trailing spaces (`/ +$/`) from the last runs, and runs left empty. */
function trimEnd(out: Inline[]): void {
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.type !== 'text') return;
    const text = last.text;
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 32) end--;
    if (end > 0) {
      if (end < text.length) last.text = text.slice(0, end);
      return;
    }
    out.pop();
  }
}

function hasBlock(el: VElement): boolean {
  if (el.blockState >= 0) return el.blockState === 1;
  let found = false;
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.kind === 1 && !child.skip && (BLOCK_TAGS.has(child.tag) || hasBlock(child))) {
      found = true;
      break;
    }
  }
  el.blockState = found ? 1 : 0;
  return found;
}

function isInline(el: VElement): boolean {
  if (INLINE_TAGS.has(el.tag)) return !hasBlock(el);
  // Custom elements holding only phrasing (<dt-math>, <d-cite>) sit inside the sentence; video placeholders do not.
  return el.tag.indexOf('-') > 0 && !hasBlock(el) && lazyVideo(el) === null;
}

const DISPLAY_WRAPPER = /(?:^|[\s_-])(?:katex-display|math-display|display-math|mathjax_display|mwe-math-element-block|math-block|equation)(?:$|[\s_-])/;

/** A formula set on its own line: by its own attributes or its renderer's wrapper (KaTeX, MathJax, Wikipedia, Distill). */
function isDisplayMath(el: VElement): boolean {
  if (el.attrs['display'] === 'block' || el.attrs['mode'] === 'display') return true;
  let p = el.parent;
  for (let depth = 0; depth < 4 && p !== null; depth++, p = p.parent) {
    if (DISPLAY_WRAPPER.test(p.matchString) || p.attrs['display'] === 'true' && p.tag === 'mjx-container') return true;
    if (p.tag.endsWith('-math') && p.attrs['block'] !== undefined) return true;
  }
  return false;
}

/** The still of a video file drawn right after it (its poster, for browsers that do not play video): that video already shows it. */
function isStillOf(prev: Block | undefined, image: Image): boolean {
  return prev !== undefined && prev.type === 'video' && prev.provider === 'file' && prev.poster === image.src;
}

function intAttr(el: VElement, name: string): number | undefined {
  const v = el.attrs[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function texFrom(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let tex = value.trim();
  const m = /^\{\\(?:displaystyle|textstyle|scriptstyle)\s*([\s\S]*)\}$/.exec(tex);
  if (m !== null) tex = m[1]!.trim();
  return tex.length > 0 ? tex : undefined;
}

export class Converter {
  /** Footnote item ids found in the article, with their labels. */
  private readonly notes = new Map<string, string>();
  /** Footnote items, and (built on first use) their text with the label stripped, to recognise inline copies. */
  private readonly noteItems: VElement[] = [];
  private noteTexts: Set<string> | null = null;
  private pendingCodeTitle: string | null = null;
  /** Notes written inline at their reference (LaTeXML, sidenotes), listed after the text. */
  private readonly inlineNotes: Footnote[] = [];
  private inNote = false;
  /** In-page "[n]" links not yet matched to a note: target id -> label. */
  private readonly pendingRefs = new Map<string, string>();
  /** Provisional refs with the link text they replace if no note turns up. */
  private readonly provisional = new Map<Inline, string>();
  private readonly resolved = new Set<string>();
  /** The <li> each item of an ordered list after a provisional ref came from, to find a ref's anchor in. */
  private readonly itemSources = new Map<ListItem, VElement>();
  /** Label of the first reference to each listed note. */
  private readonly refLabels = new Map<string, string>();
  /** Link targets resolved against the base so far (pages link the same places many times). */
  private readonly links = new Map<string, string | null>();
  /** Math nodes typeset as display (block) formulas. */
  readonly displayMath = new WeakSet<Inline>();
  /** The text holds TeX delimiters (`$$`, `\[`, `\(`), so it is parsed as math; `dollars` adds $…$ inline. */
  tex = false;
  dollars = false;

  constructor(private readonly base: string) {}

  convert(roots: VElement[]): Block[] {
    for (const root of roots) this.scanFootnotes(root);
    for (const root of roots) this.scanTex(root);
    const out: Block[] = [];
    for (const root of roots) {
      if (root.skip) continue;
      if (isInline(root) || root.tag === 'p') this.children(root, out);
      else this.block(root, out);
    }
    if (this.inlineNotes.length > 0) out.push({ type: 'footnotes', items: this.inlineNotes });
    if (this.provisional.size > 0) this.resolveRefs(out);
    return out;
  }

  private isNoteCopy(el: VElement): boolean {
    if (this.noteTexts === null) {
      this.noteTexts = new Set<string>();
      for (const item of this.noteItems) this.noteTexts.add(noteKey(rawText(item)));
    }
    return this.noteTexts.has(noteKey(rawText(el)));
  }

  /** A paragraph opened by the anchor a "[n]" link points at is that note (Paul Graham style "Notes"). */
  anchoredNote(id: string, content: Inline[], out: Block[] | null): boolean {
    const label = this.pendingRefs.get(id);
    if (out === null || label === undefined || this.resolved.has(id)) return false;
    const blocks: Block[] = [{ type: 'paragraph', content }];
    stripNoteLabel(blocks, label);
    if (blocks.length === 0) return false;
    this.resolved.add(id);
    const note: Footnote = { id, label, blocks };
    const last = out[out.length - 1];
    if (last !== undefined && last.type === 'footnotes') last.items.push(note);
    else out.push({ type: 'footnotes', items: [note] });
    return true;
  }

  /**
   * Settles provisional refs: an id-less ordered list closing the article with
   * one item per unresolved label 1..n is their notes; any ref still without a
   * note reverts to its link text.
   */
  private resolveRefs(out: Block[]): void {
    const pending: [string, string][] = [];
    const open: string[] = [];
    for (const [id, label] of this.pendingRefs) {
      if (this.resolved.has(id)) continue;
      pending.push([id, label]);
      if (open.indexOf(label) < 0) open.push(label);
    }
    const tail = Math.max(0, out.length - 3);
    for (let i = out.length - 1; i >= tail && open.length > 0; i--) {
      const list = out[i]!;
      if (list.type !== 'list' || !list.ordered || (list.start ?? 1) !== 1 || list.items.length !== open.length) continue;
      if (!open.every((label) => Number(label) >= 1 && Number(label) <= open.length)) break;
      // Each ref takes the item holding its own anchor, else the item its number names, unless another ref uses that
      // number too (two anchors, one item: which one it belongs to is unknown).
      const index = pending.map(([id, label]) => {
        const k = list.items.findIndex((item) => {
          const li = this.itemSources.get(item);
          return li !== undefined && (li.id === id || firstElement(li, (e) => e.id === id || e.attrs['name'] === id) !== null);
        });
        if (k >= 0) return k;
        return pending.some(([other, l]) => l === label && other !== id) ? -1 : Number(label) - 1;
      });
      if (!list.items.every((_, k) => index.indexOf(k) >= 0)) break;
      const items: Footnote[] = [];
      pending.forEach(([id, label], j) => {
        if (index[j]! < 0) return;
        this.resolved.add(id);
        items.push({ id, label, blocks: list.items[index[j]!]!.blocks });
      });
      out[i] = { type: 'footnotes', items };
      break;
    }
    // Paragraphs between two runs of anchored notes continue the note before them.
    for (let i = 0; i < out.length; i++) {
      const notes = out[i]!;
      if (notes.type !== 'footnotes') continue;
      let j = i + 1;
      while (j < out.length && j - i <= 4 && out[j]!.type === 'paragraph') j++;
      const next = out[j];
      if (j === i + 1 || next === undefined || next.type !== 'footnotes') continue;
      notes.items[notes.items.length - 1]!.blocks.push(...out.slice(i + 1, j));
      notes.items.push(...next.items);
      out.splice(i + 1, j - i);
      i--;
    }
    eachInlines(out, (content) => {
      let changed = false;
      for (let k = 0; k < content.length; k++) {
        const node = content[k]!;
        if (node.type !== 'ref') continue;
        const text = this.provisional.get(node);
        if (text !== undefined && !this.resolved.has(node.id)) {
          content[k] = { type: 'text', text };
          changed = true;
          continue;
        }
        // "[" ref "]": the brackets are the reference's own decoration.
        const prev = content[k - 1];
        const next = content[k + 1];
        if (prev !== undefined && next !== undefined && prev.type === 'text' && next.type === 'text' && prev.text.endsWith('[') && next.text.startsWith(']')) {
          prev.text = prev.text.slice(0, -1);
          next.text = next.text.slice(1);
          changed = true;
        }
      }
      if (!changed) return;
      const normalized = normalizeInlines(content);
      content.length = 0;
      content.push(...normalized);
    });
  }

  // ---------------------------------------------------------------- TeX

  /** Display delimiters ($$, \[) or \( anywhere in the prose mean the page renders TeX client-side. */
  private scanTex(root: VElement): void {
    const visit = (el: VElement): void => {
      if (this.tex || el.skip || el.tag === 'pre' || el.tag === 'code' || el.tag === 'math' || el.tag === 'math-tex') return;
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.kind === 1) visit(child);
        else if (child.text.indexOf('$$') >= 0 || child.text.indexOf('\\(') >= 0 || child.text.indexOf('\\[') >= 0) {
          if (!texMatches(child.text, false).next().done) this.tex = true;
        }
        if (this.tex) return;
      }
    };
    visit(root);
    this.dollars = this.tex;
  }

  // ---------------------------------------------------------------- footnotes

  private scanFootnotes(root: VElement): void {
    let counter = this.notes.size;
    walk(root, (el) => {
      if (el.skip) return false;
      const isContainer = el.tag !== 'a' && isFootnotes(el);
      if (isContainer) {
        walk(el, (item) => {
          if (item.skip) return false;
          if (item !== el && isNoteItem(item)) {
            counter++;
            this.notes.set(item.id, String(counter));
            this.noteItems.push(item);
            return false;
          }
          return true;
        });
        return false;
      }
      // Substack-style notes: <div class="footnote"><a class="footnote-number" id="footnote-1">1</a>...
      if (FOOTNOTE_CLASS.test(el.className)) {
        const number = firstElement(el, (e) => /footnote-number/.test(e.matchString) && e.id.length > 0);
        if (number !== null) {
          counter++;
          this.notes.set(number.id, collapse(rawText(number)) || String(counter));
          return false;
        }
        if (el.id.length > 0) {
          counter++;
          this.notes.set(el.id, String(counter));
          return false;
        }
      }
      return true;
    });
  }

  private isFootnoteContainer(el: VElement): boolean {
    if (el.tag === 'a' || this.notes.size === 0) return false;
    return isFootnotes(el);
  }

  private footnotes(el: VElement, out: Block[]): void {
    const items: Footnote[] = [];
    walk(el, (item) => {
      if (item.skip) return false;
      if (item !== el && isNoteItem(item) && this.notes.has(item.id)) {
        // Sphinx and docutils put the number in a label span; it is the item's label, not text.
        const label = firstElement(item, (e) => e.hasClass('label') || e.hasClass('fn-label'));
        if (label !== null) label.skip = true;
        const blocks: Block[] = [];
        this.children(item, blocks);
        // The number the text shows for this note, else its position.
        const shown = this.refLabels.get(item.id) ?? this.notes.get(item.id)!;
        stripNoteLabel(blocks, shown);
        if (blocks.length > 0) items.push({ id: item.id, label: shown, blocks });
        return false;
      }
      return true;
    });
    if (items.length > 0) out.push({ type: 'footnotes', items });
    else this.children(el, out);
  }

  private substackFootnote(el: VElement, out: Block[]): boolean {
    if (!FOOTNOTE_CLASS.test(el.className)) return false;
    const number = firstElement(el, (e) => /footnote-number/.test(e.matchString) && e.id.length > 0);
    const id = number !== null ? number.id : el.id;
    if (id.length === 0 || !this.notes.has(id)) return false;
    const content = firstElement(el, (e) => /footnote-content/.test(e.matchString)) ?? el;
    if (number !== null) number.skip = true;
    const blocks: Block[] = [];
    this.children(content, blocks);
    if (blocks.length === 0) return true;
    const last = out[out.length - 1];
    const note: Footnote = { id, label: this.notes.get(id)!, blocks };
    if (last !== undefined && last.type === 'footnotes') last.items.push(note);
    else out.push({ type: 'footnotes', items: [note] });
    return true;
  }

  // ---------------------------------------------------------------- blocks

  /** Converts a container's children: phrasing runs become paragraphs, blocks convert in place. */
  children(el: VElement, out: Block[]): void {
    const lone = loneCode(el);
    if (lone !== null) {
      this.code(lone, out);
      return;
    }
    const inline = new InlineBuilder(this, out);
    const ctx = context([], null);
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (child.kind === 0) {
        inline.text(child.text, ctx);
      } else if (child.skip) {
        continue;
      } else if (this.caption(child, out, inline)) {
        continue;
      } else if (isInline(child)) {
        this.inline(child, inline, ctx, out);
      } else {
        inline.flush();
        const before = out.length;
        this.block(child, out);
        if (out.length > before) this.attachCaption(out, kids, i);
      }
    }
    inline.flush();
  }

  /**
   * Caption and credit elements outside <figure>: attached to the image just
   * emitted, dropped when no image precedes them (the image was a script-only
   * gallery or a placeholder, so the caption describes nothing on the page).
   */
  private caption(el: VElement, out: Block[], inline: InlineBuilder | null): boolean {
    if (el.tag === 'img' || el.tag === 'figure' || el.tag === 'picture' || el.tag === 'a') return false;
    if (!CAPTION_LIKE.test(el.className) || el.textLen > 400 || hasDescendant(el, 'img') || hasDescendant(el, 'p', 1) && el.textLen > 200) return false;
    if (inline !== null && inline.nodes.length > 0) {
      // Mid-sentence spans are not captions unless an image was just emitted.
      const last = out[out.length - 1];
      if (last === undefined || last.type !== 'figure') return false;
    }
    if (inline !== null) inline.flush();
    const last = out[out.length - 1];
    if (last !== undefined && last.type === 'figure') {
      const content = this.inlineOnly(el);
      if (content.length > 0) {
        if (last.caption === undefined && !/credit/i.test(el.className)) last.caption = content;
        else if (last.credit === undefined && inlineTextOf(content) !== inlineTextOf(last.caption ?? [])) last.credit = content;
      }
    }
    return true;
  }

  /** A caption element right after an uncaptioned image belongs to it. */
  private attachCaption(out: Block[], kids: VNode[], index: number): void {
    const last = out[out.length - 1]!;
    if (last.type !== 'figure' || last.caption !== undefined) return;
    for (let j = index + 1; j < kids.length; j++) {
      const next = kids[j]!;
      if (next.kind === 0) {
        if (next.text.trim().length > 0) return;
        continue;
      }
      if (next.skip) continue;
      if (CAPTION_CLASS.test(next.matchString) && next.tag !== 'img' && collapse(rawText(next)).length < 500) {
        const caption = this.inlineOnly(next);
        if (caption.length > 0) last.caption = caption;
        next.skip = true;
      }
      return;
    }
  }

  block(el: VElement, out: Block[]): void {
    if (el.skip) return;
    switch (el.tag) {
      case 'p':
        this.children(el, out);
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.heading(el, out);
        return;
      case 'ul':
      case 'ol':
      case 'menu':
      case 'dir':
        this.list(el, out);
        return;
      case 'dl':
        this.definitions(el, out);
        return;
      case 'blockquote':
        this.quote(el, out);
        return;
      case 'pre':
      case 'xmp':
      case 'listing':
      case 'plaintext':
        this.code(el, out);
        return;
      case 'figure':
        this.figure(el, out);
        return;
      case 'table':
        this.table(el, out);
        return;
      case 'hr':
        out.push({ type: 'rule' });
        return;
      case 'details':
        this.details(el, out);
        return;
      case 'img':
      case 'picture':
        this.standaloneImage(el, out);
        return;
      case 'iframe': {
        const block = frameBlock(el, this.base);
        if (block !== null) out.push(block.type === 'code' ? this.codeBlock(block.code, 'plaintext') : block);
        return;
      }
      case 'video':
      case 'audio': {
        const block = mediaFromElement(el, this.base);
        if (block !== null) out.push(block);
        return;
      }
      case 'math':
      case 'math-tex':
        this.mathBlock(el, out);
        return;
      case 'noscript':
        this.noscript(el, out);
        return;
      case 'svg':
      case 'input':
      case 'meta':
      case 'link':
      case 'title':
      case 'source':
      case 'track':
      case 'colgroup':
      case 'col':
      case 'br':
      case 'summary':
      case 'figcaption':
        return;
      case 'li':
      case 'dd':
      case 'dt':
      case 'td':
      case 'th':
      case 'tr':
      case 'tbody':
      case 'thead':
      case 'tfoot':
      case 'caption':
        this.children(el, out);
        return;
    }
    this.container(el, out);
  }

  private container(el: VElement, out: Block[]): void {
    if (CODE_TITLE.test(el.matchString) && el.textLen < 120 && !hasDescendant(el, 'pre')) {
      const title = plainLabel(el);
      if (title.length > 0 && title.length < 120) this.pendingCodeTitle = title;
      return;
    }
    if (this.isFootnoteContainer(el)) {
      this.footnotes(el, out);
      return;
    }
    if (this.substackFootnote(el, out)) return;
    // Margin or hover copies of notes that the footnote list also has.
    if (this.noteItems.length > 0 && /footnote|sidenote|marginnote/.test(el.matchString) && el.textLen < 3000 && this.isNoteCopy(el)) return;
    const video = lazyVideo(el);
    if (video !== null) {
      out.push(video);
      return;
    }
    const social = socialProvider(el);
    if (social !== null) {
      this.embed(el, social, out);
      return;
    }
    if (isCodeTable(el)) {
      this.codeTable(el, out);
      return;
    }
    if (el.tag !== 'body' && isCallout(el) && el.textLen > 0 && el.textLen < 3000) {
      this.callout(el, out);
      return;
    }
    if (FIGURE_LIKE.test(el.matchString) && el.textLen < 600 && hasDescendant(el, 'img') && !hasDescendant(el, 'p', 2)) {
      this.figure(el, out);
      return;
    }
    this.children(el, out);
  }

  // ---------------------------------------------------------------- inline

  private inline(el: VElement, b: InlineBuilder, ctx: Ctx, out: Block[]): void {
    if (el.skip) return;
    b.edge = true;
    this.inlineElement(el, b, ctx, out);
    b.edge = true;
  }

  private inlineElement(el: VElement, b: InlineBuilder, ctx: Ctx, out: Block[]): void {
    if (this.caption(el, out, b)) return;
    const tag = el.tag;
    if (tag !== 'a' && !this.inNote && el.matchString.indexOf('note') >= 0 && INLINE_NOTE.test(el.matchString) && this.inlineNote(el, b)) return;
    if (this.notes.size > 0 && tag !== 'a') {
      // Script-driven references: <span class="foot-ref" data-footnote="footnote-esb">5</span>.
      const target = el.attrs['data-footnote'] ?? el.attrs['data-footnote-id'] ?? el.attrs['data-fn'] ?? el.attrs['data-note'];
      if (target !== undefined && this.notes.has(target)) {
        const label = collapse(rawText(el)).replace(/^\[|\]$/g, '').trim() || this.notes.get(target)!;
        if (!this.refLabels.has(target)) this.refLabels.set(target, label);
        b.push({ type: 'ref', id: target, label });
        return;
      }
    }
    switch (tag) {
      case 'br':
        b.lineBreak();
        return;
      case 'wbr':
      case 'input':
      case 'meta':
      case 'link':
      case 'source':
      case 'track':
      case 'svg':
      case 'rp':
        return;
      case 'img':
      case 'picture': {
        const img = tag === 'picture' ? firstElement(el, (e) => e.tag === 'img') : el;
        if (img === null || MATH_FALLBACK_IMAGE.test(img.className)) return;
        const image = imageFrom(img, this.base) ?? this.noscriptImage(img);
        if (image === null || isDecorativeImage(img, image, this.base)) return;
        if (isSmallImage(img, image)) {
          const node: Inline = { type: 'image', src: image.src, alt: image.alt };
          if (image.width !== undefined) node.width = image.width;
          if (image.height !== undefined) node.height = image.height;
          b.push(node);
          return;
        }
        b.flush();
        if (isStillOf(out[out.length - 1], image)) return;
        // A linked full-size file; `mailto:`/`tel:` stay on text.
        if (ctx.href !== null && image.href === undefined && ctx.href !== image.src && /^https?:/i.test(ctx.href) && /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(ctx.href)) image.href = ctx.href;
        out.push({ type: 'figure', images: [image] });
        return;
      }
      case 'math':
      case 'math-tex': {
        const node = mathInline(el);
        if (node === null) return;
        if (isDisplayMath(el)) this.displayMath.add(node);
        b.push(node);
        return;
      }
      case 'noscript':
        return;
      case 'a': {
        const href = el.attrs['href'];
        if (href !== undefined && href.charCodeAt(0) === 35) {
          const id = decodeFragment(href.slice(1));
          if (this.notes.has(id)) {
            const label = collapse(rawText(el)).replace(/^\[|\]$/g, '').trim() || this.notes.get(id)!;
            if (!this.refLabels.has(id)) this.refLabels.set(id, label);
            b.push({ type: 'ref', id, label });
            return;
          }
          const linkText = collapse(rawText(el));
          if (BACKLINK.test(el.matchString) || /^[↩↑^]/.test(linkText)) return;
          // Permalink glyphs go; a permalink wrapping the heading's own words keeps them.
          if (PERMALINK_GLYPH.test(linkText)) return;
          // "[1]" pointing at a plain anchor: a note reference until proven otherwise (see `resolveRefs`).
          const number = /^\[?(\d{1,3})\]?$/.exec(linkText);
          if (number !== null && id.length > 0 && !this.inNote) {
            const ref: Inline = { type: 'ref', id, label: number[1]! };
            this.provisional.set(ref, linkText);
            if (!this.pendingRefs.has(id)) this.pendingRefs.set(id, number[1]!);
            b.push(ref);
            return;
          }
          // Other in-page links read as plain text.
          this.inlineChildren(el, b, ctx, out);
          return;
        }
        // <a id="introduction">Introduction</a> outside a heading: a section anchor whose label is shown only to screen readers or the TOC.
        if (href === undefined && el.id.length > 0 && slug(collapse(rawText(el))) === el.id.toLowerCase() && closestHeading(el) === null) return;
        if (href === undefined && b.nodes.length <= 1 && inlineTextOf(b.nodes).trim().replace(/^[[(]$/, '').length === 0) {
          const anchor = el.attrs['name'] ?? el.id;
          if (anchor.length > 0 && this.pendingRefs.has(anchor)) b.anchor = anchor;
        }
        if (PERMALINK.test(el.matchString) && PERMALINK_GLYPH.test(collapse(rawText(el)))) return;
        const resolved = href === undefined ? null : this.resolveLink(href);
        const linkCtx = resolved !== null && LINK_SCHEME.test(resolved) ? context(ctx.marks, resolved) : ctx;
        this.inlineChildren(el, b, linkCtx, out);
        return;
      }
      case 'q':
        b.text('“', ctx);
        this.inlineChildren(el, b, ctx, out);
        b.text('”', ctx);
        return;
      case 'sup':
      case 'sub': {
        const ref = firstElement(el, (e) => e.tag === 'a' && (e.attrs['href'] ?? '').charCodeAt(0) === 35 && this.notes.has(decodeFragment((e.attrs['href'] ?? '').slice(1))));
        if (ref !== null) {
          this.inlineChildren(el, b, ctx, out);
          return;
        }
        break;
      }
      case 'span':
      case 'font': {
        if (tag === 'span' && isAlternative(el)) return;
        const style = el.attrs['style'];
        if (style !== undefined) {
          const marks = ctx.marks.slice();
          if (BOLD_STYLE.test(style)) marks.push('bold');
          if (ITALIC_STYLE.test(style)) marks.push('italic');
          if (marks.length !== ctx.marks.length) {
            this.inlineChildren(el, b, context(marks, ctx.href), out);
            return;
          }
        }
        break;
      }
    }
    const mark = TAG_MARK[tag];
    if (mark !== undefined && ctx.marks.indexOf(mark) < 0) {
      this.inlineChildren(el, b, context(ctx.marks.concat(mark), ctx.href), out);
      return;
    }
    this.inlineChildren(el, b, ctx, out);
  }

  private resolveLink(href: string): string | null {
    let resolved = this.links.get(href);
    if (resolved === undefined) {
      resolved = resolveUrl(href, this.base);
      this.links.set(href, resolved);
    }
    return resolved;
  }

  /**
   * A note written where it is referenced: <span class="ltx_note ltx_role_footnote"><sup>1</sup>
   * <span class="ltx_note_content">...</span></span>. Becomes a ref, and the note goes to the end.
   */
  private inlineNote(el: VElement, b: InlineBuilder): boolean {
    const text = collapse(rawText(el));
    const mark = firstElement(el, (e) => e.tag === 'sup' || /(?:^|[\s_-])(?:note-?mark|sidenote-number|footnote-number)(?:$|[\s_-])/.test(e.matchString));
    const label = mark !== null ? collapse(rawText(mark)).replace(/^\[|\]$/g, '') : '';
    // A bare marker ("1", "[2]") is a reference, not a note.
    if (text.length <= label.length + 3 || label.length > 4) return false;
    const content = firstElement(el, (e) => /(?:^|[\s_-])(?:note-?content|note-?text|note-?body|footnote-?content|sidenote-?content)(?:$|[\s_-])/.test(e.matchString)) ?? el;
    // The marker is hidden while the note is read, and only un-hidden if it was shown before (cleaning may have removed it).
    const hide = mark !== null && !mark.skip && !isAncestorOf(mark, content);
    if (hide) mark.skip = true;
    const blocks: Block[] = [];
    this.inNote = true;
    const inline = this.inlineOnly(content);
    this.inNote = false;
    if (hide) mark!.skip = false;
    if (inline.length === 0) return false;
    blocks.push({ type: 'paragraph', content: inline });
    const n = this.inlineNotes.length + 1;
    const noteLabel = label.length > 0 ? label : String(n);
    stripNoteLabel(blocks, noteLabel);
    if (blocks.length === 0) return false;
    let id = el.id.length > 0 ? el.id : 'note-' + n;
    if (this.notes.has(id)) id = 'inline-' + id;
    this.inlineNotes.push({ id, label: noteLabel, blocks });
    b.push({ type: 'ref', id, label: noteLabel });
    return true;
  }

  private inlineChildren(el: VElement, b: InlineBuilder, ctx: Ctx, out: Block[]): void {
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.kind === 0) b.text(child.text, ctx);
      else if (!child.skip) {
        if (isInline(child)) this.inline(child, b, ctx, out);
        else {
          b.flush();
          this.block(child, out);
        }
      }
    }
  }

  /** Inline content of an element, flattening any blocks inside it (headings, captions, cells, terms). */
  inlineOnly(el: VElement): Inline[] {
    const b = new InlineBuilder(this, null);
    const sink: Block[] = [];
    const visit = (node: VElement, ctx: Ctx): void => {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.kind === 0) {
          b.text(child.text, ctx);
          continue;
        }
        if (child.skip) continue;
        const tag = child.tag;
        if (tag === 'img' || tag === 'picture') {
          const img = tag === 'picture' ? firstElement(child, (e) => e.tag === 'img') : child;
          if (img === null || MATH_FALLBACK_IMAGE.test(img.className)) continue;
          const image = imageFrom(img, this.base);
          if (image !== null && !isDecorativeImage(img, image, this.base) && isSmallImage(img, image)) {
            const node: Inline = { type: 'image', src: image.src, alt: image.alt };
            if (image.width !== undefined) node.width = image.width;
            if (image.height !== undefined) node.height = image.height;
            b.push(node);
          }
          continue;
        }
        if (tag === 'br') {
          b.lineBreak();
          continue;
        }
        if (tag === 'math' || tag === 'math-tex') {
          const m = mathInline(child);
          if (m !== null) b.push(m);
          continue;
        }
        if (tag === 'svg' || tag === 'input' || tag === 'noscript' || tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'button') continue;
        if (BLOCK_TAGS.has(tag) && b.nodes.length > 0) b.lineBreak();
        if (INLINE_TAGS.has(tag)) {
          this.inline(child, b, ctx, sink);
        } else {
          b.edge = true;
          visit(child, ctx);
          b.edge = true;
        }
        if (BLOCK_TAGS.has(tag)) b.lineBreak();
      }
    };
    visit(el, context([], null));
    return b.result();
  }

  // ---------------------------------------------------------------- headings, lists, quotes

  private heading(el: VElement, out: Block[]): void {
    // Wordless links to a fragment (the heading's permalink icon) are not part of the heading.
    const icons: VElement[] = [];
    walk(el, (e) => {
      if (e.tag === 'a' && !e.skip && (e.attrs['href'] ?? '').indexOf('#') >= 0 && rawText(e).replace(ZERO_WIDTH, '').trim().length === 0) {
        icons.push(e);
        e.skip = true;
        return false;
      }
      return true;
    });
    const content = this.inlineOnly(el);
    for (const icon of icons) icon.skip = false;
    if (content.length === 0) return;
    const level = Number(el.tag.charAt(1)) as 2 | 3 | 4 | 5 | 6;
    const block: Block = { type: 'heading', level, content };
    let anchor = el.id;
    if (anchor.length === 0) {
      const a = firstElement(el, (e) => e.id.length > 0 || (e.tag === 'a' && e.attrs['name'] !== undefined));
      if (a !== null) anchor = a.id.length > 0 ? a.id : a.attrs['name']!;
    }
    if (anchor.length > 0) block.anchor = anchor;
    out.push(block);
  }

  private list(el: VElement, out: Block[]): void {
    const items: ListItem[] = [];
    const ordered = el.tag === 'ol';
    const start = intAttr(el, 'start');
    let number = start ?? 1;
    for (const child of el.children) {
      if (child.kind === 0) {
        if (child.text.trim().length > 0) items.push({ blocks: [{ type: 'paragraph', content: normalizeInlines([{ type: 'text', text: child.text }]) }] });
        continue;
      }
      if (child.skip) continue;
      const blocks: Block[] = [];
      if (child.tag === 'li') {
        number = intAttr(child, 'value') ?? number;
        // LaTeXML writes the marker as text before the item's paragraphs: <span class="ltx_tag ltx_tag_item">•</span>.
        const label = itemLabel(child);
        if (label !== null) label.skip = true;
        this.children(child, blocks);
        if (label !== null) {
          label.skip = false;
          prependLabel(blocks, collapse(rawText(label)));
        }
        stripItemMarker(blocks, ordered ? number : null);
        number++;
        if (blocks.length === 0) continue;
        const item: ListItem = { blocks };
        const box = firstElement(child, (e) => e.tag === 'input' && (e.attrs['type'] ?? '').toLowerCase() === 'checkbox');
        if (box !== null) item.checked = box.attrs['checked'] !== undefined;
        if (this.pendingRefs.size > 0 && el.tag === 'ol') this.itemSources.set(item, child);
        items.push(item);
      } else {
        this.block(child, blocks);
        if (blocks.length === 0) continue;
        const prev = items[items.length - 1];
        if ((child.tag === 'ul' || child.tag === 'ol') && prev !== undefined) prev.blocks.push(...blocks);
        else items.push({ blocks });
      }
    }
    if (items.length === 0) return;
    if (items.length > 1 && items.every((i) => i.blocks.length === 1 && i.blocks[0]!.type === 'figure')) {
      const images: Image[] = [];
      for (const item of items) for (const image of (item.blocks[0] as Figure).images) if (!images.some((x) => x.src === image.src)) images.push(image);
      const first = items[0]!.blocks[0] as Figure;
      const gallery: Figure = { type: 'figure', images };
      if (first.caption !== undefined && items.length === 1) gallery.caption = first.caption;
      out.push(gallery);
      return;
    }
    const block: Block = { type: 'list', ordered, items };
    if (ordered && start !== undefined && start !== 1) block.start = start;
    out.push(block);
  }

  private definitions(el: VElement, out: Block[]): void {
    const items: Definition[] = [];
    let current: Definition | null = null;
    const visit = (parent: VElement): void => {
      for (const child of parent.children) {
        if (child.kind !== 1 || child.skip) continue;
        if (child.tag === 'dt') {
          current = { term: this.inlineOnly(child), details: [] };
          items.push(current);
        } else if (child.tag === 'dd') {
          if (current === null) {
            current = { term: [], details: [] };
            items.push(current);
          }
          this.children(child, current.details);
        } else if (child.tag === 'div') {
          visit(child);
        }
      }
    };
    visit(el);
    const kept = items.filter((d) => d.term.length > 0 || d.details.length > 0);
    if (kept.length > 0) out.push({ type: 'definitions', items: kept });
  }

  private quote(el: VElement, out: Block[]): void {
    const social = socialProvider(el);
    if (social !== null) {
      this.embed(el, social, out);
      return;
    }
    let citeEl: VElement | null = null;
    for (const child of el.children) {
      if (child.kind === 1 && !child.skip && (child.tag === 'footer' || child.tag === 'cite')) citeEl = child;
    }
    const blocks: Block[] = [];
    if (citeEl !== null) citeEl.skip = true;
    this.children(el, blocks);
    if (citeEl !== null) citeEl.skip = false;
    if (blocks.length === 0) return;
    const block: Block = { type: 'quote', blocks };
    if (citeEl !== null) {
      const cite = this.inlineOnly(citeEl);
      if (cite.length > 0) block.cite = cite;
    }
    if (PULL_QUOTE.test(el.matchString) || el.parent !== null && PULL_QUOTE.test(el.parent.matchString)) block.pull = true;
    out.push(block);
  }

  private embed(el: VElement, provider: string, out: Block[]): void {
    let url: string | null = null;
    const links: string[] = [];
    walk(el, (e) => {
      if (e.tag === 'a' && e.attrs['href'] !== undefined) {
        const abs = resolveHttp(e.attrs['href'], this.base);
        if (abs !== null) links.push(abs);
      }
      return true;
    });
    if (provider === 'twitter') url = links.filter((l) => TWEET.test(l)).pop() ?? null;
    for (const key of ['data-instgrm-permalink', 'cite', 'data-bluesky-uri', 'data-href']) {
      const value = el.attrs[key];
      url ??= value !== undefined ? resolveHttp(value, this.base) : null;
    }
    url ??= links[links.length - 1] ?? null;
    const blocks: Block[] = [];
    this.children(el, blocks);
    let author: string | undefined;
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.type === 'paragraph') {
      const text = last.content.map((n) => (n.type === 'text' ? n.text : '')).join('');
      // The name starts and ends on a non-space: a long run of spaces is not retried at every split between dash,
      // name, handle and date.
      const m = /^[—–-]\s*(\S(?:.*?\S)?)(?:\s*\((@\w+)\))?\s+[A-Z][a-z]+ \d{1,2}, \d{4}$/.exec(text) ?? /^[—–-]\s*(?!\s)(.+)$/.exec(text);
      if (m !== null) {
        author = m[2] !== undefined ? m[1] + ' (' + m[2] + ')' : m[1]!;
        blocks.pop();
      }
    }
    if (url === null) {
      out.push(...blocks);
      return;
    }
    const block: Block = { type: 'embed', provider, url };
    if (author !== undefined) block.author = author;
    if (blocks.length > 0) block.blocks = blocks;
    out.push(block);
  }

  private callout(el: VElement, out: Block[]): void {
    const m = el.matchString;
    const variant: Callout['variant'] = /danger|error|critical/.test(m)
      ? 'danger'
      : /warning|caution|attention|important/.test(m)
        ? 'warning'
        : /tip|hint|success/.test(m)
          ? 'tip'
          : /info|notice/.test(m)
            ? 'info'
            : /note|admonition|callout|notecard/.test(m)
              ? 'note'
              : null;
    let titleEl: VElement | null = null;
    walk(el, (e) => {
      if (titleEl !== null || e === el) return titleEl === null;
      if (/(?:^|[\s_-])(?:admonition-title|callout-title|alert-title|markdown-alert-title|admonitionheading|notecard-title|title|heading)(?:$|[\s_-])|admonitionheading/.test(e.matchString) && e.textLen < 100) {
        titleEl = e;
        return false;
      }
      return e.tag === 'div' || e.tag === 'p';
    });
    // A short heading opening the box ("Note") is its title (whitespace and skipped elements before it don't count).
    if (titleEl === null) {
      for (const child of el.children) {
        if (child.kind === 0) {
          if (child.text.trim().length > 0) break;
          continue;
        }
        if (child.skip) continue;
        if (/^h[2-6]$/.test(child.tag) && child.textLen < 60) titleEl = child;
        break;
      }
    }
    let title: Inline[] | undefined;
    if (titleEl !== null) {
      title = this.inlineOnly(titleEl);
      (titleEl as VElement).skip = true;
    }
    const blocks: Block[] = [];
    this.children(el, blocks);
    if (titleEl !== null) (titleEl as VElement).skip = false;
    if (blocks.length === 0) {
      if (title !== undefined && title.length > 0) out.push({ type: 'paragraph', content: title });
      return;
    }
    const block: Callout = { type: 'callout', variant, blocks };
    // A title that only names the variant ("note", "Warning") repeats what the renderer already shows.
    if (title !== undefined && title.length > 0 && !(variant !== null && inlineTextOf(title).trim().toLowerCase() === variant)) block.title = title;
    out.push(block);
  }

  private details(el: VElement, out: Block[]): void {
    let summaryEl: VElement | null = null;
    for (const child of el.children) if (child.kind === 1 && child.tag === 'summary' && summaryEl === null) summaryEl = child;
    const summary = summaryEl !== null ? this.inlineOnly(summaryEl) : [];
    const blocks: Block[] = [];
    this.children(el, blocks);
    // A disclosure whose body was all chrome (badges, widgets) is chrome too.
    if (blocks.length === 0) return;
    out.push({ type: 'details', summary, blocks });
  }

  // ---------------------------------------------------------------- code

  private code(el: VElement, out: Block[]): void {
    // Some sites wrap prose in <pre>; a pre full of block markup is not code.
    if (hasDescendant(el, 'p') && hasDescendant(el, 'p', 1) && !hasDescendant(el, 'code')) {
      this.children(el, out);
      return;
    }
    // One listing in several flavours (<code class="language-mjs"> and <code class="language-cjs">): one block each.
    const flavours: VElement[] = [];
    for (const child of el.children) if (child.kind === 1 && !child.skip && child.tag === 'code') flavours.push(child);
    if (flavours.length > 1) {
      for (const flavour of flavours) {
        const text = codeText(flavour);
        if (text.trim().length > 0) out.push(this.codeBlock(text, codeLanguage(flavour)));
      }
      return;
    }
    const code = codeText(el);
    if (code.trim().length === 0) return;
    out.push(this.codeBlock(code, codeLanguage(el)));
  }

  private codeBlock(code: string, marked: string | null): Block {
    const block: Block = { type: 'code', code, language: null };
    if (marked !== null && marked !== 'plaintext') {
      block.language = marked;
      block.languageSource = 'markup';
    } else if (marked === null) {
      const detected = detectLanguage(code);
      if (detected !== null) {
        block.language = detected;
        block.languageSource = 'detected';
      }
    }
    if (this.pendingCodeTitle !== null) {
      block.title = this.pendingCodeTitle;
      this.pendingCodeTitle = null;
    }
    return block;
  }

  private codeTable(el: VElement, out: Block[]): void {
    const lines: string[] = [];
    let preCode: VElement | null = null;
    walk(el, (e) => {
      if (preCode !== null) return false;
      if (e.tag === 'td' && /(?:^|[\s_-])(?:code|blob-code|hljs-ln-code|lntd|line-content)(?:$|[\s_-])/.test(e.matchString) && !GUTTER.test(e.matchString)) {
        const pre = firstElement(e, (x) => x.tag === 'pre');
        if (pre !== null && e.parent !== null && countTag(el, 'tr') <= 2) {
          preCode = pre;
          return false;
        }
        lines.push(codeText(e).replace(/\n$/, ''));
        return false;
      }
      return true;
    });
    if (preCode !== null) {
      this.code(preCode, out);
      return;
    }
    const code = lines.join('\n').replace(/^\n+/, '').trimEnd();
    if (code.length === 0) {
      this.children(el, out);
      return;
    }
    let lang: string | null = null;
    for (let p: VElement | null = el; p !== null && lang === null; p = p.parent) lang = languageFromClass(p.className) ?? normalizeLanguage(p.attrs['data-lang'] ?? p.attrs['data-language']);
    out.push(this.codeBlock(code, lang));
  }

  // ---------------------------------------------------------------- media

  private noscriptImage(img: VElement): Image | null {
    const parent = img.parent;
    if (parent === null) return null;
    const i = parent.children.indexOf(img);
    for (let j = i + 1; j < parent.children.length && j <= i + 3; j++) {
      const sibling = parent.children[j]!;
      if (sibling.kind === 1 && sibling.tag === 'noscript') {
        const inner = firstElement(sibling, (e) => e.tag === 'img');
        if (inner !== null) {
          sibling.skip = true;
          return imageFrom(inner, this.base);
        }
      }
    }
    return null;
  }

  private noscript(el: VElement, out: Block[]): void {
    // Lazy-load fallbacks: only used when the lazy image right before it produced nothing.
    const img = firstElement(el, (e) => e.tag === 'img');
    if (img === null) return;
    const parent = el.parent;
    if (parent !== null) {
      const i = parent.children.indexOf(el);
      for (let j = i - 1; j >= 0; j--) {
        const prev = parent.children[j]!;
        if (prev.kind === 0) {
          if (prev.text.trim().length > 0) break;
          continue;
        }
        if (prev.tag === 'img' || prev.tag === 'picture' || hasDescendant(prev, 'img')) {
          const prevImg = prev.tag === 'img' ? prev : firstElement(prev, (e) => e.tag === 'img');
          if (prevImg !== null && imageFrom(prevImg, this.base) !== null) return;
        }
        break;
      }
    }
    this.standaloneImage(img, out);
  }

  private standaloneImage(el: VElement, out: Block[]): void {
    const img = el.tag === 'picture' ? firstElement(el, (e) => e.tag === 'img') : el;
    if (img === null || MATH_FALLBACK_IMAGE.test(img.className)) return;
    const image = imageFrom(img, this.base) ?? this.noscriptImage(img);
    if (image === null || isDecorativeImage(img, image, this.base)) return;
    if (isStillOf(out[out.length - 1], image)) return;
    if (isSmallImage(img, image)) {
      const node: Inline = { type: 'image', src: image.src, alt: image.alt };
      if (image.width !== undefined) node.width = image.width;
      if (image.height !== undefined) node.height = image.height;
      out.push({ type: 'paragraph', content: [node] });
      return;
    }
    out.push({ type: 'figure', images: [image] });
  }

  private figure(el: VElement, out: Block[]): void {
    let captionEl: VElement | null = null;
    walk(el, (e) => {
      if (captionEl !== null || e.skip) return false;
      if (e !== el && (e.tag === 'figcaption' || (CAPTION_CLASS.test(e.matchString) && e.tag !== 'img' && e.tag !== 'figure'))) {
        captionEl = e;
        return false;
      }
      return true;
    });
    const images: Image[] = [];
    const media: Block[] = [];
    let other = false;
    // Short texts positioned over a figure with nothing else to show: the labels of a graphic drawn by script.
    const overlays: VElement[] = [];
    walk(el, (e) => {
      if (e.skip || e === captionEl) return false;
      if (e !== el && e.textLen > 0 && e.textLen < 100 && ABSOLUTE.test(e.attrs['style'] ?? '')) overlays.push(e);
      switch (e.tag) {
        case 'img': {
          if (MATH_FALLBACK_IMAGE.test(e.className)) return false;
          const image = imageFrom(e, this.base) ?? this.noscriptImage(e);
          if (image !== null && !isDecorativeImage(e, image, this.base) && !images.some((i) => i.src === image.src)) images.push(image);
          return false;
        }
        case 'noscript':
          return false;
        case 'iframe': {
          const block = frameBlock(e, this.base);
          if (block !== null) media.push(block.type === 'code' ? this.codeBlock(block.code, 'plaintext') : block);
          return false;
        }
        case 'video':
        case 'audio': {
          const block = mediaFromElement(e, this.base);
          if (block !== null) media.push(block);
          return false;
        }
        case 'pre':
        case 'table':
        case 'blockquote':
        case 'math':
        case 'ul':
        case 'ol':
          other = true;
          return false;
      }
      if (e !== el) {
        const video = lazyVideo(e);
        if (video !== null) {
          media.push(video);
          return false;
        }
      }
      return true;
    });

    let caption: Inline[] = [];
    let credit: Inline[] = [];
    if (captionEl !== null) {
      const cap = captionEl as VElement;
      const creditEl = firstElement(cap, (e) => CREDIT_CLASS.test(e.matchString));
      if (creditEl !== null) {
        credit = this.inlineOnly(creditEl);
        creditEl.skip = true;
      }
      caption = this.inlineOnly(cap);
      if (creditEl !== null) creditEl.skip = false;
    }

    // A video file's still drawn as an image (the poster, for browsers that do not play it): one video, not a figure and a video.
    const file = media.length === 1 ? media[0]! : null;
    if (file !== null && file.type === 'video' && file.provider === 'file' && !other) {
      if (file.poster === undefined && images.length === 1) file.poster = images[0]!.src;
      for (let i = images.length - 1; i >= 0; i--) if (images[i]!.src === file.poster) images.splice(i, 1);
    }

    if (images.length === 0 && media.length === 0 || other) {
      // Code listings, tables and quotes in a <figure>: convert the content, keep the caption as text.
      if (captionEl !== null) (captionEl as VElement).skip = true;
      if (!other) for (const overlay of overlays) overlay.skip = true;
      const before = out.length;
      this.children(el, out);
      if (captionEl !== null) (captionEl as VElement).skip = false;
      if (!other) for (const overlay of overlays) overlay.skip = false;
      const first = out[before];
      if (caption.length > 0) {
        if (first !== undefined && out.length === before + 1 && first.type === 'table' && first.caption === undefined) first.caption = caption;
        else if (first !== undefined && out.length === before + 1 && first.type === 'quote' && first.cite === undefined) first.cite = caption;
        else if (first !== undefined && out.length === before + 1 && first.type === 'code' && first.title === undefined && caption.length === 1) first.title = textOfInlines(caption);
        else out.push({ type: 'paragraph', content: caption });
      }
      return;
    }
    if (images.length === 0) {
      const block = media[0]!;
      if (caption.length > 0 && (block.type === 'video' || block.type === 'audio')) block.caption = caption;
      out.push(...media);
      return;
    }
    if (credit.length === 0 && caption.length > 0) [caption, credit] = splitCredit(caption);
    const figure: Figure = { type: 'figure', images };
    if (caption.length > 0) figure.caption = caption;
    if (credit.length > 0) figure.credit = credit;
    out.push(figure);
    out.push(...media);
  }

  private mathBlock(el: VElement, out: Block[]): void {
    const node = mathInline(el);
    if (node === null) return;
    const block: Block = { type: 'math', text: node.text };
    if (node.tex !== undefined) block.tex = node.tex;
    if (node.mathml !== undefined) block.mathml = node.mathml;
    out.push(block);
  }

  // ---------------------------------------------------------------- tables

  private table(el: VElement, out: Block[]): void {
    if (isCodeTable(el)) {
      this.codeTable(el, out);
      return;
    }
    if (!isDataTableCached(el)) {
      for (const row of tableRows(el)) for (const cell of row.cells) this.children(cell, out);
      for (const child of el.children) if (child.kind === 1 && child.tag === 'caption' && !child.skip) this.children(child, out);
      return;
    }
    const rows: TableRow[] = [];
    let headerRows = 0;
    let counting = true;
    for (const row of tableRows(el)) {
      const cells: TableCell[] = [];
      let allHeader = true;
      for (const cellEl of row.cells) {
        const cell: TableCell = { content: this.inlineOnly(cellEl) };
        const header = cellEl.tag === 'th' || row.head;
        if (header) cell.header = true;
        else allHeader = false;
        const colspan = intAttr(cellEl, 'colspan');
        const rowspan = intAttr(cellEl, 'rowspan');
        if (colspan !== undefined && colspan > 1) cell.colspan = Math.min(colspan, 100);
        if (rowspan !== undefined && rowspan > 1) cell.rowspan = Math.min(rowspan, 1000);
        const align = (cellEl.attrs['align'] ?? /text-align\s*:\s*(left|center|right)/i.exec(cellEl.attrs['style'] ?? '')?.[1] ?? '').toLowerCase();
        if (align === 'left' || align === 'center' || align === 'right') cell.align = align;
        cells.push(cell);
      }
      if (cells.length === 0) continue;
      if (cells.every((c) => c.content.length === 0) && cells.length > 0 && rows.length > 0) continue;
      rows.push({ cells });
      if (counting && allHeader) headerRows++;
      else counting = false;
    }
    if (rows.length === 0) return;
    const block: Table = { type: 'table', rows };
    const captionEl = el.children.find((c): c is VElement => c.kind === 1 && c.tag === 'caption' && !c.skip);
    if (captionEl !== undefined) {
      const caption = this.inlineOnly(captionEl);
      if (caption.length > 0) block.caption = caption;
    }
    if (headerRows > 0 && headerRows < rows.length) block.headerRows = headerRows;
    else if (headerRows > 0 && headerRows === rows.length && rows.length > 1) block.headerRows = 1;
    out.push(block);
  }
}

/** Calls `visit` with every inline array in `blocks`, nested blocks included. */
function eachInlines(blocks: Block[], visit: (content: Inline[]) => void): void {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        visit(b.content);
        break;
      case 'list':
        for (const item of b.items) eachInlines(item.blocks, visit);
        break;
      case 'quote':
        eachInlines(b.blocks, visit);
        if (b.cite !== undefined) visit(b.cite);
        break;
      case 'callout':
        eachInlines(b.blocks, visit);
        if (b.title !== undefined) visit(b.title);
        break;
      case 'details':
        visit(b.summary);
        eachInlines(b.blocks, visit);
        break;
      case 'definitions':
        for (const item of b.items) {
          visit(item.term);
          eachInlines(item.details, visit);
        }
        break;
      case 'table':
        for (const row of b.rows) for (const cell of row.cells) visit(cell.content);
        if (b.caption !== undefined) visit(b.caption);
        break;
      case 'figure':
        if (b.caption !== undefined) visit(b.caption);
        if (b.credit !== undefined) visit(b.credit);
        break;
      case 'footnotes':
        for (const item of b.items) eachInlines(item.blocks, visit);
        break;
      case 'embed':
        if (b.blocks !== undefined) eachInlines(b.blocks, visit);
        break;
    }
  }
}

const INLINE_NOTE = /(?:^|[\s_-])(?:footnote|sidenote|marginnote|ltx_note)(?:$|[\s_-])/;

function isAncestorOf(ancestor: VElement, node: VElement): boolean {
  for (let p = node.parent; p !== null; p = p.parent) if (p === ancestor) return true;
  return false;
}

const NOTE_ITEM = /(?:^|[\s_-])(?:footnote|endnote)(?:$|[\s_-])/;

/**
 * A multi-line <code> that is all its container holds is a listing even
 * without <pre> (`figure.code-block > code`, styled with white-space: pre).
 */
/** Text of a label without the widgets inside it (a language picker's label, options and "No results"). */
function plainLabel(el: VElement): string {
  let out = '';
  const visit = (node: VElement): void => {
    for (const child of node.children) {
      if (child.kind === 0) out += child.text;
      else if (!child.skip && !isWidget(child)) visit(child);
    }
  };
  visit(el);
  return collapse(out);
}

function isWidget(el: VElement): boolean {
  if (el.tag === 'label' || el.tag === 'button' || el.tag === 'select' || el.tag === 'input' || el.attrs['aria-haspopup'] !== undefined) return true;
  const role = el.attrs['role'];
  return role !== undefined && role !== 'none' && role !== 'presentation' && role !== 'heading';
}

/**
 * The second of two glued spans whose classes differ in one word ("imperial_word" /
 * "metric_word") and that state the same number: unit alternatives a script or
 * stylesheet switches between ("60 mph" | "60 km/h").
 */
function isAlternative(el: VElement): boolean {
  const parent = el.parent;
  if (parent === null || el.className.length === 0 || el.textLen === 0 || el.textLen > 40) return false;
  const i = parent.children.indexOf(el);
  const prev = i > 0 ? parent.children[i - 1]! : null;
  if (prev === null || prev.kind !== 1 || prev.tag !== 'span' || prev.skip || prev.textLen === 0 || prev.textLen > 40) return false;
  const a = prev.className.toLowerCase().split(/[\s_-]+/);
  const b = el.className.toLowerCase().split(/[\s_-]+/);
  if (a.length !== b.length || a.length < 2) return false;
  let differ = 0;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differ++;
  if (differ !== 1) return false;
  // The same quantity in another unit: both open with the same number.
  const x = /^\s*([\d.,]+)/.exec(rawText(prev));
  const y = /^\s*([\d.,]+)/.exec(rawText(el));
  return x !== null && y !== null && x[1] === y[1];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function closestHeading(el: VElement): VElement | null {
  for (let p = el.parent; p !== null; p = p.parent) if (/^h[1-6]$/.test(p.tag)) return p;
  return null;
}

function loneCode(el: VElement): VElement | null {
  let any = false;
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.kind === 1 && child.tag === 'code') {
      any = true;
      break;
    }
  }
  if (!any) return null;
  let code: VElement | null = null;
  for (const child of el.children) {
    if (child.kind === 0) {
      if (child.text.trim().length > 0) return null;
      continue;
    }
    if (child.skip) continue;
    if (code !== null || child.tag !== 'code') {
      // Empty decorations (a language tag, a copy button) do not count.
      if (child.tag !== 'img' && child.textLen < 20 && rawText(child).replace(ZERO_WIDTH, '').trim().length === 0 && !hasDescendant(child, 'img')) continue;
      return null;
    }
    code = child;
  }
  if (code === null) return null;
  const text = rawText(code).trim();
  // One line is a listing too when the wrapper says so (a figure, a language, a code-block class).
  return text.indexOf('\n') > 0 || el.tag === 'figure' || el.attrs['data-lang'] !== undefined || CODE_WRAPPER.test(el.matchString) ? code : null;
}

const CODE_WRAPPER = /(?:^|[\s_-])(?:code-?block|highlight|codehilite|sourcecode|code-snippet)(?:$|[\s_-])/;

function isNoteItem(el: VElement): boolean {
  if (el.id.length === 0) return false;
  return el.tag === 'li' || el.attrs['role'] === 'doc-footnote' || el.attrs['role'] === 'doc-endnote' || (el.tag !== 'a' && NOTE_ITEM.test(lowerCase(el.className)));
}

/** Note text compared across copies: whitespace collapsed, a leading "5:" / "[5]" label dropped. */
function noteKey(text: string): string {
  return collapse(text).replace(/^\[?\d{1,3}\]?[:.)]?\s*/, '');
}

/** A note that repeats its own number ("5: We can't resist...", "<sup>1</sup> 1 https://...") loses it; the label is drawn. */
function stripNoteLabel(blocks: Block[], label: string): void {
  const first = blocks[0];
  if (first === undefined || first.type !== 'paragraph') return;
  const content = first.content;
  while (content.length > 0) {
    const run = content[0]!;
    if (run.type !== 'text') break;
    const m = /^\s*\[?(\d{1,3})\]?[:.)]?(?:\s+|$)/.exec(run.text);
    if (m === null || m[1] !== label) break;
    run.text = run.text.slice(m[0].length);
    if (run.text.length > 0) break;
    content.shift();
  }
  if (content.length === 0) blocks.shift();
}

/** The marker an item opens with as an element of its own (LaTeXML's `ltx_tag_item`), or null. */
function itemLabel(li: VElement): VElement | null {
  for (const child of li.children) {
    if (child.kind === 0) {
      if (child.text.trim().length > 0) return null;
      continue;
    }
    return !child.skip && child.hasClass('ltx_tag_item') ? child : null;
  }
  return null;
}

/** An item's label read into its first line: "(a) The encoder…", not "(a)" over the paragraph. */
function prependLabel(blocks: Block[], label: string): void {
  if (label.length === 0) return;
  const first = blocks[0];
  if (first !== undefined && first.type === 'paragraph') first.content = normalizeInlines([{ type: 'text', text: label + ' ' }, ...first.content]);
  else blocks.unshift({ type: 'paragraph', content: [{ type: 'text', text: label }] });
}

/** Bullets that never start a word; dashes, stars and dots only count with a space after them. */
const BULLET_MARKER = /^\s*(?:[•◦▪▫●○■□‣⁃∙►▸]\s*|[-–*·](?:\s+|$))/;
const NUMBER_MARKER = /^\s*(?:(\d{1,4})[.)]|\((\d{1,4})\))(?:\s+|$)/;

/**
 * A marker the page typed into an item ("• Point", "3. Step", LaTeXML's tags) repeats the one the list draws and
 * goes; an ordered item keeps a number that is not its own.
 */
function stripItemMarker(blocks: Block[], number: number | null): void {
  const first = blocks[0];
  if (first === undefined || first.type !== 'paragraph') return;
  const content = first.content;
  const run = content[0];
  if (run === undefined || run.type !== 'text') return;
  const m = (number === null ? BULLET_MARKER : NUMBER_MARKER).exec(run.text);
  if (m === null || (number !== null && Number(m[1] ?? m[2]) !== number)) return;
  run.text = run.text.slice(m[0].length);
  if (run.text.length === 0) content.shift();
  const next = content[0];
  if (next !== undefined && next.type === 'text') next.text = next.text.trimStart();
  if (next !== undefined && next.type === 'text' && next.text.length === 0) content.shift();
  if (content.length === 0) blocks.shift();
}

const CAPITAL = /^\p{Lu}/u;

/**
 * Words ending a sentence: ".", "!" or "?", maybe inside closing quotes or brackets, after a space somewhere
 * (`asyncio.` before `TaskGroup` is one name) and not an ellipsis ("Credit...").
 */
function endsSentence(text: string): boolean {
  let i = text.length - 1;
  while (i >= 0 && '"\')]”’»'.indexOf(text[i]!) >= 0) i--;
  const c = text[i];
  if (c !== '.' && c !== '!' && c !== '?') return false;
  if (c === '.' && text[i - 1] === '.') return false;
  return text.lastIndexOf(' ', i) >= 0;
}

/** "Photograph: …" as a run of its own (`<small>`) or the words after a sentence. */
const CREDIT_LEAD = /(?:^\s*|[.!?…”’")]\s+)((?:Photograph|Photo|Image|Picture|Illustration|Credit|Source|Graphic)s?\s*:\s*\S)/;
const SENTENCE_AFTER = /[.!?]\s+\p{Lu}/u;

/** A short credit closing a caption, split off: [caption, credit]; the caption is unchanged when there is none. */
function splitCredit(caption: Inline[]): [Inline[], Inline[]] {
  for (let i = 0; i < caption.length; i++) {
    const run = caption[i]!;
    if (run.type !== 'text') continue;
    const m = CREDIT_LEAD.exec(run.text);
    if (m === null) continue;
    const at = m.index + m[0].length - m[1]!.length;
    const rest: Inline[] = [{ ...run, text: run.text.slice(at) }, ...caption.slice(i + 1)];
    const restText = inlineTextOf(rest);
    if (restText.length > 120 || SENTENCE_AFTER.test(restText)) break;
    // Marks every credit run shares are its wrapper's (`<small>`), not the credit's.
    let shared: Mark[] | null = null;
    for (const n of rest) if (n.type === 'text') shared = shared === null ? n.marks ?? [] : shared.filter((x) => n.marks !== undefined && n.marks.indexOf(x) >= 0);
    const credit = rest.map((n): Inline => {
      if (n.type !== 'text' || shared === null || shared.length === 0) return n;
      const run: TextRun = { type: 'text', text: n.text };
      const marks = n.marks!.filter((x) => shared!.indexOf(x) < 0);
      if (marks.length > 0) run.marks = marks;
      if (n.href !== undefined) run.href = n.href;
      return run;
    });
    const before = normalizeInlines([...caption.slice(0, i), { ...run, text: run.text.slice(0, at) }]);
    // "Image: Jose Mourinho, left, …" alone is the caption, labelled.
    if (before.length === 0) break;
    return [before, normalizeInlines(credit)];
  }
  return [caption, []];
}

function inlineTextOf(content: Inline[]): string {
  let s = '';
  for (const n of content) if (n.type === 'text') s += n.text;
  return s;
}

function textOfInlines(content: Inline[]): string {
  let s = '';
  for (const n of content) if (n.type === 'text') s += n.text;
  return s;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasDescendant(el: VElement, tag: string, maxDepth = 64): boolean {
  return descendantWithin(el, tag, maxDepth - 1);
}

/** A `tag` element at most `levels` levels below the children of `el` (skipped subtrees excluded). */
function descendantWithin(el: VElement, tag: string, levels: number): boolean {
  if (levels < 0) return false;
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.kind !== 1 || child.skip) continue;
    if (child.tag === tag || descendantWithin(child, tag, levels - 1)) return true;
  }
  return false;
}

function countTag(el: VElement, tag: string): number {
  let n = 0;
  walk(el, (e) => {
    if (e !== el && e.tag === tag) n++;
    return true;
  });
  return n;
}

interface RowInfo {
  cells: VElement[];
  head: boolean;
}

function tableRows(table: VElement): RowInfo[] {
  const rows: RowInfo[] = [];
  const visit = (el: VElement, head: boolean): void => {
    for (const child of el.children) {
      if (child.kind !== 1 || child.skip) continue;
      if (child.tag === 'tr') {
        const cells: VElement[] = [];
        for (const c of child.children) if (c.kind === 1 && !c.skip && (c.tag === 'td' || c.tag === 'th')) cells.push(c);
        rows.push({ cells, head });
      } else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        visit(child, child.tag === 'thead');
      }
    }
  };
  visit(table, false);
  return rows;
}

function isCodeTable(el: VElement): boolean {
  if (el.tag !== 'table' && el.tag !== 'div') return false;
  if (el.tag === 'table' && /(?:^|[\s_-])(?:highlight|hljs-ln|rouge-table|code-table|lntable|codehilitetable|highlighttable|js-file-line-container|blob-code-table|chroma)(?:$|[\s_-])/.test(el.matchString)) return true;
  if (el.tag !== 'table') return false;
  let code = false;
  walk(el, (e) => {
    if (code) return false;
    if (e.tag === 'td' && /(?:^|[\s_-])(?:blob-code|hljs-ln-code|code-line|line-content)(?:$|[\s_-])/.test(e.matchString)) code = true;
    else if (e.tag === 'td' && /(?:^|\s)code(?:\s|$)/.test(e.className) && hasDescendant(e, 'pre')) code = true;
    return !code;
  });
  return code;
}

/** Verbatim code: <br> as newlines, line-per-element markup joined, gutters dropped. */
export function codeText(el: VElement): string {
  let out = '';
  const visit = (node: VElement): void => {
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (child.kind === 0) {
        out += child.text;
        continue;
      }
      if (child.tag === 'br') {
        out += '\n';
        continue;
      }
      if (GUTTER.test(child.matchString) || child.attrs['data-line-number'] !== undefined && rawText(child).trim().length === 0) continue;
      if (child.tag === 'button' || child.tag === 'svg' || child.tag === 'input' || CODE_CHROME.test(child.matchString)) continue;
      const line = child.tag === 'div' || child.tag === 'p' || child.tag === 'tr' || child.tag === 'li' || LINE_ELEMENT.test(child.matchString);
      visit(child);
      if (line && out.length > 0 && out.charCodeAt(out.length - 1) !== 10) {
        const next = kids[i + 1];
        if (!(next !== undefined && next.kind === 0 && next.text.charCodeAt(0) === 10)) out += '\n';
      }
    }
  };
  visit(el);
  return out
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(/^(?:[ \t]*\n)+/, '')
    // `trimEnd` strips what `\s` matches; `/\s+$/` would rescan a long run of spaces from each of them.
    .trimEnd();
}

/** Language from markup on the block, its <code> child, or wrappers up to three levels. */
export function codeLanguage(pre: VElement): string | null {
  const fromEl = (e: VElement): string | null =>
    normalizeLanguage(e.attrs['data-lang'] ?? e.attrs['data-language'] ?? e.attrs['data-code-language'] ?? e.attrs['data-snippet-lang'] ?? e.attrs['data-syntax'] ?? e.attrs['lang'] ?? null) ??
    languageFromClass(e.className);
  let lang = fromEl(pre);
  if (lang !== null) return lang;
  const code = firstElement(pre, (e) => e.tag === 'code');
  if (code !== null) {
    lang = fromEl(code);
    if (lang !== null) return lang;
  }
  let p = pre.parent;
  for (let depth = 0; depth < 3 && p !== null; depth++, p = p.parent) {
    lang = normalizeLanguage(p.attrs['data-lang'] ?? p.attrs['data-language'] ?? p.attrs['data-code-language'] ?? null) ?? languageFromClass(p.className);
    if (lang !== null) return lang;
  }
  return null;
}

function mathInline(el: VElement): (Inline & { type: 'math' }) | null {
  if (el.tag === 'math-tex') {
    const tex = texFrom(rawText(el));
    if (tex === undefined) return null;
    return { type: 'math', tex, text: tex };
  }
  const tex = texFrom(el.attrs['data-tex'] ?? el.attrs['alttext']);
  const mathml = el.attrs['data-xml'];
  const text = tex ?? collapse(rawText(el));
  if (text.length === 0 && (mathml === undefined || mathml.length === 0)) return null;
  // Keys in model order: type, tex, mathml, text.
  const node: Inline & { type: 'math' } = { type: 'math' } as Inline & { type: 'math' };
  if (tex !== undefined) node.tex = tex;
  if (mathml !== undefined && mathml.length > 0) node.mathml = mathml;
  node.text = text;
  return node;
}
