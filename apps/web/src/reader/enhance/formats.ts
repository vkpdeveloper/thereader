import { addClass, BLOCKS, classOf, closest, create, hasClass, isElement, nameOf, UI_ATTR } from './dom';
import { classMatches, DISPLAY_CONTEXT, makeHost, makeMathmlHost, mathmlMarkup, TEX_SIGNAL, type TexRenderer } from './math';
import { isMathElement, rebuildMathml } from './mathml';

/**
 * Rule 1b: formulas that typesetting libraries already rendered. Without
 * the library's stylesheet and fonts a KaTeX or MathJax rendering shows
 * twice (its MathML and its glyph soup) or as garbage, so the best source it
 * carries is shown instead: its MathML (KaTeX's `.katex-mathml`, MathJax's
 * assistive MathML or `data-mathml`), else its TeX (`data-tex` and friends,
 * MathJax's `script` sources). Everything else stays, hidden.
 *
 * Also here: images embedded with `<object>`/`<embed>` become images the ink
 * rule can see.
 */
export function prepareFormats(root: Element, tex: TexRenderer | null): number {
  let count = 0;
  const run = (fn: () => number) => {
    try {
      count += fn();
    } catch {
      // One construct failing leaves the rest as they are.
    }
  };
  run(() => prepareKatex(root));
  run(() => prepareMathJax(root));
  run(() => prepareMathScripts(root));
  run(() => prepareDataAttributes(root, tex));
  run(() => prepareObjects(root));
  return count;
}

/** Shows an element a library hid for screen readers only (`.tr-shown` undoes the clipping). */
function show(el: Element): void {
  addClass(el, 'tr-shown');
}

function hide(el: Element): void {
  addClass(el, 'tr-hidden');
}

/** A `<math>` inside `el`, looking at no more than a formula's worth of elements. */
function hasMath(el: Element): boolean {
  const stack: Element[] = [el];
  for (let seen = 0; stack.length && seen < 20000; seen++) {
    const e = stack.pop()!;
    if (e !== el && isMathElement(e)) return true;
    for (let c = e.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
  }
  return false;
}

/** MathJax 2 frames this pass dealt with (their `data-mathml` is not rendered again). */
const done = new WeakSet<Element>();

function handled(el: Element): boolean {
  return !!closest(el, (e) => hasClass(e, 'tr-hidden') || hasClass(e, 'tr-shown') || e.hasAttribute(UI_ATTR), 32);
}

// ---------------------------------------------------------------- KaTeX

/** `.katex` = `.katex-mathml` (MathML with a TeX annotation) + `.katex-html` (needs KaTeX's CSS and fonts). */
function prepareKatex(root: Element): number {
  let count = 0;
  for (const katex of Array.from(root.getElementsByClassName('katex'))) {
    if (handled(katex)) continue;
    let mathml: Element | null = null;
    let html: Element | null = null;
    for (let c = katex.firstElementChild; c; c = c.nextElementSibling) {
      if (hasClass(c, 'katex-mathml')) mathml = c;
      else if (hasClass(c, 'katex-html')) html = c;
    }
    if (!mathml || !hasMath(mathml)) continue;
    show(mathml);
    if (html) hide(html);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- MathJax

/** MathJax 2 output frames (`<span id="MathJax-Element-3-Frame">`) by output jax. */
const MJ2_FRAME = /(^|\s)(MathJax|MathJax_CHTML|MathJax_SVG|MathJax_PHTML|MathJax_MathML|mjx-chtml)(\s|$)/;
const MJ2_DISPLAY = /(^|\s)(MathJax_Display|MathJax_SVG_Display|MJXc-display|MathJax_MathML_Display)(\s|$)/;

function prepareMathJax(root: Element): number {
  let count = 0;
  // MathJax 3: <mjx-container> holding <mjx-math> (CHTML) or <svg>, and <mjx-assistive-mml>.
  for (const container of Array.from(root.getElementsByTagNameNS('*', 'mjx-container'))) {
    if (handled(container)) continue;
    const assistive = Array.from(container.children).find((c) => nameOf(c) === 'mjx-assistive-mml');
    if (!assistive || !hasMath(assistive)) continue;
    for (const c of Array.from(container.children)) if (c !== assistive) hide(c);
    show(assistive);
    count++;
  }
  // MathJax 2: a frame per formula, a preview before it and its source script after it.
  for (const frame of Array.from(root.getElementsByTagNameNS('*', '*'))) {
    if (!/-Frame$/.test(frame.getAttribute('id') ?? '') || !MJ2_FRAME.test(classOf(frame)) || handled(frame)) continue;
    const outer = frame.parentElement && MJ2_DISPLAY.test(classOf(frame.parentElement)) ? frame.parentElement : frame;
    const script = sourceScript(outer);
    const preview = outer.previousElementSibling && hasClass(outer.previousElementSibling, 'MathJax_Preview') ? outer.previousElementSibling : null;
    const assistive = Array.from(frame.children).find((c) => hasClass(c, 'MJX_Assistive_MathML'));
    const display = outer !== frame || hasClass(frame, 'MathJax_SVG_Display');
    done.add(frame);
    if (assistive && hasMath(assistive)) {
      for (const c of Array.from(frame.children)) if (c !== assistive) hide(c);
      show(assistive);
    } else {
      const source = parseMarkup(frame.getAttribute('data-mathml') ?? '');
      const markup = source && mathmlMarkup(rebuildMathml(source, frame.ownerDocument));
      if (markup) outer.parentNode!.insertBefore(makeMathmlHost(frame.ownerDocument, markup, display, source), outer);
      // Nothing better to show: the frame stays.
      else if (!script) continue;
      hide(outer);
      if (!markup) {
        // The TeX rule renders the script (and hides the preview).
        count++;
        continue;
      }
    }
    if (preview) hide(preview);
    // The script source would render the formula a second time.
    if (script) addClass(script, 'tr-math-source');
    count++;
  }
  return count;
}

/** The `script type=math/…` right after a MathJax 2 frame (the frame is inserted before its script). */
function sourceScript(outer: Element): Element | null {
  const next = outer.nextElementSibling;
  return next && nameOf(next) === 'script' && /^math\//i.test(next.getAttribute('type') ?? '') ? next : null;
}

/** Longest book MathML string parsed. */
const MAX_SOURCE = 64_000;

/**
 * A MathML string from the book (an attribute or a script), parsed in an
 * inert document. Null when it is not MathML. Only `rebuildMathml`'s copy
 * of what this returns is ever shown.
 */
export function parseMarkup(source: string): Element | null {
  const text = source.trim();
  if (!text || text.length > MAX_SOURCE || !/^<(\w+:)?math[\s>/]/.test(text)) return null;
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (!xml.getElementsByTagName('parsererror').length && xml.documentElement && isMathElement(xml.documentElement)) {
    return xml.documentElement as unknown as Element;
  }
  // HTML named entities (`&nbsp;`) and unclosed tags: the HTML parser reads those.
  const html = new DOMParser().parseFromString(text, 'text/html');
  return Array.from(html.getElementsByTagNameNS('*', '*')).find(isMathElement) ?? null;
}

/** MathJax's MathML input: `<script type="math/mml">` holding the formula as text. */
function prepareMathScripts(root: Element): number {
  let count = 0;
  for (const script of Array.from(root.getElementsByTagNameNS('*', 'script'))) {
    const type = (script.getAttribute('type') ?? '').toLowerCase().trim();
    if (!/^math\/(mml|mathml)\b/.test(type) || hasClass(script, 'tr-math-source')) continue;
    const prev = script.previousElementSibling;
    if (prev && prev.hasAttribute(UI_ATTR)) continue;
    const source = parseMarkup(script.textContent ?? '');
    const markup = source && mathmlMarkup(rebuildMathml(source, root.ownerDocument));
    if (!markup) continue;
    const display = /mode\s*=\s*display/.test(type) || source!.getAttribute('display') === 'block';
    script.parentNode!.insertBefore(makeMathmlHost(root.ownerDocument, markup, display, source), script);
    addClass(script, 'tr-math-source');
    const preview = prev && hasClass(prev, 'MathJax_Preview') ? prev : null;
    if (preview) hide(preview);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- data attributes

const TEX_ATTRS = ['data-tex', 'data-latex'];
/** Generic names: their value must look like TeX (an equation number is not a formula). */
const LOOSE_TEX_ATTRS = ['data-equation', 'data-formula', 'data-math'];

/**
 * Elements that carry their formula as an attribute (`<span data-latex="…">`
 * around an image or a hand-made rendering, `data-mathml`). The attribute
 * renders in a host; the element, hidden, keeps its text.
 */
function prepareDataAttributes(root: Element, tex: TexRenderer | null): number {
  let count = 0;
  const doc = root.ownerDocument;
  const selector = [...TEX_ATTRS, ...LOOSE_TEX_ATTRS, 'data-mathml'].map((a) => `[${a}]`).join(',');
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (done.has(el) || handled(el) || isMathElement(el) || closest(el, isMathElement, 32)) continue;
    // MathJax output and native MathML are better than any attribute.
    if (nameOf(el).startsWith('mjx-') || hasMath(el)) continue;
    const display = isDisplay(el);
    const mathml = el.getAttribute('data-mathml');
    if (mathml !== null) {
      const source = parseMarkup(mathml);
      const markup = source && mathmlMarkup(rebuildMathml(source, doc));
      if (markup) {
        insertHost(el, makeMathmlHost(doc, markup, display, source));
        count++;
        continue;
      }
    }
    if (!tex) continue;
    let source: string | null = null;
    for (const a of TEX_ATTRS) source ??= el.getAttribute(a)?.trim() || null;
    for (const a of LOOSE_TEX_ATTRS) {
      const v = el.getAttribute(a)?.trim();
      if (!source && v && v.length <= 4000 && TEX_SIGNAL.test(v)) source = v;
    }
    if (!source || source.length > 16000 || tex(source, display) === null) continue;
    insertHost(el, makeHost(doc, source, display));
    count++;
  }
  return count;
}

function isDisplay(el: Element): boolean {
  const mode = (el.getAttribute('data-display') ?? el.getAttribute('data-mode') ?? '').toLowerCase();
  if (mode === 'block' || mode === 'display' || mode === 'true') return true;
  if (mode === 'inline' || mode === 'false') return false;
  return BLOCKS.has(nameOf(el)) || !!closest(el, classMatches(DISPLAY_CONTEXT), 3);
}

function insertHost(el: Element, host: Element): void {
  el.parentNode!.insertBefore(host, el);
  addClass(el, 'tr-hidden', 'tr-math-source');
}

// ---------------------------------------------------------------- object / embed

const IMAGE_FILE = /\.(svg|png|gif|jpe?g|webp)$/i;

/**
 * `<object data="eq.svg">` and `<embed src="eq.svg">`: the web reader drops
 * them (plugins, scripts), and nothing can check their ink. An `<img>` of
 * the same file takes their place; the element, hidden, keeps its fallback.
 * Only files inside the book.
 */
function prepareObjects(root: Element): number {
  let count = 0;
  const doc = root.ownerDocument;
  for (const el of [...Array.from(root.getElementsByTagNameNS('*', 'object')), ...Array.from(root.getElementsByTagNameNS('*', 'embed'))]) {
    if (handled(el) || !isElement(el.parentNode)) continue;
    const url = (el.getAttribute(nameOf(el) === 'object' ? 'data' : 'src') ?? '').trim();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const path = url.split(/[?#]/)[0];
    if (!url || /^[a-z][\w+.-]*:|^\/\//i.test(url) || !(type.startsWith('image/') || IMAGE_FILE.test(path))) continue;
    const img = create(doc, 'img');
    img.setAttribute(UI_ATTR, '');
    img.setAttribute('src', url);
    img.setAttribute('alt', el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '');
    for (const a of ['width', 'height', 'style', 'class']) {
      const v = el.getAttribute(a);
      if (v !== null) img.setAttribute(a, v);
    }
    el.parentNode.insertBefore(img, el);
    hide(el);
    count++;
  }
  return count;
}
