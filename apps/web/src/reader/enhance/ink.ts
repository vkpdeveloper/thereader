import { addClass, hasClass } from './dom';

/**
 * Rule 4: dark ink on a transparent background (equation renders, line
 * diagrams) vanishes on a dark page, and black-on-white equation scans
 * (GIF/PNG/JPEG exports, Kindle conversions) glare as white boxes. Such
 * images are drawn small onto a canvas: mostly transparent with dark ink, or
 * grey ink on an opaque white ground with nothing but greys, they are
 * inverted so the ink turns light; hues survive the hue rotation. Photos,
 * colour artwork and anything else with an opaque background are never
 * touched.
 */

/** `invert`: dark ink on transparency. `paper`: dark ink on opaque white. */
export type InkVerdict = 'invert' | 'paper' | 'keep';

const SAMPLE = 256;
/** Larger images are never ink renders; drawing one would make the browser decode it in full. */
const MAX_PIXELS = 4096 * 4096;

/**
 * Pixel statistics → verdict. `width` (of the sample) enables the paper
 * test, which looks at the border. Exposed for tests.
 */
export function inkVerdict(data: Uint8ClampedArray, width = 0): InkVerdict {
  let transparent = 0;
  let inkWeight = 0;
  let inkLum = 0;
  let light = 0;
  let grey = 0;
  let mid = 0;
  let dark = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 24) {
      transparent++;
      continue;
    }
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const w = a / 255;
    inkWeight += w;
    inkLum += lum * w;
    if (lum > 200 && a > 200) light++;
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 36) grey++;
    if (lum < 110) dark++;
    else if (lum <= 200) mid++;
  }
  if (pixels === 0 || inkWeight === 0) return 'keep';
  const clear = transparent / pixels;
  const mean = inkLum / inkWeight;
  const opaque = pixels - transparent;
  if (clear >= 0.2 && mean < 100 && light / Math.max(1, opaque) < 0.15) return 'invert';
  // Paper: opaque, all greys, at least three quarters white with a white
  // border, and ink that is mostly solid. A greyscale photo fills more of its
  // frame and spreads its tones over the middle.
  if (width <= 0 || clear > 0.02) return 'keep';
  const ink = dark + mid;
  if (grey / opaque < 0.97 || light / opaque < 0.75 || ink / opaque < 0.005 || dark < mid * 0.4) return 'keep';
  return borderLight(data, width) >= 0.9 ? 'paper' : 'keep';
}

/** Share of the outermost ring of pixels that is light and opaque. */
function borderLight(data: Uint8ClampedArray, width: number): number {
  const height = Math.floor(data.length / 4 / width);
  if (width < 3 || height < 3) return 0;
  let total = 0;
  let light = 0;
  const visit = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    total++;
    if (data[i + 3] > 200 && 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 215) light++;
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  return light / total;
}

/** Null when the image cannot be read (not loaded, cross-origin, broken). */
export function analyzeImage(img: HTMLImageElement): InkVerdict | null {
  if (!img.complete) return null;
  // An SVG without a size of its own reports none; draw it at its layout size.
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  if (w < 4 || h < 4 || w * h > MAX_PIXELS) return 'keep';
  const scale = Math.min(1, SAMPLE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  try {
    const canvas = img.ownerDocument.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);
    return inkVerdict(ctx.getImageData(0, 0, cw, ch).data, cw);
  } catch {
    // Tainted (cross-origin) or undecodable.
    return null;
  }
}

/** Whether the page behind `el` is dark: its background, or failing that light text. */
export function darkPage(doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return true;
  for (let el: Element | null = doc.body; el; el = el.parentElement) {
    const rgb = parseRgb(view.getComputedStyle(el).backgroundColor);
    if (rgb && rgb[3] > 0.5) return luminance(rgb) < 0.45;
  }
  const text = parseRgb(view.getComputedStyle(doc.body ?? doc.documentElement).color);
  return text ? luminance(text) > 0.5 : false;
}

function parseRgb(value: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(value);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The class each verdict puts on an image. */
export const INK_CLASS: Record<InkVerdict, string | null> = { invert: 'tr-ink', paper: 'tr-ink-paper', keep: null };

export interface InkOptions {
  /** Known verdicts by image URL, shared across mounts of the same chapter. */
  cache?: Map<string, InkVerdict>;
  /** Called when an image changed (the class was added). */
  onChange?: () => void;
}

/**
 * Checks the images under `root` now and, for those still loading, when they
 * load. Hidden formula sources are skipped. Returns a function that stops
 * listening. Inverting is a paint-only filter: it never changes layout.
 */
export function watchInk(root: Element, options: InkOptions = {}): () => void {
  const cache = options.cache;
  const doc = root.ownerDocument;
  const pending = new Set<HTMLImageElement>();
  let stopped = false;
  const check = (img: HTMLImageElement): boolean => {
    const src = img.currentSrc || img.src;
    let verdict = src ? cache?.get(src) ?? null : null;
    if (!verdict) {
      verdict = analyzeImage(img);
      if (!verdict) return false;
      if (src) cache?.set(src, verdict);
    }
    const cls = INK_CLASS[verdict];
    if (cls && !hasClass(img, cls)) {
      addClass(img, cls);
      options.onChange?.();
    }
    return true;
  };
  const onLoad = (e: Event) => {
    const img = e.target as HTMLImageElement;
    if (stopped || !pending.has(img)) return;
    pending.delete(img);
    check(img);
  };
  doc.addEventListener('load', onLoad, true);
  const imgs = Array.from(root.getElementsByTagNameNS('*', 'img')) as HTMLImageElement[];
  // Known verdicts first (no flash on remount), then analyse the rest in small batches.
  const todo: HTMLImageElement[] = [];
  for (const img of imgs) {
    if (hasClass(img, 'tr-hidden') || hasClass(img, 'tr-ink') || hasClass(img, 'tr-ink-paper')) continue;
    const src = img.currentSrc || img.src;
    const known = src ? cache?.get(src) : undefined;
    if (known && INK_CLASS[known]) addClass(img, INK_CLASS[known]!);
    else if (!known) todo.push(img);
  }
  // Timers of the calling realm: the web engine drives a script-less frame from outside.
  const step = () => {
    if (stopped) return;
    const until = Date.now() + 8;
    while (todo.length && Date.now() < until) {
      const img = todo.shift()!;
      if (!check(img)) pending.add(img);
    }
    if (todo.length) setTimeout(step, 16);
  };
  step();
  return () => {
    stopped = true;
    doc.removeEventListener('load', onLoad, true);
  };
}
