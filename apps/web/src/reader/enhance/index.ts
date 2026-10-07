import { prepareCode, type Highlighter } from './code';
import { ENHANCED_ATTR } from './dom';
import { isGarbledMath, prepareGarbled } from './garbled';
import { prepareMathml, prepareRawTex, prepareTexImages, texOfImage, type TexRenderer } from './math';
import { preparePdf } from './pdf';
import { prepareTables } from './tables';

/**
 * The content enhancer: one set of DOM rules that makes math, code, tables
 * and badly converted books readable, shared by the web engine (on each
 * chapter as it is prepared) and by mobile Readium (as the self-contained
 * bundle in apps/mobile/assets/reader, built by scripts/build-enhance-bundle.ts).
 *
 * Invariant: the chapter's text — the concatenation of its text nodes that
 * highlights, search and Readium's text quotes index into — is unchanged.
 * Original nodes are hidden, never removed or reordered; inserted elements
 * carry no text, or keep it in a shadow root under a `data-tr-ui` host.
 */

/**
 * Bump whenever the output changes (rules, CSS, bundled libraries): mobile
 * keys its enhanced copy of each EPUB on it.
 */
export const ENHANCE_VERSION = '3';

export { UI_ATTR, ENHANCED_ATTR } from './dom';
export { enhanceCss, themeDeclarations, MATH_FONT_FILE, type EnhanceTheme } from './css';
export { fitBlocks, isPaginated, type Highlighter, type Highlighted } from './code';
export { hydrateMath, type TexRenderer } from './math';
export { watchInk, darkPage, type InkVerdict } from './ink';

export interface EnhanceDeps {
  /** TeX → MathML; null skips the TeX rules (the web engine loads it only when needed). */
  tex: TexRenderer | null;
  highlight: Highlighter | null;
}

export interface EnhanceReport {
  math: number;
  code: number;
  tables: number;
  pdf: number;
}

const RAW_TEX = /\$\$|\\\(|\\\[/;

/** What a chapter needs loaded before `enhanceContent`, cheaply. */
export function needs(doc: Document, root: Element): { tex: boolean; code: boolean } {
  let tex = RAW_TEX.test(root.textContent ?? '');
  if (!tex) {
    for (const span of Array.from(root.getElementsByTagNameNS('*', 'span'))) {
      if (/(^|\s)math(\s|$)/.test(span.getAttribute('class') ?? '')) {
        tex = true;
        break;
      }
    }
  }
  if (!tex) {
    for (const s of Array.from(doc.getElementsByTagNameNS('*', 'script'))) {
      if ((s.getAttribute('type') ?? '').toLowerCase().startsWith('math/tex')) {
        tex = true;
        break;
      }
    }
  }
  if (!tex) {
    for (const img of Array.from(root.getElementsByTagNameNS('*', 'img'))) {
      if (texOfImage(img)) {
        tex = true;
        break;
      }
    }
  }
  if (!tex) tex = isGarbledMath(doc, root);
  return { tex, code: root.getElementsByTagNameNS('*', 'pre').length > 0 };
}

/**
 * Runs the structural rules on a chapter (before it is shown). Idempotent:
 * a second call on the same root does nothing. Formulas are only prepared
 * here; `hydrateMath` renders them on the live document.
 */
export async function enhanceContent(doc: Document, root: Element, deps: EnhanceDeps, marker: Element = root): Promise<EnhanceReport> {
  const report: EnhanceReport = { math: 0, code: 0, tables: 0, pdf: 0 };
  if (marker.hasAttribute(ENHANCED_ATTR)) return report;
  marker.setAttribute(ENHANCED_ATTR, ENHANCE_VERSION);
  const run = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  report.pdf = run(() => preparePdf(doc, root), 0);
  report.math = run(() => prepareMathml(root), 0);
  if (deps.tex) {
    const tex = deps.tex;
    // After the PDF rule: whether a line was joined into a paragraph decides inline or display.
    report.math += run(() => prepareGarbled(doc, root), 0);
    report.math += run(() => prepareRawTex(root, tex), 0);
    report.math += run(() => prepareTexImages(root, tex), 0);
  }
  report.tables = run(() => prepareTables(root), 0);
  try {
    report.code = await prepareCode(root, deps.highlight);
  } catch {
    // Unhighlighted code is still styled by the stylesheet.
  }
  return report;
}
