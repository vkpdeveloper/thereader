/**
 * Sanitises book descriptions (plain text or publisher HTML) into a small
 * block/inline tree that components render as React elements. Nothing from the
 * source reaches the DOM as markup: only allowlisted structure survives, and
 * every attribute is dropped except http(s)/mailto link targets.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'br' }
  | { kind: 'mark'; tag: MarkTag; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'p'; heading?: boolean; children: Inline[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; items: Block[][] };

export type MarkTag = 'em' | 'strong' | 'u' | 's' | 'small' | 'sub' | 'sup';

/** The slice of the DOM `Node` interface the walker needs; tests supply a fake. */
export interface RichNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<RichNode>;
  getAttribute?(name: string): string | null;
}

type Parse = (html: string) => RichNode | null;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const MAX_DEPTH = 16;

const MARKS: Record<string, MarkTag> = {
  em: 'em', i: 'em', cite: 'em',
  strong: 'strong', b: 'strong',
  u: 'u', ins: 'u',
  s: 's', strike: 's', del: 's',
  small: 'small', sub: 'sub', sup: 'sup',
};
/** Dropped together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'img', 'picture', 'svg', 'math',
  'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template', 'head',
  'title', 'meta', 'link', 'base',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Block containers whose children are hoisted into the surrounding flow. */
const BLOCK_UNWRAP = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'body', 'html', 'center', 'figure', 'dl', 'dd',
  'dt', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'pre', 'li',
]);

const tagOf = (node: RichNode) => node.nodeName.toLowerCase();

/** Returns a normalised href for absolute http(s)/mailto URLs, otherwise null. */
export function safeHref(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function textOf(node: RichNode): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeType !== ELEMENT_NODE || DROP.has(tagOf(node))) return '';
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) text += textOf(node.childNodes[i]);
  return text;
}

function walkInline(nodes: ArrayLike<RichNode>, depth: number, inLink: boolean, out: Inline[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ');
      if (text) out.push({ kind: 'text', text });
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const tag = tagOf(node);
    if (DROP.has(tag)) continue;
    if (tag === 'br') {
      out.push({ kind: 'br' });
      continue;
    }
    if (depth >= MAX_DEPTH) {
      const text = textOf(node).replace(/\s+/g, ' ');
      if (text) out.push({ kind: 'text', text });
      continue;
    }
    const mark = MARKS[tag];
    const href = tag === 'a' && !inLink ? safeHref(node.getAttribute?.('href')) : null;
    if (mark || href) {
      const children: Inline[] = [];
      walkInline(node.childNodes, depth + 1, inLink || !!href, children);
      if (children.length) out.push(href ? { kind: 'link', href, children } : { kind: 'mark', tag: mark, children });
      continue;
    }
    // span, font, unsafe or nested links, and blocks nested inside inline content.
    walkInline(node.childNodes, depth + 1, inLink, out);
  }
}

const isBlank = (node: Inline | undefined) => node?.kind === 'text' && node.text.trim() === '';

function hasText(inlines: Inline[]): boolean {
  return inlines.some((n) => (n.kind === 'text' ? n.text.trim() !== '' : n.kind !== 'br' && hasText(n.children)));
}

/** Splits an inline run into paragraphs at 2+ consecutive <br>s, trims edge <br>s and drops empties. */
function paragraphs(inlines: Inline[], heading = false): Block[] {
  const out: Block[] = [];
  let current: Inline[] = [];
  const flush = () => {
    while (current.length && (current[0].kind === 'br' || isBlank(current[0]))) current.shift();
    while (current.length && (current[current.length - 1].kind === 'br' || isBlank(current[current.length - 1]))) {
      current.pop();
    }
    if (hasText(current)) out.push(heading ? { kind: 'p', heading, children: current } : { kind: 'p', children: current });
    current = [];
  };
  for (let i = 0; i < inlines.length; i++) {
    if (inlines[i].kind === 'br') {
      let end = i + 1;
      let breaks = 1;
      while (end < inlines.length && (inlines[end].kind === 'br' || isBlank(inlines[end]))) {
        if (inlines[end].kind === 'br') breaks++;
        end++;
      }
      if (breaks > 1) {
        flush();
        i = end - 1;
        continue;
      }
    }
    current.push(inlines[i]);
  }
  flush();
  return out;
}

function walkList(node: RichNode, depth: number): Block | null {
  const items: Block[][] = [];
  let loose: RichNode[] = [];
  const pushLoose = () => {
    const item = walkBlocks(loose, depth + 1);
    if (item.length) items.push(item);
    loose = [];
  };
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === ELEMENT_NODE && tagOf(child) === 'li') {
      pushLoose();
      const item = walkBlocks(child.childNodes, depth + 1);
      if (item.length) items.push(item);
    } else {
      loose.push(child);
    }
  }
  pushLoose();
  return items.length ? { kind: 'list', ordered: tagOf(node) === 'ol', items } : null;
}

function walkBlocks(nodes: ArrayLike<RichNode>, depth: number): Block[] {
  const out: Block[] = [];
  let inline: Inline[] = [];
  const flush = () => {
    out.push(...paragraphs(inline));
    inline = [];
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const tag = node.nodeType === ELEMENT_NODE ? tagOf(node) : '';
    const block =
      tag === 'p' || tag === 'blockquote' || tag === 'ul' || tag === 'ol' || HEADINGS.has(tag) || BLOCK_UNWRAP.has(tag);
    if (!block || depth >= MAX_DEPTH) {
      walkInline([node], depth, false, inline);
      continue;
    }
    flush();
    if (tag === 'p' || HEADINGS.has(tag)) {
      const children: Inline[] = [];
      walkInline(node.childNodes, depth + 1, false, children);
      out.push(...paragraphs(children, tag !== 'p'));
    } else if (tag === 'blockquote') {
      const children = walkBlocks(node.childNodes, depth + 1);
      if (children.length) out.push({ kind: 'quote', children });
    } else if (tag === 'ul' || tag === 'ol') {
      const list = walkList(node, depth + 1);
      if (list) out.push(list);
    } else {
      out.push(...walkBlocks(node.childNodes, depth + 1));
    }
  }
  flush();
  return out;
}

/** Sanitises a DOM(-like) subtree, e.g. a parsed document body, into blocks. */
export function blocksFromNodes(root: RichNode): Block[] {
  return walkBlocks(root.childNodes, 0);
}

/** Plain text: blank lines separate paragraphs, single newlines become line breaks. */
export function blocksFromPlainText(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t ]*\n\s*/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const children: Inline[] = [];
      para.split('\n').forEach((line, i) => {
        if (i > 0) children.push({ kind: 'br' });
        const collapsed = line.replace(/[ \t]+/g, ' ').trim();
        if (collapsed) children.push({ kind: 'text', text: collapsed });
      });
      return { kind: 'p' as const, children };
    });
}

const HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/** True when the text contains tags or character references and needs parsing. */
export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text) || ENTITY.test(text);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tag-stripping fallback for environments without DOMParser; keeps paragraph breaks. */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|svg|math|noscript|template|title|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|blockquote|ul|ol|li|h[1-6]|section|article|table|tr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHtml(html: string): RichNode | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html').body as unknown as RichNode;
  } catch {
    return null;
  }
}

/** Parses a description into sanitised blocks. `parse` is injectable for tests. */
export function parseDescription(source: string, parse: Parse = parseHtml): Block[] {
  if (!source.trim()) return [];
  if (!looksLikeHtml(source)) return blocksFromPlainText(source);
  const root = parse(source);
  return root ? blocksFromNodes(root) : blocksFromPlainText(stripHtml(source));
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.text : n.kind === 'br' ? '\n' : inlineText(n.children))).join('');
}

/** Flattens blocks to text: paragraphs separated by blank lines, list items by newlines. */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.kind === 'p') return inlineText(block.children).replace(/ *\n */g, '\n').trim();
      if (block.kind === 'quote') return blocksToText(block.children);
      return block.items.map((item) => `• ${blocksToText(item).replace(/\s*\n\s*/g, ' ')}`).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/** A description as plain text for snippets, titles and meta tags; tags never leak. */
export function descriptionToPlainText(source: string, parse?: Parse): string {
  return blocksToText(parseDescription(source, parse));
}
