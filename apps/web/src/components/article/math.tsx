import { useLayoutEffect, useRef, useState } from 'react';
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

const supportsMathml = typeof window !== 'undefined' && 'MathMLElement' in window;

/**
 * Rebuilds a `<math>` tree from MathML presentation elements and attributes
 * only: no links, styles, event handlers or embedded HTML survive.
 */
export function sanitizeMathml(source: string, display: 'block' | 'inline'): Element | null {
  const parsed = new DOMParser().parseFromString(source, 'text/html').querySelector('math');
  if (!parsed) return null;
  const copy = (node: Element): Element | null => {
    const name = node.localName.toLowerCase();
    if (!elements.has(name)) return null;
    const out = document.createElementNS(MATHML_NS, name);
    for (const attr of Array.from(node.attributes)) {
      if (attributes.has(attr.name.toLowerCase())) out.setAttribute(attr.name.toLowerCase(), attr.value);
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
  math?.setAttribute('display', display);
  return math;
}

/** Native MathML when the page had it, else the TeX source as code-styled text, else the plain fallback. */
export function MathView({ math, display }: { math: InlineMath | MathBlock; display: 'block' | 'inline' }) {
  const ref = useRef<HTMLElement>(null);
  const [failed, setFailed] = useState(false);
  const useMathml = supportsMathml && !!math.mathml && !failed;

  useLayoutEffect(() => {
    if (!useMathml || !math.mathml) return;
    const node = sanitizeMathml(math.mathml, display);
    if (node) ref.current?.replaceChildren(node);
    else setFailed(true);
  }, [useMathml, math.mathml, display]);

  const Tag = display === 'block' ? 'div' : 'span';
  if (useMathml) return <Tag ref={ref as never} className={`article-math is-${display}`} />;
  if (math.tex) {
    return (
      <Tag className={`article-math is-${display} is-tex`} title={math.text || undefined}>
        <code>{math.tex}</code>
      </Tag>
    );
  }
  return <Tag className={`article-math is-${display} is-text`}>{math.text}</Tag>;
}
