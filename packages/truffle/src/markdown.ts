import type { Article, Block, Callout, Code, Footnotes, Image, Inline, List, Table } from './model';

/**
 * Markdown of an article, for consumers that render it themselves. The output
 * is GitHub Flavored Markdown (CommonMark plus pipe tables, task lists,
 * strikethrough and `[^label]` footnotes), with `$…$` / `$$…$$` math as GitHub,
 * remark-math and KaTeX read it and callouts as GitHub alerts (`> [!NOTE]`). It
 * holds no raw HTML, so renderers that strip HTML lose nothing.
 *
 * Text is escaped wherever it could read as syntax, and emphasis that a
 * CommonMark parser would not see as emphasis (a delimiter between a letter
 * and punctuation, as in `x**(y)**`) is written as plain text, so every
 * renderer shows the article's words and nothing else.
 */

/** The article as Markdown: the title as a level-1 heading, then the body. */
export function articleMarkdown(article: Article): string {
  const body = blocksMarkdown(article.blocks);
  const title = article.title.length > 0 ? heading(1, escapeText(article.title, false)) : '';
  if (title.length === 0) return body;
  return body.length === 0 ? title + '\n' : title + '\n\n' + body;
}

/** Body blocks as Markdown, ending with one newline (empty when nothing renders). */
export function blocksMarkdown(blocks: readonly Block[]): string {
  const writer = new Writer(blocks);
  const out = writer.blocks(blocks, '\n\n', true);
  return out.length === 0 ? '' : out + '\n';
}

// ------------------------------------------------------------------ inline

const BOLD = 1;
const ITALIC = 2;
const STRIKE = 4;
const LINK = 8;
const MARK_BITS = [BOLD, ITALIC, STRIKE] as const;

/** One piece of a line: escaped text, a code span, an image, math, a footnote call or a break. */
interface Atom {
  md: string;
  marks: number;
  href: string | undefined;
  /** Source of a code span. */
  code?: string;
}

const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const LEADING_SPACE = /^\s+/;
const TRAILING_SPACE = /\s+$/;

/** CommonMark character classes for flanking: 0 whitespace or line edge, 1 punctuation, 2 anything else. */
function charClass(ch: string): number {
  if (ch.length === 0 || WHITESPACE.test(ch)) return 0;
  return PUNCTUATION.test(ch) ? 1 : 2;
}

function firstChar(s: string): string {
  if (s.length === 0) return '';
  const code = s.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff ? s.slice(0, 2) : s.charAt(0);
}

function lastChar(s: string): string {
  if (s.length === 0) return '';
  const code = s.charCodeAt(s.length - 1);
  return code >= 0xdc00 && code <= 0xdfff ? s.slice(-2) : s.charAt(s.length - 1);
}

/**
 * First and last character the latest `spans` or `wrap` call wrote ('' when
 * it wrote nothing). Tracked as the text is written, because reading a
 * character of a string still being concatenated would flatten it each time.
 */
let headChar = '';
let tailChar = '';

/**
 * Lays out marks over a run of atoms as properly nested delimiters: at each
 * point the mark that lasts longest opens first, so `**a *b***` rather than
 * crossed spans. `before` and `after` are the characters around the run.
 */
function spans(atoms: Atom[], from: number, to: number, mask: number, before: string, after: string): string {
  let out = '';
  let head = '';
  let tail = '';
  let k = from;
  while (k < to) {
    const atom = atoms[k]!;
    const open = atom.marks & ~mask;
    const link = (mask & LINK) === 0 && atom.href !== undefined;
    if (open === 0 && !link) {
      if (atom.md.length > 0) {
        out += atom.md;
        if (head.length === 0) head = firstChar(atom.md);
        tail = lastChar(atom.md);
      }
      k++;
      continue;
    }
    let mark = 0;
    let end = k;
    if (link) {
      end = k + 1;
      while (end < to && atoms[end]!.href === atom.href) end++;
      mark = LINK;
    }
    for (const bit of MARK_BITS) {
      if ((open & bit) === 0) continue;
      let e = k + 1;
      while (e < to && (atoms[e]!.marks & bit) !== 0) e++;
      if (e > end) {
        end = e;
        mark = bit;
      }
    }
    const next = end < to ? leadingChar(atoms[end]!, mask) : after;
    const md = wrap(atoms, k, end, mask, mark, atom.href!, tail.length > 0 ? tail : before, next);
    if (md.length > 0) {
      out += md;
      if (head.length === 0) head = headChar;
      tail = tailChar;
    }
    k = end;
  }
  headChar = head;
  tailChar = tail;
  return out;
}

/** First character an atom puts down at this level: a delimiter (punctuation) when it opens a mark. */
function leadingChar(atom: Atom, mask: number): string {
  if ((atom.marks & ~mask) !== 0 || ((mask & LINK) === 0 && atom.href !== undefined)) return '*';
  return firstChar(atom.md);
}

function wrap(atoms: Atom[], from: number, to: number, mask: number, mark: number, href: string, prev: string, next: string): string {
  const inner = mark === LINK ? spans(atoms, from, to, mask | LINK, '[', ']') : spans(atoms, from, to, mask | mark, '*', '*');
  if (inner.length === 0) return inner;
  let lead = '';
  let trail = '';
  let core = inner;
  let coreHead = headChar;
  let coreTail = tailChar;
  if (WHITESPACE.test(coreHead) || WHITESPACE.test(coreTail)) {
    lead = LEADING_SPACE.exec(inner)?.[0] ?? '';
    if (lead.length === inner.length) return inner; // headChar and tailChar already describe it
    trail = TRAILING_SPACE.exec(inner)?.[0] ?? '';
    core = inner.slice(lead.length, inner.length - trail.length);
    coreHead = firstChar(core);
    coreTail = lastChar(core);
  }
  if (mark === LINK) {
    const auto = core === href && AUTOLINK.test(href);
    headChar = lead.length > 0 ? firstChar(lead) : auto ? '<' : '[';
    tailChar = trail.length > 0 ? lastChar(trail) : auto ? '>' : ')';
    return lead + (auto ? `<${href}>` : `[${core}](${destination(href)})`) + trail;
  }
  const delimiter = mark === BOLD ? '**' : mark === ITALIC ? '*' : '~~';
  const p = charClass(lead.length > 0 ? lastChar(lead) : prev);
  const q = charClass(trail.length > 0 ? firstChar(trail) : next);
  // Left-flanking opener, right-flanking closer (CommonMark 6.2).
  const opens = charClass(coreHead) !== 1 || p !== 2;
  const closes = charClass(coreTail) !== 1 || q !== 2;
  if (opens && closes) {
    headChar = lead.length > 0 ? firstChar(lead) : delimiter.charAt(0);
    tailChar = trail.length > 0 ? lastChar(trail) : delimiter.charAt(0);
    return lead + delimiter + core + delimiter + trail;
  }
  // No parser would read these delimiters as emphasis here: keep the words without the mark.
  return spans(atoms, from, to, mask | mark, prev, next);
}

const SPECIAL = /[\\`*_[\]<&~$]/;
const SPECIAL_ALL = /[\\`*_[\]<&~$]/g;
const WORD = /[\p{L}\p{N}]/u;
const TAG_START = /[A-Za-z/!?]/;
const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;

/**
 * Backslash-escapes what Markdown would read as syntax inside a line. `_`
 * between two letters stays bare (it cannot delimit emphasis there), `<` only
 * before a tag or autolink, `&` only before an entity. A trailing `!` is
 * escaped when something follows (it would turn a following link into an image).
 * Outside links, a bare URL is left as written: GFM links it as it stands, and
 * a backslash inside it would become part of the address.
 */
function escapeText(text: string, followed: boolean, linked = false): string {
  let out: string;
  if (!linked && (text.indexOf('://') > 0 || text.indexOf('www.') >= 0)) {
    out = '';
    let last = 0;
    URL_LITERAL.lastIndex = 0;
    for (let m = URL_LITERAL.exec(text); m !== null; m = URL_LITERAL.exec(text)) {
      const scheme = m[0].charCodeAt(0) === 104;
      if (m.index > 0 && (scheme ? ASCII_LETTER : URL_BEFORE_WWW).test(text.charAt(m.index - 1)) === scheme) continue;
      const url = literalExtent(m[0]);
      out += escapeSyntax(text.slice(last, m.index));
      last = m.index + url.length;
      // A backslash right after the address would extend it: close it with `<…>`, or leave that character bare.
      if (last < text.length && escapeSyntax(text.charAt(last)).length > 1) {
        if (scheme) out += `<${url}>`;
        else out += url + text.charAt(last++);
      } else {
        out += url;
      }
      URL_LITERAL.lastIndex = last;
    }
    out += escapeSyntax(text.slice(last));
  } else {
    out = escapeSyntax(text);
  }
  return followed && out.charCodeAt(out.length - 1) === 33 ? out.slice(0, -1) + '\\!' : out;
}

function escapeSyntax(text: string): string {
  if (!SPECIAL.test(text)) return text;
  return text.replace(SPECIAL_ALL, (ch: string, i: number) => {
    switch (ch) {
      case '_':
        return WORD.test(text.charAt(i - 1)) && WORD.test(text.charAt(i + 1)) ? '_' : '\\_';
      case '<':
        return TAG_START.test(text.charAt(i + 1)) ? '\\<' : '<';
      case '&':
        ENTITY.lastIndex = i;
        return ENTITY.test(text) ? '\\&' : '&';
      default:
        return '\\' + ch;
    }
  });
}

/** A GFM autolink literal (`http://`, `https://`, `www.`), and what may stand before one. */
const URL_LITERAL = /(?:https?:\/\/|www\.)[^\s<]+/g;
const ASCII_LETTER = /[A-Za-z]/;
const URL_BEFORE_WWW = /[\s(*_~]/;
const URL_TRAILING = /[?!.,:;*_~'"\]]$/;

/** The part of a URL-like run GFM links: trailing punctuation and an unmatched `)` stay outside. */
function literalExtent(url: string): string {
  let end = url.length;
  for (;;) {
    const tail = url.slice(0, end);
    if (URL_TRAILING.test(tail)) end--;
    else if (tail.endsWith(')') && count(tail, '(') < count(tail, ')')) end--;
    else return tail;
  }
}

function count(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i >= 0; i = text.indexOf(ch, i + 1)) n++;
  return n;
}

const BACKTICKS = /`+/g;

function longestRun(text: string, pattern: RegExp): number {
  let longest = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) if (m[0].length > longest) longest = m[0].length;
  return longest;
}

function codeSpan(text: string): string {
  const fence = '`'.repeat(text.indexOf('`') < 0 ? 1 : longestRun(text, BACKTICKS) + 1);
  // One space each side is stripped by the parser, so pad when the code starts or ends with a backtick or a space.
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  const pad = first === 96 || last === 96 || (first === 32 && last === 32 && text.trim().length > 0) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

function mathSpan(tex: string, cell: boolean): string {
  let flat = tex.replace(/\s+/g, ' ').trim();
  // A table cell ends at `|`, and `\|` stays as written inside math: spell the bars as commands.
  if (cell && flat.indexOf('|') >= 0) flat = flat.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ').replace(/ {2,}/g, ' ').trim();
  return flat.indexOf('$') < 0 ? `$${flat}$` : `$$${flat}$$`;
}

/** What `destination` acts on: spaces and controls, angle brackets, parentheses, backslashes and `&`. */
const DESTINATION_SYNTAX = /[\x00-\x20<>()\\&]/;

/** A link or image destination: bare, or in `<…>` when it holds spaces, angle brackets or unbalanced parentheses. */
function destination(url: string): string {
  if (!DESTINATION_SYNTAX.test(url)) return url;
  // One pass over the address decides everything; most need nothing.
  let depth = 0;
  let bracket = false;
  let escape = false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c > 62) {
      if (c === 92) escape = true;
    } else if (c <= 32 || c === 60 || c === 62) {
      bracket = true;
    } else if (c === 40) {
      depth++;
    } else if (c === 41) {
      if (--depth < 0) bracket = true;
    } else if (c === 38) {
      escape = true;
    }
  }
  let out = url;
  if (escape) {
    out = out.replace(/\\/g, '\\\\');
    out = out.replace(/&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g, '\\&');
  }
  if (!bracket && depth === 0) return out;
  return '<' + out.replace(/[<>]/g, '\\$&') + '>';
}

function imageMarkdown(image: Image): string {
  const md = `![${escapeText(image.alt.replace(/\s+/g, ' ').trim(), false)}](${destination(image.src)})`;
  return image.href === undefined ? md : `[${md}](${destination(image.href)})`;
}

/** `<url>` when the URL is a valid autolink, else a link labeled with the URL. */
const AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;

function bareLink(url: string): string {
  return AUTOLINK.test(url) ? `<${url}>` : `[${escapeText(url, false)}](${destination(url)})`;
}

// ------------------------------------------------------------------ line starts

const LINE_START = /^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$)|(?:-[ \t]*)+$|=+[ \t]*$)/;
const ORDERED_START = /^(\d{1,9})([.)])(?=\s|$)/;

/** Escapes a line that would otherwise start a heading, quote, list or setext underline. */
function escapeLineStart(line: string): string {
  const c = line.charCodeAt(0);
  // # + - = > and digits
  if (c === 35 || c === 43 || c === 45 || c === 61 || c === 62) return LINE_START.test(line) ? '\\' + line : line;
  if (c >= 48 && c <= 57) return line.replace(ORDERED_START, '$1\\$2');
  return line;
}

function escapeLines(text: string): string {
  if (text.indexOf('\n') < 0) return escapeLineStart(text);
  return text.split('\n').map(escapeLineStart).join('\n');
}

// ------------------------------------------------------------------ blocks

function heading(level: number, text: string): string {
  // A trailing `#` run after a space would be read as a closing sequence.
  const closing = /(^|\s)(#+)$/.exec(text);
  const body = closing === null ? text : text.slice(0, closing.index + closing[1]!.length) + '\\' + closing[2];
  return '#'.repeat(level) + ' ' + body;
}

const SETEXT_UNDERLINE = /^(?:-+|=+)[ \t]*(?:\n|$)/;

/** `line`, then `content` on the next line, or after a blank line where it would underline `line` into a heading. */
function afterLine(line: string, content: string): string {
  if (content.length === 0) return line;
  return line + (SETEXT_UNDERLINE.test(content) ? '\n\n' : '\n') + content;
}

/** Prefixes the first line and every following non-empty line. */
function indent(text: string, first: string, rest: string): string {
  const lines = text.split('\n');
  let out = first + lines[0];
  for (let i = 1; i < lines.length; i++) out += lines[i]!.length === 0 ? '\n' : '\n' + rest + lines[i];
  return out;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : '> ' + line))
    .join('\n');
}

const ALERT: Record<NonNullable<Callout['variant']>, string> = {
  note: 'NOTE',
  tip: 'TIP',
  info: 'NOTE',
  warning: 'WARNING',
  danger: 'CAUTION',
};

const FOOTNOTE_LABEL = /[^A-Za-z0-9_-]+/g;

class Writer {
  /** Footnote id → label written in `[^label]`. */
  private readonly notes = new Map<string, string>();
  /** Footnote ids with a `[^label]` call written so far. */
  private readonly called = new Set<string>();
  /** Footnote ids written as plain text (no call yet) by the latest pass over the footnotes. */
  private readonly uncalled: string[] = [];

  constructor(blocks: readonly Block[]) {
    const used = new Set<string>();
    const visit = (list: readonly Block[]) => {
      for (const block of list) {
        if (block.type === 'footnotes') {
          for (const item of block.items) {
            if (this.notes.has(item.id)) continue;
            let label = clean(item.label);
            if (label.length === 0 || used.has(label)) label = clean(item.id);
            if (label.length === 0) label = 'note';
            if (used.has(label)) {
              let n = 2;
              while (used.has(`${label}-${n}`)) n++;
              label = `${label}-${n}`;
            }
            used.add(label);
            this.notes.set(item.id, label);
          }
        } else if (block.type === 'list') {
          for (const item of block.items) visit(item.blocks);
        } else if (block.type === 'quote' || block.type === 'details' || block.type === 'callout') {
          visit(block.blocks);
        } else if (block.type === 'definitions') {
          for (const item of block.items) visit(item.details);
        }
      }
    };
    visit(blocks);
  }

  /** Inline content. `line` writes breaks as spaces (headings, table cells, terms); `mask` marks already applied around it. */
  inline(content: readonly Inline[], line = false, mask = 0, cell = false): string {
    if (content.length === 1) {
      const only = content[0]!;
      if (only.type === 'text' && only.marks === undefined && only.href === undefined) return escapeText(only.text, false);
    }
    const atoms: Atom[] = [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i]!;
      switch (node.type) {
        case 'text': {
          let marks = 0;
          let code = false;
          const list = node.marks;
          for (let k = 0; list !== undefined && k < list.length; k++) {
            const m = list[k]!;
            if (m === 'bold') marks |= BOLD;
            else if (m === 'italic') marks |= ITALIC;
            else if (m === 'strike') marks |= STRIKE;
            else if (m === 'code' || m === 'kbd') code = true;
          }
          const last = atoms[atoms.length - 1];
          if (code && last !== undefined && last.code !== undefined && last.marks === marks && last.href === node.href) {
            // Neighbouring code spans would run their backticks together: one span holds both.
            last.code += node.text;
            last.md = codeSpan(last.code);
            break;
          }
          const md = code ? codeSpan(node.text) : escapeText(node.text, i < content.length - 1, node.href !== undefined);
          atoms.push({ md, marks, href: node.href, code: code ? node.text : undefined });
          break;
        }
        case 'break':
          atoms.push({ md: line ? ' ' : '\\\n', marks: 0, href: undefined });
          break;
        case 'image':
          atoms.push({ md: imageMarkdown(node), marks: 0, href: undefined });
          break;
        case 'math':
          atoms.push({ md: node.tex !== undefined && node.tex.trim().length > 0 ? mathSpan(node.tex, cell) : escapeText(node.text, false), marks: 0, href: undefined });
          break;
        case 'ref': {
          const label = this.notes.get(node.id);
          if (label !== undefined) this.called.add(node.id);
          atoms.push({ md: label !== undefined ? `[^${label}]` : escapeText(node.label, false), marks: 0, href: undefined });
          break;
        }
      }
    }
    const edge = mask !== 0 ? '*' : '';
    return spans(atoms, 0, atoms.length, mask, edge, edge);
  }

  paragraph(content: readonly Inline[]): string {
    const md = this.inline(content);
    // A line of only no-break or ideographic spaces is not blank to a parser: it would be an empty-looking paragraph.
    if (md.length === 0 || (LEADING_SPACE.test(md) && md.trim().length === 0)) return '';
    return escapeLines(md);
  }

  /** Bold line (definition terms, summaries, callout titles). */
  strong(content: readonly Inline[]): string {
    const text = this.inline(content, true, BOLD).trim();
    return text.length === 0 ? '' : escapeLineStart(`**${text}**`);
  }

  /**
   * Blocks joined by `separator`. At the top level footnotes are written last: a note
   * nothing calls is invisible as a GFM definition, so it becomes plain text instead.
   */
  blocks(blocks: readonly Block[], separator: string, top = false): string {
    const parts: string[] = [];
    const deferred: number[] = [];
    let previous: List | null = null;
    let alternate = false;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      let md: string;
      if (block.type === 'list') {
        // Two lists in a row would merge: the second switches its marker (`-` / `*`, `.` / `)`).
        alternate = previous !== null && previous.ordered === block.ordered ? !alternate : false;
        md = this.list(block, alternate);
      } else if (top && block.type === 'footnotes') {
        deferred.push(i);
        md = '';
      } else {
        md = this.block(block);
      }
      parts.push(md);
      if (md.length > 0 || deferred[deferred.length - 1] === i) previous = block.type === 'list' ? block : null;
    }
    if (deferred.length > 0) {
      this.uncalled.length = 0;
      for (const i of deferred) parts[i] = this.footnotes(blocks[i] as Footnotes);
      // A note written as text before a later note called it: write them again now that every call is known.
      if (this.uncalled.some((id) => this.called.has(id))) for (const i of deferred) parts[i] = this.footnotes(blocks[i] as Footnotes);
    }
    let out = '';
    for (const md of parts) if (md.length > 0) out = out.length === 0 ? md : out + separator + md;
    return out;
  }

  block(block: Block): string {
    switch (block.type) {
      case 'heading': {
        const text = this.inline(block.content, true);
        return text.length === 0 ? '' : heading(block.level, text);
      }
      case 'paragraph':
        return this.paragraph(block.content);
      case 'list':
        return this.list(block, false);
      case 'quote': {
        let inner = this.blocks(block.blocks, '\n\n');
        if (block.cite !== undefined) {
          const cite = this.inline(block.cite);
          if (cite.length > 0) inner = (inner.length > 0 ? inner + '\n\n' : '') + '— ' + cite;
        }
        return inner.length === 0 ? '' : quote(inner);
      }
      case 'code':
        return codeBlock(block);
      case 'figure': {
        const parts = block.images.map(imageMarkdown);
        if (block.caption !== undefined) parts.push(this.paragraph(block.caption));
        if (block.credit !== undefined) parts.push(this.paragraph(block.credit));
        return parts.filter((part) => part.length > 0).join('\n\n');
      }
      case 'video':
      case 'audio': {
        const title = block.title !== undefined ? escapeText(block.title, false) : '';
        let md: string;
        if (block.type === 'video' && block.poster !== undefined) md = `[![${title}](${destination(block.poster)})](${destination(block.url)})`;
        else md = title.length > 0 ? `[${title}](${destination(block.url)})` : bareLink(block.url);
        const caption = block.caption !== undefined ? this.paragraph(block.caption) : '';
        return caption.length > 0 ? md + '\n\n' + caption : md;
      }
      case 'embed': {
        const source = (block.author !== undefined ? escapeText(block.author, false) + ', ' : '') + bareLink(block.url);
        const inner = this.blocks(block.blocks ?? [], '\n\n');
        return inner.length === 0 ? escapeLineStart(source) : quote(inner + '\n\n— ' + source);
      }
      case 'table':
        return this.table(block);
      case 'rule':
        return '---';
      case 'math': {
        const tex = block.tex?.replace(/^\s*\n|\n\s*$/g, '').trimEnd();
        if (tex !== undefined && tex.trim().length > 0) return `$$\n${tex}\n$$`;
        return escapeLines(escapeText(block.text, false));
      }
      case 'definitions':
        return block.items
          .map((item) => {
            const term = this.strong(item.term);
            const details = this.blocks(item.details, '\n\n');
            return term.length > 0 && details.length > 0 ? term + '\n\n' + details : term + details;
          })
          .filter((part) => part.length > 0)
          .join('\n\n');
      case 'details': {
        const summary = this.strong(block.summary);
        const inner = this.blocks(block.blocks, '\n\n');
        return summary.length > 0 && inner.length > 0 ? summary + '\n\n' + inner : summary + inner;
      }
      case 'callout': {
        const title = block.title !== undefined ? this.strong(block.title) : '';
        let inner = this.blocks(block.blocks, '\n\n');
        if (title.length > 0) inner = inner.length > 0 ? title + '\n\n' + inner : title;
        if (block.variant !== null) return quote(afterLine(`[!${ALERT[block.variant]}]`, inner));
        return inner.length === 0 ? '' : quote(inner);
      }
      case 'footnotes':
        return this.footnotes(block);
    }
  }

  list(list: List, alternate: boolean): string {
    // Tight unless an item holds blocks that need a blank line between them.
    const tight = list.items.every((item) => {
      const blocks = item.blocks;
      if (blocks.length <= 1) return true;
      if (blocks.length !== 2 || blocks[0]!.type !== 'paragraph' || blocks[1]!.type !== 'list') return false;
      // Only a bullet list or one starting at 1 may interrupt a paragraph.
      const nested = blocks[1] as List;
      return (!nested.ordered || (nested.start ?? 1) === 1) && nested.items.length > 0 && nested.items[0]!.blocks.length > 0;
    });
    const start = list.start !== undefined && list.start >= 0 && list.start <= 999_999_999 - list.items.length ? list.start : 1;
    const out: string[] = [];
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!;
      const marker = list.ordered ? `${start + i}${alternate ? ')' : '.'}` : alternate ? '*' : '-';
      let content = this.blocks(item.blocks, tight ? '\n' : '\n\n');
      if (item.checked !== undefined) {
        const box = item.checked ? '[x]' : '[ ]';
        content = item.blocks[0]?.type === 'paragraph' && content.length > 0 ? `${box} ${content}` : afterLine(box, content);
      }
      out.push(content.length === 0 ? marker : indent(content, marker + ' ', ' '.repeat(marker.length + 1)));
    }
    return out.join(tight ? '\n' : '\n\n');
  }

  table(table: Table): string {
    // Lay the cells on a grid: spanned positions stay empty, as GFM tables have no spans.
    const grid: (string | undefined)[][] = [];
    const align: (string | undefined)[] = [];
    let width = 0;
    for (let r = 0; r < table.rows.length; r++) {
      const row = (grid[r] ??= []);
      let c = 0;
      for (const cell of table.rows[r]!.cells) {
        while (row[c] !== undefined) c++;
        const md = this.inline(cell.content, true, 0, true);
        const text = md.indexOf('|') < 0 ? md : md.replace(/\|/g, '\\|');
        const colspan = Math.min(Math.max(cell.colspan ?? 1, 1), 1000);
        const rowspan = Math.min(Math.max(cell.rowspan ?? 1, 1), table.rows.length - r);
        if (r === 0 && cell.align !== undefined) align[c] = cell.align;
        for (let dr = 0; dr < rowspan; dr++) {
          const target = (grid[r + dr] ??= []);
          for (let dc = 0; dc < colspan; dc++) target[c + dc] = dr === 0 && dc === 0 ? text : '';
        }
        c += colspan;
      }
      if (row.length > width) width = row.length;
    }
    if (width === 0) return '';
    const line = (cells: (string | undefined)[]) => {
      let out = '|';
      for (let c = 0; c < width; c++) {
        const cell = cells[c] ?? '';
        out += cell.length === 0 ? '  |' : ` ${cell} |`;
      }
      return out;
    };
    const header = (table.headerRows ?? 0) > 0 ? grid[0]! : [];
    const delimiter = '|' + Array.from({ length: width }, (_, c) => {
      const a = align[c];
      return a === 'center' ? ' :-: |' : a === 'right' ? ' --: |' : a === 'left' ? ' :-- |' : ' --- |';
    }).join('');
    const rows = [line(header), delimiter];
    for (let r = header.length > 0 ? 1 : 0; r < grid.length; r++) rows.push(line(grid[r]!));
    const md = rows.join('\n');
    const caption = table.caption !== undefined ? this.paragraph(table.caption) : '';
    return caption.length > 0 ? caption + '\n\n' + md : md;
  }

  footnotes(block: Footnotes): string {
    const out: string[] = [];
    for (const item of block.items) {
      const content = this.blocks(item.blocks, '\n\n');
      if (this.called.has(item.id)) {
        const label = this.notes.get(item.id)!;
        out.push(content.length === 0 ? `[^${label}]:` : indent(content, `[^${label}]: `, '    '));
      } else {
        this.uncalled.push(item.id);
        const label = escapeText(`[${item.label}]`, false);
        out.push(content.length === 0 ? label : item.blocks[0]?.type === 'paragraph' ? `${label} ${content}` : `${label}\n\n${content}`);
      }
    }
    return out.join('\n\n');
  }
}

function clean(label: string): string {
  return label.replace(FOOTNOTE_LABEL, '-').replace(/^-+|-+$/g, '');
}

const TILDES = /~+/g;

function codeBlock(block: Code): string {
  let info = block.language ?? '';
  if (block.title !== undefined) {
    const title = block.title.replace(/\s+/g, ' ').trim();
    if (title.length > 0) info = `${info.length > 0 ? info : 'text'} title="${title.replace(/[\\"]/g, '\\$&')}"`;
  }
  // Backtick fences cannot carry a backtick in their info string; tildes can.
  const tilde = info.indexOf('`') >= 0;
  const fence = tilde ? '~'.repeat(Math.max(3, longestRun(block.code, TILDES) + 1)) : '`'.repeat(Math.max(3, longestRun(block.code, BACKTICKS) + 1));
  const code = block.code.length === 0 || block.code.endsWith('\n') ? block.code : block.code + '\n';
  return `${fence}${info}\n${code}${fence}`;
}
