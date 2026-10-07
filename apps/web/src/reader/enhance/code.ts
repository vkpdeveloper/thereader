import { addClass, classOf, create, hasClass, isElement, isText, nameOf, UI_ATTR } from './dom';

export interface Highlighted {
  /** highlight.js markup: escaped source wrapped in `hljs-*` spans. */
  html: string;
  language: string;
}

/** Highlights code in a named language, or detects one when null; null leaves it plain. */
export type Highlighter = (code: string, language: string | null) => Highlighted | null | Promise<Highlighted | null>;

const LANG_CLASS = /(?:^|\s)(?:language|lang|highlight|brush|code|source|sourceCode)[-:_]([\w#+.-]+)/i;
const BRUSH = /brush\s*:\s*([\w#+.-]+)/i;
/** Bare classes some converters use for the language itself. */
const BARE = new Set([
  'python', 'javascript', 'typescript', 'java', 'kotlin', 'swift', 'rust', 'go', 'golang', 'ruby', 'php', 'csharp', 'cpp', 'c',
  'bash', 'shell', 'sh', 'sql', 'json', 'yaml', 'xml', 'html', 'css', 'scala', 'haskell', 'r', 'lua', 'perl', 'dart', 'elixir',
  'clojure', 'julia', 'matlab', 'powershell', 'dockerfile', 'makefile', 'latex', 'diff',
]);
/** Not a language, whatever the class says. */
const NOT_CODE = new Set(['text', 'plain', 'plaintext', 'txt', 'none', 'output', 'console-output', 'nohighlight', 'no-highlight']);

/** Declared language of a code block, from the `pre`, its `code` child or `data-lang`. */
export function declaredLanguage(pre: Element): string | null {
  const code = Array.from(pre.children).find((c) => nameOf(c) === 'code') ?? null;
  for (const el of code ? [code, pre] : [pre]) {
    for (const attr of ['data-lang', 'data-language', 'data-code-language', 'lang', 'language']) {
      const v = el.getAttribute(attr)?.trim().toLowerCase();
      // `lang` on a pre is usually a natural language ("en"); only trust it when it names code.
      if (v && (attr !== 'lang' || BARE.has(v))) return NOT_CODE.has(v) ? '' : v;
    }
    const cls = classOf(el);
    const m = LANG_CLASS.exec(cls) ?? BRUSH.exec(cls);
    if (m) {
      const v = m[1].toLowerCase();
      if (v === 'block' || v === 'area' || v === 'listing' || v === 'line' || v === 'inline') continue;
      return NOT_CODE.has(v) ? '' : v;
    }
    for (const c of cls.toLowerCase().split(/\s+/)) {
      if (BARE.has(c)) return c;
      if (NOT_CODE.has(c)) return '';
    }
  }
  return null;
}

/**
 * The code a `pre` shows: its text nodes in order, `<br>` as a newline.
 * `segments` maps the string back to text nodes (a br has no node).
 */
function codeOf(pre: Element): { code: string; segments: { node: Text | null; start: number; length: number }[] } {
  const segments: { node: Text | null; start: number; length: number }[] = [];
  let code = '';
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (isText(c)) {
        segments.push({ node: c, start: code.length, length: c.data.length });
        code += c.data;
      } else if (isElement(c)) {
        const name = nameOf(c);
        if (name === 'br') {
          segments.push({ node: null, start: code.length, length: 1 });
          code += '\n';
        } else if (name !== 'script' && name !== 'style' && !c.hasAttribute(UI_ATTR)) walk(c);
      }
    }
  };
  walk(pre);
  return { code, segments };
}

/** Flattens highlight.js markup into scoped runs over the plain source. */
export function tokensOf(html: string): { text: string; runs: { start: number; end: number; cls: string }[] } {
  const runs: { start: number; end: number; cls: string }[] = [];
  const stack: { cls: string; start: number }[] = [];
  let text = '';
  const re = /<span class="([^"]*)">|<\/span>|&(amp|lt|gt|quot|#x27|#39|apos|nbsp);|([^<&]+)|([<&])/g;
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", apos: "'", nbsp: ' ' };
  // Innermost scope wins; a nested span splits its parent's run.
  const flush = () => {
    const top = stack[stack.length - 1];
    if (top && text.length > top.start) runs.push({ start: top.start, end: text.length, cls: top.cls });
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      flush();
      stack.push({ cls: m[1], start: text.length });
    } else if (m[0] === '</span>') {
      flush();
      stack.pop();
      const top = stack[stack.length - 1];
      if (top) top.start = text.length;
    } else if (m[2] !== undefined) text += entities[m[2]];
    else text += m[3] ?? m[4] ?? '';
  }
  return { text, runs };
}

/**
 * Applies highlight.js output to a `pre` without replacing its text: each
 * token's stretch of the original text nodes is split out and wrapped in a
 * span. Text nodes keep their characters and order, so offsets into the
 * chapter text are unchanged. False when the markup does not match the source.
 */
export function applyHighlight(pre: Element, html: string): boolean {
  const { code, segments } = codeOf(pre);
  const { text, runs } = tokensOf(html);
  if (text !== code) return false;
  const doc = pre.ownerDocument;
  const scoped = runs
    .map((r) => ({ ...r, cls: r.cls.split(/\s+/).filter((c) => /^hljs-|^[\w-]+_$/.test(c)).join(' ') }))
    .filter((r) => r.cls && r.end > r.start);
  if (!scoped.length) return true;
  // Runs are disjoint and in order. Split each text node at run edges, then
  // wrap every piece that falls inside a run.
  const edges = new Set<number>();
  for (const r of scoped) {
    edges.add(r.start);
    edges.add(r.end);
  }
  let k = 0;
  for (const seg of segments) {
    if (!seg.node || !seg.length) continue;
    const end = seg.start + seg.length;
    const cuts = [...edges].filter((e) => e > seg.start && e < end).sort((a, b) => a - b);
    const pieces: { node: Text; start: number }[] = [];
    let node = seg.node;
    let at = seg.start;
    for (const cut of cuts) {
      const rest = node.splitText(cut - at);
      pieces.push({ node, start: at });
      node = rest;
      at = cut;
    }
    pieces.push({ node, start: at });
    for (const piece of pieces) {
      while (k < scoped.length && scoped[k].end <= piece.start) k++;
      const run = scoped[k];
      if (!run || run.start > piece.start) continue;
      const span = create(doc, 'span', run.cls);
      piece.node.parentNode!.insertBefore(span, piece.node);
      span.append(piece.node);
    }
  }
  return true;
}

/**
 * Rule 5: code blocks. Every `pre` gets the code styling from the
 * stylesheet; blocks with a declared language, or a confidently detected one,
 * are highlighted.
 */
export async function prepareCode(root: Element, highlight: Highlighter | null): Promise<number> {
  let count = 0;
  for (const pre of Array.from(root.getElementsByTagNameNS('*', 'pre'))) {
    if (hasClass(pre, 'tr-code')) continue;
    addClass(pre, 'tr-code');
    if (!highlight || pre.querySelector('[class*="hljs-"], [class*="token "], .tr-math')) continue;
    const language = declaredLanguage(pre);
    if (language === '') continue;
    const { code } = codeOf(pre);
    if (!code.trim() || code.length > 60000) continue;
    let result: Highlighted | null = null;
    try {
      result = await highlight(code, language);
    } catch {
      result = null;
    }
    if (result && applyHighlight(pre, result.html)) {
      pre.setAttribute('data-tr-lang', result.language);
      count++;
    }
  }
  return count;
}

/** Whether the document is laid out in CSS columns (Readium paged mode, the web engine's pages). */
export function isPaginated(doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(doc.documentElement);
  return (style.columnCount !== 'auto' && style.columnCount !== '' && style.columnCount !== '1') ||
    (style.columnWidth !== 'auto' && style.columnWidth !== '');
}

/**
 * Paginated layouts: a scroll box cannot break across pages, so code blocks
 * and tables taller than a page fall back to wrapping (at spaces first) and
 * may then continue on the next page. Others keep scrolling sideways. Returns
 * whether anything changed (the caller re-measures pages).
 */
export function fitBlocks(root: Element, pageHeight: number | null): boolean {
  const blocks = Array.from(root.querySelectorAll('pre.tr-code, .tr-table-scroll')) as HTMLElement[];
  if (!blocks.length) return false;
  const was = blocks.map((el) => el.classList.contains('tr-wrap'));
  // Unwrap all, read every height in one layout, then wrap the tall ones.
  for (const el of blocks) el.classList.remove('tr-wrap');
  const want = pageHeight && pageHeight > 0 ? blocks.map((el) => el.offsetHeight > pageHeight * 0.92) : blocks.map(() => false);
  let changed = false;
  blocks.forEach((el, i) => {
    if (want[i]) el.classList.add('tr-wrap');
    if (want[i] !== was[i]) changed = true;
  });
  return changed;
}
