import { addClass, BLOCKS, create, elements, hasClass, isElement, nameOf, squash } from './dom';

/**
 * Rule 7: EPUBs converted from PDF line by line (pdftohtml, often through
 * calibre). Gated on strong signals; nothing here runs on ordinary books.
 * Text is never removed or reordered: wrappers are neutralised with CSS,
 * running headers are collapsed, and broken lines are joined by moving whole
 * paragraphs into a wrapper in order, with spacing from CSS.
 */

const GENERATOR = /pdftohtml|pdf2htmlEX|pdftotext|ABBYY|Adobe InDesign.*PDF/i;
const PAGE_ANCHOR = /^(p|page|pg|pdf-page|page_?)[-_]?\d+$/i;
const INLINE_WRAPPERS = new Set(['i', 'em', 'b', 'strong', 'cite', 'span', 'font', 'u', 'big', 'small', 'var', 'dfn']);
const PAGE_NUMBER = /^(\d{1,4}|[ivxlcdm]{1,7})$/i;
const RUNNING_HEAD = /^(chapter|section|part|appendix)\s+[\dA-Z]+(\.[\dA-Z]+)*$/i;
/** A line that ends a sentence (a closing parenthesis does not: "(a)" labels run into their item). */
const TERMINAL = /[.!?:;”"’]$/;
/** A list item's label on its own line, "(a)" or "(iv)"; its item always follows. */
const ITEM_LABEL = /^\(([a-z]|[ivx]{1,4}|\d{1,2})\)$/;

/** Empty anchors marking PDF page starts (`<a id="p112"></a>`). */
function pageAnchors(root: Element): Element[] {
  return elements(root, 'a').filter((a) => {
    const id = a.getAttribute('id') ?? a.getAttribute('name') ?? '';
    return PAGE_ANCHOR.test(id) && !a.hasAttribute('href') && !squash(a);
  });
}

export function isPdfConversion(doc: Document, root: Element): boolean {
  for (const meta of elements(doc.documentElement ?? root, 'meta')) {
    // A generator names itself up front; the cap keeps `.*` from rescanning a huge content attribute.
    const content = (meta.getAttribute('content') ?? '').slice(0, 256);
    if ((meta.getAttribute('name') ?? '').toLowerCase() === 'generator' && GENERATOR.test(content)) return true;
  }
  // No generator: many page anchors and mostly unterminated one-line paragraphs.
  const paragraphs = elements(root, 'p');
  if (paragraphs.length < 40 || pageAnchors(root).length < 3) return false;
  let open = 0;
  for (const p of paragraphs) {
    const t = squash(p);
    if (t && !TERMINAL.test(t)) open++;
  }
  return open / paragraphs.length > 0.4;
}

export function preparePdf(doc: Document, root: Element): number {
  if (!isPdfConversion(doc, root)) return 0;
  let count = 0;

  // (a) Inline formatting wrapped around blocks (the whole book in one <i>).
  for (const el of Array.from(root.getElementsByTagNameNS('*', '*'))) {
    if (!INLINE_WRAPPERS.has(nameOf(el))) continue;
    if (Array.from(el.children).some((c) => BLOCKS.has(nameOf(c)))) {
      addClass(el, 'tr-pdf-neutral');
      count++;
    }
  }

  const lines = elements(root, 'p').filter((p) => !p.closest('table, li, pre'));
  const texts = new Map<Element, string>(lines.map((p) => [p, squash(p)]));

  // (b) Page numbers and running headers: the first lines after a page
  // anchor that are page numbers, "CHAPTER 3"-style heads, or text that
  // recurs at page starts (the chapter or section title).
  const index = new Map(lines.map((p, i) => [p, i]));
  const starts: number[] = [];
  for (const a of pageAnchors(root)) {
    const first = a.closest('p');
    let i = first ? index.get(first) : undefined;
    if (i === undefined) {
      // Anchor between paragraphs: the header lines follow it (within a few
      // siblings; a run of thousands of anchors must not be rescanned from each).
      let next = a.nextElementSibling;
      for (let hops = 0; next && !index.has(next) && hops < 8; hops++) next = next.nextElementSibling;
      if (next && !index.has(next)) next = null;
      i = next ? index.get(next) : undefined;
    }
    if (i !== undefined) starts.push(i);
  }
  const atPageStart = new Map<string, number>();
  for (const i of starts) {
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const t = texts.get(lines[k]) ?? '';
      if (t.length <= 80) atPageStart.set(t, (atPageStart.get(t) ?? 0) + 1);
    }
  }
  for (const i of starts) {
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const t = texts.get(lines[k]) ?? '';
      const header = PAGE_NUMBER.test(t) || RUNNING_HEAD.test(t) || (t.length <= 80 && (atPageStart.get(t) ?? 0) >= 2 && !TERMINAL.test(t));
      if (!header) break;
      addClass(lines[k], 'tr-pdf-hidden');
      count++;
    }
  }

  // Result numbers ("3.85") and the short title line after them.
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i];
    if (hasClass(p, 'tr-pdf-hidden') || !/^\d+(\.\d+)+$/.test(texts.get(p) ?? '')) continue;
    addClass(p, 'tr-pdf-label');
    const next = lines[i + 1];
    const t = next ? texts.get(next) ?? '' : '';
    if (next && t.length <= 90 && /^[A-Z]/.test(t) && !TERMINAL.test(t) && !/^(Proof|Example|Definition)\b/.test(t)) {
      addClass(next, 'tr-pdf-title');
    }
  }

  // (c) Lines of one paragraph split into many <p>.
  count += joinLines(doc, lines, texts);
  return count;
}

function joinLines(doc: Document, lines: Element[], texts: Map<Element, string>): number {
  let count = 0;
  const visible = (p: Element) => !hasClass(p, 'tr-pdf-hidden');
  const plain = (p: Element) => visible(p) && !hasClass(p, 'tr-pdf-label') && !hasClass(p, 'tr-pdf-title');
  let i = 0;
  while (i < lines.length) {
    const start = lines[i];
    if (!plain(start)) {
      i++;
      continue;
    }
    // Extend the run while the next visible line continues this one.
    const run: Element[] = [start];
    let j = i + 1;
    let last = start;
    while (j < lines.length) {
      const next = lines[j];
      if (!visible(next)) {
        // Collapsed page furniture between two halves of a sentence goes along.
        if (next.parentNode === last.parentNode && adjacent(last, next)) {
          run.push(next);
          last = next;
          j++;
          continue;
        }
        break;
      }
      const prevText = lastVisibleText(run, texts);
      const nextText = texts.get(next) ?? '';
      const continues = plain(next) && next.parentNode === last.parentNode && adjacent(last, next) &&
        !!prevText && !!nextText && (/^[a-z(]/.test(nextText) && !TERMINAL.test(prevText) || /[-,]$/.test(prevText) || ITEM_LABEL.test(prevText));
      if (!continues) break;
      run.push(next);
      last = next;
      j++;
    }
    // Trailing collapsed lines stay outside the paragraph.
    while (run.length > 1 && !visible(run[run.length - 1])) run.pop();
    if (run.filter(visible).length > 1) {
      const wrap = create(doc, 'div', 'tr-pdf-para');
      const first = run[0];
      const last = run[run.length - 1];
      first.parentNode!.insertBefore(wrap, first);
      // Move the whole sibling range, whitespace between the lines included, so text order is exact.
      for (let n: Node | null = first; n; ) {
        const next: Node | null = n === last ? null : n.nextSibling;
        wrap.append(n);
        n = next;
      }
      for (const p of run) if (/-$/.test(texts.get(p) ?? '')) addClass(p, 'tr-pdf-hyphen');
      count++;
    }
    i = Math.max(j, i + 1);
  }
  return count;
}

function lastVisibleText(run: Element[], texts: Map<Element, string>): string {
  for (let k = run.length - 1; k >= 0; k--) if (!hasClass(run[k], 'tr-pdf-hidden')) return texts.get(run[k]) ?? '';
  return '';
}

/** Next element sibling, with only whitespace or empty anchors between. */
function adjacent(a: Element, b: Element): boolean {
  for (let n = a.nextSibling; n; n = n.nextSibling) {
    if (n === b) return true;
    if (isElement(n)) return false;
    if ((n.textContent ?? '').trim()) return false;
  }
  return false;
}
