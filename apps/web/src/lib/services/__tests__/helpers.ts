import type { Book } from '../../types';
import type { SyncResponse } from '../api';
import { sha256OfBlob } from '../hash';
import { HighlightStoreImpl } from '../highlights';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl } from '../library';
import { SettingsStoreImpl } from '../settings';
import { SyncStoreImpl, type SyncEnvironment } from '../sync';
import { createMemoryLocks } from '../tabs';

export const ORIGIN = 'http://api.test';

export class Clock {
  constructor(public ms = Date.parse('2026-09-27T10:00:00.000Z')) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export function makeBook(overrides: Partial<Book> = {}): Book {
  const sha = overrides.sha256 ?? 'a'.repeat(64);
  return {
    id: 'moby-dick',
    version: '1',
    title: 'Moby Dick',
    author: 'Herman Melville',
    description: '',
    language: 'en',
    subjects: ['Sea'],
    coverUrl: null,
    downloadUrl: '/v1/books/moby-dick/download',
    fileSize: 10,
    sha256: sha,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A book whose sha256/fileSize describe `bytes`. */
export async function bookFor(bytes: Uint8Array, overrides: Partial<Book> = {}): Promise<Book> {
  const sha256 = await sha256OfBlob(new Blob([bytes as BlobPart]));
  return makeBook({ sha256, fileSize: bytes.length, ...overrides });
}

export function streamResponse(bytes: Uint8Array, chunk = 4, headers: Record<string, string> = {}): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(body, { status: 200, headers });
}

export function fakeEnv(visible = true): SyncEnvironment & { setVisible(v: boolean): void } {
  const handlers = new Set<(v: boolean) => void>();
  let current = visible;
  return {
    isVisible: () => current,
    onVisibilityChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onPageHide: () => () => {},
    setVisible(v) {
      current = v;
      for (const h of handlers) h(v);
    },
  };
}

export interface SyncCall {
  deviceId: string;
  changes: Array<Record<string, unknown> & { kind: string; payload: Record<string, unknown> }>;
  highlightsSince?: number;
}

export type SyncHandler = (call: SyncCall) => Promise<SyncResponse> | SyncResponse;

export const emptyResponse = (): SyncResponse => ({ serverTime: '2026-09-27T10:00:00.000Z', books: [], preferences: null });

export async function harness(options: { handler?: SyncHandler; books?: Record<string, Book> } = {}) {
  const clock = new Clock();
  const kv = new MemoryKv();
  const blobs = new MemoryKv();
  const locks = createMemoryLocks();
  const settings = new SettingsStoreImpl(kv, ORIGIN, undefined, clock.now);
  await settings.load();
  const library = new LibraryStoreImpl({
    kv,
    books: blobs,
    currentOrigin: () => settings.currentOrigin(),
    clientFor: () => ({ openDownload: async () => new Response(null, { status: 500 }) }),
    now: clock.now,
  });
  await library.load();
  const highlights = new HighlightStoreImpl(kv, undefined, clock.now);
  await highlights.load();
  const calls: SyncCall[] = [];
  let handler: SyncHandler = options.handler ?? (() => emptyResponse());
  const pendingUploads = new Set<string>();
  const env = fakeEnv();
  const sync = new SyncStoreImpl({
    kv,
    library,
    settings,
    highlights,
    locks,
    env,
    now: clock.now,
    pollInterval: 10 * 60_000,
    isUploadPending: (id) => pendingUploads.has(id),
    clientFor: () => ({
      async syncState(o) {
        const call = JSON.parse(JSON.stringify(o)) as SyncCall;
        calls.push(call);
        return handler(call);
      },
      async getBook(id) {
        const book = options.books?.[id];
        if (!book) throw new Error(`no book ${id}`);
        return book;
      },
    }),
  });
  await sync.load({ startTimers: false });
  return {
    clock,
    kv,
    blobs,
    settings,
    library,
    highlights,
    sync,
    calls,
    env,
    pendingUploads,
    setHandler(next: SyncHandler) {
      handler = next;
    },
    /** Lets microtask-scheduled captures and queued writes settle. */
    async settle() {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await sync.flush();
      }
    },
    pending() {
      return sync.stored.origins[ORIGIN]?.pending ?? {};
    },
  };
}

/** Adds a readable library entry without any network. */
export async function addBook(h: Awaited<ReturnType<typeof harness>>, book: Book) {
  await h.blobs.set(`book:x:${book.sha256}`, new Blob(['x']));
  return h.library.importLocal({ book, origin: ORIGIN, path: `book:x:${book.sha256}` });
}
