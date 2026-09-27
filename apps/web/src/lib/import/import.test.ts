import * as bunTest from 'bun:test';
import { unzipSync, zipSync } from 'fflate';
import type { Book } from '../types';
import { ImportError, bookFromInspected, inspectFile, uploadBook } from './index';
import { resolveUri, decodeComponent } from './epub';
import { parseXml, descendants, getAttribute } from './xml';
import { convertMobi, finalizeKf8Part } from './mobi';
import { sha256Hex } from './bytes';

// Run with `cd apps/web && bun test src/lib/import`.

const { afterEach, describe, test } = bunTest;
// Other test folders declare a narrower `bun:test`; these tests use the full matcher set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

const repo = new URL('../../../../../', import.meta.url);
const read = async (path: string): Promise<Uint8Array> => {
  const bun = (globalThis as unknown as { Bun: { file(path: string): Blob } }).Bun;
  return new Uint8Array(await bun.file(decodeURIComponent(new URL(path, repo).pathname)).arrayBuffer());
};
const fileOf = (bytes: Uint8Array, name: string): File => new File([bytes as BlobPart], name);
const decoder = new TextDecoder();

async function rejection(promise: Promise<unknown>): Promise<ImportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    return error as ImportError;
  }
  throw new Error('expected a rejection');
}

/** What `apps/api/src/upload.ts` `validateEpub` and EPUB readers require of the container. */
function expectValidPackage(epub: Uint8Array): Record<string, Uint8Array> {
  const header = new DataView(epub.buffer, epub.byteOffset, epub.byteLength);
  expect(header.getUint32(0, true)).toBe(0x04034b50);
  expect(header.getUint16(6, true) & 0x09).toBe(0); // no encryption, no data descriptor
  expect(header.getUint16(8, true)).toBe(0); // stored
  expect(header.getUint32(18, true)).toBe(20);
  expect(header.getUint32(22, true)).toBe(20);
  expect(header.getUint16(26, true)).toBe(8);
  expect(header.getUint16(28, true)).toBe(0);
  expect(decoder.decode(epub.subarray(30, 58))).toBe('mimetypeapplication/epub+zip');

  const entries = unzipSync(epub);
  const container = parseXml(decoder.decode(entries['META-INF/container.xml']));
  const opfPath = getAttribute(descendants(container).find((e) => e.local === 'rootfile')!, 'full-path')!;
  const opf = parseXml(decoder.decode(entries[opfPath]));
  const manifest = new Map(
    descendants(opf).filter((e) => e.local === 'item').map((e) => [getAttribute(e, 'id')!, getAttribute(e, 'href')!]),
  );
  const spine = descendants(opf).filter((e) => e.local === 'itemref');
  expect(spine.length).toBeGreaterThan(0);
  for (const itemref of spine) {
    const href = manifest.get(getAttribute(itemref, 'idref')!)!;
    expect(entries[decodeComponent(resolveUri(opfPath, href)!.path)]).toBeDefined();
  }
  for (const href of manifest.values()) expect(entries[decodeComponent(resolveUri(opfPath, href)!.path)]).toBeDefined();
  return entries;
}

describe('inspectFile: EPUB', () => {
  for (const name of ['a-walk-in-the-rain', 'notes-on-attention', 'the-quiet-hour']) {
    test(`reads ${name} like the mobile inspector`, async () => {
      const manifest = JSON.parse(decoder.decode(await read('apps/mobile/assets/samples/manifest.json'))) as { items: Book[] };
      const expected = manifest.items.find((item) => item.id === name)!;
      const bytes = await read(`apps/mobile/assets/samples/${name}.epub`);
      const inspected = await inspectFile(fileOf(bytes, `${name}.epub`));
      expect(inspected.converted).toBe(false);
      expect(inspected.sha256).toBe(expected.sha256);
      expect(inspected.fileSize).toBe(expected.fileSize);
      expect(inspected.title).toBe(expected.title);
      expect(inspected.author).toBe(expected.author);
      expect(inspected.description).toBe(expected.description);
      expect(inspected.language).toBe(expected.language);
      expect(inspected.subjects).toEqual(expected.subjects);
      expect(inspected.epub.type).toBe('application/epub+zip');
      expect(new Uint8Array(await inspected.epub.arrayBuffer())).toEqual(bytes);

      const book = bookFromInspected(inspected);
      expect(book).toMatchObject({
        id: `epub-${expected.sha256}`,
        version: expected.sha256.substring(0, 12),
        downloadUrl: `/v1/books/epub-${expected.sha256}/download`,
        coverUrl: null,
        fileSize: expected.fileSize,
        sha256: expected.sha256,
      });
      expect(Number.isNaN(Date.parse(book.updatedAt))).toBe(false);
    });
  }

  test('cleans metadata, strips HTML descriptions and extracts the EPUB 3 cover', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const opf = `<?xml version="1.0"?>
<!DOCTYPE package PUBLIC "+//ISBN 0-9673008-1-9//DTD OEB 1.0.1 Package//EN" "http://openebook.org/dtds/oeb-1.0.1/oebpkg101.dtd">
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>  Two\n  Lines </dc:title>
    <dc:creator>Ann</dc:creator><dc:creator>Bo</dc:creator>
    <dc:description>&lt;p&gt;Bold &amp;amp; &lt;b&gt;bright&lt;/b&gt;&lt;/p&gt;</dc:description>
    <dc:language>not a tag!</dc:language>
    <dc:subject>A</dc:subject><dc:subject>A</dc:subject><dc:subject><![CDATA[B & C]]></dc:subject>
  </metadata>
  <manifest>
    <item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="art" href="Images/art.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
    const epub = zipSync({
      mimetype: [new TextEncoder().encode('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': new TextEncoder().encode(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>',
      ),
      'OPS/package.opf': new TextEncoder().encode(opf),
      'OPS/Text/chapter 1.xhtml': new TextEncoder().encode('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'),
      'OPS/Images/art.png': png,
    });
    const inspected = await inspectFile(fileOf(epub, 'custom.bin'));
    expect(inspected.title).toBe('Two Lines');
    expect(inspected.author).toBe('Ann; Bo');
    expect(inspected.description).toBe('Bold & bright');
    expect(inspected.language).toBe('und');
    expect(inspected.subjects).toEqual(['A', 'B & C']);
    expect(inspected.cover?.type).toBe('image/png');
    expect(new Uint8Array(await inspected.cover!.arrayBuffer())).toEqual(png);
  });
});

describe('inspectFile: MOBI', () => {
  for (const edition of ['mobi7', 'kf8']) {
    test(`converts the ${edition} fixture into a complete EPUB`, async () => {
      const source = await read(`apps/mobile/test/fixtures/mobi/alice-${edition}.mobi`);
      // A misleading extension: detection is by content.
      const inspected = await inspectFile(fileOf(source, 'alice.epub'));
      expect(inspected.converted).toBe(true);
      expect(inspected.title).toBe("Alice's Adventures in Wonderland");
      expect(inspected.author).toBe('Lewis Carroll');
      expect(inspected.language).toBe('en');
      expect(inspected.cover?.type).toBe('image/jpeg');
      const epub = new Uint8Array(await inspected.epub.arrayBuffer());
      expect(inspected.fileSize).toBe(epub.length);
      expect(inspected.epub.type).toBe('application/epub+zip');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', epub as BufferSource));
      expect(inspected.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''));

      const entries = expectValidPackage(epub);
      const names = Object.keys(entries);
      expect(names.some((name) => name.startsWith('OEBPS/Images/'))).toBe(true);
      for (const [name, data] of Object.entries(entries)) {
        if (!/\.(xhtml|svg|opf|ncx)$/.test(name)) continue;
        const text = decoder.decode(data);
        expect(() => parseXml(text.replace('<!DOCTYPE html>', ''))).not.toThrow();
        expect(text.includes('kindle:')).toBe(false);
        for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
          const link = match[1]!;
          if (link.startsWith('#') || /^[a-z]+:/i.test(link)) continue;
          expect({ link: `${name} -> ${link}`, exists: entries[decodeComponent(resolveUri(name, link)!.path)] !== undefined })
            .toEqual({ link: `${name} -> ${link}`, exists: true });
        }
      }
      const parts = names.filter((name) => name.startsWith('OEBPS/Text/')).sort();
      if (edition === 'kf8') {
        expect(parts.length).toBe(19);
        expect(names.filter((name) => name.endsWith('.css')).length).toBe(3);
        expect(names.some((name) => name.endsWith('.svg'))).toBe(true);
        expect(decoder.decode(entries['OEBPS/Text/part0000.xhtml'])).toContain('../Images/image10004.svg');
        expect(decoder.decode(entries['OEBPS/Text/part0018.xhtml'])).toContain('part0004.xhtml#');
      } else {
        const texts = parts.map((name) => decoder.decode(entries[name]));
        expect(texts.length).toBeGreaterThan(1);
        expect(texts.some((t) => t.includes('CHAPTER I. Down the Rabbit-Hole'))).toBe(true);
        expect(texts.some((t) => t.includes('CHAPTER XII. Alice’s Evidence'))).toBe(true);
        expect(texts.join('')).toContain('mobi-pos-');
        for (const body of texts) {
          expect(body.includes('filepos=')).toBe(false);
          expect(body.includes('mbp:pagebreak')).toBe(false);
        }
      }
    });
  }

  test('conversion is byte-stable across repeat imports', async () => {
    const source = await read('apps/mobile/test/fixtures/mobi/alice-kf8.mobi');
    const first = await inspectFile(fileOf(source, 'a.mobi'));
    const second = await inspectFile(fileOf(source, 'b.azw3'));
    expect(first.sha256).toBe(second.sha256);
  });

  test('rejects damaged and DRM-protected Kindle files', async () => {
    const source = await read('apps/mobile/test/fixtures/mobi/alice-mobi7.mobi');
    const damaged = await rejection(inspectFile(fileOf(source.slice(0, 100), 'broken.mobi')));
    expect(damaged.message).toBe('This MOBI cannot be converted.');

    const encrypted = source.slice();
    const record0 = new DataView(encrypted.buffer).getUint32(78);
    new DataView(encrypted.buffer).setUint16(record0 + 12, 2); // PalmDOC encryption = Mobipocket DRM
    const drm = await rejection(inspectFile(fileOf(encrypted, 'locked.azw')));
    expect(drm.code).toBe('DRM');
    expect(drm.message).toContain('DRM-protected');
  });
});

// ---------------------------------------------------------------------------
// MOBI parity with the mobile converter

/**
 * Every entry the Dart converter (`mobi_converter.dart`) writes for the
 * fixtures, in ZIP order, with a SHA-256 prefix of its content. Regenerate
 * from `convertMobi` in Dart when the mobile converter changes.
 */
const dartConversions: Record<string, string[]> = {
  'alice-kf8': [
    'mimetype e468e350d1143eb6',
    'META-INF/container.xml 7ce02a1312e4fa4c',
    'OEBPS/content.opf b1c6fb93dde81f1b',
    'OEBPS/nav.xhtml 14308e42e161a0b6',
    'OEBPS/toc.ncx aa476b237b273f0b',
    'OEBPS/Text/part0000.xhtml 9d22c6460916ba96',
    'OEBPS/Text/part0001.xhtml f12f2d78df2b0f50',
    'OEBPS/Text/part0002.xhtml f6e98406167ef3f7',
    'OEBPS/Text/part0003.xhtml 56c97452d10052b3',
    'OEBPS/Text/part0004.xhtml b27ec5a9e5a4286e',
    'OEBPS/Text/part0005.xhtml 2ba9076a1653456f',
    'OEBPS/Text/part0006.xhtml 0710085cb308104b',
    'OEBPS/Text/part0007.xhtml c6ee54207fb37b69',
    'OEBPS/Text/part0008.xhtml f704b4ccc816881a',
    'OEBPS/Text/part0009.xhtml bea26a400774047a',
    'OEBPS/Text/part0010.xhtml ff55043f1d2c8cdb',
    'OEBPS/Text/part0011.xhtml 611b5086498554a4',
    'OEBPS/Text/part0012.xhtml f4731a1be2fa0a93',
    'OEBPS/Text/part0013.xhtml c6813d55822daaef',
    'OEBPS/Text/part0014.xhtml e09eb61a258ffb08',
    'OEBPS/Text/part0015.xhtml 90fa230b3283cde8',
    'OEBPS/Text/part0016.xhtml f1bb7c85847e68b0',
    'OEBPS/Text/part0017.xhtml b32d10a73bc20682',
    'OEBPS/Text/part0018.xhtml 96abc630441eae8a',
    'OEBPS/Images/image00000.jpg 2a34efaa254af4e3',
    'OEBPS/Images/image00001.jpg 47a54f7434520afc',
    'OEBPS/Images/image10004.svg 4f5622f0af5ed1f9',
    'OEBPS/Styles/style0001.css 6d41342290307c1e',
    'OEBPS/Styles/style0002.css 686758780bb13da9',
    'OEBPS/Styles/style0003.css 3efb4a54d1609c17',
  ],
  'alice-mobi7': [
    'mimetype e468e350d1143eb6',
    'META-INF/container.xml 7ce02a1312e4fa4c',
    'OEBPS/content.opf 39e3f6463a4f28dc',
    'OEBPS/nav.xhtml 303bc8d5324a9ba3',
    'OEBPS/toc.ncx 120c20ec25a55e21',
    'OEBPS/Text/part0000.xhtml 8d3c1713afdb66a3',
    'OEBPS/Text/part0001.xhtml fa41eeecd08f5083',
    'OEBPS/Text/part0002.xhtml 1a561ce64d460938',
    'OEBPS/Text/part0003.xhtml f24552fdc053d665',
    'OEBPS/Text/part0004.xhtml 2d03873c27cd2f40',
    'OEBPS/Text/part0005.xhtml 7340ba35549d932d',
    'OEBPS/Text/part0006.xhtml 21a76296940149f7',
    'OEBPS/Text/part0007.xhtml 21397334fb58f7ec',
    'OEBPS/Text/part0008.xhtml b6bea4a2437f238c',
    'OEBPS/Text/part0009.xhtml 09a24864f5e1856e',
    'OEBPS/Text/part0010.xhtml e979725798255647',
    'OEBPS/Text/part0011.xhtml 40c86966298f8f48',
    'OEBPS/Text/part0012.xhtml 34e6dbd3ccacf8cc',
    'OEBPS/Text/part0013.xhtml 0f030355b596f946',
    'OEBPS/Text/part0014.xhtml 2dc776bb2bef57e8',
    'OEBPS/Text/part0015.xhtml 6be0575a1bc5ec70',
    'OEBPS/Text/part0016.xhtml 074c9a79a8628ac9',
    'OEBPS/Text/part0017.xhtml d09ddb7014d01a63',
    'OEBPS/Text/part0018.xhtml 27a787230fb5c6c0',
    'OEBPS/Text/part0019.xhtml 74c1388d30460a35',
    'OEBPS/Images/image00000.jpg 2a34efaa254af4e3',
    'OEBPS/Images/image00001.jpg 47a54f7434520afc',
  ],
};

describe('convertMobi: parity with the mobile converter', () => {
  for (const [edition, expected] of Object.entries(dartConversions)) {
    test(`${edition} converts file-for-file like Dart`, async () => {
      const entries = unzipSync(convertMobi(await read(`apps/mobile/test/fixtures/mobi/${edition}.mobi`)));
      const actual = await Promise.all(
        Object.entries(entries).map(async ([name, data]) => `${name} ${(await sha256Hex(data)).substring(0, 16)}`),
      );
      expect(actual).toEqual(expected);
    });
  }

  test('navigation is labelled with titles read from the text, not "Part N"', async () => {
    const labels = async (edition: string): Promise<string[]> => {
      const entries = unzipSync(convertMobi(await read(`apps/mobile/test/fixtures/mobi/${edition}.mobi`)));
      const ncx = decoder.decode(entries['OEBPS/toc.ncx']);
      expect(decoder.decode(entries['OEBPS/nav.xhtml'])).not.toContain('>Part 1<');
      return [...ncx.matchAll(/<navLabel><text>([^<]*)<\/text>/g)].map((match) => match[1]!);
    };
    const kf8 = await labels('alice-kf8');
    expect(kf8.slice(0, 5)).toEqual([
      'Section 1',
      'Alice’s Adventures in Wonderland',
      'by Lewis Carroll',
      'THE MILLENNIUM FULCRUM EDITION 3.0',
      'Contents',
    ]);
    const mobi7 = await labels('alice-mobi7');
    expect(mobi7).toContain('CHAPTER I. Down the Rabbit-Hole');
    expect(mobi7).toContain('CHAPTER XII. Alice’s Evidence');
  });
});

/** Expected values produced by the Dart `_finalizeKf8Part` for the same bodies. */
const headingCases: Array<{ name: string; body: string; title: string; headings: Array<[number, string, string]>; xhtml: string }> = [
  {
    name: 'numberAndTitle',
    body: '<p class="c">1.</p><p class="c"><b>The Greatest Story Ever Told</b></p><p>The greatest story ever told is the story of everything.</p>',
    title: '1. The Greatest Story Ever Told',
    headings: [[1, '1. The Greatest Story Ever Told', 'mobi-hd-7-0']],
    xhtml: '<h1 style="text-align: center" id="mobi-hd-7-0">1. The Greatest Story Ever Told</h1><p>The greatest story ever told is the story of everything.</p>',
  },
  {
    name: 'allCaps',
    body: '<p><font size="3">PREFACE</font></p><p>Some introductory remarks, written in ordinary sentence case.</p>',
    title: 'PREFACE',
    headings: [[2, 'PREFACE', 'mobi-hd-7-0']],
    xhtml: '<h2 style="text-align: center" id="mobi-hd-7-0">PREFACE</h2><p>Some introductory remarks, written in ordinary sentence case.</p>',
  },
  {
    name: 'smallPrintCaption',
    body: '<p><font size="2">LUCRETIUS, C. 50 BC</font></p><p>Some introductory remarks, written in ordinary sentence case.</p>',
    title: 'Section 8',
    headings: [],
    xhtml: '<p><font size="2">LUCRETIUS, C. 50 BC</font></p><p>Some introductory remarks, written in ordinary sentence case.</p>',
  },
  {
    name: 'attribution',
    body: '<p><b>—NDT</b></p><p>Some introductory remarks, written in ordinary sentence case.</p>',
    title: 'Section 8',
    headings: [],
    xhtml: '<p><b>—NDT</b></p><p>Some introductory remarks, written in ordinary sentence case.</p>',
  },
  {
    name: 'existingHeadings',
    body: '<h1>1</h1><h2 id="t">Title</h2><p>Body.</p>',
    title: '1 Title',
    headings: [[1, '1 Title', 'mobi-hd-7-0']],
    xhtml: '<h1 id="mobi-hd-7-0">1</h1><h2 id="t">Title</h2><p>Body.</p>',
  },
  {
    name: 'firstRunOnly',
    body: '<h2>Part One</h2><br/><span> </span><h3>Chapter A</h3><p>Body text that is not a heading because it is long and lowercase.</p><h2>Later</h2>',
    title: 'Part One',
    headings: [[2, 'Part One', 'mobi-hd-7-0'], [3, 'Chapter A', 'mobi-hd-7-3']],
    xhtml: '<h2 id="mobi-hd-7-0">Part One</h2><br/><span> </span><h3 id="mobi-hd-7-3">Chapter A</h3><p>Body text that is not a heading because it is long and lowercase.</p><h2>Later</h2>',
  },
  {
    name: 'centeredBold',
    body: '<div align="center"><b>A Long Emphasized Title That Is Centered In Its Paragraph</b></div><p>body text in sentence case goes here.</p>',
    title: 'A Long Emphasized Title That Is Centered In Its Paragraph',
    headings: [[2, 'A Long Emphasized Title That Is Centered In Its Paragraph', 'mobi-hd-7-0']],
    xhtml: '<h2 style="text-align: center" id="mobi-hd-7-0">A Long Emphasized Title That Is Centered In Its Paragraph</h2><p>body text in sentence case goes here.</p>',
  },
  {
    name: 'keepsId',
    body: '<p id="c1" class="x">CHAPTER 3</p><p>A plain opening sentence follows here.</p>',
    title: 'CHAPTER 3',
    headings: [[1, 'CHAPTER 3', 'c1']],
    xhtml: '<h1 style="text-align: center" id="c1">CHAPTER 3</h1><p>A plain opening sentence follows here.</p>',
  },
  {
    name: 'dartUpperCase',
    body: '<p>STRAßE</p><p>body text in sentence case goes here.</p>',
    title: 'STRAßE',
    headings: [[2, 'STRAßE', 'mobi-hd-7-0']],
    xhtml: '<h2 style="text-align: center" id="mobi-hd-7-0">STRAßE</h2><p>body text in sentence case goes here.</p>',
  },
  {
    name: 'hexFontSize',
    body: '<p><font size="0x4">Quiet emphasis</font></p><p>body text in sentence case goes here.</p>',
    title: 'Quiet emphasis',
    headings: [[2, 'Quiet emphasis', 'mobi-hd-7-0']],
    xhtml: '<h2 style="text-align: center" id="mobi-hd-7-0">Quiet emphasis</h2><p>body text in sentence case goes here.</p>',
  },
  {
    name: 'nbspNumber',
    body: '<p>\u00a0 2 \u00a0</p><p><b>Two</b></p><p>body text in sentence case goes here.</p>',
    title: '2 Two',
    headings: [[1, '2 Two', 'mobi-hd-7-0']],
    xhtml: '<h1 style="text-align: center" id="mobi-hd-7-0">2 Two</h1><p>body text in sentence case goes here.</p>',
  },
  {
    name: 'noHeadings',
    body: '<p>Just a paragraph of ordinary prose, nothing more.</p>',
    title: 'Section 8',
    headings: [],
    xhtml: '<p>Just a paragraph of ordinary prose, nothing more.</p>',
  },
];

describe('finalizeKf8Part: chapter titles and headings like Dart', () => {
  for (const { name, body, title, headings, xhtml } of headingCases) {
    test(name, () => {
      const source =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body>${body}</body></html>`;
      const part = finalizeKf8Part(7, source);
      expect(part.title).toBe(title);
      expect(part.headings.map((heading) => [heading.level, heading.text, heading.anchor])).toEqual(headings);
      const text = decoder.decode(part.bytes);
      expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"')).toBe(true);
      expect(/<body>(.*)<\/body>/s.exec(text)![1]).toBe(xhtml);
    });
  }
});

describe('sha256Hex without WebCrypto', () => {
  test('plain-http origins (no crypto.subtle) hash imports in JS', async () => {
    const real = globalThis.crypto;
    const epubBytes = await read('apps/mobile/assets/samples/the-quiet-hour.epub');
    const mobiBytes = await read('apps/mobile/test/fixtures/mobi/alice-kf8.mobi');
    const native = [await sha256Hex(epubBytes), (await inspectFile(fileOf(mobiBytes, 'a.mobi'))).sha256];
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: real.getRandomValues.bind(real) },
      configurable: true,
      writable: true,
    });
    try {
      expect(globalThis.crypto.subtle).toBeUndefined();
      expect(await sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect((await inspectFile(fileOf(epubBytes, 'x.epub'))).sha256).toBe(native[0]);
      expect((await inspectFile(fileOf(mobiBytes, 'a.mobi'))).sha256).toBe(native[1]);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true, writable: true });
    }
  });
});

describe('inspectFile: rejection', () => {
  test('refuses files that are neither ZIP nor PalmDB', async () => {
    const error = await rejection(inspectFile(fileOf(new TextEncoder().encode('just some text, not a book'), 'book.epub')));
    expect(error.message).toBe('Choose an EPUB or MOBI file.');
  });

  test('refuses ZIPs that are not EPUB publications', async () => {
    const zip = zipSync({ 'readme.txt': new TextEncoder().encode('hello') });
    expect((await rejection(inspectFile(fileOf(zip, 'x.epub')))).message).toBe('The EPUB has missing or oversized metadata: mimetype.');
    const wrongType = zipSync({ mimetype: [new TextEncoder().encode('application/zip'), { level: 0 }] });
    expect((await rejection(inspectFile(fileOf(wrongType, 'x.epub')))).message).toBe('This file is not an EPUB publication.');
  });

  test('refuses EPUBs whose reading order points at missing chapters', async () => {
    const epub = zipSync({
      mimetype: [new TextEncoder().encode('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': new TextEncoder().encode('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
      'content.opf': new TextEncoder().encode(
        '<package><metadata/><manifest><item id="a" href="../a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>',
      ),
      'a.xhtml': new TextEncoder().encode('<html/>'),
    });
    // Like Dart's Uri.resolve on relative bases, "../a.xhtml" stays outside the container.
    expect((await rejection(inspectFile(fileOf(epub, 'x.epub')))).message).toBe('The EPUB is missing a reading-order chapter.');
  });

  test('refuses truncated ZIPs', async () => {
    const bytes = await read('apps/mobile/assets/samples/the-quiet-hour.epub');
    expect((await rejection(inspectFile(fileOf(bytes.slice(0, bytes.length - 30), 'x.epub')))).message).toBe(
      'The EPUB ZIP directory is damaged.',
    );
  });
});

// ---------------------------------------------------------------------------
// Upload

const origin = 'https://books.example';
const realFetch = globalThis.fetch;
const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  size: number;
}

type Handler = (call: Call) => { status: number; json: unknown } | 'network';

function install(handler: Handler): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      size: 0,
    };
    expect(init.redirect).toBe('manual');
    calls.push(call);
    const result = handler(call);
    if (result === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(result.json), { status: result.status });
  }) as typeof fetch;

  class MockXhr {
    static last: MockXhr | null = null;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    timeout = 0;
    responseType = '';
    status = 0;
    responseText = '';
    responseURL = '';
    private method = '';
    private url = '';
    private headers: Record<string, string> = {};
    private aborted = false;
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    }
    abort(): void {
      this.aborted = true;
      queueMicrotask(() => this.onabort?.());
    }
    send(body: Blob): void {
      MockXhr.last = this;
      const call: Call = { method: this.method, url: this.url, headers: this.headers, body, size: body.size };
      calls.push(call);
      setTimeout(() => {
        if (this.aborted) return;
        this.upload.onprogress?.({ loaded: Math.floor(body.size / 2) });
        this.upload.onprogress?.({ loaded: body.size });
        const result = handler(call);
        if (result === 'network') return this.onerror?.();
        this.status = result.status;
        this.responseText = JSON.stringify(result.json);
        this.responseURL = this.url;
        this.onload?.();
      }, 1);
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = MockXhr;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr;
});

const sha = 'a'.repeat(64);
function localBook(fileSize: number): Book {
  return {
    id: `epub-${sha}`,
    version: sha.substring(0, 12),
    title: 'Fixture',
    author: 'Author',
    description: '',
    language: 'en',
    subjects: ['One'],
    coverUrl: null,
    downloadUrl: `/v1/books/epub-${sha}/download`,
    fileSize,
    sha256: sha,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const serverBook = (book: Book): Book => ({ ...book, version: '1', coverUrl: `/v1/books/${book.id}/cover`, updatedAt: '2026-09-27T00:00:00.000Z' });

describe('uploadBook', () => {
  test('prepares, PUTs once with progress and returns the canonical book', async () => {
    const book = localBook(1000);
    const calls = install((call) => {
      if (call.url.endsWith('/v1/uploads/prepare')) {
        return { status: 200, json: { book: serverBook(book), uploaded: false, uploadUrl: `/v1/uploads/${sha}`, multipart: null } };
      }
      return { status: 201, json: { book: serverBook(book), uploaded: true } };
    });
    const progress: number[] = [];
    const result = await uploadBook({
      origin,
      book,
      epub: new Blob([new Uint8Array(1000)]),
      onProgress: ({ sent, total }) => {
        expect(total).toBe(1000);
        progress.push(sent);
      },
    });
    expect(result.coverUrl).toBe(`/v1/books/${book.id}/cover`);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${origin}/v1/uploads/prepare`,
      `PUT ${origin}/v1/uploads/${sha}`,
    ]);
    expect(calls[0]!.body).toEqual({
      sha256: sha,
      fileSize: 1000,
      title: 'Fixture',
      author: 'Author',
      description: '',
      language: 'en',
      subjects: ['One'],
    });
    expect(calls[1]!.headers['content-type']).toBe('application/epub+zip');
    expect(calls[1]!.size).toBe(1000);
    expect(progress).toEqual([500, 1000, 1000]);
  });

  test('returns immediately when the server already has the EPUB', async () => {
    const book = localBook(10);
    const calls = install(() => ({ status: 200, json: { book: serverBook(book), uploaded: true, uploadUrl: null, multipart: null } }));
    const result = await uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]) });
    expect(result.version).toBe('1');
    expect(calls.length).toBe(1);
  });

  test('multipart skips acknowledged parts, sends x-upload-id and completes', async () => {
    const partSize = 8 * 1024 * 1024;
    const book = localBook(partSize + 17);
    const calls = install((call) => {
      if (call.url.endsWith('/prepare')) {
        return {
          status: 200,
          json: {
            book: serverBook(book),
            uploaded: false,
            uploadUrl: null,
            multipart: { uploadId: 'session-one', partSize, parts: [{ partNumber: 1, etag: 'etag-1' }] },
          },
        };
      }
      if (call.method === 'PUT') return { status: 200, json: { partNumber: 2, etag: 'etag-2' } };
      return { status: 201, json: { book: serverBook(book), uploaded: true } };
    });
    const progress: number[] = [];
    await uploadBook({ origin, book, epub: new Blob([new Uint8Array(book.fileSize)]), onProgress: ({ sent }) => progress.push(sent) });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${origin}/v1/uploads/prepare`,
      `PUT ${origin}/v1/uploads/${sha}/parts/2`,
      `POST ${origin}/v1/uploads/${sha}/complete`,
    ]);
    expect(calls[1]!.headers).toEqual({ 'content-type': 'application/octet-stream', 'x-upload-id': 'session-one' });
    expect(calls[1]!.size).toBe(17);
    expect(calls[2]!.body).toEqual({ uploadId: 'session-one' });
    expect(progress[0]).toBe(partSize);
    expect(progress[progress.length - 1]).toBe(partSize + 17);
  });

  test('server errors surface their message and code', async () => {
    const book = localBook(10);
    install(() => ({ status: 429, json: { error: { code: 'UPLOAD_QUEUE_FULL', message: 'Too many uploads are waiting to finish.' } } }));
    const error = await rejection(uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]) }));
    expect(error.code).toBe('UPLOAD_QUEUE_FULL');
    expect(error.message).toBe('Too many uploads are waiting to finish.');
    expect(error.isNetwork).toBe(false);
  });

  test('network failures keep the book local and are retryable', async () => {
    const book = localBook(10);
    install((call) =>
      call.method === 'PUT'
        ? 'network'
        : { status: 200, json: { book: serverBook(book), uploaded: false, uploadUrl: `/v1/uploads/${sha}`, multipart: null } },
    );
    const error = await rejection(uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]) }));
    expect(error.code).toBe('NETWORK');
    expect(error.isNetwork).toBe(true);
    expect(error.message).toBe('Could not upload. Your book is saved on this device; retry when connected.');
  });

  test('rejects foreign upload destinations and responses for another EPUB', async () => {
    const book = localBook(10);
    install(() => ({ status: 200, json: { book: serverBook(book), uploaded: false, uploadUrl: 'https://evil.example/v1/uploads/x', multipart: null } }));
    const foreign = await rejection(uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]) }));
    expect(foreign.message).toBe('The server returned an invalid upload destination.');

    install(() => ({ status: 200, json: { book: { ...serverBook(book), fileSize: 11 }, uploaded: true } }));
    const other = await rejection(uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]) }));
    expect(other.message).toBe('The upload response describes a different EPUB.');
  });

  test('abort cancels the in-flight PUT', async () => {
    const book = localBook(10);
    install(() => ({ status: 200, json: { book: serverBook(book), uploaded: false, uploadUrl: `/v1/uploads/${sha}`, multipart: null } }));
    const controller = new AbortController();
    const pending = uploadBook({ origin, book, epub: new Blob([new Uint8Array(10)]), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const error = await rejection(pending);
    expect(error.code).toBe('ABORTED');
  });
});
