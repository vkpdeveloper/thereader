import * as bunTest from 'bun:test';
import { unzipSync, zipSync } from 'fflate';
import type { Book } from '../types';
import { ImportError, bookFromInspected, inspectFile, uploadBook } from './index';
import { resolveUri, decodeComponent } from './epub';
import { parseXml, descendants, getAttribute } from './xml';

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
