import {
  addClass,
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

/** TeX to MathML markup (temml with `xml: true`), null when it does not parse. */
export type TexRenderer = (tex: string, display: boolean) => string | null;

/** Host for a rendered formula; its MathML lives in a shadow root. */
export const MATH_HOST = 'tr-math';
const TEX_ATTR = 'data-tr-tex';
const DISPLAY_ATTR = 'data-tr-display';

// ---------------------------------------------------------------- native MathML

/**
 * Rule 1: keep the book's own MathML. `epub:switch` shows its MathML case
 * and hides the fallback; display formulas get a scroll box so a wide one
 * scrolls instead of overflowing the column.
 */
export function prepareMathml(root: Element): number {
  let count = 0;
  for (const sw of [...elements(root, 'switch'), ...elements(root, 'epub:switch')]) {
    if (sw.namespaceURI !== OPS_NS && nameOf(sw) !== 'epub:switch') continue;
    const kids = Array.from(sw.children);
    const mathCase = kids.find(
      (k) => (nameOf(k) === 'case' || nameOf(k) === 'epub:case') && /MathML/i.test(k.getAttribute('required-namespace') ?? ''),
    );
    if (!mathCase || !mathCase.getElementsByTagNameNS(MATHML_NS, 'math').length) continue;
    for (const k of kids) if (k !== mathCase) addClass(k, 'tr-hidden');
    addClass(mathCase, 'tr-switch-case');
    count++;
  }
  for (const math of Array.from(root.getElementsByTagNameNS(MATHML_NS, 'math'))) {
    count++;
    if (math.getAttribute('display') !== 'block') continue;
    const parent = math.parentElement;
    if (!parent || hasClass(parent, 'tr-math-scroll')) continue;
    const box = create(root.ownerDocument, 'div', 'tr-math-scroll');
    parent.insertBefore(box, math);
    box.append(math);
  }
  return count;
}

// ---------------------------------------------------------------- TeX in image alt text

/** TeX commands, scripts or groups. */
const TEX_SIGNAL = /\\[A-Za-z]+|\\[{}|,;:!]|[_^]|\{[^}]*\}/;
/** Classes of equation containers and equation images in converted books. */
const MATH_CONTEXT = /(^|[\s_-])(math|maths|equation|eqn|equ|formula|tex|latex|displaymath|inlinemath|inline_math|disp-formula|inline-formula|MathJax\w*)([\s_-]|$)/i;
const DISPLAY_CONTEXT = /(^|[\s_-])(displaymath|display-math|math-display|equation|eqn|disp-formula|MathJax_SVG_Display|MathJax_Display|MathJax_CHTML_Display|mathblock|math-block)([\s_-]|$)/i;
/** Inline-sized: a height or vertical-align in em/ex, the way TeX-to-image converters size formulas. */
const EM_SIZED = /(height|vertical-align)\s*:\s*-?[\d.]+\s*(em|ex)/i;

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
  const context = closest(img, (e) => MATH_CONTEXT.test(classOf(e)), 5);
  const sized = EM_SIZED.test(img.getAttribute('style') ?? '');
  const signal = TEX_SIGNAL.test(alt);
  const token = alt.length <= 12 && !/[A-Za-z]{3,}/.test(alt) && /^[\w\s+\-=<>()[\]|.,'′*/:;!]+$/.test(alt);
  if (!(signal || token) || !(context || sized)) return null;
  // A one-word alt with an underscore and no other TeX is a file name ("number_line").
  if (signal && /^[A-Za-z][\w-]*$/.test(alt) && /[A-Za-z]{3,}_|_[A-Za-z]{3,}/.test(alt)) return null;
  const display = !!closest(img, (e) => DISPLAY_CONTEXT.test(classOf(e)), 5);
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
/** `$$…$$`, `\[…\]` or `\(…\)` inside one text node. */
const DELIMITED = /\$\$([^$]{1,4000}?)\$\$|\\\[([\s\S]{1,4000}?)\\\]|\\\(([\s\S]{1,4000}?)\\\)/g;

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
    if (!type.startsWith('math/tex')) continue;
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
    DELIMITED.lastIndex = 0;
    const matches = Array.from(node.data.matchAll(DELIMITED));
    let consumed = 0;
    for (const m of matches) {
      const body = m[1] ?? m[2] ?? m[3] ?? '';
      if (!TEX_SIGNAL.test(body) && body.trim().length > 3) continue;
      const display = m[1] !== undefined || m[2] !== undefined;
      if (tex(m[0], display) === null) continue;
      // Split the text node around the formula; the pieces keep the same characters.
      const start = m.index! - consumed;
      const source = start > 0 ? current.splitText(start) : current;
      const rest = source.splitText(m[0].length);
      const wrap = create(doc, 'span', 'tr-hidden tr-math-source');
      source.parentNode!.insertBefore(wrap, source);
      wrap.append(source);
      wrap.parentNode!.insertBefore(makeHost(doc, m[0], display), wrap.nextSibling);
      consumed = m.index! + m[0].length;
      current = rest;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- hosts

function makeHost(doc: Document, tex: string, display: boolean): HTMLElement {
  const host = create(doc, display ? 'div' : 'span', display ? `${MATH_HOST} tr-math-display` : MATH_HOST);
  host.setAttribute(UI_ATTR, '');
  host.setAttribute(TEX_ATTR, tex);
  if (display) host.setAttribute(DISPLAY_ATTR, '');
  host.setAttribute('role', 'math');
  host.setAttribute('aria-label', tex);
  return host;
}

/** The `MathJax_Preview` one or two element siblings before `el` (the host or MathJax's output span sits between). */
function mathJaxPreview(el: Element | null): Element | null {
  for (let sib = el?.previousElementSibling ?? null, i = 0; sib && i < 2; sib = sib.previousElementSibling, i++) {
    if (hasClass(sib, 'MathJax_Preview')) return sib;
  }
  return null;
}

const templates = new Map<string, Element | null>();
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
  for (const host of Array.from(root.querySelectorAll(`.${MATH_HOST}[${TEX_ATTR}]`))) {
    if ((host as HTMLElement).shadowRoot || host.querySelector('math')) continue;
    const source = host.getAttribute(TEX_ATTR) ?? '';
    const display = host.hasAttribute(DISPLAY_ATTR);
    const math = mathElement(doc, source, display, tex);
    if (!math) {
      // Prepared but not renderable here: show the book's own version again.
      for (const sib of [host.previousElementSibling, host.nextElementSibling, mathJaxPreview(host)]) {
        if (sib && hasClass(sib, 'tr-math-source')) sib.classList.remove('tr-hidden');
      }
      continue;
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
    count++;
  }
  return count;
}

function mathElement(doc: Document, source: string, display: boolean, tex: TexRenderer): Element | null {
  const key = `${display ? 'D' : 'I'}${source}`;
  let template = templates.get(key);
  if (template === undefined) {
    template = null;
    const markup = tex(source, display);
    if (markup) {
      const parsed = new DOMParser().parseFromString(markup, 'application/xml');
      const el = parsed.documentElement;
      if (el && el.namespaceURI === MATHML_NS && !parsed.getElementsByTagName('parsererror').length) template = el;
    }
    if (templates.size > 4000) templates.delete(templates.keys().next().value as string);
    templates.set(key, template);
  }
  return template ? (doc.importNode(template, true) as Element) : null;
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
