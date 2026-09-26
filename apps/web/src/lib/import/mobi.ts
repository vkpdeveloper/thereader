import { ImportError } from './contract';
import { ByteBuilder, latin1Decode, utf8Decode, utf8DecodeStrict, utf8Encode, view } from './bytes';
import { allElements, htmlElement, parseHtml, type HtmlElement, type HtmlNode } from './html';
import {
  KindleError,
  UNSET,
  buildEpub,
  coverImage,
  exth,
  fontExtension,
  imageName,
  parseFont,
  parseFragments,
  readKindleBook,
  type EpubAsset,
  type ExtractedImage,
  type FragmentEntry,
  type XhtmlPart,
} from './kindle';

/**
 * Port of `apps/mobile/lib/data/import/mobi_converter.dart`: rebuilds a MOBI
 * as an EPUB publication so every subsequent read uses the ordinary EPUB
 * path. Kindle URLs must become relative EPUB links before a reader can load
 * styles, images or the table of contents.
 */

/** Thrown for conversion problems the user should read verbatim (Dart `FormatException`). */
class ConversionError extends Error {}

export const maxMobiBytes = 64 * 1024 * 1024;

/**
 * `prepareBook` + `_convertMobi` from `import_platform_io.dart`: bounded
 * input, readable conversion errors, generic failure otherwise.
 */
export function convertMobiFile(source: Uint8Array): Uint8Array {
  if (source.length === 0 || source.length > maxMobiBytes) {
    throw new ImportError('MOBI imports are limited to 64 MiB.', 'TOO_LARGE');
  }
  try {
    return convertMobi(source);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error instanceof ConversionError) throw new ImportError(error.message, 'MOBI_CONVERSION');
    if (error instanceof KindleError && error.kind === 'drm') {
      throw new ImportError('This Kindle book is DRM-protected and cannot be imported.', 'DRM');
    }
    throw new ImportError('This MOBI cannot be converted.', 'MOBI_CONVERSION');
  }
}

export function convertMobi(source: Uint8Array): Uint8Array {
  const book = readKindleBook(source);
  const flowPaths = new Map<number, string>();
  const resourcePaths = new Map<number, string>();
  for (const image of book.images.all) resourcePaths.set(image.blockIndex, `Images/${imageName(image)}`);
  const css: EpubAsset[] = [];
  const extraImages: ExtractedImage[] = [];
  const fontAssets: EpubAsset[] = [];
  const firstResource = book.mobi.firstImageIndex;
  if (firstResource !== UNSET && firstResource > 0) {
    for (let i = firstResource; i < book.pdb.records.length; i++) {
      const bytes = book.pdb.records[i]!.data;
      if (bytes.length < 4 || bytes[0] !== 0x46 || bytes[1] !== 0x4f || bytes[2] !== 0x4e || bytes[3] !== 0x54) continue;
      try {
        const font = parseFont(bytes);
        const name = `font${String(fontAssets.length).padStart(4, '0')}.${fontExtension(font.format)}`;
        resourcePaths.set(i - firstResource, `Fonts/${name}`);
        fontAssets.push({
          name,
          bytes: font.payload,
          mediaType: font.format === 'otf' ? 'font/otf' : font.format === 'unknown' ? 'application/octet-stream' : 'font/ttf',
        });
      } catch (error) {
        // A damaged font is treated like any other missing referenced asset.
        if (!(error instanceof KindleError) || error.kind !== 'header') throw error;
      }
    }
  }

  for (const flow of book.flows ?? []) {
    if (flow.kind === 'css') {
      const name = `style${String(css.length + 1).padStart(4, '0')}.css`;
      flowPaths.set(flow.index, `Styles/${name}`);
      css.push({ name, bytes: flow.bytes });
    } else if (flow.kind === 'svg') {
      const image: ExtractedImage = { blockIndex: 10000 + flow.index, recordIndex: -1, format: 'svg', data: flow.bytes };
      flowPaths.set(flow.index, `Images/${imageName(image)}`);
      extraImages.push(image);
    }
  }

  const fragments: FragmentEntry[] = [];
  if (book.flows !== null) {
    try {
      fragments.push(...parseFragments(book.pdb, book.mobi));
    } catch (error) {
      // The unpacker already falls back to a single part for books without
      // usable fragment indices. Resource URLs still resolve in that part.
      if (!(error instanceof KindleError) || error.kind !== 'header') throw error;
    }
  }

  const partTexts = new Map<number, string>();
  for (const part of book.parts) partTexts.set(part.fileNumber, utf8Decode(part.bytes));
  const targets = new Map<number, string>();
  for (let fid = 0; fid < fragments.length; fid++) {
    const fragment = fragments[fid]!;
    let text = partTexts.get(fragment.fileNumber);
    if (text === undefined) continue;
    const aid = /@aid=['"]([^'"]+)['"]/.exec(fragment.idText)?.[1];
    if (aid === undefined) continue;
    const element = new RegExp(`(<[A-Za-z][^>]*\\baid=["']${escapeRegExp(aid)}["'][^>]*)(>)`).exec(text);
    if (element === null) continue;
    let anchor = /\bid=['"]([^'"]+)['"]/.exec(element[1]!)?.[1];
    if (anchor === undefined) {
      anchor = `mobi-aid-${aid}`;
      const end = element.index + element[0].length;
      text = `${text.slice(0, end - 1)} id="${anchor}"${text.slice(end - 1)}`;
      partTexts.set(fragment.fileNumber, text);
    }
    targets.set(fid, `part${String(fragment.fileNumber).padStart(4, '0')}.xhtml#${anchor}`);
  }

  const cover = coverImage(book.images);
  const rewrite = (input: string, directory: string): string => {
    let text = input.replace(/kindle:flow:([0-9]+)\?mime=[^\s"'<>]+/g, (_, digits: string) => {
      const index = Number.parseInt(digits, 10);
      const path = flowPaths.get(index);
      if (path === undefined) throw new ConversionError(`The MOBI references missing flow ${index}.`);
      return `../${path}`;
    });
    text = text.replace(/kindle:embed:([0-9A-V]+)(?:\?mime=[^\s"'<>]+)?/g, (_, digits: string) => {
      const index = Number.parseInt(digits, 32) - 1;
      const path = resourcePaths.get(index);
      if (path === undefined) throw new ConversionError(`The MOBI references missing resource ${index + 1}.`);
      return `../${path}`;
    });
    text = text.replace(/kindle:pos:fid:([0-9A-V]+):off:[0-9A-V]+/g, (_, digits: string) => {
      const fid = Number.parseInt(digits, 32);
      const target = targets.get(fid);
      if (target === undefined) throw new ConversionError(`The MOBI references missing chapter ${fid}.`);
      return target;
    });
    if (cover !== null && directory === 'Text') {
      const coverPath = `../Images/${imageName(cover)}`;
      text = text.replace(/(<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["'])[^"']+(["'])/g, (_, a: string, b: string) => `${a}${coverPath}${b}`);
      text = text.replace(/(<link\b[^>]*\bhref=["'])[^"']+(["'][^>]*\brel=["']icon["'])/g, (_, a: string, b: string) => `${a}${coverPath}${b}`);
    }
    if (text.includes('kindle:')) throw new ConversionError('The MOBI contains an unsupported internal link.');
    return text;
  };

  const fixedCss = css.map((asset) => ({ name: asset.name, bytes: utf8Encode(rewrite(utf8DecodeStrict(asset.bytes), 'Styles')) }));
  const fixedImages: ExtractedImage[] = [
    ...book.images.all,
    ...extraImages.map((image) => ({ ...image, data: utf8Encode(rewrite(utf8DecodeStrict(image.data), 'Images')) })),
  ];
  const parts: XhtmlPart[] = book.format === 'mobi7Only'
    ? splitMobi7Parts(book.parts[0]!.bytes, book.mobi.textEncoding, book.images.all)
    : book.parts.map((part) => ({ fileNumber: part.fileNumber, bytes: utf8Encode(rewrite(partTexts.get(part.fileNumber)!, 'Text')) }));

  const epub = buildEpub({
    metadata: {
      identifier: (book.exth === null ? null : exth.asin(book.exth)) ?? `urn:kindle:${book.mobi.uniqueId}`,
      title: book.title,
      language: (book.exth === null ? null : exth.language(book.exth)) ?? 'und',
      creators: book.exth === null ? [] : exth.authors(book.exth),
      publisher: book.exth === null ? null : exth.publisher(book.exth),
      description: book.exth === null ? null : exth.description(book.exth),
      coverImageId: cover === null ? null : `img${cover.blockIndex}`,
    },
    parts,
    images: fixedImages,
    css: fixedCss,
    fonts: fontAssets,
  });
  normalizeZipTimestamps(epub);
  return epub;
}

export function splitMobi7Parts(
  original: Uint8Array,
  textEncoding: number,
  images: ExtractedImage[],
  firstFileNumber = 0,
): XhtmlPart[] {
  let sourceBytes = original;
  const byRecord = new Map<number, ExtractedImage>();
  for (const image of images) byRecord.set(image.blockIndex + 1, image);
  const positions = new Set<number>();
  for (const match of latin1Decode(sourceBytes).matchAll(/\bfilepos=["']?(\d+)/g)) positions.add(Number.parseInt(match[1]!, 10));
  // Mobi-7 filepos values address the original byte stream. Anchors are
  // inserted at the next tag boundary in one pass, then carried through HTML
  // repair so invalid publisher HTML becomes valid XHTML.
  if (positions.size > 0) {
    const ordered = [...positions].sort((a, b) => a - b);
    const patched = new ByteBuilder();
    let lastOffset = 0;
    for (const position of ordered) {
      if (position >= sourceBytes.length) continue;
      let at = position > lastOffset ? position : lastOffset;
      while (at < sourceBytes.length && sourceBytes[at] !== 0x3c) at++;
      if (at < sourceBytes.length) {
        patched.add(sourceBytes.subarray(lastOffset, at));
        patched.add(utf8Encode(`<span id="mobi-pos-${position}"></span>`));
        lastOffset = at;
      }
    }
    patched.add(sourceBytes.subarray(lastOffset));
    sourceBytes = patched.toBytes();
  }
  let source = textEncoding === 1252 ? decodeWindows1252(sourceBytes) : utf8Decode(sourceBytes);
  source = source.replace(/<\/br\s*>/gi, '');
  // An HTML parser treats <mbp:pagebreak> as a non-void element and nests all
  // subsequent content inside it. Convert it to a self-describing <hr> marker
  // before parsing so chapters become sibling body children.
  source = source.replace(/<mbp:pagebreak\s*\/?>/gi, '<hr class="mbp-pagebreak"/>');
  source = source.replace(/<\/mbp:pagebreak\s*>/gi, '');
  const repaired = parseHtml(source);
  for (const element of allElements(repaired.html)) {
    const position = element.attributes.get('filepos');
    if (position !== undefined) {
      element.attributes.delete('filepos');
      const parsed = dartIntTryParse(position);
      if (parsed !== null) element.attributes.set('href', `#mobi-pos-${parsed}`);
    }
  }
  for (const element of allElements(repaired.html)) {
    if (!element.attributes.has('recindex')) continue;
    const index = dartIntTryParse(element.attributes.get('recindex')!);
    element.attributes.delete('recindex');
    const image = index === null ? undefined : byRecord.get(index);
    if (image === undefined) throw new ConversionError('The MOBI references a missing image.');
    element.attributes.set('src', `../Images/${imageName(image)}`);
  }

  const body = repaired.body;
  const groups: HtmlNode[][] = [[]];
  for (const node of body.children) {
    if (node.kind === 'element' && node.name === 'hr' && node.attributes.get('class') === 'mbp-pagebreak') groups.push([]);
    else groups[groups.length - 1]!.push(node);
  }
  const nonEmpty = groups.filter((group) => group.length > 0);
  const headString = writeXhtml(repaired.head);

  const partStrings = nonEmpty.map((group) => {
    const bodyElement = htmlElement('body', new Map(body.attributes));
    bodyElement.children = group;
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">\n' +
      `${headString}\n` +
      `${writeXhtml(bodyElement)}\n` +
      '</html>\n'
    );
  });

  const positionToPart = new Map<number, number>();
  partStrings.forEach((text, i) => {
    for (const match of text.matchAll(/id="mobi-pos-(\d+)"/g)) positionToPart.set(Number.parseInt(match[1]!, 10), i);
  });
  const linked = partStrings.map((text) =>
    text.replace(/href="#mobi-pos-(\d+)"/g, (match, digits: string) => {
      const position = Number.parseInt(digits, 10);
      const target = positionToPart.get(position);
      if (target === undefined) return match;
      return `href="part${String(target).padStart(4, '0')}.xhtml#mobi-pos-${position}"`;
    }),
  );
  return linked.map((text, i) => ({ fileNumber: firstFileNumber + i, bytes: utf8Encode(text) }));
}

/** Dart `int.tryParse` (radix 10): optional sign, digits, surrounding whitespace. */
function dartIntTryParse(text: string): number | null {
  const trimmed = text.trim();
  return /^[+-]?[0-9]+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const windows1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const codes = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    codes[i] = byte >= 0x80 && byte <= 0x9f ? windows1252[byte - 0x80]! : byte;
  }
  let out = '';
  for (let i = 0; i < codes.length; i += 0x8000) out += String.fromCharCode(...codes.slice(i, i + 0x8000));
  return out;
}

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const xmlName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeXhtml(root: HtmlNode): string {
  const out: string[] = [];
  const write = (node: HtmlNode): void => {
    if (node.kind === 'text') {
      out.push(escapeXml(node.text));
      return;
    }
    let tag = node.name.toLowerCase();
    if (tag === 'mbp:pagebreak') {
      out.push('<hr style="break-before: page"/>');
      for (const child of node.children) write(child);
      return;
    }
    if (!xmlName.test(tag)) tag = 'span';
    out.push(`<${tag}`);
    if (tag === 'html') out.push(' xmlns="http://www.w3.org/1999/xhtml"', ' xmlns:xlink="http://www.w3.org/1999/xlink"');
    for (const [name, value] of (node as HtmlElement).attributes) {
      if (tag === 'html' && (name === 'xmlns' || name === 'xmlns:xlink')) continue;
      if (!xmlName.test(name) && name !== 'xml:lang' && name !== 'xlink:href' && !name.startsWith('xmlns:')) continue;
      if (name.startsWith('xmlns:') && !xmlName.test(name.substring(6))) continue;
      out.push(` ${name}="${escapeXml(value)}"`);
    }
    if (voidTags.has(tag)) {
      out.push('/>');
    } else {
      out.push('>');
      for (const child of node.children) write(child);
      out.push(`</${tag}>`);
    }
  };
  write(root);
  return out.join('');
}

/** Fixed 1980-01-01 00:00 DOS timestamps make repeat conversions byte-identical. */
function normalizeZipTimestamps(bytes: Uint8Array): void {
  const data = view(bytes);
  const damaged = (): never => {
    throw new TypeError('Invalid converted EPUB.');
  };
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const signature = data.getUint32(offset, true);
    if (signature === 0x04034b50) {
      if (offset + 30 > bytes.length) damaged();
      data.setUint16(offset + 10, 0, true);
      data.setUint16(offset + 12, 33, true);
      offset += 30 + data.getUint16(offset + 26, true) + data.getUint16(offset + 28, true) + data.getUint32(offset + 18, true);
    } else if (signature === 0x02014b50) {
      if (offset + 46 > bytes.length) damaged();
      data.setUint16(offset + 12, 0, true);
      data.setUint16(offset + 14, 33, true);
      offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
    } else if (signature === 0x06054b50) {
      return;
    } else {
      damaged();
    }
    if (offset > bytes.length) damaged();
  }
  damaged();
}
