import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { grammarFor } from '../../lib/codeLanguages';
import { themeDeclarations, type EnhanceTheme } from './css';
import { darkPage, ENHANCE_VERSION, enhanceContent, fitBlocks, hydrateMath, isPaginated, UI_ATTR, watchInk, type EnhanceReport, type Highlighted } from './index';
import { texToMathml } from './tex';

/**
 * Mobile entry, built into apps/mobile/assets/reader/enhance.js by
 * scripts/build-enhance-bundle.ts. Loaded by every chapter of the enhanced
 * EPUB copy Readium opens; runs the same rules as the web engine on the
 * original XHTML, synchronously enough to finish before Readium paginates.
 *
 * Contract: `globalThis.TheReaderEnhance = { version, enhance, setTheme }`.
 * `enhance` is idempotent and never throws.
 */

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, php, python, r, ruby, rust, scala, shell, sql, swift, typescript,
  xml, yaml,
};
for (const [name, fn] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, fn);
/** Same candidates and confidence rule as the web highlighter (src/lib/highlight.ts). */
const DETECTABLE = ['javascript', 'typescript', 'python', 'bash', 'json', 'xml', 'css', 'go', 'rust', 'java', 'cpp', 'csharp', 'sql', 'yaml', 'ruby', 'php'];

function highlight(code: string, language: string | null): Highlighted | null {
  if (language) {
    const name = grammarFor(language);
    if (!name || !hljs.getLanguage(name)) return null;
    return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language };
  }
  if (code.trim().length < 12) return null;
  const result = hljs.highlightAuto(code, DETECTABLE);
  const runnerUp = result.secondBest?.relevance ?? 0;
  if (!result.language || result.relevance < 10 || result.relevance < runnerUp * 1.4) return null;
  return { html: result.value, language: result.language };
}

const started = new WeakSet<Document>();

/** Enhances a chapter document. Resolves with what changed, or null when it did nothing or failed. */
async function enhance(doc: Document = document, _options: { mode?: 'readium' } = {}): Promise<EnhanceReport | null> {
  try {
    const root = doc.body;
    if (!root || started.has(doc)) return null;
    started.add(doc);
    const report = await enhanceContent(doc, root, { tex: texToMathml, highlight }, doc.documentElement);
    hydrateMath(root, texToMathml);
    watch(doc, root);
    return report;
  } catch {
    return null;
  }
}

/** Keeps dark-ink images and tall blocks right as Readium changes theme, font size or pagination. */
function watch(doc: Document, root: Element): void {
  const view = doc.defaultView;
  if (!view) return;
  let stopInk: (() => void) | null = null;
  let dark: boolean | null = null;
  let timer = 0;
  const update = () => {
    timer = 0;
    try {
      const nowDark = darkPage(doc);
      if (nowDark !== dark) {
        dark = nowDark;
        stopInk?.();
        stopInk = null;
        if (dark) stopInk = watchInk(root);
        else for (const img of Array.from(root.querySelectorAll('.tr-ink'))) img.classList.remove('tr-ink');
      }
      fitBlocks(root, isPaginated(doc) ? doc.documentElement.clientHeight : null);
    } catch {
      // Best effort; the content is readable without it.
    }
  };
  const schedule = () => {
    if (!timer) timer = view.setTimeout(update, 120);
  };
  update();
  view.addEventListener('resize', schedule);
  view.addEventListener('load', schedule);
  // ReadiumCSS applies reader settings as custom properties on <html>.
  new view.MutationObserver(schedule).observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  doc.fonts?.addEventListener?.('loadingdone', schedule);
}

const themeStyles = new WeakMap<Document, Element>();

/** Theme colours for code panels and syntax (`--tr-*`); call again when the theme changes. */
function setTheme(theme: EnhanceTheme, doc: Document = document): void {
  try {
    // Only our own element: a book's `id="tr-theme"` must not have its text replaced.
    let style = themeStyles.get(doc);
    if (!style?.isConnected) {
      style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.setAttribute(UI_ATTR, '');
      (doc.head ?? doc.documentElement).append(style);
      themeStyles.set(doc, style);
    }
    style.textContent = `:root{${themeDeclarations(theme ?? {})}}`;
  } catch {
    // Ignore: the stylesheet falls back to mixes of the text colour.
  }
}

const api = { version: ENHANCE_VERSION, enhance, setTheme };
try {
  // Nothing outside the page calls this; a book script that took the name first only loses the handle.
  (globalThis as unknown as { TheReaderEnhance: typeof api }).TheReaderEnhance = api;
} catch {
  // Still enhance below.
}

if (typeof document !== 'undefined') {
  const start = () => void enhance(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
