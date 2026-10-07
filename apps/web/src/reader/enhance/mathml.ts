import { MATHML_NS } from './dom';

/**
 * MathML as books ship it, made renderable by MathML Core browsers
 * (Chromium: the web reader and Android Readium). Chromium ignores
 * `mfenced`, `menclose`, `mlabeledtr`, `mglyph` and every `mathvariant`
 * but `normal`, so MathML 2 output (MathType, InDesign, KaTeX's
 * `\mathbb`) loses its brackets, boxes and blackboard letters. Formulas
 * that use them, and MathML that is not in the MathML namespace (`m:math`
 * read as HTML, Kindle conversions that dropped the `xmlns`), are rebuilt
 * as a fresh MathML tree for a formula host; the book's own element stays,
 * hidden. The rebuild copies only MathML elements, text and presentation
 * attributes, so book markup never reaches the page through it.
 */

/** Elements and text nodes one rebuilt formula may have; more is not a formula. */
export const MAX_MATHML_NODES = 20000;
const MAX_DEPTH = 200;

const TAGS = new Set([
  'math', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace', 'mrow', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror', 'mpadded',
  'mphantom', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none',
  'mtable', 'mtr', 'mtd', 'maction', 'semantics', 'annotation',
  // Rewritten below.
  'mfenced', 'menclose', 'mlabeledtr', 'mglyph',
]);

/** Presentation attributes worth keeping; no styles, classes, ids or URLs. */
const ATTRS = new Set([
  'display', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'dir', 'linethickness', 'bevelled', 'numalign',
  'denomalign', 'stretchy', 'symmetric', 'largeop', 'movablelimits', 'accent', 'accentunder', 'fence', 'separator',
  'form', 'lspace', 'rspace', 'minsize', 'maxsize', 'width', 'height', 'depth', 'voffset', 'columnalign', 'rowalign',
  'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'columnspan', 'rowspan',
  'encoding', 'alttext', 'selection', 'actiontype',
]);

/** The local name without any prefix an HTML parser left in it (`m:mi` → `mi`). */
export function mathmlName(el: Element): string {
  const name = el.localName.toLowerCase();
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** A `<math>` element in any namespace or with any prefix. */
export function isMathElement(el: Element): boolean {
  return mathmlName(el) === 'math';
}

/** Elements every MathML Core browser renders as the book means them. */
const CORE_SAFE_VARIANTS = new Set(['', 'normal']);

/**
 * Whether `math` needs rebuilding to render right in MathML Core browsers.
 * Stops early, and at the node cap (a larger formula is left as it is).
 */
export function needsRebuild(math: Element): boolean {
  if (math.namespaceURI !== MATHML_NS || math.localName !== 'math') return true;
  const stack: Element[] = [math];
  for (let seen = 0; stack.length; seen++) {
    if (seen > MAX_MATHML_NODES) return false;
    const el = stack.pop()!;
    const name = el.localName;
    // Annotations may hold anything; they are never shown.
    if (name === 'annotation' || name === 'annotation-xml') continue;
    if (el.namespaceURI !== MATHML_NS) return true;
    if (name === 'mfenced' || name === 'menclose' || name === 'mlabeledtr' || name === 'mglyph') return true;
    const variant = el.getAttribute('mathvariant');
    if (variant !== null && !CORE_SAFE_VARIANTS.has(variant.trim().toLowerCase())) return true;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
  }
  return false;
}

/**
 * A clean MathML copy of `src` (any namespace), with MathML 2 constructs
 * rewritten for MathML Core: `mfenced` as an `mrow` of fences, `mathvariant`
 * as Mathematical Alphanumeric characters, `menclose` as a bordered row,
 * labelled rows as plain rows. Null when `src` is not a formula or too big.
 */
export function rebuildMathml(src: Element, doc: Document): Element | null {
  let budget = MAX_MATHML_NODES;
  const make = (name: string) => doc.createElementNS(MATHML_NS, name);

  const build = (el: Element, variant: string, depth: number): Element | null => {
    if (--budget < 0 || depth > MAX_DEPTH) return null;
    const name = mathmlName(el);
    if (name === 'annotation-xml') return null;
    if (name === 'mfenced') return fenced(el, variant, depth);
    if (name === 'mglyph') {
      const mi = make('mi');
      mi.textContent = el.getAttribute('alt') ?? '';
      return mi;
    }
    const known = TAGS.has(name);
    const out = make(!known ? 'mrow' : name === 'menclose' ? 'mrow' : name === 'mlabeledtr' ? 'mtr' : name);
    let own = variant;
    if (known) {
      for (const a of Array.from(el.attributes)) {
        const n = a.localName.toLowerCase();
        if (!ATTRS.has(n) || a.namespaceURI) continue;
        if (n === 'mathvariant') {
          own = a.value.trim().toLowerCase();
          // Core renders `normal` on `mi`; the rest becomes characters.
          if (own === 'normal' && name === 'mi') out.setAttribute('mathvariant', 'normal');
          continue;
        }
        if (a.value.length > 200) continue;
        out.setAttribute(n, a.value);
      }
      if (name === 'menclose') enclose(out, el.getAttribute('notation') ?? 'longdiv');
    }
    const token = name === 'mi' || name === 'mn' || name === 'mo' || name === 'mtext' || name === 'ms';
    const kids: Node[] = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) {
        if (--budget < 0) return null;
        const data = (c as CharacterData).data;
        kids.push(doc.createTextNode(token && own && own !== 'normal' ? styled(data, own, name === 'mi') : data));
      } else if (c.nodeType === 1) {
        const child = build(c as Element, own, depth + 1);
        if (budget < 0) return null;
        if (child) kids.push(child);
      }
    }
    if (name === 'mlabeledtr' && kids.length > 1) kids.push(kids.shift()!);
    out.append(...kids);
    return out;
  };

  const fenced = (el: Element, variant: string, depth: number): Element | null => {
    const row = make('mrow');
    const fence = (text: string, form: string) => {
      if (!text) return;
      const mo = make('mo');
      mo.setAttribute('fence', 'true');
      mo.setAttribute('form', form);
      mo.textContent = text;
      row.append(mo);
    };
    const open = (el.getAttribute('open') ?? '(').trim();
    const close = (el.getAttribute('close') ?? ')').trim();
    const separators = Array.from((el.getAttribute('separators') ?? ',').replace(/\s+/g, ''));
    fence(open, 'prefix');
    let i = 0;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling, i++) {
      if (i > 0 && separators.length) {
        const mo = make('mo');
        mo.setAttribute('separator', 'true');
        mo.textContent = separators[Math.min(i - 1, separators.length - 1)];
        row.append(mo);
      }
      const child = build(c, variant, depth + 1);
      if (budget < 0) return null;
      if (child) row.append(child);
    }
    fence(close, 'postfix');
    return row;
  };

  if (src.nodeType !== 1) return null;
  let root = build(src, '', 0);
  if (!root || budget < 0) return null;
  if (root.localName !== 'math') {
    const math = make('math');
    math.append(root);
    root = math;
  }
  // Marks a rebuilt formula for the shadow stylesheet (MathML layout, not temml's wrapping).
  root.setAttribute('class', 'tr-mml');
  return root;
}

/** `menclose` notations as borders on the row standing in for it (Core has no enclosures). */
function enclose(row: Element, notation: string): void {
  const n = new Set(notation.toLowerCase().split(/\s+/));
  const css: string[] = [];
  if (n.has('box') || n.has('roundedbox') || n.has('circle')) css.push('border:0.067em solid');
  else {
    if (n.has('top') || n.has('longdiv') || n.has('actuarial')) css.push('border-top:0.067em solid');
    if (n.has('bottom')) css.push('border-bottom:0.067em solid');
    if (n.has('left') || n.has('longdiv')) css.push('border-left:0.067em solid');
    if (n.has('right') || n.has('actuarial')) css.push('border-right:0.067em solid');
  }
  if (n.has('roundedbox')) css.push('border-radius:0.3em');
  if (n.has('circle')) css.push('border-radius:50%');
  if (n.has('horizontalstrike')) css.push('text-decoration:line-through');
  if (n.has('updiagonalstrike')) css.push('background:linear-gradient(to top right,transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)');
  if (n.has('downdiagonalstrike')) css.push('background:linear-gradient(to bottom right,transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)');
  if (css.length) row.setAttribute('style', `${css.join(';')};padding:0.1em 0.2em`);
}

// ---------------------------------------------------------------- mathvariant

/** First code point of capital A (lower case follows 26 later) per variant. */
const LATIN: Record<string, number> = {
  bold: 0x1d400, italic: 0x1d434, 'bold-italic': 0x1d468, script: 0x1d49c, 'bold-script': 0x1d4d0, fraktur: 0x1d504,
  'double-struck': 0x1d538, 'bold-fraktur': 0x1d56c, 'sans-serif': 0x1d5a0, 'bold-sans-serif': 0x1d5d4,
  'sans-serif-italic': 0x1d608, 'sans-serif-bold-italic': 0x1d63c, monospace: 0x1d670,
};
/** Capital Alpha and small alpha per variant that has Greek. */
const GREEK: Record<string, [number, number]> = {
  bold: [0x1d6a8, 0x1d6c2], italic: [0x1d6e2, 0x1d6fc], 'bold-italic': [0x1d71c, 0x1d736],
  'bold-sans-serif': [0x1d756, 0x1d770], 'sans-serif-bold-italic': [0x1d790, 0x1d7aa],
};
const DIGITS: Record<string, number> = {
  bold: 0x1d7ce, 'double-struck': 0x1d7d8, 'sans-serif': 0x1d7e2, 'bold-sans-serif': 0x1d7ec, monospace: 0x1d7f6,
};
/** Letters encoded earlier, in Letterlike Symbols; their slots in the math block are empty. */
const HOLES: Record<string, Record<string, number>> = {
  italic: { h: 0x210e },
  script: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 },
  fraktur: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  'double-struck': { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
};

/**
 * `text` in the Mathematical Alphanumeric Symbols of `variant`. A single
 * letter in an `mi` is italic by default, so `italic` leaves it alone.
 */
export function styled(text: string, variant: string, mi = false): string {
  if (variant === 'italic' && mi && Array.from(text.trim()).length === 1) return text;
  const latin = LATIN[variant];
  if (latin === undefined) return text;
  const greek = GREEK[variant];
  const digits = DIGITS[variant];
  const holes = HOLES[variant];
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const hole = holes?.[ch];
    if (hole) out += String.fromCodePoint(hole);
    else if (c >= 0x41 && c <= 0x5a) out += String.fromCodePoint(latin + c - 0x41);
    else if (c >= 0x61 && c <= 0x7a) out += String.fromCodePoint(latin + 26 + c - 0x61);
    else if (digits !== undefined && c >= 0x30 && c <= 0x39) out += String.fromCodePoint(digits + c - 0x30);
    else if (greek && c >= 0x391 && c <= 0x3a9 && c !== 0x3a2) out += String.fromCodePoint(greek[0] + c - 0x391);
    else if (greek && c >= 0x3b1 && c <= 0x3c9) out += String.fromCodePoint(greek[1] + c - 0x3b1);
    else out += ch;
  }
  return out;
}
