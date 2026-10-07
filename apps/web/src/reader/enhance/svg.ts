import { addClass, classOf, closest, hasClass, nameOf, UI_ATTR } from './dom';
import { classMatches, MATH_CONTEXT } from './math';

/**
 * Rule 4b: inline SVG formulas drawn in black (equation exports, MathJax 2
 * SVG with a fixed colour, hand-made SVG maths) vanish on a dark page. A
 * formula-like SVG whose paint is only black, greys and `none` has its dark
 * paint switched to `currentColor`, so it follows the text colour of every
 * theme. Illustrations (colour, gradients, embedded images, a background
 * of their own, larger than a formula) are never touched. Attributes only:
 * the text inside an SVG stays what it was.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** More elements than this is artwork, not a formula. */
const MAX_ELEMENTS = 4000;
const PAINT_ATTRS = ['fill', 'stroke', 'color'];
const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128], dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105], darkgray: [169, 169, 169], darkgrey: [169, 169, 169], silver: [192, 192, 192],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], gainsboro: [220, 220, 220], whitesmoke: [245, 245, 245],
};
const COLOURFUL = /gradient|pattern|image|foreignobject|filter|mask/;

type Paint = 'none' | 'dark' | 'light' | 'colour';

/** What a paint value is, for the formula test. */
export function paintOf(value: string): Paint {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v === 'inherit' || v === 'context-stroke' || v === 'context-fill') return 'none';
  let rgb: [number, number, number] | null = NAMED[v] ?? null;
  let m: RegExpExecArray | null;
  if (!rgb && (m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v))) {
    const h = m[1].length <= 4 ? Array.from(m[1].slice(0, 3)).map((c) => c + c).join('') : m[1].slice(0, 6);
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (!rgb && (m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/.exec(v))) {
    const c = (n: string, pct: string) => (pct ? (parseFloat(n) * 255) / 100 : parseFloat(n));
    rgb = [c(m[1], m[2]), c(m[3], m[4]), c(m[5], m[6])];
  }
  if (!rgb) return 'colour';
  const spread = Math.max(...rgb) - Math.min(...rgb);
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (spread > 40) return 'colour';
  return lum < 0.45 ? 'dark' : lum > 0.8 ? 'light' : 'colour';
}

/** `fill`, `stroke` and `color` set in a style attribute (`fill:#000; stroke-width:2`). */
function stylePaints(style: string): [string, string][] {
  const out: [string, string][] = [];
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim().toLowerCase();
    if (PAINT_ATTRS.includes(name)) out.push([name, decl.slice(colon + 1).replace(/!important/i, '').trim()]);
  }
  return out;
}

/** Sized like text: em/ex dimensions or a baseline shift, the way TeX-to-SVG converters write them. */
const TEXT_SIZED = /^\s*-?[\d.]+\s*(em|ex)\s*$/i;

function looksLikeFormula(svg: Element): boolean {
  if (closest(svg, (e) => nameOf(e) === 'mjx-container' || /(^|\s)MathJax/.test(classOf(e)), 6)) return true;
  if (svg.querySelector('[data-mml-node], [data-c]')) return true;
  if (closest(svg, classMatches(MATH_CONTEXT), 5)) return true;
  const width = svg.getAttribute('width') ?? '';
  const height = svg.getAttribute('height') ?? '';
  if (TEXT_SIZED.test(width) || TEXT_SIZED.test(height) || /vertical-align\s*:/i.test(svg.getAttribute('style') ?? '')) return true;
  // Small and set in running text.
  const h = parseFloat(height);
  const w = parseFloat(width);
  if (!(h > 0 && h <= 64 && /^\s*[\d.]+\s*(px)?\s*$/.test(height) && (!(w > 0) || w <= 900))) return false;
  const parent = svg.parentElement;
  return !!parent && Array.from(parent.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
}

/**
 * The dark paints of a formula SVG to recolour, or null when the SVG is not
 * a monochrome formula (or has its own light background).
 */
function darkPaints(svg: Element): { el: Element; name: string; style: boolean }[] | null {
  const all = svg.getElementsByTagNameNS('*', '*');
  if (all.length > MAX_ELEMENTS) return null;
  const out: { el: Element; name: string; style: boolean }[] = [];
  for (const el of [svg, ...Array.from(all)]) {
    const name = el.localName.toLowerCase();
    if (COLOURFUL.test(name)) return null;
    if (name === 'style') {
      // Class rules cannot be recoloured one attribute at a time.
      if (/\b(fill|stroke|color)\s*:/i.test(el.textContent ?? '')) return null;
      continue;
    }
    const paints: [string, string, boolean][] = PAINT_ATTRS.flatMap((a) => {
      const v = el.getAttribute(a);
      return v === null ? [] : [[a, v, false] as [string, string, boolean]];
    });
    for (const [a, v] of stylePaints(el.getAttribute('style') ?? '')) paints.push([a, v, true]);
    for (const [a, v, style] of paints) {
      const paint = paintOf(v);
      if (paint === 'colour' || paint === 'light') return null;
      if (paint === 'dark') out.push({ el, name: a, style });
    }
  }
  return out;
}

/**
 * Makes black formula SVGs follow the text colour. Returns how many changed.
 * Readium paints a light backdrop behind SVGs unless they carry `tr-svg-ink`.
 */
export function prepareSvgInk(root: Element): number {
  let count = 0;
  for (const svg of Array.from(root.getElementsByTagNameNS(SVG_NS, 'svg'))) {
    if (hasClass(svg, 'tr-svg-ink') || svg.parentElement?.closest?.('svg') || closest(svg, (e) => e.hasAttribute(UI_ATTR), 32)) continue;
    if (!looksLikeFormula(svg)) continue;
    const dark = darkPaints(svg);
    if (!dark) continue;
    for (const { el, name, style } of dark) {
      if (!style) el.setAttribute(name, 'currentColor');
      else (el as SVGElement).style?.setProperty(name, 'currentColor');
    }
    // Unpainted shapes are black by default.
    if (!svg.hasAttribute('fill') && !stylePaints(svg.getAttribute('style') ?? '').some(([n]) => n === 'fill')) svg.setAttribute('fill', 'currentColor');
    addClass(svg, 'tr-svg-ink');
    count++;
  }
  return count;
}
