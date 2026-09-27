import { zipSync, type Zippable } from 'fflate';
import { ImportError } from './contract';
import { ByteBuilder, latin1Decode, utf8Decode, utf8DecodeStrict, utf8Encode, view } from './bytes';
import { allElements, htmlElement, parseHtml, type HtmlElement, type HtmlNode } from './html';
import {
  KindleError,
  UNSET,
  coverImage,
  exth,
  fontExtension,
  imageMime,
  imageName,
  parseFont,
  parseFragments,
  partFilename,
  readKindleBook,
  type EpubAsset,
  type EpubMetadata,
  type ExtractedImage,
  type FragmentEntry,
} from './kindle';

/**
 * Port of `apps/mobile/lib/data/import/mobi_converter.dart`: rebuilds a MOBI
 * as an EPUB publication so every subsequent read uses the ordinary EPUB
 * path. Kindle URLs must become relative EPUB links before a reader can load
 * styles, images or the table of contents.
 *
 * The converter is deliberately "intelligent" about chapter labels: instead
 * of emitting generic "Part 1, Part 2..." entries, it reads the actual
 * headings inside each XHTML part and uses those for the EPUB 3 nav doc and
 * NCX. Sub-sections are nested so the table of contents matches the book's
 * real structure.
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
  const parts: EpubPart[] = book.format === 'mobi7Only'
    ? splitMobi7Parts(book.parts[0]!.bytes, book.mobi.textEncoding, book.images.all)
    : book.parts.map((part) => finalizeKf8Part(part.fileNumber, rewrite(partTexts.get(part.fileNumber)!, 'Text')));

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

/** One finalized EPUB text part, including the real heading-derived label. */
export interface EpubPart {
  fileNumber: number;
  bytes: Uint8Array;
  /** Human-readable label for this part (chapter/section title). */
  title: string;
  /** All headings found inside this part, used for nested navigation. */
  headings: Heading[];
}

export interface Heading {
  level: number;
  text: string;
  anchor: string;
}

export function finalizeKf8Part(fileNumber: number, text: string): EpubPart {
  const document = parseHtml(text);
  restructureHeadings(document.body);
  const headings = collectHeadings(document.body, fileNumber);
  const title = selectTitle(headings, fileNumber);
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>\n${writeXhtml(document.html)}`;
  return { fileNumber, bytes: utf8Encode(xhtml), title, headings };
}

function collectHeadings(body: HtmlElement, fileNumber: number): Heading[] {
  const headings: Heading[] = [];
  let inHeadings = false;
  // Anchors number element children only, like Dart's `body.children`.
  let index = 0;
  for (const child of body.children) {
    if (child.kind !== 'element') continue;
    const heading = extractHeading(child, fileNumber, index++);
    if (heading !== null) {
      headings.push(heading);
      inHeadings = true;
      continue;
    }
    if (inHeadings && !isIgnorableForHeadings(child)) break;
  }
  combineNumberHeadings(headings);
  return headings;
}

function extractHeading(element: HtmlElement, fileNumber: number, index: number): Heading | null {
  if (isIgnorableForHeadings(element)) return null;
  if (!isHeadingLike(element)) return null;
  const text = cleanHeading(textContent(element));
  if (text === '') return null;
  let anchor = element.attributes.get('id');
  if (anchor === undefined || anchor === '') {
    anchor = `mobi-hd-${fileNumber}-${index}`;
    element.attributes.set('id', anchor);
  }
  const level = dartIntTryParse(element.name.substring(1)) ?? 1;
  return { level, text, anchor };
}

function isIgnorableForHeadings(element: HtmlElement): boolean {
  const tag = element.name;
  if (tag === 'br' || tag === 'hr' || tag === 'script' || tag === 'style') return true;
  return tag === 'span' && cleanHeading(textContent(element)) === '';
}

const headingTag = /^h[1-6]$/;

function isHeadingLike(element: HtmlElement): boolean {
  if (headingTag.test(element.name)) return true;

  const text = cleanHeading(textContent(element));
  if (text === '' || text.length > 120) return false;

  // Attribution lines such as "—NDT" are not chapter titles.
  if (/^[—\-–]/.test(text) && text.length <= 8) return false;

  const fontSize = firstFontSize(element);
  const hasLargeFont = fontSize !== null && fontSize >= 4;
  const hasBold = hasDescendant(element, (node) => node.name === 'b' || node.name === 'strong');
  const isCentered = element.attributes.get('align')?.toLowerCase() === 'center';

  // All-caps short titles like PREFACE, CONTENTS, ACKNOWLEDGMENTS.
  // Skip very small print (e.g. attribution captions like "LUCRETIUS, C. 50 BC").
  if ((fontSize === null || fontSize >= 3) && isDartUpperCase(text) && text.length >= 2 && text.length <= 30) return true;

  // Chapter / section numbers, with or without the word "Chapter".
  if (isNumberHeading(text) || isChapterHeading(text)) return true;

  // Visually emphasized, short introductory text.
  return (hasLargeFont || hasBold) && (isCentered || text.length <= 40);
}

/** `querySelectorAll('font[size]')` (descendants, document order), then the element's own `size`. */
function firstFontSize(element: HtmlElement): number | null {
  let found: number | null = null;
  hasDescendant(element, (node) => {
    const size = node.name === 'font' ? node.attributes.get('size') : undefined;
    if (size !== undefined) found = dartIntTryParse(size);
    return found !== null;
  });
  return found ?? dartIntTryParse(element.attributes.get('size') ?? '');
}

/** Pre-order search of the element's descendants, stopping at the first match. */
function hasDescendant(element: HtmlElement, test: (node: HtmlElement) => boolean): boolean {
  for (const child of element.children) {
    if (child.kind === 'element' && (test(child) || hasDescendant(child, test))) return true;
  }
  return false;
}

/** Dart `Element.text`: every descendant text node, concatenated. */
function textContent(element: HtmlElement): string {
  let text = '';
  const walk = (node: HtmlElement): void => {
    for (const child of node.children) {
      if (child.kind === 'text') text += child.text;
      else if (child.kind === 'element') walk(child);
    }
  };
  walk(element);
  return text;
}

const numberHeadingPattern = /^\s*\d+[.:\-]?\s*$/;
const chapterHeadingPattern = /^\s*(Chapter|CHAPTER|Ch\.?|Section|SECTION)?\s*\d+[.:\-]?\s*$/;

function isNumberHeading(text: string): boolean {
  return numberHeadingPattern.test(text);
}

function isChapterHeading(text: string): boolean {
  return chapterHeadingPattern.test(text);
}

function combineNumberHeadings(headings: Heading[]): void {
  for (let i = 0; i < headings.length - 1; i++) {
    const current = headings[i]!;
    const next = headings[i + 1]!;
    if ((isNumberHeading(current.text) || isChapterHeading(current.text)) && !isNumberHeading(next.text)) {
      headings[i] = { level: current.level, text: `${dartTrim(current.text)} ${dartTrim(next.text)}`, anchor: current.anchor };
      headings.splice(i + 1, 1);
      i--;
    }
  }
}

/** Stands in for a body child `restructureHeadings` removed, so removal stays linear. */
const removedNode: HtmlNode = { kind: 'text', text: '' };

function restructureHeadings(body: HtmlElement): void {
  const nodes = body.children;
  let removed = false;
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i]!;
    if (current.kind !== 'element' || !isHeadingLike(current)) continue;
    const currentText = cleanHeading(textContent(current));
    if (currentText === '' || headingTag.test(current.name)) continue;
    const numbered = isNumberHeading(currentText) || isChapterHeading(currentText);

    // Combine a chapter/section number with the immediately following title.
    if (numbered) {
      let j = i + 1;
      while (j < nodes.length && nodes[j]!.kind !== 'element') j++;
      const next = nodes[j];
      if (next?.kind === 'element' && isHeadingLike(next)) {
        const nextText = cleanHeading(textContent(next));
        if (nextText !== '' && !isNumberHeading(nextText)) {
          nodes[i] = centeredHeading(current, `${dartTrim(currentText)} ${dartTrim(nextText)}`, 'h1');
          nodes[j] = removedNode;
          removed = true;
          i = j;
          continue;
        }
      }
    }

    // Promote remaining heading-like paragraphs to a proper heading tag.
    nodes[i] = centeredHeading(current, currentText, numbered ? 'h1' : 'h2');
  }
  if (removed) body.children = nodes.filter((node) => node !== removedNode);
}

function centeredHeading(old: HtmlElement, text: string, tag: string): HtmlElement {
  const heading = htmlElement(tag, new Map([['style', 'text-align: center']]));
  heading.children.push({ kind: 'text', text });
  const id = old.attributes.get('id');
  if (id !== undefined && id !== '') heading.attributes.set('id', id);
  return heading;
}

function cleanHeading(value: string): string {
  let text = dartTrim(value.replace(/\u00a0/g, ' ')).replace(/\s+/g, ' ');
  if (text.length > 200) text = dartTrim(text.substring(0, 200));
  return text;
}

function selectTitle(headings: Heading[], fallbackNumber: number): string {
  return headings.length > 0 ? headings[0]!.text : `Section ${fallbackNumber + 1}`;
}

export function splitMobi7Parts(
  original: Uint8Array,
  textEncoding: number,
  images: ExtractedImage[],
  firstFileNumber = 0,
): EpubPart[] {
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

  const titles: string[] = [];
  const headingsList: Heading[][] = [];
  const partStrings = nonEmpty.map((group, i) => {
    const bodyElement = htmlElement('body', new Map(body.attributes));
    bodyElement.children = group;
    const fileNumber = firstFileNumber + i;
    restructureHeadings(bodyElement);
    const headings = collectHeadings(bodyElement, fileNumber);
    titles.push(selectTitle(headings, fileNumber));
    headingsList.push(headings);
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
  return linked.map((text, i) => ({
    fileNumber: firstFileNumber + i,
    bytes: utf8Encode(text),
    title: titles[i]!,
    headings: headingsList[i]!,
  }));
}

// ---------------------------------------------------------------------------
// EPUB package (`_ThereaderEpubBuilder`)

const containerXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">\n' +
  '  <rootfiles>\n' +
  '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
  '  </rootfiles>\n' +
  '</container>\n';

function buildEpub(options: {
  metadata: EpubMetadata;
  parts: EpubPart[];
  images: ExtractedImage[];
  css: EpubAsset[];
  fonts: EpubAsset[];
}): Uint8Array {
  const { metadata, parts, images, css, fonts } = options;
  const files: Zippable = {
    // Stored, no extra field, first entry: OCF requires this exact prefix.
    mimetype: [utf8Encode('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': utf8Encode(containerXml),
    'OEBPS/content.opf': utf8Encode(buildOpf(metadata, parts, images, css, fonts)),
    'OEBPS/nav.xhtml': utf8Encode(buildNav(metadata, parts)),
    'OEBPS/toc.ncx': utf8Encode(buildNcx(metadata, parts)),
  };
  for (const part of parts) files[`OEBPS/Text/${partFilename(part)}`] = part.bytes;
  for (const image of images) files[`OEBPS/Images/${imageName(image)}`] = image.data;
  for (const asset of css) files[`OEBPS/Styles/${asset.name}`] = asset.bytes;
  for (const asset of fonts) files[`OEBPS/Fonts/${asset.name}`] = asset.bytes;
  return zipSync(files, { level: 6 });
}

function buildOpf(m: EpubMetadata, parts: EpubPart[], images: ExtractedImage[], css: EpubAsset[], fonts: EpubAsset[]): string {
  const manifest: string[] = [];
  const spine: string[] = [];
  for (const part of parts) {
    const id = `p${part.fileNumber}`;
    manifest.push(`    <item id="${id}" href="Text/${partFilename(part)}" media-type="application/xhtml+xml"/>\n`);
    spine.push(`    <itemref idref="${id}"/>\n`);
  }
  for (const image of images) {
    manifest.push(`    <item id="img${image.blockIndex}" href="Images/${imageName(image)}" media-type="${imageMime[image.format]}"/>\n`);
  }
  css.forEach((asset, i) => manifest.push(`    <item id="css${i}" href="Styles/${asset.name}" media-type="text/css"/>\n`));
  fonts.forEach((asset, i) => {
    manifest.push(`    <item id="font${i}" href="Fonts/${asset.name}" media-type="${asset.mediaType ?? 'application/octet-stream'}"/>\n`);
  });
  manifest.push('    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n');
  manifest.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n');
  const coverMeta = m.coverImageId !== null ? `    <meta name="cover" content="${escapeXml(m.coverImageId)}"/>\n` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    `    <dc:identifier id="bookid">${escapeXml(m.identifier)}</dc:identifier>\n` +
    `    <dc:title>${escapeXml(m.title)}</dc:title>\n` +
    `    <dc:language>${escapeXml(m.language)}</dc:language>\n` +
    m.creators.map((creator) => `    <dc:creator>${escapeXml(creator)}</dc:creator>\n`).join('') +
    (m.publisher === null ? '' : `    <dc:publisher>${escapeXml(m.publisher)}</dc:publisher>\n`) +
    (m.description === null ? '' : `    <dc:description>${escapeXml(m.description)}</dc:description>\n`) +
    coverMeta +
    '  </metadata>\n' +
    '  <manifest>\n' +
    manifest.join('') +
    '  </manifest>\n' +
    '  <spine toc="ncx">\n' +
    spine.join('') +
    '  </spine>\n' +
    '</package>\n'
  );
}

interface NavNode {
  label: string;
  src: string;
  level: number;
  children: NavNode[];
}

/** Headings nest under the closest earlier entry of a shallower level; heading-less parts are top level. */
function buildNavTree(parts: EpubPart[]): NavNode[] {
  const roots: NavNode[] = [];
  const stack: NavNode[] = [];
  for (const part of parts) {
    if (part.headings.length === 0) {
      const node: NavNode = { label: part.title, src: `Text/${partFilename(part)}`, level: 1, children: [] };
      roots.push(node);
      stack.length = 0;
      stack.push(node);
      continue;
    }
    for (const heading of part.headings) {
      const node: NavNode = { label: heading.text, src: `Text/${partFilename(part)}#${heading.anchor}`, level: heading.level, children: [] };
      while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    }
  }
  return roots;
}

function buildNav(m: EpubMetadata, parts: EpubPart[]): string {
  const items: string[] = [];
  const render = (nodes: NavNode[], depth: number): void => {
    if (nodes.length === 0) return;
    items.push(`${'  '.repeat(depth)}<ol>\n`);
    for (const node of nodes) {
      items.push(`${'  '.repeat(depth + 1)}<li>\n`);
      items.push(`${'  '.repeat(depth + 2)}<a href="${escapeXml(node.src)}">${escapeXml(node.label)}</a>\n`);
      render(node.children, depth + 2);
      items.push(`${'  '.repeat(depth + 1)}</li>\n`);
    }
    items.push(`${'  '.repeat(depth)}</ol>\n`);
  };
  render(buildNavTree(parts), 3);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE html>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(m.language)}">\n` +
    '  <head>\n' +
    '    <meta charset="utf-8"/>\n' +
    `    <title>${escapeXml(m.title)}</title>\n` +
    '  </head>\n' +
    '  <body>\n' +
    '    <nav epub:type="toc" id="toc">\n' +
    `      <h1>${escapeXml(m.title)}</h1>\n` +
    items.join('') +
    '    </nav>\n' +
    '  </body>\n' +
    '</html>\n'
  );
}

/** NCX 2005 nests by heading level too; `navPoint`s close when a same or shallower level starts. */
function buildNcx(m: EpubMetadata, parts: EpubPart[]): string {
  const entries: Array<{ level: number; label: string; src: string }> = [];
  for (const part of parts) {
    if (part.headings.length === 0) {
      entries.push({ level: 1, label: part.title, src: `Text/${partFilename(part)}` });
    } else {
      for (const heading of part.headings) {
        entries.push({ level: heading.level, label: heading.text, src: `Text/${partFilename(part)}#${heading.anchor}` });
      }
    }
  }
  const navPoints: string[] = [];
  const open: number[] = [];
  let order = 0;
  for (const entry of entries) {
    while (open.length > 0 && open[open.length - 1]! >= entry.level) {
      navPoints.push(`${'  '.repeat(open.length + 1)}</navPoint>\n`);
      open.pop();
    }
    order++;
    const indent = '  '.repeat(open.length + 2);
    const labelIndent = '  '.repeat(open.length + 3);
    navPoints.push(`${indent}<navPoint id="navPoint-${order}" playOrder="${order}">\n`);
    navPoints.push(`${labelIndent}<navLabel><text>${escapeXml(entry.label)}</text></navLabel>\n`);
    navPoints.push(`${labelIndent}<content src="${escapeXml(entry.src)}"/>\n`);
    open.push(entry.level);
  }
  while (open.length > 0) {
    navPoints.push(`${'  '.repeat(open.length + 1)}</navPoint>\n`);
    open.pop();
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
    '  <head>\n' +
    `    <meta name="dtb:uid" content="${escapeXml(m.identifier)}"/>\n` +
    '  </head>\n' +
    `  <docTitle><text>${escapeXml(m.title)}</text></docTitle>\n` +
    '  <navMap>\n' +
    navPoints.join('') +
    '  </navMap>\n' +
    '</ncx>\n'
  );
}

/** Dart `int.tryParse` without a radix: optional sign, decimal or `0x` hex digits, surrounding whitespace. */
function dartIntTryParse(text: string): number | null {
  const match = /^([+-]?)(?:([0-9]+)|0[xX]([0-9a-fA-F]+))$/.exec(dartTrim(text));
  if (match === null) return null;
  const value = match[2] !== undefined ? Number.parseInt(match[2], 10) : Number.parseInt(match[3]!, 16);
  return match[1] === '-' ? -value : value;
}

/** Dart `String.trim`: Unicode White_Space plus BOM, which (unlike JS) includes U+0085. */
function dartTrim(text: string): string {
  return text.replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g, '');
}

/**
 * Characters Dart's `toUpperCase` leaves unchanged but JS maps: special
 * casings JS expands (ß, ligatures) and letters added after Dart's Unicode
 * tables (Georgian Mtavruli, Cherokee, newer Latin extensions...).
 */
const dartCaseless =
  /[\u{df}\u{149}\u{19b}\u{1f0}\u{23f}-\u{240}\u{252}\u{25c}\u{261}\u{264}-\u{266}\u{26a}\u{26c}\u{282}\u{287}\u{29d}-\u{29e}\u{390}\u{3b0}\u{3f3}\u{525}\u{527}\u{529}\u{52b}\u{52d}\u{52f}\u{587}\u{10d0}-\u{10fa}\u{10fd}-\u{10ff}\u{13f8}-\u{13fd}\u{1c80}-\u{1c88}\u{1c8a}\u{1d8e}\u{1e96}-\u{1e9a}\u{1f50}\u{1f52}\u{1f54}\u{1f56}\u{1f88}-\u{1f8f}\u{1f98}-\u{1f9f}\u{1fa8}-\u{1faf}\u{1fb2}\u{1fb4}\u{1fb6}-\u{1fb7}\u{1fbc}\u{1fc2}\u{1fc4}\u{1fc6}-\u{1fc7}\u{1fcc}\u{1fd2}-\u{1fd3}\u{1fd6}-\u{1fd7}\u{1fe2}-\u{1fe4}\u{1fe6}-\u{1fe7}\u{1ff2}\u{1ff4}\u{1ff6}-\u{1ff7}\u{1ffc}\u{2c5f}\u{2cec}\u{2cee}\u{2cf3}\u{2d27}\u{2d2d}\u{a661}\u{a699}\u{a69b}\u{a791}\u{a793}-\u{a794}\u{a797}\u{a799}\u{a79b}\u{a79d}\u{a79f}\u{a7a1}\u{a7a3}\u{a7a5}\u{a7a7}\u{a7a9}\u{a7b5}\u{a7b7}\u{a7b9}\u{a7bb}\u{a7bd}\u{a7bf}\u{a7c1}\u{a7c3}\u{a7c8}\u{a7ca}\u{a7cd}\u{a7cf}\u{a7d1}\u{a7d3}\u{a7d5}\u{a7d7}\u{a7d9}\u{a7db}\u{a7f6}\u{ab53}\u{ab70}-\u{abbf}\u{fb00}-\u{fb06}\u{fb13}-\u{fb17}\u{104d8}-\u{104fb}\u{10597}-\u{105a1}\u{105a3}-\u{105b1}\u{105b3}-\u{105b9}\u{105bb}-\u{105bc}\u{10cc0}-\u{10cf2}\u{10d70}-\u{10d85}\u{118c0}-\u{118df}\u{16e60}-\u{16e7f}\u{16ebb}-\u{16ed3}\u{1e922}-\u{1e943}]/gu;

/** Dart `text.toUpperCase() == text`. */
function isDartUpperCase(text: string): boolean {
  const cased = text.replace(dartCaseless, '');
  return cased.toUpperCase() === cased;
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
