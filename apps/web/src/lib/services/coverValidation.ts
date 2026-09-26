/**
 * Cover bytes must be a raster image or a self-contained SVG: neither local
 * EPUB artwork nor a custom catalog may make the page load secondary URLs.
 * Ported from mobile `cover_validation.dart`.
 */

export const MAX_COVER_BYTES = 4 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;

export const COVER_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);

export function isSvgCover(bytes: Uint8Array): boolean {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).trimStart().startsWith('<');
}

function starts(bytes: Uint8Array, signature: number[] | string): boolean {
  const sig = typeof signature === 'string' ? [...signature].map((c) => c.charCodeAt(0)) : signature;
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** Sniffed MIME type of valid cover bytes, or null when they are not a safe cover. */
export function coverType(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
  if (isSvgCover(bytes)) return validSvg(bytes) ? 'image/svg+xml' : null;
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts(bytes, 'GIF87a') || starts(bytes, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && starts(bytes, 'RIFF') && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export const validCoverBytes = (bytes: Uint8Array): boolean => coverType(bytes) !== null;

function unsafeCss(value: string): boolean {
  if (/@import|@font-face/i.test(value)) return true;
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const ref = match[1]!.trim().replace(/["']/g, '');
    if (!ref.startsWith('#')) return true;
  }
  return false;
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/;
const FORBIDDEN_ELEMENTS = new Set(['script', 'foreignobject', 'a', 'animate', 'set']);

function validSvg(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_SVG_BYTES) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || unsafeCss(text)) return false;
  if (typeof DOMParser !== 'undefined') return validSvgDocument(text);
  // Without a DOM parser (tests, workers) apply conservative textual checks.
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return false;
  if (/<\s*(script|foreignObject|a|animate|set)[\s/>]/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  for (const match of text.matchAll(/\s(?:[a-z]+:)?(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const value = match[2] ?? match[3] ?? '';
    if (!value.startsWith('#') && !SAFE_DATA_IMAGE.test(value)) return false;
  }
  return true;
}

function validSvgDocument(text: string): boolean {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length > 0 || root.localName !== 'svg') return false;
  // Numeric entities are decoded before CSS reaches the renderer; validate the
  // decoded text and attributes as well as the serialized input.
  const walker = doc.createTreeWalker(root, 0x1 | 0x4 | 0x8);
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (unsafeCss(node.nodeValue ?? '')) return false;
      continue;
    }
    const element = node as Element;
    if (FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase())) return false;
    for (const attr of Array.from(element.attributes)) {
      if (unsafeCss(attr.value)) return false;
      const name = attr.localName.toLowerCase();
      if (name.startsWith('on')) return false;
      if ((name === 'href' || name === 'src') && !attr.value.startsWith('#') && !SAFE_DATA_IMAGE.test(attr.value)) return false;
    }
  }
  return true;
}
