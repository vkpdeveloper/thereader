import { addClass, hasClass } from './dom';

/**
 * Rule 4: dark ink on a transparent background (equation renders, line
 * diagrams) vanishes on a dark page. Such images are drawn small onto a
 * canvas and, when they are mostly transparent with dark ink, inverted so the
 * ink turns light; hues survive the hue rotation. Photos and anything with an
 * opaque background are never touched.
 */

export type InkVerdict = 'invert' | 'keep';

const SAMPLE = 160;
/** Larger images are never ink renders; drawing one would make the browser decode it in full. */
const MAX_PIXELS = 4096 * 4096;

/** Pixel statistics → verdict. Exposed for tests. */
export function inkVerdict(data: Uint8ClampedArray): InkVerdict {
  let transparent = 0;
  let inkWeight = 0;
  let inkLum = 0;
  let light = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 24) {
      transparent++;
      continue;
    }
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const w = a / 255;
    inkWeight += w;
    inkLum += lum * w;
    if (lum > 200 && a > 200) light++;
  }
  if (pixels === 0 || inkWeight === 0) return 'keep';
  const clear = transparent / pixels;
  const mean = inkLum / inkWeight;
  const opaque = pixels - transparent;
  return clear >= 0.2 && mean < 100 && light / Math.max(1, opaque) < 0.15 ? 'invert' : 'keep';
}

/** Null when the image cannot be read (not loaded, cross-origin, broken). */
export function analyzeImage(img: HTMLImageElement): InkVerdict | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!img.complete || !w || !h) return null;
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
    return inkVerdict(ctx.getImageData(0, 0, cw, ch).data);
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
    if (verdict === 'invert' && !hasClass(img, 'tr-ink')) {
      addClass(img, 'tr-ink');
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
    if (hasClass(img, 'tr-hidden') || hasClass(img, 'tr-ink')) continue;
    const src = img.currentSrc || img.src;
    const known = src ? cache?.get(src) : undefined;
    if (known === 'invert') addClass(img, 'tr-ink');
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
