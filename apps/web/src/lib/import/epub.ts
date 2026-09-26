import { Inflate } from 'fflate';
import { ImportError } from './contract';
import { crc32, sha256Hex, startsWith, ascii, utf8Decode, utf8DecodeStrict, view } from './bytes';
import { decodeHtmlEntities } from './html';
import {
  childElements,
  descendants,
  getAttribute,
  innerText,
  parseXml,
  textNodes,
  type XmlElement,
} from './xml';

/**
 * Port of the mobile EPUB inspector (`import_platform_io.dart` `_inspect`):
 * the same ZIP bounds, package validation, metadata cleaning and cover
 * selection, with the same user-facing messages.
 */

export const maxImportBytes = 512 * 1024 * 1024;

export interface EpubMetadata {
  sha256: string;
  fileSize: number;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
  cover: Uint8Array | null;
}

interface ZipHeader {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  dataOffset: number;
}

function invalid(message: string): ImportError {
  return new ImportError(message, 'INVALID_EPUB');
}

export async function inspectEpub(bytes: Uint8Array): Promise<EpubMetadata> {
  const size = bytes.length;
  if (size < 22) throw invalid('This file is not a valid EPUB.');
  if (size > maxImportBytes) throw new ImportError('EPUB imports are limited to 512 MiB.', 'TOO_LARGE');
  const headers = readDirectory(bytes);
  const digest = await sha256Hex(bytes);

  const read = (name: string, limit: number): Uint8Array => {
    const header = headers.get(name);
    if (
      header === undefined ||
      header.dataOffset < 0 ||
      header.uncompressedSize > limit ||
      header.compressedSize > limit ||
      (header.method !== 0 && header.method !== 8)
    ) {
      throw invalid(`The EPUB has missing or oversized metadata: ${name}.`);
    }
    const end = header.dataOffset + header.compressedSize;
    if (end > bytes.length) throw invalid('The EPUB metadata is damaged.');
    const compressed = bytes.subarray(header.dataOffset, end);
    const output = header.method === 0 ? compressed : inflateBounded(compressed, limit);
    if (output.length > limit) throw invalid('The EPUB metadata expands beyond its size limit.');
    if (output.length !== header.uncompressedSize || crc32(output) !== header.crc32) {
      throw invalid('The EPUB metadata is damaged.');
    }
    return output;
  };

  const xml = (name: string, limit: number): XmlElement => {
    let text: string;
    try {
      text = utf8DecodeStrict(read(name, limit));
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw invalid('The EPUB metadata is damaged.');
    }
    // EPUB 2 publishers commonly include external DTD declarations. They are
    // unnecessary for metadata extraction: remove them without resolving any
    // network resource. Internal subsets/custom entities remain unsupported.
    const withoutExternalDtd = text.replace(/<!DOCTYPE\s+[^>[]*>/g, '');
    if (withoutExternalDtd.includes('<!DOCTYPE') || text.includes('<!ENTITY')) {
      throw invalid('External XML declarations are not supported in EPUB metadata.');
    }
    try {
      return parseXml(withoutExternalDtd);
    } catch (error) {
      throw invalid(`The EPUB contains malformed XML: ${name}. ${(error as Error).message}`);
    }
  };

  let mimetype: string;
  try {
    mimetype = utf8DecodeStrict(read('mimetype', 64));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    mimetype = '';
  }
  if (mimetype.trim() !== 'application/epub+zip') throw invalid('This file is not an EPUB publication.');
  if (headers.has('META-INF/encryption.xml')) {
    const encryption = xml('META-INF/encryption.xml', 512 * 1024);
    for (const element of descendants(encryption)) {
      if (element.local !== 'EncryptionMethod') continue;
      const algorithm = getAttribute(element, 'Algorithm');
      if (algorithm !== 'http://www.idpf.org/2008/embedding' && algorithm !== 'http://ns.adobe.com/pdf/enc#RC') {
        throw new ImportError('Encrypted or DRM-protected EPUBs are not supported.', 'DRM');
      }
    }
  }
  const container = xml('META-INF/container.xml', 128 * 1024);
  const root = descendants(container).find((element) => element.local === 'rootfile');
  const packagePath = root === undefined ? null : getAttribute(root, 'full-path');
  if (packagePath === null || packagePath.startsWith('/') || packagePath.split('/').includes('..')) {
    throw invalid('The EPUB package is missing.');
  }
  const pkg = xml(packagePath, 2 * 1024 * 1024);
  const all = descendants(pkg);
  if (pkg.local !== 'package' || !all.some((element) => element.local === 'itemref')) {
    throw invalid('The EPUB has no reading order.');
  }
  const items = all.filter((element) => element.local === 'item');
  const manifest = new Map<string, string>();
  for (const item of items) {
    const id = getAttribute(item, 'id');
    const href = getAttribute(item, 'href');
    if (id !== null && href !== null) manifest.set(id, href);
  }
  for (const itemref of all.filter((element) => element.local === 'itemref')) {
    const idref = getAttribute(itemref, 'idref');
    const href = idref === null ? undefined : manifest.get(idref);
    const resolved = href === undefined ? null : resolveUri(packagePath, href);
    if (resolved === null || resolved.scheme || resolved.authority || !headers.has(decodeComponent(resolved.path))) {
      throw invalid('The EPUB is missing a reading-order chapter.');
    }
  }
  const metadata = all.find((element) => element.local === 'metadata');
  const metadataChildren = metadata === undefined ? [] : childElements(metadata);

  const value = (name: string, fallback: string, limit: number, transform = (text: string) => text): string => {
    const text = metadataChildren
      .filter((element) => element.local === name)
      .map((element) => transform(innerText(element)).trim())
      .filter((text) => text.length > 0)
      .join(name === 'creator' ? '; ' : ' ');
    const result = clean(text, limit);
    return result.length === 0 ? fallback : result;
  };

  const coverCandidates: string[] = [];
  for (const item of items) {
    if ((getAttribute(item, 'properties') ?? '').split(/\s+/).includes('cover-image')) {
      const href = getAttribute(item, 'href');
      if (href !== null) coverCandidates.push(href);
    }
  }
  for (const meta of metadataChildren) {
    if (meta.local === 'meta' && getAttribute(meta, 'name') === 'cover') {
      const content = getAttribute(meta, 'content');
      const href = content === null ? undefined : manifest.get(content);
      if (href !== undefined) coverCandidates.push(href);
    }
  }
  for (const reference of all.filter((element) => element.local === 'reference')) {
    if ((getAttribute(reference, 'type') ?? '').split(' ').includes('cover')) {
      const href = getAttribute(reference, 'href');
      if (href !== null) coverCandidates.push(href);
    }
  }
  for (const item of items) {
    const id = (getAttribute(item, 'id') ?? '').toLowerCase();
    const href = getAttribute(item, 'href');
    if (href !== null && (id.startsWith('cover') || /(^|[/_])cover([._/]|$)/i.test(href))) coverCandidates.push(href);
  }

  const resolveCover = (base: string, href: string): string | null => {
    const uri = resolveUri(base, href);
    if (uri === null || uri.scheme || uri.authority || uri.path.startsWith('/')) return null;
    const name = decodeComponent(uri.path);
    return headers.has(name) ? name : null;
  };

  let cover: Uint8Array | null = null;
  for (const href of new Set(coverCandidates)) {
    try {
      const name = resolveCover(packagePath, href);
      if (name === null) continue;
      if (/\.(xhtml|html|htm)$/i.test(name)) {
        const page = xml(name, 512 * 1024);
        for (const image of descendants(page)) {
          if (image.local !== 'img' && image.local !== 'image') continue;
          const ref = getAttribute(image, 'src') ?? image.attributes.find((attribute) => attribute.local === 'href')?.value ?? null;
          const imageName = ref === null ? null : resolveCover(name, ref);
          if (imageName === null) continue;
          const data = read(imageName, 4 * 1024 * 1024);
          if (validCoverBytes(data)) {
            cover = data;
            break;
          }
        }
      } else {
        const data = read(name, 4 * 1024 * 1024);
        if (validCoverBytes(data)) cover = data;
      }
      if (cover !== null) break;
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      /* Try another declared cover candidate. */
    }
  }
  if (coverCandidates.length > 0 && cover === null) {
    throw invalid('The embedded cover is damaged, unsupported or larger than 4 MiB.');
  }

  const language = value('language', 'und', 32);
  const subjects = [...new Set(
    metadataChildren
      .filter((element) => element.local === 'subject')
      .map((element) => clean(innerText(element), 100))
      .filter((subject) => subject.length > 0),
  )].slice(0, 32);
  return {
    sha256: digest,
    fileSize: size,
    title: value('title', 'Untitled', 300),
    author: value('creator', 'Unknown', 300),
    description: value('description', '', 4000, stripHtml),
    language: /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) ? language : 'und',
    subjects,
    cover: cover === null ? null : cover.slice(),
  };
}

function clean(text: string, limit: number): string {
  let result = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (result.length > limit) {
    result = result.substring(0, limit);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.substring(0, result.length - 1);
  }
  return result;
}

/**
 * Publisher descriptions (and every converted Kindle description) are often
 * escaped HTML. The catalog shows plain text, so tags become spaces.
 */
function stripHtml(text: string): string {
  if (!/<[A-Za-z!/][^>]*>/.test(text)) return text;
  return decodeHtmlEntities(text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[A-Za-z!/][^>]*>/g, ' '), false);
}

// ---------------------------------------------------------------------------
// ZIP directory

function readDirectory(bytes: Uint8Array): Map<string, ZipHeader> {
  const size = bytes.length;
  const data = view(bytes);
  // Bound directory allocation before parsing local headers. ZIP64/multidisk
  // archives are unnecessary for the 512 MiB import limit.
  const tailStart = size > 65557 ? size - 65557 : 0;
  const tailLength = size - tailStart;
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    const at = tailStart + i;
    if (data.getUint32(at, true) === 0x06054b50 && i + 22 + data.getUint16(at + 20, true) === tailLength) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw invalid('The EPUB ZIP directory is damaged.');
  const entries = data.getUint16(eocd + 10, true);
  const dirSize = data.getUint32(eocd + 12, true);
  const dirOffset = data.getUint32(eocd + 16, true);
  if (
    entries === 0 ||
    entries > 50000 ||
    dirSize > 8 * 1024 * 1024 ||
    dirOffset + dirSize > eocd ||
    data.getUint16(eocd + 4, true) !== 0 ||
    data.getUint16(eocd + 6, true) !== 0 ||
    data.getUint16(eocd + 8, true) !== entries ||
    (eocd - tailStart >= 20 && data.getUint32(eocd - 20, true) === 0x07064b50)
  ) {
    throw invalid('This EPUB uses an unsupported ZIP directory.');
  }
  const headers = new Map<string, ZipHeader>();
  let offset = dirOffset;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > size || data.getUint32(offset, true) !== 0x02014b50) {
      throw invalid('The EPUB ZIP directory is damaged.');
    }
    const flags = data.getUint16(offset + 8, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localOffset = data.getUint32(offset + 42, true);
    if (offset + 46 + nameLength > size) throw invalid('The EPUB ZIP directory is damaged.');
    const name = zipName(bytes.subarray(offset + 46, offset + 46 + nameLength));
    let localFlags = 0;
    let dataOffset = -1;
    if (localOffset + 30 <= size && data.getUint32(localOffset, true) === 0x04034b50) {
      localFlags = data.getUint16(localOffset + 6, true);
      dataOffset = localOffset + 30 + data.getUint16(localOffset + 26, true) + data.getUint16(localOffset + 28, true);
    }
    if ((flags & 1) !== 0 || (localFlags & 1) !== 0) {
      throw new ImportError('Encrypted or DRM-protected EPUBs are not supported.', 'DRM');
    }
    if (headers.has(name)) throw invalid('The EPUB contains duplicate ZIP entries.');
    headers.set(name, {
      name,
      method: data.getUint16(offset + 10, true),
      crc32: data.getUint32(offset + 16, true),
      compressedSize: data.getUint32(offset + 20, true),
      uncompressedSize: data.getUint32(offset + 24, true),
      dataOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return headers;
}

/** `package:archive` decodes names as UTF-8 and falls back to Latin-1. */
function zipName(bytes: Uint8Array): string {
  try {
    return utf8DecodeStrict(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** Raw DEFLATE with an output ceiling, fed in small chunks so a bomb stops early. */
function inflateBounded(compressed: Uint8Array, limit: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) overflow = true;
    else chunks.push(chunk);
  });
  try {
    for (let offset = 0; offset < compressed.length && !overflow; offset += 4096) {
      const end = Math.min(offset + 4096, compressed.length);
      inflater.push(compressed.subarray(offset, end), end === compressed.length);
    }
    if (compressed.length === 0) inflater.push(new Uint8Array(0), true);
  } catch {
    throw invalid('The EPUB metadata is damaged.');
  }
  if (overflow) throw invalid('The EPUB metadata expands beyond its size limit.');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dart `Uri(path: base).resolve(href)` for path-only bases.

export interface ResolvedUri {
  path: string;
  scheme: boolean;
  authority: boolean;
}

export function resolveUri(base: string, reference: string): ResolvedUri | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return { path: reference, scheme: true, authority: false };
  if (reference.startsWith('//')) return { path: reference, scheme: false, authority: true };
  const path = reference.split('#', 1)[0]!.split('?', 1)[0]!;
  if (path.length === 0) return { path: base, scheme: false, authority: false };
  if (path.startsWith('/')) return { path: removeDotSegments(path), scheme: false, authority: false };
  if (base.startsWith('/')) return { path: removeDotSegments(mergePaths(base, path)), scheme: false, authority: false };
  // Both paths relative: Dart keeps leading ".." instead of dropping it.
  return { path: normalizeRelativePath(mergePaths(base, path)), scheme: false, authority: false };
}

function mergePaths(base: string, reference: string): string {
  let backCount = 0;
  let refStart = 0;
  while (reference.startsWith('../', refStart)) {
    refStart += 3;
    backCount++;
  }
  let baseEnd = base.lastIndexOf('/');
  while (baseEnd > 0 && backCount > 0) {
    const newEnd = base.lastIndexOf('/', baseEnd - 1);
    if (newEnd < 0) break;
    const delta = baseEnd - newEnd;
    if ((delta === 2 || delta === 3) && base[newEnd + 1] === '.' && (delta === 2 || base[newEnd + 2] === '.')) break;
    baseEnd = newEnd;
    backCount--;
  }
  return base.substring(0, baseEnd + 1) + reference.substring(refStart - 3 * backCount);
}

function mayContainDotSegments(path: string): boolean {
  return path === '.' || path === '..' || path.startsWith('./') || path.startsWith('../') ||
    path.includes('/./') || path.includes('/../') || path.endsWith('/.') || path.endsWith('/..');
}

function normalizeRelativePath(path: string): string {
  if (!mayContainDotSegments(path)) return path;
  const output: string[] = [];
  let appendSlash = false;
  for (const segment of path.split('/')) {
    appendSlash = false;
    if (segment === '..') {
      if (output.length > 0 && output[output.length - 1] !== '..') {
        output.pop();
        appendSlash = true;
      } else {
        output.push('..');
      }
    } else if (segment === '.') {
      appendSlash = true;
    } else {
      output.push(segment);
    }
  }
  if (output.length === 0 || (output.length === 1 && output[0] === '')) return './';
  if (appendSlash || output[output.length - 1] === '..') output.push('');
  return output.join('/');
}

function removeDotSegments(path: string): string {
  if (!mayContainDotSegments(path)) return path;
  const output: string[] = [];
  let appendSlash = false;
  for (const segment of path.split('/')) {
    appendSlash = false;
    if (segment === '..') {
      if (output.length > 0) {
        output.pop();
        if (output.length === 0) output.push('');
      }
      appendSlash = true;
    } else if (segment === '.') {
      appendSlash = true;
    } else {
      output.push(segment);
    }
  }
  if (appendSlash) output.push('');
  return output.join('/');
}

/** Tolerant `Uri.decodeComponent`: valid %XX runs decode as UTF-8, anything else stays. */
export function decodeComponent(text: string): string {
  if (!text.includes('%')) return text;
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return utf8Decode(bytes);
  });
}

// ---------------------------------------------------------------------------
// Cover validation (`cover_validation.dart`)

export function isSvgCover(bytes: Uint8Array): boolean {
  return utf8Decode(bytes.subarray(0, 512)).trimStart().startsWith('<');
}

/** Neither local EPUB artwork nor a custom catalog may load secondary URLs. */
export function validCoverBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) return false;
  if (isSvgCover(bytes)) {
    if (bytes.length > 2 * 1024 * 1024) return false;
    try {
      const text = utf8DecodeStrict(bytes);
      const unsafeCss = (value: string): boolean => {
        if (/@import|@font-face/i.test(value)) return true;
        for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
          const ref = match[1]!.trim().replace(/["']/g, '');
          if (!ref.startsWith('#')) return true;
        }
        return false;
      };
      if (/<!DOCTYPE|<!ENTITY/i.test(text) || unsafeCss(text)) return false;
      const root = parseXml(text);
      if (root.local !== 'svg') return false;
      // XML numeric entities are decoded before CSS reaches the renderer.
      // Validate decoded text and attributes as well as the serialized input.
      for (const node of textNodes(root)) if (unsafeCss(node.value)) return false;
      for (const element of descendants(root)) {
        if (['script', 'foreignObject', 'a', 'animate', 'set'].includes(element.local)) return false;
        for (const attribute of element.attributes) {
          if (unsafeCss(attribute.value)) return false;
          if (attribute.local.toLowerCase().startsWith('on')) return false;
          if (
            (attribute.local === 'href' || attribute.local === 'src') &&
            !attribute.value.startsWith('#') &&
            !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/.test(attribute.value)
          ) {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  return (
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    startsWith(bytes, ascii('GIF87a')) ||
    startsWith(bytes, ascii('GIF89a')) ||
    (bytes.length >= 12 && startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8))
  );
}

export function coverMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [137, 80, 78, 71])) return 'image/png';
  if (startsWith(bytes, ascii('GIF8'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF'))) return 'image/webp';
  return 'image/svg+xml';
}
