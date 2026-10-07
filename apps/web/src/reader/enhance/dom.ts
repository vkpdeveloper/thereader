/**
 * DOM helpers shared by the enhancer rules. Everything works on XHTML
 * (namespaced, case-sensitive) and HTML documents alike, and touches only
 * standard DOM APIs so the same code runs in the web engine, in Readium's
 * web views and under jsdom in tests.
 */

/**
 * Marks a subtree the enhancer inserted. Text inside it is not book text:
 * the web TextIndex skips it, and its rendering lives in a shadow root so
 * Readium's `body.textContent` never sees it either.
 */
export const UI_ATTR = 'data-tr-ui';
/** Set on `<html>` (or the enhanced root) once the sync rules ran. */
export const ENHANCED_ATTR = 'data-tr-enhanced';

export const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
export const OPS_NS = 'http://www.idpf.org/2007/ops';

export function isElement(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === 1;
}

export function isText(n: Node | null | undefined): n is Text {
  return !!n && n.nodeType === 3;
}

/** Lower-case local name; `epub:switch` parsed as HTML keeps its prefix in the name. */
export function nameOf(el: Element): string {
  return el.localName.toLowerCase();
}

/** An XHTML element; in HTML documents that is the same as `createElement`, in XHTML ones it keeps the namespace. */
export function create(doc: Document, tag: string, className?: string): HTMLElement {
  const el = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
  if (className) el.setAttribute('class', className);
  return el;
}

export function addClass(el: Element, ...names: string[]): void {
  const have = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  let changed = false;
  for (const n of names) {
    if (!have.includes(n)) {
      have.push(n);
      changed = true;
    }
  }
  if (changed) el.setAttribute('class', have.join(' '));
}

export function hasClass(el: Element, name: string): boolean {
  return (el.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

export function classOf(el: Element): string {
  return el.getAttribute('class') ?? '';
}

/** Elements under `root` (inclusive) by local name, namespace-agnostic. */
export function elements(root: Element, name: string): Element[] {
  const out: Element[] = [];
  if (nameOf(root) === name) out.push(root);
  for (const el of Array.from(root.getElementsByTagNameNS('*', name))) out.push(el);
  if (out.length === 0 || name.includes(':')) {
    // HTML-parsed `epub:switch` and friends: the prefix is part of the local name.
    for (const el of Array.from(root.getElementsByTagName(name))) if (!out.includes(el)) out.push(el);
  }
  return out;
}

export function closest(el: Element, test: (e: Element) => boolean, limit = 64): Element | null {
  let cur: Element | null = el;
  for (let i = 0; cur && i < limit; i++, cur = cur.parentElement) if (test(cur)) return cur;
  return null;
}

/** Inside code, preformatted text, existing MathML or something the enhancer inserted. */
export function inProtected(el: Element): boolean {
  return !!closest(el, (e) => {
    const n = nameOf(e);
    return n === 'pre' || n === 'code' || n === 'math' || n === 'script' || n === 'style' || e.hasAttribute(UI_ATTR);
  });
}

/** Text nodes under `root` in document order. */
export function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (isText(c)) out.push(c);
      else if (isElement(c)) walk(c);
    }
  };
  walk(root);
  return out;
}

/** Block-level element names, for "inline element wraps blocks" and paragraph checks. */
export const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'ul',
]);

/** Visible-ish text of an element, whitespace collapsed (for heuristics, never for offsets). */
export function squash(el: Node): string {
  return (el.textContent ?? '').replace(/[\s ­​]+/g, ' ').trim();
}
