import { isCallout, isDataTableCached, isFootnotes } from './content';
import { detectLanguage, languageFromClass, normalizeLanguage } from './languages';
import { frameBlock, imageFrom, isDecorativeImage, isSmallImage, lazyVideo, mediaFromElement, socialProvider, TWEET } from './media';
import type { Block, Callout, Definition, Figure, Footnote, Image, Inline, ListItem, Mark, Table, TableCell, TableRow, TextRun } from './model';
import { collapse, firstElement, rawText, textOf, walk, type VElement, type VNode } from './tree';
import { resolveUrl } from './url';

/** TeX left for MathJax/KaTeX: $$…$$ and \[…\] display, \(…\) inline. */
const TEX_DELIMITED = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
/** The same plus $…$ inline, for pages that show they use TeX (never "$5 and $10"). */
const TEX_ANY = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$\d](?:[^$\n]{0,300}?[^\s$\\])?)\$(?![\d\w])/g;

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
const LINE_ELEMENT = /(?:^|[\s_-])(?:line|code-line|cm-line|ec-line|token-line|highlight-line|view-line|line-content)(?:$|[\s_-])/;
const PULL_QUOTE = /(?:^|[\s_-])(?:pullquote|pull-quote|wp-block-pullquote|pull_quote|blockquote--pull)(?:$|[\s_-])/;
/** Zero-width characters, and private-use code points (icon-font glyphs that show as boxes without their font). */
const ZERO_WIDTH = /[\u200b\ufeff\u2060\ue000-\uf8ff]/g;
const SPACES = /[\t\n\f\r ]+/g;

interface Ctx {
  marks: Mark[];
  href: string | null;
}

/** Builds inline content with whitespace normalized the way a browser renders it. */
class InlineBuilder {
  nodes: Inline[] = [];
  /** Consecutive line breaks with nothing visible between them. */
  breaks = 0;
  /** Id of an anchor that opens the current paragraph ("[<a name="f1n">1</a>] ..."). */
  anchor: string | null = null;

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
    if (this.breaks > 0 && text.replace(SPACES, '').length === 0) return;
    this.breaks = 0;
    const run: TextRun = { type: 'text', text };
    if (ctx.marks.length > 0) run.marks = sortMarks(ctx.marks);
    if (ctx.href !== null) run.href = ctx.href;
    this.nodes.push(run);
  }

  /** Splits TeX written for a client-side renderer out of `text` as math; false when there is none. */
  private texRuns(text: string, ctx: Ctx): boolean {
    const re = this.converter.dollars ? TEX_ANY : TEX_DELIMITED;
    re.lastIndex = 0;
    let m = re.exec(text);
    if (m === null) return false;
    let at = 0;
    while (m !== null) {
      if (m.index > at) this.text(text.slice(at, m.index), ctx);
      const tex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (tex.length > 0) {
        const node: Inline = { type: 'math', tex, text: tex };
        if (m[1] !== undefined || m[2] !== undefined) this.converter.lastDisplayMath = node;
        this.push(node);
      }
      at = m.index + m[0].length;
      m = re.exec(text);
    }
    if (at < text.length) this.text(text.slice(at), ctx);
    return true;
  }

  lineBreak(): void {
    this.breaks++;
    if (this.breaks >= 2 && this.out !== null) {
      this.flush();
      this.breaks = 2;
      return;
    }
    this.nodes.push({ type: 'break' });
  }

  push(node: Inline): void {
    this.breaks = 0;
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
    if (content.length === 1 && content[0]!.type === 'math' && this.converter.lastDisplayMath === content[0]) {
      const math = content[0];
      const block: Block = { type: 'math', text: math.text };
      if (math.tex !== undefined) block.tex = math.tex;
      if (math.mathml !== undefined) block.mathml = math.mathml;
      this.out.push(block);
      return;
    }
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
  const am = a.marks ?? [];
  const bm = b.marks ?? [];
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) if (am[i] !== bm[i]) return false;
  return true;
}

/** Collapses whitespace across runs, trims around breaks and block edges, merges equal runs. */
export function normalizeInlines(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  let spaceBefore = true;
  for (const node of nodes) {
    if (node.type === 'text') {
      let text = node.text.replace(SPACES, ' ');
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
  return out.filter((n) => n.type !== 'text' || n.text.length > 0);
}

function trimEnd(out: Inline[]): void {
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.type !== 'text') return;
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed.length > 0) {
      last.text = trimmed;
      return;
    }
    out.pop();
  }
}

function hasBlock(el: VElement): boolean {
  if (el.blockState >= 0) return el.blockState === 1;
  let found = false;
  for (const child of el.children) {
    if (child.kind === 1 && !child.skip && (BLOCK_TAGS.has(child.tag) || hasBlock(child))) {
      found = true;
      break;
    }
  }
  el.blockState = found ? 1 : 0;
  return found;
}

function isInline(el: VElement): boolean {
  return INLINE_TAGS.has(el.tag) && !hasBlock(el);
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
  /** Label of the first reference to each listed note. */
  private readonly refLabels = new Map<string, string>();
  lastDisplayMath: Inline | null = null;
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
    const open: string[] = [];
    for (const [id, label] of this.pendingRefs) if (!this.resolved.has(id) && open.indexOf(label) < 0) open.push(label);
    const tail = Math.max(0, out.length - 3);
    for (let i = out.length - 1; i >= tail && open.length > 0; i--) {
      const list = out[i]!;
      if (list.type !== 'list' || !list.ordered || (list.start ?? 1) !== 1 || list.items.length !== open.length) continue;
      if (!open.every((label) => Number(label) >= 1 && Number(label) <= open.length)) break;
      const items: Footnote[] = [];
      for (const [id, label] of this.pendingRefs) {
        if (this.resolved.has(id)) continue;
        this.resolved.add(id);
        items.push({ id, label, blocks: list.items[Number(label) - 1]!.blocks });
      }
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
      for (const child of el.children) {
        if (child.kind === 1) visit(child);
        else if (child.text.indexOf('$$') >= 0 || /\\[([]/.test(child.text)) {
          if (TEX_DELIMITED.test(child.text)) this.tex = true;
          TEX_DELIMITED.lastIndex = 0;
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
      if (/(?:^|\s)footnote(?:\s|$)/.test(el.className)) {
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
    if (!/(?:^|\s)footnote(?:\s|$)/.test(el.className)) return false;
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
    const ctx: Ctx = { marks: [], href: null };
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
      const title = textOf(el);
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
    if (this.caption(el, out, b)) return;
    const tag = el.tag;
    if (tag !== 'a' && !this.inNote && INLINE_NOTE.test(el.matchString) && this.inlineNote(el, b)) return;
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
        if (img === null || /mwe-math-fallback-image/.test(img.className)) return;
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
        if (ctx.href !== null && image.href === undefined && ctx.href !== image.src && /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(ctx.href)) image.href = ctx.href;
        out.push({ type: 'figure', images: [image] });
        return;
      }
      case 'math':
      case 'math-tex': {
        const node = mathInline(el);
        if (node === null) return;
        if (el.attrs['display'] === 'block' || el.attrs['mode'] === 'display') this.lastDisplayMath = node;
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
          if (/^[#¶§🔗]?$/u.test(linkText)) return;
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
        if (href === undefined && b.nodes.length <= 1 && inlineTextOf(b.nodes).trim().replace(/^[[(]$/, '').length === 0) {
          const anchor = el.attrs['name'] ?? el.id;
          if (anchor.length > 0 && this.pendingRefs.has(anchor)) b.anchor = anchor;
        }
        if (PERMALINK.test(el.matchString) && /^[#¶§🔗]?$/u.test(collapse(rawText(el)))) return;
        const resolved = href === undefined ? null : resolveUrl(href, this.base);
        const linkCtx: Ctx = resolved !== null && /^(?:https?|mailto|tel):/i.test(resolved) ? { marks: ctx.marks, href: resolved } : ctx;
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
        const style = el.attrs['style'];
        if (style !== undefined) {
          const marks = ctx.marks.slice();
          if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) marks.push('bold');
          if (/font-style\s*:\s*italic/i.test(style)) marks.push('italic');
          if (marks.length !== ctx.marks.length) {
            this.inlineChildren(el, b, { marks, href: ctx.href }, out);
            return;
          }
        }
        break;
      }
    }
    const mark = TAG_MARK[tag];
    if (mark !== undefined && ctx.marks.indexOf(mark) < 0) {
      this.inlineChildren(el, b, { marks: ctx.marks.concat(mark), href: ctx.href }, out);
      return;
    }
    this.inlineChildren(el, b, ctx, out);
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
    if (mark !== null && !isAncestorOf(mark, content)) mark.skip = true;
    const blocks: Block[] = [];
    this.inNote = true;
    const inline = this.inlineOnly(content);
    this.inNote = false;
    if (mark !== null) mark.skip = false;
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
    for (const child of el.children) {
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
      for (const child of node.children) {
        if (child.kind === 0) {
          b.text(child.text, ctx);
          continue;
        }
        if (child.skip) continue;
        const tag = child.tag;
        if (tag === 'img' || tag === 'picture') {
          const img = tag === 'picture' ? firstElement(child, (e) => e.tag === 'img') : child;
          if (img === null || /mwe-math-fallback-image/.test(img.className)) continue;
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
          visit(child, ctx);
        }
        if (BLOCK_TAGS.has(tag)) b.lineBreak();
      }
    };
    visit(el, { marks: [], href: null });
    return b.result();
  }

  // ---------------------------------------------------------------- headings, lists, quotes

  private heading(el: VElement, out: Block[]): void {
    const content = this.inlineOnly(el);
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
    for (const child of el.children) {
      if (child.kind === 0) {
        if (child.text.trim().length > 0) items.push({ blocks: [{ type: 'paragraph', content: normalizeInlines([{ type: 'text', text: child.text }]) }] });
        continue;
      }
      if (child.skip) continue;
      const blocks: Block[] = [];
      if (child.tag === 'li') {
        this.children(child, blocks);
        if (blocks.length === 0) continue;
        const item: ListItem = { blocks };
        const box = firstElement(child, (e) => e.tag === 'input' && (e.attrs['type'] ?? '').toLowerCase() === 'checkbox');
        if (box !== null) item.checked = box.attrs['checked'] !== undefined;
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
    const block: Block = { type: 'list', ordered: el.tag === 'ol', items };
    const start = intAttr(el, 'start');
    if (el.tag === 'ol' && start !== undefined && start !== 1) block.start = start;
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
        const abs = resolveUrl(e.attrs['href'], this.base);
        if (abs !== null) links.push(abs);
      }
      return true;
    });
    if (provider === 'twitter') url = links.filter((l) => TWEET.test(l)).pop() ?? null;
    url ??= el.attrs['data-instgrm-permalink'] ?? el.attrs['cite'] ?? el.attrs['data-bluesky-uri'] ?? el.attrs['data-href'] ?? links[links.length - 1] ?? null;
    const blocks: Block[] = [];
    this.children(el, blocks);
    let author: string | undefined;
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.type === 'paragraph') {
      const text = last.content.map((n) => (n.type === 'text' ? n.text : '')).join('');
      const m = /^[—–-]\s*(.+?)(?:\s*\((@\w+)\))?\s+[A-Z][a-z]+ \d{1,2}, \d{4}$/.exec(text) ?? /^[—–-]\s*(.+)$/.exec(text);
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
    if (title !== undefined && title.length > 0) block.title = title;
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
    const code = lines.join('\n').replace(/^\n+|\s+$/g, '');
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
    if (img === null || /mwe-math-fallback-image/.test(img.className)) return;
    const image = imageFrom(img, this.base) ?? this.noscriptImage(img);
    if (image === null || isDecorativeImage(img, image, this.base)) return;
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
    walk(el, (e) => {
      if (e.skip || e === captionEl) return false;
      switch (e.tag) {
        case 'img': {
          if (/mwe-math-fallback-image/.test(e.className)) return false;
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

    if (images.length === 0 && media.length === 0 || other) {
      // Code listings, tables and quotes in a <figure>: convert the content, keep the caption as text.
      if (captionEl !== null) (captionEl as VElement).skip = true;
      const before = out.length;
      this.children(el, out);
      if (captionEl !== null) (captionEl as VElement).skip = false;
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
function loneCode(el: VElement): VElement | null {
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
  return el.tag === 'li' || el.attrs['role'] === 'doc-footnote' || el.attrs['role'] === 'doc-endnote' || (el.tag !== 'a' && NOTE_ITEM.test(el.className.toLowerCase()));
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
  const visit = (node: VElement, depth: number): boolean => {
    if (depth > maxDepth) return false;
    for (const child of node.children) {
      if (child.kind !== 1 || child.skip) continue;
      if (child.tag === tag || visit(child, depth + 1)) return true;
    }
    return false;
  };
  return visit(el, 1);
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
      if (child.tag === 'button' || child.tag === 'svg' || child.tag === 'input') continue;
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
    .replace(/\s+$/, '');
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
  const text = collapse(rawText(el));
  const node: Inline & { type: 'math' } = { type: 'math', text: tex ?? text };
  if (tex !== undefined) node.tex = tex;
  if (mathml !== undefined && mathml.length > 0) node.mathml = mathml;
  if (node.text.length === 0 && node.mathml === undefined) return null;
  return node;
}
