import { describe, expect, test } from 'bun:test';
import type { Book } from '../../types';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl, bookBlobKey } from '../library';
import { entryIdentity, parseDownload } from '../models';
import { Clock, ORIGIN, bookFor, streamResponse } from './helpers';

const bytesOf = (text: string) => new TextEncoder().encode(text);

function setup(respond: (book: Book) => Response) {
  const clock = new Clock();
  const kv = new MemoryKv();
  const blobs = new MemoryKv();
  let requests = 0;
  const library = new LibraryStoreImpl({
    kv,
    books: blobs,
    currentOrigin: () => ORIGIN,
    clientFor: () => ({
      openDownload: async (book: Book) => {
        requests++;
        return respond(book);
      },
    }),
    now: clock.now,
  });
  return { clock, kv, blobs, library, requests: () => requests };
}

const locator = { href: 'ch1.xhtml', progression: 0.4, totalProgression: 0.1, title: null, engine: 'web', raw: null };

describe('downloads', () => {
  test('verifies, stores the blob and reads it back with no network', async () => {
    const epub = bytesOf('first edition bytes');
    const book = await bookFor(epub);
    const s = setup(() => streamResponse(epub, 3, { 'content-length': String(epub.length) }));
    await s.library.load();
    const statuses: string[] = [];
    s.library.subscribe(() => {
      const e = s.library.entryFor(book);
      if (e && statuses[statuses.length - 1] !== e.download.status) statuses.push(e.download.status);
    });
    await s.library.download(book);
    const entry = s.library.entryFor(book)!;
    expect(entry.download.status).toBe('ready');
    expect(entry.download.path).toBe(bookBlobKey(entry.id, book.sha256));
    expect(statuses).toContain('downloading');
    expect(statuses).toContain('verifying');
    expect(s.library.canRead(entry.id)).toBe(true);

    const before = s.requests();
    const blob = await s.library.openForReading(entry.id);
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).toBe('first edition bytes');
    expect(blob.type).toBe('application/epub+zip');
    expect(s.requests()).toBe(before);
  });

  test('a checksum mismatch fails with the mobile message and stores nothing', async () => {
    const epub = bytesOf('genuine');
    const book = await bookFor(epub);
    const s = setup(() => streamResponse(bytesOf('tampere')));
    await s.library.load();
    await s.library.download(book);
    const entry = s.library.entryFor(book)!;
    expect(entry.download.status).toBe('failed');
    expect(entry.download.error).toBe('The downloaded book failed its integrity check.');
    expect(await s.blobs.keys()).toHaveLength(0);
    await expect(s.library.openForReading(entry.id)).rejects.toThrow('This book is not ready to read yet.');
  });

  test('a short body fails with the byte counts', async () => {
    const epub = bytesOf('0123456789');
    const book = await bookFor(epub);
    const s = setup(() => streamResponse(epub.slice(0, 6)));
    await s.library.load();
    await s.library.download(book);
    expect(s.library.entryFor(book)!.download.error).toBe('Download ended early: 6 of 10 bytes.');
  });

  test('a replacement edition keeps the verified copy until the new one verifies', async () => {
    const v1 = bytesOf('edition one');
    const v2 = bytesOf('edition two!');
    const book1 = await bookFor(v1, { version: '1' });
    const book2 = await bookFor(v2, { version: '2' });
    let serve: Uint8Array = v1;
    const s = setup(() => streamResponse(serve));
    await s.library.load();
    await s.library.download(book1);
    const id = s.library.entryFor(book1)!.id;
    await s.library.saveProgress(id, locator, book1.sha256);

    // The new edition fails verification: the old copy stays readable.
    serve = bytesOf('edition tw0!');
    await s.library.download(book2);
    let entry = s.library.entry(id)!;
    expect(entry.book.sha256).toBe(book1.sha256);
    expect(entry.download.status).toBe('ready');
    expect(entry.download.error).toBe('Update failed. The downloaded book failed its integrity check.');
    expect(entry.progress!.locator.progression).toBe(0.4);

    // It verifies: the old blob goes, progress of the old edition is cleared.
    serve = v2;
    await s.library.download(book2);
    entry = s.library.entry(id)!;
    expect(entry.book.sha256).toBe(book2.sha256);
    expect(entry.download.status).toBe('ready');
    expect(entry.progress).toBeNull();
    expect(await s.blobs.keys()).toEqual([bookBlobKey(id, book2.sha256)]);
  });

  test('progress from the old edition reader during a replacement lands on the verified copy', async () => {
    const v1 = bytesOf('edition one');
    const v2 = bytesOf('edition two!');
    const book1 = await bookFor(v1, { version: '1' });
    const book2 = await bookFor(v2, { version: '2' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const s = setup(() => {
      if (first) {
        first = false;
        return streamResponse(v1);
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate;
          controller.enqueue(v2);
          controller.close();
        },
      });
      return new Response(body);
    });
    await s.library.load();
    await s.library.download(book1);
    const id = s.library.entryFor(book1)!.id;
    const running = s.library.download(book2);
    await new Promise((r) => setTimeout(r, 0));
    await s.library.saveProgress(id, { ...locator, progression: 0.7 }, book1.sha256);
    // Persisted state still describes the verified edition, with the new progress.
    const stored = (await s.kv.get<{ entries: Array<{ book: Book; progress: { locator: { progression: number } } }> }>('library.v1'))!;
    expect(stored.entries[0]!.book.sha256).toBe(book1.sha256);
    expect(stored.entries[0]!.progress.locator.progression).toBe(0.7);
    s.library.cancelDownload(id);
    release();
    await running;
    const entry = s.library.entry(id)!;
    expect(entry.book.sha256).toBe(book1.sha256);
    expect(entry.download.status).toBe('ready');
    expect(entry.progress!.locator.progression).toBe(0.7);
  });
});

describe('persistence', () => {
  test('in-flight downloads reload as interrupted; missing blobs are not ready', async () => {
    expect(parseDownload({ status: 'downloading', receivedBytes: 5 })).toEqual({
      status: 'failed',
      receivedBytes: 5,
      totalBytes: null,
      path: null,
      error: 'Interrupted before it finished.',
    });
    const kv = new MemoryKv();
    const book = await bookFor(bytesOf('x'));
    await kv.set('library.v1', {
      entries: [
        {
          book,
          source: 'api',
          origin: ORIGIN,
          addedAt: '2026-09-01T00:00:00.000Z',
          download: { status: 'ready', receivedBytes: 1, totalBytes: 1, path: 'book:gone', error: null },
          progress: null,
          lastOpenedAt: null,
        },
        { garbage: true },
      ],
    });
    const library = new LibraryStoreImpl({ kv, books: new MemoryKv(), currentOrigin: () => ORIGIN, clientFor: () => ({ openDownload: async () => new Response() }) });
    await library.load();
    expect(library.getSnapshot().entries).toHaveLength(1);
    const entry = library.entry(entryIdentity(book.id, ORIGIN))!;
    expect(entry.download.status).toBe('failed');
    expect(entry.download.error).toBe('The file is missing from storage.');
  });

  test('remove with keepMetadata keeps the entry and its progress', async () => {
    const epub = bytesOf('bytes');
    const book = await bookFor(epub);
    const s = setup(() => streamResponse(epub));
    await s.library.load();
    await s.library.download(book);
    const id = s.library.entryFor(book)!.id;
    await s.library.markOpened(id, book.sha256);
    await s.library.saveProgress(id, locator, book.sha256);
    expect(s.library.getSnapshot().continueReading.map((e) => e.id)).toEqual([id]);
    await s.library.remove(id, { keepMetadata: true });
    const entry = s.library.entry(id)!;
    expect(entry.download.status).toBe('none');
    expect(entry.progress!.locator.progression).toBe(0.4);
    expect(await s.blobs.keys()).toHaveLength(0);
    expect(s.library.getSnapshot().continueReading).toHaveLength(0);
    await s.library.remove(id);
    expect(s.library.entry(id)).toBeUndefined();
  });
});
