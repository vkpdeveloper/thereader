import { enhanceContent, needs, type EnhanceReport, type TexRenderer } from './index';

/**
 * The web engine's entry: runs the enhancer on a parsed chapter, loading
 * temml and highlight.js as their own chunks only when the chapter has TeX or
 * code. Returns the TeX renderer for `hydrateMath` at mount time.
 */
export async function enhanceChapter(doc: Document, body: Element): Promise<{ tex: TexRenderer | null; report: EnhanceReport | null }> {
  try {
    const need = needs(doc, body);
    const [tex, highlight] = await Promise.all([
      need.tex ? import('./tex').then((m) => m.texToMathml, () => null) : null,
      need.code ? import('../../lib/highlight').then((m) => m.highlightCode, () => null) : null,
    ]);
    const report = await enhanceContent(doc, body, { tex, highlight });
    return { tex: report.math > 0 ? tex : null, report };
  } catch {
    return { tex: null, report: null };
  }
}
