import {
  addClass,
  BoundedCache,
  classOf,
  closest,
  create,
  elements,
  hasClass,
  inProtected,
  isElement,
  isText,
  MATHML_NS,
  nameOf,
  OPS_NS,
  UI_ATTR,
} from './dom';
import { SHADOW_CSS } from './css';
import { isMathElement, needsRebuild, rebuildMathml } from './mathml';

/** TeX to MathML markup (temml with `xml: true`), null when it does not parse. */
export type TexRenderer = (tex: string, display: boolean) => string | null;

/** Host for a rendered formula; its MathML lives in a shadow root. */
export const MATH_HOST = 'tr-math';
const TEX_ATTR = 'data-tr-tex';
/** A rebuilt formula's MathML markup (see mathml.ts), for hosts without TeX. */
const MML_ATTR = 'data-tr-mml';
const DISPLAY_ATTR = 'data-tr-display';
/** Longest rebuilt MathML kept on a host; a larger formula keeps the book's own markup. */
const MAX_MML = 256_000;

// ---------------------------------------------------------------- native MathML

/**
 * Rule 1: keep the book's own MathML. `epub:switch` shows its MathML case
 * and hides the fallback; display formulas get a scroll box so a wide one
 * scrolls instead of overflowing the column. MathML that MathML Core
 * browsers would get wrong (MathML 2 constructs, a missing namespace, an
 * HTML-parsed `m:` prefix) renders from a rebuilt copy in a formula host.
 */
export function prepareMathml(root: Element): number {
  let count = 0;
  for (const sw of [...elements(root, 'switch'), ...elements(root, 'epub:switch')]) {
    if (sw.namespaceURI !== OPS_NS && nameOf(sw) !== 'epub:switch') continue;
    const kids = Array.from(sw.children);
    const mathCase = kids.find(
      (k) => (nameOf(k) === 'case' || nameOf(k) === 'epub:case') && /MathML/i.test(k.getAttribute('required-namespace') ?? ''),
    );
    if (!mathCase || !Array.from(mathCase.getElementsByTagNameNS('*', '*')).some(isMathElement)) continue;
    for (const k of kids) if (k !== mathCase) addClass(k, 'tr-hidden');
    addClass(mathCase, 'tr-switch-case');
    count++;
  }
  const doc = root.ownerDocument;
  for (const math of formulasIn(root)) {
    if (closest(math, (e) => hasClass(e, 'tr-hidden') || e.hasAttribute(UI_ATTR), 32)) continue;
    count++;
    const display = math.getAttribute('display') === 'block' || math.getAttribute('mode') === 'display';
    if (needsRebuild(math)) {
      const markup = mathmlMarkup(rebuildMathml(math, doc));
      if (markup) {
        math.parentNode!.insertBefore(makeMathmlHost(doc, markup, display, math), math);
        addClass(math, 'tr-hidden', 'tr-math-source');
        continue;
      }
    }
    if (!display || math.namespaceURI !== MATHML_NS) continue;
    const parent = math.parentElement;
    if (!parent || hasClass(parent, 'tr-math-scroll')) continue;
    const box = create(doc, 'div', 'tr-math-scroll');
    parent.insertBefore(box, math);
    box.append(math);
  }
  return count;
}

/** Outermost `<math>` elements under `root`, in any namespace or prefix. */
function formulasIn(root: Element): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.getElementsByTagNameNS('*', '*'))) {
    if (!isMathElement(el)) continue;
    const last = out[out.length - 1];
    if (last && last.contains(el)) continue;
    out.push(el);
  }
  return out;
}

/** Serialized MathML for a host, or null when there is none or it is too big. */
export function mathmlMarkup(math: Element | null): string | null {
  if (!math) return null;
  try {
    const markup = new XMLSerializer().serializeToString(math);
    return markup.length <= MAX_MML ? markup : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- TeX in image alt text

/** TeX commands, scripts or groups. */
export const TEX_SIGNAL = /\\[A-Za-z]+|\\[{}|,;:!]|[_^]|\{[^{}]*\}/;
/** Classes of equation containers and equation images in converted books. */
export const MATH_CONTEXT = /(^|[\s_-])(math|maths|equation|eqn|equ|formula|tex|latex|displaymath|inlinemath|inline_math|disp-formula|inline-formula|MathJax\w*)([\s_-]|$)/i;
export const DISPLAY_CONTEXT = /(^|[\s_-])(displaymath|display-math|math-display|equation|eqn|disp-formula|MathJax_SVG_Display|MathJax_Display|MathJax_CHTML_Display|mathblock|math-block)([\s_-]|$)/i;
/** Inline-sized: a height or vertical-align in em/ex, the way TeX-to-image converters size formulas. */
const EM_SIZED = /(height|vertical-align)\s*:\s*-?[\d.]+\s*(em|ex)/i;
/** Real class lists are short; a huge one on a shared ancestor would be scanned once per image. */
export const classMatches = (re: RegExp) => (e: Element) => {
  const cls = classOf(e);
  return cls.length <= 512 && re.test(cls);
};

/**
 * Whether an image is a formula whose alt text is its TeX source. Needs
 * TeX-looking alt text (or a short math token) and either equation context
 * or text-relative sizing; figures whose alt is a file name never match.
 */
export function texOfImage(img: Element): { tex: string; display: boolean } | null {
  const alt = (img.getAttribute('alt') ?? '').trim();
  if (!alt || alt.length > 4000) return null;
  const src = img.getAttribute('src') ?? '';
  const stem = (src.split(/[?#]/)[0].split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '');
  if (stem && alt === stem) return null;
  const context = closest(img, classMatches(MATH_CONTEXT), 5);
  const sized = EM_SIZED.test(img.getAttribute('style') ?? '');
  const signal = TEX_SIGNAL.test(alt);
  const token = alt.length <= 12 && !/[A-Za-z]{3,}/.test(alt) && /^[\w\s+\-=<>()[\]|.,'′*/:;!]+$/.test(alt);
  if (!(signal || token) || !(context || sized)) return null;
  // A one-word alt with an underscore and no other TeX is a file name ("number_line").
  if (signal && /^[A-Za-z][\w-]*$/.test(alt) && /[A-Za-z]{3,}_|_[A-Za-z]{3,}/.test(alt)) return null;
  const display = !!closest(img, classMatches(DISPLAY_CONTEXT), 5);
  return { tex: alt, display };
}

/**
 * Rule 2: formula images whose alt is TeX get a rendered twin. The image
 * stays in the DOM (hidden) and keeps showing if TeX does not parse.
 */
export function prepareTexImages(root: Element, tex: TexRenderer): number {
  let count = 0;
  for (const img of Array.from(root.getElementsByTagNameNS('*', 'img'))) {
    if (hasClass(img, 'tr-hidden') || inProtected(img)) continue;
    const found = texOfImage(img);
    if (!found || tex(found.tex, found.display) === null) continue;
    const host = makeHost(root.ownerDocument, found.tex, found.display);
    img.parentNode!.insertBefore(host, img);
    addClass(img, 'tr-hidden', 'tr-math-source');
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- raw TeX

const MATH_SPAN = /(^|\s)math(\s|$)/;
const MAX_DELIMITED = 4000;

export interface Delimited {
  index: number;
  /** The formula with its delimiters. */
  source: string;
  body: string;
  display: boolean;
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** First entry of the ascending `list` at or after `at`, or -1. */
function firstFrom(list: number[], at: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : -1;
}

/**
 * `$$…$$`, `\[…\]` or `\(…\)` inside one text node, bodies of 1 to 4000
 * characters (no `$` in a `$$` body), leftmost-shortest: what
 * `/\$\$([^$]{1,4000}?)\$\$|\\\[([\s\S]{1,4000}?)\\\]|\\\(([\s\S]{1,4000}?)\\\)/g` finds. A
 * scan with closers looked up by binary search, since that regex rescans up to
 * 4000 characters at every unclosed opener.
 */
export function findDelimited(text: string): Delimited[] {
  const out: Delimited[] = [];
  const dollars = occurrences(text, '$');
  const closers: Record<string, number[]> = { '\\[': occurrences(text, '\\]'), '\\(': occurrences(text, '\\)') };
  const opens = [...occurrences(text, '$$'), ...occurrences(text, '\\['), ...occurrences(text, '\\(')].sort((a, b) => a - b);
  let cursor = 0;
  for (const i of opens) {
    if (i < cursor) continue;
    const open = text.slice(i, i + 2);
    // The closer: for `$$` the first `$` after the opener, which must start `$$`.
    const end = open === '$$' ? firstFrom(dollars, i + 2) : firstFrom(closers[open], i + 3);
    const length = end - i - 2;
    if (end < 0 || length < 1 || length > MAX_DELIMITED || (open === '$$' && text[end + 1] !== '$')) continue;
    out.push({ index: i, source: text.slice(i, end + 2), body: text.slice(i + 2, end), display: open !== '\\(' });
    cursor = end + 2;
  }
  return out;
}

/**
 * Rule 3: TeX a book left for MathJax. Pandoc's `span.math`, MathJax
 * `script type=math/tex` and delimited TeX in text. The source stays (hidden)
 * so book text and highlight offsets are unchanged.
 */
export function prepareRawTex(root: Element, tex: TexRenderer): number {
  const doc = root.ownerDocument;
  let count = 0;
  for (const span of Array.from(root.getElementsByTagNameNS('*', 'span'))) {
    const cls = classOf(span);
    if (!MATH_SPAN.test(cls) || !/(^|\s)(inline|display)(\s|$)/.test(cls) || inProtected(span.parentElement ?? span)) continue;
    if (span.getElementsByTagNameNS(MATHML_NS, 'math').length || hasClass(span, 'tr-hidden')) continue;
    const display = /(^|\s)display(\s|$)/.test(cls);
    const source = span.textContent ?? '';
    if (tex(source, display) === null) continue;
    span.parentNode!.insertBefore(makeHost(doc, source, display), span.nextSibling);
    addClass(span, 'tr-hidden', 'tr-math-source');
    count++;
  }
  for (const script of Array.from(root.getElementsByTagNameNS('*', 'script'))) {
    const type = (script.getAttribute('type') ?? '').toLowerCase();
    // Sources whose rendered output already shows (see formats.ts) are done.
    if (!type.startsWith('math/tex') || hasClass(script, 'tr-math-source')) continue;
    const prev = script.previousSibling;
    if (isElement(prev) && prev.hasAttribute(UI_ATTR)) continue;
    const display = /mode\s*=\s*display/.test(type);
    const source = script.textContent ?? '';
    if (tex(source, display) === null) continue;
    script.parentNode!.insertBefore(makeHost(doc, source, display), script);
    // MathJax previews duplicate the formula as plain text. A page MathJax
    // already typeset has its output span between the preview and the script.
    const preview = mathJaxPreview(script.previousElementSibling);
    if (preview) addClass(preview, 'tr-hidden', 'tr-math-source');
    count++;
  }
  count += prepareDelimitedTex(root, tex);
  return count;
}

function prepareDelimitedTex(root: Element, tex: TexRenderer): number {
  const doc = root.ownerDocument;
  let count = 0;
  const candidates: Text[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (isText(c)) {
        if (/\$\$|\\\[|\\\(/.test(c.data)) candidates.push(c);
      } else if (isElement(c)) {
        const name = nameOf(c);
        if (name === 'pre' || name === 'code' || name === 'math' || name === 'script' || name === 'style' || name === 'textarea') continue;
        if (c.hasAttribute(UI_ATTR) || hasClass(c, 'tr-math-source')) continue;
        walk(c);
      }
    }
  };
  walk(root);
  for (const node of candidates) {
    let current: Text = node;
    let consumed = 0;
    for (const m of findDelimited(node.data)) {
      if (!TEX_SIGNAL.test(m.body) && m.body.trim().length > 3) continue;
      if (tex(m.source, m.display) === null) continue;
      // Split the text node around the formula; the pieces keep the same characters.
      const start = m.index - consumed;
      const source = start > 0 ? current.splitText(start) : current;
      const rest = source.splitText(m.source.length);
      const wrap = create(doc, 'span', 'tr-hidden tr-math-source');
      source.parentNode!.insertBefore(wrap, source);
      wrap.append(source);
      wrap.parentNode!.insertBefore(makeHost(doc, m.source, m.display), wrap.nextSibling);
      consumed = m.index + m.source.length;
      current = rest;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- hosts

export function makeHost(doc: Document, tex: string, display: boolean): HTMLElement {
  const host = emptyHost(doc, display);
  host.setAttribute(TEX_ATTR, tex);
  host.setAttribute('aria-label', tex);
  return host;
}

/** A host for rebuilt MathML; `source` is the element it stands for (its text labels the host). */
export function makeMathmlHost(doc: Document, markup: string, display: boolean, source: Element | null): HTMLElement {
  const host = emptyHost(doc, display);
  host.setAttribute(MML_ATTR, markup);
  const label = source?.getAttribute('alttext') ?? (source?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (label) host.setAttribute('aria-label', label.slice(0, 300));
  return host;
}

function emptyHost(doc: Document, display: boolean): HTMLElement {
  const host = create(doc, display ? 'div' : 'span', display ? `${MATH_HOST} tr-math-display` : MATH_HOST);
  host.setAttribute(UI_ATTR, '');
  if (display) host.setAttribute(DISPLAY_ATTR, '');
  host.setAttribute('role', 'math');
  return host;
}

/** The `MathJax_Preview` one or two element siblings before `el` (the host or MathJax's output span sits between). */
function mathJaxPreview(el: Element | null): Element | null {
  for (let sib = el?.previousElementSibling ?? null, i = 0; sib && i < 2; sib = sib.previousElementSibling, i++) {
    if (hasClass(sib, 'MathJax_Preview')) return sib;
  }
  return null;
}

/** Parsed, scrubbed formulas (null: none), by mode and source. */
const templates = new BoundedCache<Element | null>(4000, 4_000_000);
const sheets = new WeakMap<Document, CSSStyleSheet | null>();

/**
 * Renders every formula host under `root` into its own shadow root. Shadow
 * content is not part of `textContent`, so book text, search and highlight
 * offsets (web and Readium alike) are exactly what they were without it.
 * Runs on the live document: shadow roots are not cloned with their host.
 */
export function hydrateMath(root: Element, tex: TexRenderer): number {
  const doc = root.ownerDocument;
  let count = 0;
  for (const host of Array.from(root.querySelectorAll(`.${MATH_HOST}[${UI_ATTR}]`))) {
    // Hosts the enhancer made are empty; a look-alike in the book keeps its content.
    if ((host as HTMLElement).shadowRoot || host.firstChild || !(host.hasAttribute(TEX_ATTR) || host.hasAttribute(MML_ATTR))) continue;
    try {
      if (hydrateHost(doc, host, tex)) count++;
    } catch {
      // One formula failing leaves the rest (and the chapter) as they are.
    }
  }
  return count;
}

function hydrateHost(doc: Document, host: Element, tex: TexRenderer): boolean {
  const display = host.hasAttribute(DISPLAY_ATTR);
  const mml = host.getAttribute(MML_ATTR);
  const math = mml !== null ? mathmlElement(doc, mml) : mathElement(doc, host.getAttribute(TEX_ATTR) ?? '', display, tex);
  if (!math) {
    // Prepared but not renderable here: show the book's own version again.
    for (const sib of [host.previousElementSibling, host.nextElementSibling, mathJaxPreview(host)]) {
      if (sib && hasClass(sib, 'tr-math-source')) sib.classList.remove('tr-hidden');
    }
    return false;
  }
  let shadow: ShadowRoot | null = null;
  try {
    shadow = (host as HTMLElement).attachShadow({ mode: 'open' });
  } catch {
    shadow = null;
  }
  if (shadow) {
    adoptStyles(doc, shadow);
    shadow.append(math);
  } else {
    // No shadow DOM: light DOM under the UI marker, still skipped by the web TextIndex.
    host.append(math);
  }
  return true;
}

function mathElement(doc: Document, source: string, display: boolean, tex: TexRenderer): Element | null {
  const key = `${display ? 'D' : 'I'}${source}`;
  let template = templates.get(key);
  if (template === undefined) {
    const markup = tex(source, display);
    template = markup ? parseMathml(markup) : null;
    templates.set(key, template, key.length + (markup?.length ?? 0));
  }
  return template ? (doc.importNode(template, true) as Element) : null;
}

function mathmlElement(doc: Document, markup: string): Element | null {
  const key = `M${markup}`;
  let template = templates.get(key);
  if (template === undefined) {
    template = markup.length <= MAX_MML ? parseMathml(markup) : null;
    templates.set(key, template, key.length);
  }
  return template ? (doc.importNode(template, true) as Element) : null;
}

/** Parsed and scrubbed MathML, or null. */
export function parseMathml(markup: string): Element | null {
  const parsed = new DOMParser().parseFromString(markup, 'application/xml');
  const el = parsed.documentElement;
  return el && !parsed.getElementsByTagName('parsererror').length && scrubMathml(el) ? el : null;
}

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * Rendered formulas are inserted after the web sanitizer ran, and on mobile
 * into the book's own page, so their markup is checked here as well as by
 * temml's `trust: false`: MathML elements only, no links (`\ref` makes
 * `<a href="#…">`), no handlers or other URLs. False when the root is not MathML.
 */
export function scrubMathml(math: Element): boolean {
  if (math.namespaceURI !== MATHML_NS || nameOf(math) !== 'math') return false;
  for (const el of [math, ...Array.from(math.getElementsByTagNameNS('*', '*'))]) {
    if (el !== math && (el.namespaceURI !== MATHML_NS || nameOf(el) === 'annotation-xml')) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const n = a.localName.toLowerCase();
      if (n.startsWith('on') || n === 'href' || n === 'src' || (a.namespaceURI && a.namespaceURI !== XMLNS_NS)) {
        el.removeAttributeNode(a);
      }
    }
  }
  return true;
}

function adoptStyles(doc: Document, shadow: ShadowRoot): void {
  let sheet = sheets.get(doc);
  if (sheet === undefined) {
    sheet = null;
    try {
      const Ctor = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet;
      if (Ctor && 'adoptedStyleSheets' in shadow) {
        sheet = new Ctor();
        sheet.replaceSync(SHADOW_CSS);
      }
    } catch {
      sheet = null;
    }
    sheets.set(doc, sheet);
  }
  if (sheet) {
    shadow.adoptedStyleSheets = [sheet];
    return;
  }
  const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.textContent = SHADOW_CSS;
  shadow.append(style);
}
