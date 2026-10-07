import temml from 'temml';

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

const cache = new Map<string, string | null>();
const CACHE_LIMIT = 4000;

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
  const source = stripDelimiters(tex);
  if (!source) return null;
  const displayMode = display || DISPLAY_ONLY.test(source);
  const key = `${displayMode ? 'D' : 'I'}${source}`;
  if (cache.has(key)) return cache.get(key)!;
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
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}
