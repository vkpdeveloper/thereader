import * as bunTest from 'bun:test';
import { unzipSync, zipSync } from 'fflate';
import { crc32, sha256Hex, utf8Encode } from './bytes';
import { repackOrder, writeCbz, type RepackEntry } from './cbzWriter';
import { comicMetadata, titleFromFileName } from './comicInfo';
import { ImportError, inspectFile, sourceKind } from './index';
import { extractRar } from './rar';

// Run with `cd apps/web && bun test src/lib/import`.

const { describe, test } = bunTest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

const bun = (globalThis as unknown as {
  Bun: { file(path: string): Blob; resolveSync(specifier: string, from: string): string };
}).Bun;
const here = decodeURIComponent(new URL('.', import.meta.url).pathname);
/** The unrar binary as the browser would fetch it. */
const wasm = (): Promise<ArrayBuffer> => bun.file(bun.resolveSync('node-unrar-js/esm/js/unrar.wasm', here)).arrayBuffer();
const fileOf = (bytes: Uint8Array, name: string): File => new File([bytes as BlobPart], name);
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

async function rejection(promise: Promise<unknown>): Promise<ImportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    return error as ImportError;
  }
  throw new Error('expected a rejection');
}

/** The reference vector's input entries (docs/comics.md "CBR → CBZ repack"). */
const VECTOR: Array<[string, Uint8Array]> = [
  ['Comic/ComicInfo.xml', utf8Encode('<?xml version="1.0"?><ComicInfo><Series>Vector</Series></ComicInfo>')],
  ['Comic/page10.jpg', latin1('\xff\xd8\xff ten')],
  ['Comic/page2.JPG', latin1('\xff\xd8\xff two')],
  ['Comic/page02b.png', latin1('\x89PNG two-b')],
  ['Comic/Cover.webp', utf8Encode('RIFF cover')],
  ['Comic/__MACOSX/._page2.jpg', utf8Encode('junk')],
  ['Comic/.hidden.jpg', utf8Encode('hidden')],
  ['Comic/notes.txt', utf8Encode('notes')],
  ['Comic/extras/001.jpg', latin1('\xff\xd8\xff extra')],
];
const VECTOR_SHA = 'f425a5b825fd0263e84f6a9106d6ca08e240adb2982c0007e4c644835dace109';

const repackEntries = (files: Array<[string, Uint8Array]>): RepackEntry[] => {
  const byName = new Map(files);
  return repackOrder(byName.keys()).map((path) => {
    const bytes = byName.get(path)!;
    return { path, data: new Blob([bytes as BlobPart]), crc32: crc32(bytes) };
  });
};

// ---------------------------------------------------------------- RAR fixtures

const vint = (value: number): number[] => {
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
};
const u32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
const u16 = (value: number): number[] => [value & 0xff, value >>> 8];

/**
 * A RAR5 archive with every file stored (method 0), written to the RARLAB
 * format description: signature, main header, a file header per file with
 * its data, end of archive. Header CRC-32 covers the size field onwards.
 */
function rar5(files: Array<[string, Uint8Array]>, options: { volume?: boolean } = {}): Uint8Array {
  const block = (fields: number[], data: Uint8Array = new Uint8Array(0)): number[] => {
    const body = [...vint(fields.length), ...fields];
    return [...u32(crc32(Uint8Array.from(body))), ...body, ...data];
  };
  const out = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
  // Main archive header: type 1, no header flags, archive flags (0x0001 = volume).
  out.push(...block([1, 0, options.volume ? 0x0001 : 0]));
  for (const [name, data] of files) {
    const encoded = utf8Encode(name);
    out.push(
      ...block(
        [
          2, // file header
          0x0002, // header flags: data area present
          ...vint(data.length), // data size
          0x0004, // file flags: data CRC-32 present
          ...vint(data.length), // unpacked size
          0x20, // attributes
          ...u32(crc32(data)),
          0, // compression: version 0, method 0 (store)
          0, // host OS: Windows
          ...vint(encoded.length),
          ...encoded,
        ],
        data,
      ),
    );
  }
  out.push(...block([5, 0, 0]));
  return Uint8Array.from(out);
}

/** The same in the RAR 1.5–4.x layout: 16-bit header CRCs, fixed-width fields. */
function rar4(files: Array<[string, Uint8Array]>): Uint8Array {
  const header = (type: number, flags: number, rest: number[]): number[] => {
    const body = [type, ...u16(flags), ...u16(7 + rest.length), ...rest];
    return [...u16(crc32(Uint8Array.from(body)) & 0xffff), ...body];
  };
  const out = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
  out.push(...header(0x73, 0, [0, 0, 0, 0, 0, 0]));
  for (const [name, data] of files) {
    const encoded = [...name].map((c) => c.charCodeAt(0));
    out.push(
      ...header(0x74, 0x8000, [
        ...u32(data.length), // packed size
        ...u32(data.length), // unpacked size
        0, // host OS: MS-DOS
        ...u32(crc32(data)),
        ...u32(0x00210000), // DOS date 1980-01-01, time 0
        20, // version needed: 2.0
        0x30, // method: store
        ...u16(encoded.length),
        ...u32(0x20),
        ...encoded,
      ]),
      ...data,
    );
  }
  out.push(...header(0x7b, 0x4000, []));
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- tests

describe('writeCbz: deterministic repack', () => {
  test('reproduces the docs/comics.md reference vector', async () => {
    const entries = repackEntries(VECTOR);
    expect(entries.map((e) => e.path)).toEqual([
      'Comic/Cover.webp',
      'Comic/extras/001.jpg',
      'Comic/page2.JPG',
      'Comic/page02b.png',
      'Comic/page10.jpg',
      'Comic/ComicInfo.xml',
    ]);
    const cbz = await writeCbz(entries);
    const bytes = new Uint8Array(await cbz.blob.arrayBuffer());
    expect(cbz.size).toBe(794);
    expect(bytes.length).toBe(794);
    expect(cbz.sha256).toBe(VECTOR_SHA);
    expect(await sha256Hex(bytes)).toBe(VECTOR_SHA);
    expect(cbz.blob.type).toBe('application/vnd.comicbook+zip');
    // Any ZIP reader opens it.
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped)).toEqual(entries.map((e) => e.path));
    expect(new TextDecoder().decode(unzipped['Comic/Cover.webp'])).toBe('RIFF cover');
  });
});

describe('sourceKind: magic bytes', () => {
  const head = (bytes: number[], length = 263): Uint8Array => {
    const out = new Uint8Array(length);
    out.set(bytes);
    return out;
  };

  test('recognises ZIP, RAR4, RAR5 and PalmDB regardless of the file name', () => {
    expect(sourceKind(head([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(sourceKind(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(sourceKind(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe('rar');
    const mobi = head([]);
    mobi.set(utf8Encode('BOOKMOBI'), 60);
    expect(sourceKind(mobi)).toBe('mobi');
    expect(sourceKind(head([...utf8Encode('hello')]))).toBe(null);
    // "Rar!" with an unknown version byte is not a RAR we can read.
    expect(sourceKind(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x02, 0x00]))).toBe(null);
  });

  test('refuses CB7 and CBT, and recognizes PDF', () => {
    expect(() => sourceKind(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toThrow('CB7 (7-Zip) comics are not supported');
    const tar = head([...utf8Encode('page001.jpg')]);
    tar.set(utf8Encode('ustar'), 257);
    expect(() => sourceKind(tar)).toThrow('CBT (TAR) comics are not supported');
    expect(sourceKind(head([...utf8Encode('%PDF-1.7')]))).toBe('pdf');
  });

  test('inspectFile refuses them before reading further', async () => {
    const seven = fileOf(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'issue.cb7');
    expect((await rejection(inspectFile(seven))).code).toBe('UNSUPPORTED_FILE');
  });
});

describe('comicMetadata: ComicInfo.xml', () => {
  const info = (xml: string): Uint8Array => utf8Encode(xml);

  test('composes series, number and title; takes writer, summary, language and genres', () => {
    const metadata = comicMetadata(
      info(
        '<?xml version="1.0"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
          '<Title>The Long Night</Title><Series>Night Watch</Series><Number>3</Number>' +
          '<Summary>  Three   lines\nof text. </Summary><Writer>A. Writer</Writer><Penciller>P. Artist</Penciller>' +
          '<Genre>Horror, Mystery,  ,Horror</Genre><LanguageISO>fr</LanguageISO></ComicInfo>',
      ),
      'night_watch_003.cbz',
    );
    expect(metadata).toEqual({
      title: 'Night Watch #3: The Long Night',
      author: 'A. Writer',
      description: 'Three lines of text.',
      language: 'fr',
      subjects: ['Comics', 'Horror', 'Mystery'],
    });
  });

  test('falls back to the penciller, the file name and defaults', () => {
    expect(comicMetadata(info('<ComicInfo><Series>Solo</Series><Penciller>P</Penciller></ComicInfo>'), 'x.cbz')).toMatchObject({
      title: 'Solo',
      author: 'P',
    });
    expect(comicMetadata(info('<ComicInfo><Title>Only a title</Title></ComicInfo>'), 'x.cbz').title).toBe('Only a title');
    const none = comicMetadata(null, 'Saga_Vol_1 (2012).cbr');
    expect(none).toEqual({ title: 'Saga Vol 1 (2012)', author: 'Unknown', description: '', language: 'en', subjects: ['Comics'] });
    expect(titleFromFileName('/path/to/.cbz')).toBe('.cbz');
    expect(comicMetadata(null, '.cbz').title).toBe('.cbz');
  });

  test('ignores broken, foreign or entity-laden XML and invalid languages', () => {
    expect(comicMetadata(info('<ComicInfo><Title>Open'), 'a_b.cbz').title).toBe('a b');
    expect(comicMetadata(info('<Other><Title>Nope</Title></Other>'), 'file.cbz').title).toBe('file');
    const bomb = '<!DOCTYPE ComicInfo [<!ENTITY a "aaaa">]><ComicInfo><Title>&a;</Title></ComicInfo>';
    expect(comicMetadata(info(bomb), 'safe.cbz').title).toBe('safe');
    const external = '<!DOCTYPE ComicInfo SYSTEM "ComicInfo.dtd"><ComicInfo><Title>Kept</Title></ComicInfo>';
    expect(comicMetadata(info(external), 'x.cbz').title).toBe('Kept');
    expect(comicMetadata(info('<ComicInfo><LanguageISO>not a language</LanguageISO></ComicInfo>'), 'x.cbz').language).toBe('en');
  });

  test('respects the API metadata limits', () => {
    const genres = Array.from({ length: 40 }, (_, i) => `Genre ${i} ${'x'.repeat(120)}`).join(',');
    const metadata = comicMetadata(
      info(`<ComicInfo><Title>${'t'.repeat(400)}</Title><Writer>w\u0007ho</Writer><Summary>${'s'.repeat(5000)}</Summary><Genre>${genres}</Genre></ComicInfo>`),
      'x.cbz',
    );
    expect(metadata.title.length).toBeLessThanOrEqual(300);
    expect(metadata.author).not.toMatch(/[\u0000-\u001f]/);
    expect(metadata.description.length).toBeLessThanOrEqual(4000);
    expect(metadata.subjects.length).toBe(32);
    expect(metadata.subjects.every((subject) => subject.length <= 100)).toBe(true);
  });
});

describe('extractRar: CBR conversion', () => {
  test('a RAR5 archive of the reference entries repacks to the reference CBZ', async () => {
    const archive = rar5(VECTOR);
    expect(sourceKind(archive)).toBe('rar');
    const { entries, comicInfo } = await extractRar(archive.slice().buffer, await wasm(), 1024 * 1024);
    expect(entries.map((e) => e.path)).toEqual(repackEntries(VECTOR).map((e) => e.path));
    expect(new TextDecoder().decode(comicInfo!)).toContain('<Series>Vector</Series>');
    const cbz = await writeCbz(entries);
    expect(cbz.size).toBe(794);
    expect(cbz.sha256).toBe(VECTOR_SHA);
  });

  test('RAR4 archives and Windows separators work too', async () => {
    const archive = rar4([
      ['Book\\p2.jpg', latin1('\xff\xd8\xff 2')],
      ['Book\\p1.jpg', latin1('\xff\xd8\xff 1')],
      ['Book\\readme.txt', utf8Encode('skip me')],
    ]);
    expect(sourceKind(archive)).toBe('rar');
    const { entries, comicInfo } = await extractRar(archive.slice().buffer, await wasm(), 1024 * 1024);
    expect(entries.map((e) => e.path)).toEqual(['Book/p1.jpg', 'Book/p2.jpg']);
    expect(new Uint8Array(await entries[0]!.data.arrayBuffer())).toEqual(latin1('\xff\xd8\xff 1'));
    expect(entries[0]!.crc32).toBe(crc32(latin1('\xff\xd8\xff 1')));
    expect(comicInfo).toBe(null);
  });

  test('refuses archives without pages, over the size limit, split or damaged', async () => {
    const binary = await wasm();
    const noPages = await rejection(extractRar(rar5([['notes.txt', utf8Encode('hi')]]).buffer as ArrayBuffer, binary, 1024));
    expect(noPages.message).toBe('This archive has no comic pages.');
    const big = await rejection(extractRar(rar5([['p.jpg', new Uint8Array(4096)]]).buffer as ArrayBuffer, binary, 1024));
    expect(big.message).toBe('Comic imports are limited to 1 GiB.');
    const split = await rejection(extractRar(rar5([['p.jpg', utf8Encode('x')]], { volume: true }).buffer as ArrayBuffer, binary, 1024));
    expect(split.message).toBe('Split (multi-volume) CBR archives are not supported.');
    const damaged = rar5([['p.jpg', utf8Encode('page bytes')]]);
    damaged[damaged.length - 20] ^= 0xff;
    expect((await rejection(extractRar(damaged.buffer as ArrayBuffer, binary, 1024))).code).toBe('INVALID_COMIC');
  });
});

describe('inspectFile: CBZ', () => {
  const page = latin1('\xff\xd8\xff\xe0 page');

  test('keeps the picked bytes and reads ComicInfo.xml, even when misnamed', async () => {
    const zip = zipSync({
      'b.jpg': [page, { level: 0 }],
      'a.jpg': page,
      'ComicInfo.xml': utf8Encode('<ComicInfo><Series>Zipped</Series><Number>1</Number><Writer>W</Writer></ComicInfo>'),
    });
    const inspected = await inspectFile(fileOf(zip, 'mislabelled.epub'));
    expect(inspected.format).toBe('comic');
    expect(inspected.converted).toBe(false);
    expect(inspected.title).toBe('Zipped #1');
    expect(inspected.author).toBe('W');
    expect(inspected.subjects).toEqual(['Comics']);
    expect(inspected.sha256).toBe(await sha256Hex(zip));
    expect(inspected.fileSize).toBe(zip.length);
    expect(inspected.epub.type).toBe('application/vnd.comicbook+zip');
    expect(new Uint8Array(await inspected.epub.arrayBuffer())).toEqual(zip);
  });

  test('refuses empty, encrypted and unsafe archives', async () => {
    const empty = zipSync({ 'notes.txt': utf8Encode('no pages') });
    expect((await rejection(inspectFile(fileOf(empty, 'empty.cbz')))).message).toBe('This archive has no comic pages.');

    const encrypted = zipSync({ 'p.jpg': [page, { level: 0 }] });
    // General-purpose flag bit 0 in the central record (the local header is not consulted).
    const directory = encrypted.length - 22 - (46 + 'p.jpg'.length);
    encrypted[directory + 8]! |= 1;
    expect((await rejection(inspectFile(fileOf(encrypted, 'locked.cbz')))).message).toBe('Password-protected comics are not supported.');

    const escape = zipSync({ '../p.jpg': [page, { level: 0 }] });
    expect((await rejection(inspectFile(fileOf(escape, 'escape.cbz')))).message).toBe('The comic archive has unsafe or duplicate file names.');
  });
});
