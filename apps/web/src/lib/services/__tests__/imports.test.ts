import { describe, expect, test } from 'bun:test';
import type { Book } from '../../types';
import { ImportError, type InspectedBook, type UploadBook } from '../../import/contract';
import { ApiError } from '../contract';
import { ImportStoreImpl } from '../imports';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl } from '../library';
import { entryIdentity } from '../models';
import { Clock, ORIGIN, makeBook } from './helpers';
import { sha256OfBlob } from '../hash';

async function inspected(text: string): Promise<InspectedBook> {
  const epub = new Blob([text], { type: 'application/epub+zip' });
  return {
    epub,
    sha256: await sha256OfBlob(epub),
    fileSize: epub.size,
    title: 'Imported',
    author: 'Someone',
    description: '',
    language: 'en',
    subjects: [],
    cover: null,
    converted: false,
  };
}

async function setup(upload: UploadBook, kv = new MemoryKv(), blobs = new MemoryKv()) {
  const clock = new Clock();
  const library = new LibraryStoreImpl({
    kv,
    books: blobs,
    currentOrigin: () => ORIGIN,
    clientFor: () => ({ openDownload: async () => new Response(null, { status: 500 }) }),
    now: clock.now,
  });
  await library.load();
  let next: InspectedBook | null = null;
  const imports = new ImportStoreImpl({
    kv,
    books: blobs,
    library,
    currentOrigin: () => ORIGIN,
    inspect: async () => {
      if (!next) throw new ImportError('This file is not a valid EPUB.');
      return next;
    },
    upload,
    now: clock.now,
  });
  await imports.load();
  return {
    kv,
    blobs,
    library,
    imports,
    setNext(b: InspectedBook) {
      next = b;
    },
  };
}

const file = () => new File(['ignored'], 'book.epub');

describe('import queue', () => {
  test('imports locally, uploads, and adopts the canonical server edition under an alias', async () => {
    const book = await inspected('epub bytes');
    let uploads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const canonical = (b: Book): Book => ({ ...b, id: 'existing-server-book', downloadUrl: '/v1/books/existing-server-book/download', coverUrl: '/v1/books/existing-server-book/cover' });
    const s = await setup(async ({ book: b, epub, onProgress }) => {
      uploads++;
      expect(epub.size).toBe(b.fileSize);
      await gate;
      onProgress?.({ sent: b.fileSize, total: b.fileSize });
      return canonical(b);
    });
    s.setNext(book);

    const entry = await s.imports.importFile(file());
    const provisional = entryIdentity(`epub-${book.sha256}`, ORIGIN);
    expect(entry.id).toBe(provisional);
    expect(entry.download.status).toBe('ready');
    expect(s.library.canRead(entry.id)).toBe(true);
    expect(s.imports.isPending(entry.id)).toBe(true);
    const queued = (await s.kv.get<{ items: unknown[] }>('imports.pending.v1'))!;
    expect(queued.items).toHaveLength(1);

    release();
    await s.imports.retryPending();
    expect(uploads).toBe(1);
    const adopted = s.library.entry(provisional)!;
    expect(adopted.book.id).toBe('existing-server-book');
    expect(adopted.id).toBe(entryIdentity('existing-server-book', ORIGIN));
    expect(adopted.download.path).toBe(entry.download.path);
    expect(s.imports.isPending(provisional)).toBe(false);
    expect(s.imports.getSnapshot().pendingCount).toBe(0);
    expect((await s.kv.get<{ items: unknown[] }>('imports.pending.v1'))!.items).toHaveLength(0);
    expect(await (await s.library.openForReading(provisional)).text()).toBe('epub bytes');
  });

  test('a failed upload keeps the book readable and reports per entry', async () => {
    const s = await setup(async () => {
      throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
    });
    s.setNext(await inspected('abc'));
    const entry = await s.imports.importFile(file());
    await s.imports.retryPending();
    expect(s.imports.errorFor(entry.id)).toBe('Could not reach api.test.');
    expect(s.imports.isPending(entry.id)).toBe(true);
    expect(s.library.canRead(entry.id)).toBe(true);
  });

  test('the queue survives a reload and cancel removes it durably', async () => {
    const kv = new MemoryKv();
    const blobs = new MemoryKv();
    const never: UploadBook = () => new Promise(() => {});
    const first = await setup(async () => {
      throw new Error('offline');
    }, kv, blobs);
    first.setNext(await inspected('persisted'));
    const entry = await first.imports.importFile(file());
    await first.imports.retryPending();
    expect(first.imports.errorFor(entry.id)).toBe('Could not finish the import or upload. Your existing books are unchanged.');

    const second = await setup(never, kv, blobs);
    expect(second.imports.isPending(entry.id)).toBe(true);
    await second.imports.cancelPending(entry.id);
    expect(second.imports.isPending(entry.id)).toBe(false);
    const third = await setup(never, kv, blobs);
    expect(third.imports.getSnapshot().pendingCount).toBe(0);
  });

  test('importing a book that is already here returns the existing entry', async () => {
    const epub = await inspected('same');
    const s = await setup(async ({ book }) => book);
    s.setNext(epub);
    const first = await s.imports.importFile(file());
    await s.imports.retryPending();
    const again = await s.imports.importFile(file());
    expect(again.id).toBe(first.id);
    expect(s.library.getSnapshot().entries).toHaveLength(1);
  });

  test('inspection errors surface as user-facing messages', async () => {
    const s = await setup(async ({ book }) => book);
    await expect(s.imports.importFile(file())).rejects.toThrow('This file is not a valid EPUB.');
    expect(s.imports.getSnapshot().error).toBe('This file is not a valid EPUB.');
    expect(s.imports.getSnapshot().busy).toBe(false);
  });

  test('a pending import with no local bytes is dropped on load', async () => {
    const kv = new MemoryKv();
    await kv.set('imports.pending.v1', { items: [{ book: makeBook(), origin: ORIGIN, path: 'book:missing' }] });
    const s = await setup(async ({ book }) => book, kv);
    expect(s.imports.getSnapshot().pendingCount).toBe(0);
  });
});
