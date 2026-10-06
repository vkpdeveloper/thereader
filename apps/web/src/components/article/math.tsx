import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InlineMath, MathBlock } from '@thereader/extract';

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

const elements = new Set([
  'math', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mrow', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror', 'mpadded',
  'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts',
  'mprescripts', 'none', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maligngroup', 'malignmark', 'semantics', 'annotation',
]);

const attributes = new Set([
  'accent', 'accentunder', 'align', 'close', 'columnalign', 'columnlines', 'columnspacing', 'columnspan', 'depth', 'dir',
  'display', 'displaystyle', 'encoding', 'fence', 'form', 'frame', 'height', 'largeop', 'linethickness', 'lspace',
  'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits', 'notation', 'open', 'rowalign', 'rowlines',
  'rowspacing', 'rowspan', 'rspace', 'scriptlevel', 'separator', 'separators', 'stretchy', 'symmetric', 'voffset', 'width',
]);

/**
 * Token elements hold text only. Some converters (older KaTeX) nest `<mi>`
 * inside `<mtext>`, which Chromium lays out one glyph per line.
 */
const tokens = new Set(['mi', 'mn', 'mo', 'ms', 'mtext']);

/** Layout classes from converted TeX (array cell alignment, row spacing), styled in article.css. */
const classes = new Set(['tml-right', 'tml-left', 'tml-jot', 'tml-small']);
/** Inline styles are kept only when they are plain cell padding. */
const paddingStyle = /^(?:\s*padding-(?:left|right|top|bottom)\s*:\s*-?[\d.]+(?:em|ex)\s*;?)+\s*$/;

const supportsMathml = typeof window !== 'undefined' && 'MathMLElement' in window;

/**
 * Rebuilds a `<math>` tree from MathML presentation elements and attributes
 * only: no links, event handlers or embedded HTML survive, and styling only
 * as known layout classes and cell padding.
 */
export function sanitizeMathml(source: string, display: 'block' | 'inline'): Element | null {
  const parsed = new DOMParser().parseFromString(source, 'text/html').querySelector('math');
  if (!parsed) return null;
  const copy = (node: Element): Element | null => {
    const name = node.localName.toLowerCase();
    if (!elements.has(name)) return null;
    const out = document.createElementNS(MATHML_NS, name);
    for (const attr of Array.from(node.attributes)) {
      const key = attr.name.toLowerCase();
      if (attributes.has(key)) out.setAttribute(key, attr.value);
      else if (key === 'class') {
        const kept = attr.value.split(/\s+/).filter((token) => classes.has(token));
        if (kept.length > 0) out.setAttribute('class', kept.join(' '));
      } else if (key === 'style' && paddingStyle.test(attr.value)) out.setAttribute('style', attr.value);
    }
    if (tokens.has(name) && node.children.length > 0) {
      out.textContent = node.textContent ?? '';
      return out;
    }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out.appendChild(document.createTextNode(child.textContent ?? ''));
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const next = copy(child as Element);
        if (next) out.appendChild(next);
      }
    }
    return out;
  };
  const math = copy(parsed);
  if (!math) return null;
  math.setAttribute('display', display);
  alignCells(math);
  return math;
}

/** Chromium ignores `columnalign`; carries table and row alignment to the cells as layout classes. */
function alignCells(math: Element): void {
  const list = (el: Element) => (el.getAttribute('columnalign') ?? '').split(/\s+/).filter(Boolean);
  for (const table of Array.from(math.getElementsByTagNameNS(MATHML_NS, 'mtable'))) {
    const tableAlign = list(table);
    for (const row of Array.from(table.children)) {
      if (row.localName !== 'mtr') continue;
      const rowAlign = list(row);
      const aligns = rowAlign.length > 0 ? rowAlign : tableAlign;
      Array.from(row.children).forEach((cell, i) => {
        const align = cell.getAttribute('columnalign') ?? aligns[Math.min(i, aligns.length - 1)];
        if (align === 'left' || align === 'right') cell.classList.add(`tml-${align}`);
      });
    }
  }
}

/** The TeX converter chunk, fetched once and only for articles with TeX-only formulas. */
let texModule: Promise<typeof import('../../lib/tex')> | null = null;
function loadTex() {
  texModule ??= import('../../lib/tex').catch((e: unknown) => {
    texModule = null;
    throw e;
  });
  return texModule;
}

/**
 * Native MathML: the page's own, or converted from its TeX when that is all
 * it had. Until a conversion lands (or when it fails) the TeX shows as
 * code-styled text; without either, the plain fallback.
 */
export function MathView({ math, display }: { math: InlineMath | MathBlock; display: 'block' | 'inline' }) {
  const ref = useRef<HTMLElement>(null);
  const [converted, setConverted] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const source = math.mathml ?? converted;
  const useMathml = supportsMathml && !!source && !failed;

  useEffect(() => {
    if (!supportsMathml || math.mathml || !math.tex) return;
    let cancelled = false;
    const tex = math.tex;
    loadTex().then(
      (m) => {
        const mathml = m.texToMathml(tex, display === 'block');
        if (!cancelled && mathml) setConverted(mathml);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [math.mathml, math.tex, display]);

  // A formula the page itself set as display math stays one, even inside a paragraph.
  const shown = display === 'inline' && math.mathml && /^\s*<math\b[^>]*\sdisplay\s*=\s*["']?block/i.test(math.mathml) ? 'block' : display;

  useLayoutEffect(() => {
    if (!useMathml || !source) return;
    const node = sanitizeMathml(source, shown);
    if (node) ref.current?.replaceChildren(node);
    else setFailed(true);
  }, [useMathml, source, shown]);

  const Tag = display === 'block' ? 'div' : 'span';
  if (useMathml) return <Tag ref={ref as never} className={`article-math is-${shown}`} />;
  if (math.tex) {
    return (
      <Tag className={`article-math is-${display} is-tex`} title={math.text || undefined}>
        <code>{math.tex}</code>
      </Tag>
    );
  }
  return <Tag className={`article-math is-${display} is-text`}>{math.text}</Tag>;
}
