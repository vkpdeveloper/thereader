import temml from 'temml';

/**
 * TeX to MathML for formulas a page shipped as TeX only, loaded as its own
 * chunk on first use. Null when the TeX does not parse, so the caller keeps
 * showing the source.
 */
export function texToMathml(tex: string, display: boolean): string | null {
  const source = tex
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
    .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
    .replace(/^\$([\s\S]*)\$$/, '$1');
  if (!source.trim()) return null;
  try {
    return temml.renderToString(source, { displayMode: display, throwOnError: true, trust: false });
  } catch {
    return null;
  }
}
