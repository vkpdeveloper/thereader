import { Readability } from '@mozilla/readability';
import Defuddle from 'defuddle';
import { articleText, extract } from '../../packages/extract/src/index.ts';
import type { Article, Block, Inline } from '../../packages/extract/src/model.ts';
import { canonicalLanguage, normalizeText } from './text';

/**
 * Runs inside headless Chromium. Each engine gets a fresh document from the
 * native `DOMParser` (engines mutate it); parse and extraction are timed
 * separately with `performance.now()`.
 */

export type BrowserEngine = 'ours' | 'readability' | 'defuddle';

export interface Stats {
  codeBlocks: number;
  codeLanguages: string[];
  images: number;
  headings: number;
  tables: number;
  lists: number;
  math: number;
  footnotes: number;
  footnoteRefs: number;
  embeds: number;
}

export interface Summary {
  title: string;
  text: string;
  stats: Stats;
  /** Ours only: count of blocks per type. */
  blockTypes?: Record<string, number>;
}

export interface EngineRun {
  ok: boolean;
  error?: string;
  summary?: Summary;
  parseMs: number[];
  extractMs: number[];
}

interface Engine {
  run(doc: Document, url: string): unknown;
  summarize(result: unknown): Summary;
}

function parse(html: string, url: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.querySelector('base[href]')) {
    const base = doc.createElement('base');
    base.href = url;
    doc.head.prepend(base);
  }
  return doc;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'svg', 'IFRAME', 'OBJECT']);
const BLOCK = new Set(
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE BR CAPTION DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HGROUP HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TFOOT THEAD TR UL'.split(' '),
);

/** Plain text of a subtree with block boundaries as newlines and table cells as tabs. */
function nodeText(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(pre ? node.nodeValue ?? '' : (node.nodeValue ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (SKIP.has(element.tagName)) return;
    const block = BLOCK.has(element.tagName);
    if (block) out.push('\n');
    for (const child of Array.from(element.childNodes)) walk(child, pre || element.tagName === 'PRE');
    if (element.tagName === 'TD' || element.tagName === 'TH') out.push('\t');
    if (block) out.push('\n');
  };
  walk(root, false);
  return normalizeText(out.join(''));
}

function fragment(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html').body;
}

const LANGUAGE_CLASS = /(?:^|\s)(?:language|lang|highlight-source|brush:?)-?([\w+#.-]+)/i;

function elementLanguage(element: Element | null): string | null {
  if (!element) return null;
  const attr = element.getAttribute('data-lang') ?? element.getAttribute('data-language');
  if (attr) return canonicalLanguage(attr);
  const match = element.className && typeof element.className === 'string' ? element.className.match(LANGUAGE_CLASS) : null;
  return match ? canonicalLanguage(match[1]) : null;
}

const FOOTNOTE_ITEMS =
  'li[id^="fn"], li[id^="footnote"], li[id^="note"], [role="doc-endnote"], [role="doc-footnote"], .footnotes li, .footnote-definition, .sidenote, .marginnote';
const FOOTNOTE_REFS = 'a[href^="#fn"], a[href^="#footnote"], a[href^="#note"], [role="doc-noteref"], sup a[href^="#"]';
const EMBEDS =
  'iframe, video, audio, embed, object, lite-youtube, blockquote.twitter-tweet, blockquote.instagram-media, blockquote.tiktok-embed, blockquote.bluesky-embed, .twitter-tweet';

/** Structure of an engine's HTML output. An `h1` counts as a section heading unless it repeats the title. */
export function htmlStats(root: Element, title = ''): Stats {
  const pres = Array.from(root.querySelectorAll('pre')).filter((pre) => !pre.parentElement?.closest('pre'));
  const languages = new Set<string>();
  for (const pre of pres) {
    const language = elementLanguage(pre) ?? elementLanguage(pre.querySelector('code')) ?? elementLanguage(pre.parentElement);
    if (language) languages.add(language);
  }
  const katex = Array.from(root.querySelectorAll('.katex, mjx-container, .MathJax')).filter((el) => !el.querySelector('math'));
  return {
    codeBlocks: pres.length,
    codeLanguages: [...languages].sort(),
    images: root.querySelectorAll('img').length,
    headings:
      root.querySelectorAll('h2, h3, h4, h5, h6').length +
      Array.from(root.querySelectorAll('h1')).filter((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim() !== title.replace(/\s+/g, ' ').trim()).length,
    tables: root.querySelectorAll('table').length,
    lists: root.querySelectorAll('ul, ol').length,
    math: root.querySelectorAll('math').length + katex.length,
    footnotes: root.querySelectorAll(FOOTNOTE_ITEMS).length,
    footnoteRefs: root.querySelectorAll(FOOTNOTE_REFS).length,
    embeds: root.querySelectorAll(EMBEDS).length,
  };
}

/** Text and structure of an HTML fragment (Readability, Defuddle, Postlight, Trafilatura output). */
export function summarizeHtml(html: string, title = ''): Summary {
  const root = fragment(html);
  return { title, text: nodeText(root), stats: htmlStats(root, title) };
}

function articleStats(article: Article): { stats: Stats; blockTypes: Record<string, number> } {
  const stats: Stats = { codeBlocks: 0, codeLanguages: [], images: 0, headings: 0, tables: 0, lists: 0, math: 0, footnotes: 0, footnoteRefs: 0, embeds: 0 };
  const blockTypes: Record<string, number> = {};
  const languages = new Set<string>();
  const inlines = (content: readonly Inline[] | undefined) => {
    for (const node of content ?? []) {
      if (node.type === 'math') stats.math++;
      else if (node.type === 'ref') stats.footnoteRefs++;
    }
  };
  const visit = (block: Block) => {
    blockTypes[block.type] = (blockTypes[block.type] ?? 0) + 1;
    switch (block.type) {
      case 'heading':
        stats.headings++;
        inlines(block.content);
        break;
      case 'paragraph':
        inlines(block.content);
        break;
      case 'code': {
        stats.codeBlocks++;
        const language = canonicalLanguage(block.language);
        if (language) languages.add(language);
        break;
      }
      case 'figure':
        stats.images += block.images.length;
        inlines(block.caption);
        break;
      case 'table':
        stats.tables++;
        for (const row of block.rows) for (const cell of row.cells) inlines(cell.content);
        break;
      case 'list':
        stats.lists++;
        for (const item of block.items) item.blocks.forEach(visit);
        break;
      case 'quote':
        block.blocks.forEach(visit);
        break;
      case 'math':
        stats.math++;
        break;
      case 'footnotes':
        stats.footnotes += block.items.length;
        for (const item of block.items) item.blocks.forEach(visit);
        break;
      case 'video':
      case 'audio':
        stats.embeds++;
        break;
      case 'embed':
        stats.embeds++;
        block.blocks?.forEach(visit);
        break;
      case 'definitions':
        for (const item of block.items) item.details.forEach(visit);
        break;
      case 'details':
      case 'callout':
        block.blocks.forEach(visit);
        break;
      case 'rule':
        break;
    }
  };
  article.blocks.forEach(visit);
  stats.codeLanguages = [...languages].sort();
  return { stats, blockTypes };
}

const engines: Record<BrowserEngine, Engine> = {
  ours: {
    run: (doc, url) => extract(doc, { url }),
    summarize(result) {
      const article = result as Article | null;
      if (!article) return summarizeHtml('');
      const { stats, blockTypes } = articleStats(article);
      return { title: article.title, text: normalizeText(articleText(article)), stats, blockTypes };
    },
  },
  readability: {
    run: (doc) => new Readability(doc).parse(),
    summarize(result) {
      const article = result as { content?: string | null; title?: string | null } | null;
      return summarizeHtml(article?.content ?? '', article?.title ?? '');
    },
  },
  defuddle: {
    run: (doc, url) => new Defuddle(doc, { url }).parse(),
    summarize(result) {
      const article = result as { content?: string; title?: string };
      return summarizeHtml(article.content ?? '', article.title ?? '');
    },
  },
};

let current = { html: '', url: '' };

/** Holds the page's HTML in the renderer so engine runs do not re-send it. */
export function load(html: string, url: string): number {
  current = { html, url };
  return html.length;
}

/**
 * One warm-up run (its output is the one scored), then `runs` timed runs. A
 * warm-up slower than `slowMs` becomes the only timing sample, so a
 * pathological page cannot stall the whole eval.
 */
export function runEngine(name: BrowserEngine, runs: number, slowMs = 5000): EngineRun {
  const engine = engines[name];
  const { html, url } = current;
  const result: EngineRun = { ok: true, parseMs: [], extractMs: [] };
  try {
    for (let i = 0; i <= runs; i++) {
      const t0 = performance.now();
      const doc = parse(html, url);
      const t1 = performance.now();
      const output = engine.run(doc, url);
      const t2 = performance.now();
      if (i === 0) result.summary = engine.summarize(output);
      if (i > 0 || t2 - t0 > slowMs) {
        result.parseMs.push(t1 - t0);
        result.extractMs.push(t2 - t1);
      }
      if (t2 - t0 > slowMs) break;
    }
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return result;
}

/** Text of the whole page as the engines see it (scripts, styles, templates and noscript dropped). */
export function pageText(): string {
  return nodeText(parse(current.html, current.url).body);
}

function describe(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node.tagName !== 'BODY' && parts.length < 4; node = node.parentElement) {
    const id = node.id ? `#${node.id.slice(0, 30)}` : '';
    const classes =
      typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c.slice(0, 30)}`).join('')
        : '';
    if (node === element || id || classes || /^(ARTICLE|MAIN|NAV|HEADER|FOOTER|ASIDE|SECTION|FORM|TABLE)$/.test(node.tagName)) {
      parts.unshift(`${node.tagName.toLowerCase()}${id}${classes}`);
    }
  }
  return parts.join(' > ') || 'body';
}

/**
 * Annotation aid: the page's text as a flat list of blocks in document order,
 * each run of inline text attributed to its nearest block element and that
 * element's short DOM path.
 */
export function pageBlocks(): { path: string; text: string }[] {
  const doc = parse(current.html, current.url);
  const blocks: { path: string; text: string }[] = [];
  let owner: Element = doc.body;
  let buffer = '';
  const flush = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ path: describe(owner), text });
    buffer = '';
  };
  const walk = (node: Node, block: Element) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (owner !== block) {
        flush();
        owner = block;
      }
      buffer += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (SKIP.has(element.tagName)) return;
    const isBlock = BLOCK.has(element.tagName) || element.tagName === 'TD' || element.tagName === 'TH';
    if (isBlock) flush();
    for (const child of Array.from(element.childNodes)) walk(child, isBlock ? element : block);
    if (isBlock) flush();
  };
  walk(doc.body, doc.body);
  flush();
  return blocks;
}

export function meta(): Record<string, string> {
  const doc = parse(current.html, current.url);
  const content = (selector: string) => doc.querySelector(selector)?.getAttribute('content') ?? '';
  return {
    title: doc.title,
    ogTitle: content('meta[property="og:title"]'),
    h1: Array.from(doc.querySelectorAll('h1')).map((h) => nodeText(h)).join(' | '),
    lang: doc.documentElement.lang,
  };
}

Object.assign(globalThis, { evalPage: { load, runEngine, summarizeHtml, pageText, pageBlocks, meta } });
