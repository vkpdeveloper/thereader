import temml from 'temml';
import { BoundedCache } from './dom';

/**
 * TeX to MathML for book formulas (temml). The web engine loads this as its
 * own chunk the first time a chapter has TeX; the mobile bundle includes it.
 */

/** Macros common in books converted from LaTeX that temml does not define. */
const MACROS: Record<string, string> = {
  '\\eqdef': '\\overset{\\text{def}}{=}',
  '\\defeq': '\\overset{\\text{def}}{=}',
  '\\mathbbm': '\\mathbb',
  '\\bm': '\\boldsymbol',
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\Q': '\\mathbb{Q}',
  '\\C': '\\mathbb{C}',
  '\\F': '\\mathbb{F}',
  '\\abs': '\\left|#1\\right|',
  '\\norm': '\\left\\lVert#1\\right\\rVert',
  '\\tr': '\\operatorname{tr}',
  '\\rank': '\\operatorname{rank}',
  '\\diag': '\\operatorname{diag}',
  '\\sfT': '\\mathsf{T}',
};

/** Environments temml accepts only in display mode. */
const DISPLAY_ONLY = /\\begin\{(align|alignat|gather|equation|multline|flalign|eqnarray)\*?\}/;

/**
 * Longest TeX rendered. Book formulas run to a few thousand characters; more
 * is a hostile book (temml's output grows with the input, ~16x for flat sums).
 */
export const MAX_TEX = 16000;

/** Rendered markup (null: did not parse), by mode and source. */
const cache = new BoundedCache<string | null>(4000, 8_000_000);

/** Strips `$$…$$`, `\[…\]`, `\(…\)` and `$…$` delimiters. */
export function stripDelimiters(tex: string): string {
  return tex
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
    .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
    .replace(/^\$([\s\S]*)\$$/, '$1')
    .trim();
}

/**
 * MathML markup for `tex`, or null when temml cannot parse it (the caller
 * then keeps the book's own fallback). Inline formulas may wrap after
 * top-level relations so long ones do not overflow the column.
 */
export function texToMathml(tex: string, display: boolean): string | null {
  if (tex.length > MAX_TEX + 8) return null;
  const source = stripDelimiters(tex);
  if (!source) return null;
  const displayMode = display || DISPLAY_ONLY.test(source);
  const key = `${displayMode ? 'D' : 'I'}${source}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let out: string | null;
  try {
    out = temml.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      // temml extends the object on \def; give each call its own copy.
      macros: { ...MACROS },
      wrap: displayMode ? 'none' : 'tex',
      // With the namespace, so it parses as XML (chapters may be XHTML documents).
      xml: true,
    });
  } catch {
    out = null;
  }
  cache.set(key, out, key.length + (out?.length ?? 0));
  return out;
}
