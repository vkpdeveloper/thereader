import { describe, expect, test } from 'bun:test';
import type { Book } from '../../types';
import { createApiClient, type FetchLike } from '../api';
import { ApiError } from '../contract';
import { sha256OfBlob } from '../hash';
import { MemoryKv } from '../kv';
import { LibraryStoreImpl, bookBlobKey } from '../library';
import { entryIdentity } from '../models';
import { ProgressiveDownload } from '../progressiveDownload';
import { SEGMENT_ALIGNMENT, ZIP_TAIL_WINDOW, defaultSegmentPolicy, planSegments, type SegmentPolicy } from '../segmentPlan';
import { makeBook } from './helpers';

const MiB = 1024 * 1024;
const ORIGIN_A = 'http://a.test';
const ORIGIN_B = 'http://b.test';

function pattern(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

async function bookOf(bytes: Uint8Array, overrides: Partial<Book> = {}): Promise<Book> {
  return makeBook({ sha256: await sha256OfBlob(new Blob([bytes as BlobPart])), fileSize: bytes.length, ...overrides });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Request {
  url: string;
  range: string | null;
  ifRange: string | null;
}

/**
 * The API's download route in miniature: `Range` + `If-Range` answer 206
 * with the edition ETag, bodies stream in small pieces. Hooks gate or fail
 * individual requests.
 */
function rangeServer(
  bytes: Uint8Array,
  sha256: string,
  options: {
    ignoreRanges?: boolean;
    piece?: number;
    /** Returning a promise holds the response until it settles. */
    gate?: (req: Request) => Promise<void> | undefined;
    /** Returning a status fails that request. */
    fail?: (req: Request, index: number) => number | undefined;
  } = {},
) {
  const requests: Request[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const req: Request = { url, range: headers.get('range'), ifRange: headers.get('if-range') };
    const index = requests.push(req) - 1;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const signal = init?.signal;
    try {
      await options.gate?.(req);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const status = options.fail?.(req, index);
      if (status) {
        inFlight--;
        return new Response(JSON.stringify({ error: { code: 'X', message: `status ${status}` } }), { status });
      }
    } catch (error) {
      inFlight--;
      throw error;
    }
    let start = 0;
    let end = bytes.length;
    let ranged = false;
    const match = req.range ? /^bytes=(\d+)-(\d+)$/.exec(req.range) : null;
    if (match && !options.ignoreRanges && (req.ifRange === null || req.ifRange === `"${sha256}"`)) {
      ranged = true;
      start = Number(match[1]);
      end = Math.min(bytes.length, Number(match[2]) + 1);
    }
    const piece = options.piece ?? 16 * 1024;
    let offset = start;
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        inFlight--;
      }
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          done();
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (offset >= end) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, Math.min(end, offset + piece)));
        offset += piece;
      },
      cancel: done,
    });
    const responseHeaders: Record<string, string> = {
      'content-length': String(end - start),
      etag: `"${sha256}"`,
      'accept-ranges': 'bytes',
    };
    if (ranged) responseHeaders['content-range'] = `bytes ${start}-${end - 1}/${bytes.length}`;
    return new Response(body, { status: ranged ? 206 : 200, headers: responseHeaders });
  };
  return {
    fetch,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    ranges: () => requests.map((r) => r.range),
  };
}

function library(origins: Record<string, FetchLike>, current: () => string, policy?: SegmentPolicy) {
  const kv = new MemoryKv();
  const blobs = new MemoryKv();
  const clientOrigins: string[] = [];
  const lib = new LibraryStoreImpl({
    kv,
    books: blobs,
    currentOrigin: current,
    clientFor: (origin) => {
      clientOrigins.push(origin);
      const f = origins[origin];
      if (!f) throw new Error(`no server at ${origin}`);
      return createApiClient(origin, { fetch: f, timeoutMs: 2_000 });
    },
    segmentPolicy: policy,
  });
  return { lib, kv, blobs, clientOrigins };
}

/** Small segments so multi-segment behaviour shows up on test-sized books. */
const smallPolicy: SegmentPolicy = {
  ...defaultSegmentPolicy,
  minSegment: 256 * 1024,
  maxSegment: 256 * 1024,
  singleRequestLimit: 256 * 1024,
  demandSplitDistance: 128 * 1024,
  retryDelayMs: 1,
};

describe('segment plan (mobile SegmentPolicy)', () => {
  test('a 181 MiB edition is 32 aligned segments after the ZIP tail', () => {
    const size = 181 * MiB + 12345;
    const plan = planSegments(defaultSegmentPolicy, size);
    expect(plan).toHaveLength(33);
    const [tail, ...rest] = plan;
    expect(tail![1]).toBe(size);
    expect(tail![0] % SEGMENT_ALIGNMENT).toBe(0);
    expect(size - tail![0]).toBeGreaterThanOrEqual(ZIP_TAIL_WINDOW);
    let next = 0;
    for (const [start, end] of rest) {
      expect(start).toBe(next);
      expect(start % SEGMENT_ALIGNMENT).toBe(0);
      next = end;
    }
    expect(next).toBe(tail![0]);
  });

  test('small books are one request; segments stay within 4..16 MiB', () => {
    expect(planSegments(defaultSegmentPolicy, 4 * MiB)).toEqual([[0, 4 * MiB]]);
    const plan = planSegments(defaultSegmentPolicy, 600 * MiB);
    expect(plan[1]![1] - plan[1]![0]).toBe(16 * MiB);
    const small = planSegments(defaultSegmentPolicy, 5 * MiB);
    expect(small[1]![1] - small[1]![0]).toBeLessThanOrEqual(small[0]![0]);
    expect(() => planSegments(defaultSegmentPolicy, 0)).toThrow();
  });
});

describe('streamRange', () => {
  test('delivers aligned chunks of the pinned edition', async () => {
    const bytes = pattern(300 * 1024);
    const book = await bookOf(bytes);
    const server = rangeServer(bytes, book.sha256, { piece: 10_000 });
    const client = createApiClient(ORIGIN_A, { fetch: server.fetch });
    const chunks: Uint8Array[] = [];
    await client.streamRange(book, 64 * 1024, 300 * 1024, { onChunk: (c) => void chunks.push(c.slice()) });
    expect(chunks.map((c) => c.length)).toEqual([65536, 65536, 65536, 45056]);
    expect(server.requests[0]!.range).toBe(`bytes=${64 * 1024}-${300 * 1024 - 1}`);
    expect(server.requests[0]!.ifRange).toBe(`"${book.sha256}"`);
    const joined = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    expect(joined).toEqual(bytes.slice(64 * 1024));
  });

  test('a server ignoring ranges is INVALID_RANGE with status 200; consumer errors pass through', async () => {
    const bytes = pattern(1000);
    const book = await bookOf(bytes);
    const client = createApiClient(ORIGIN_A, { fetch: rangeServer(bytes, book.sha256, { ignoreRanges: true }).fetch });
    const error = await client.streamRange(book, 0, 1000, { onChunk: () => undefined }).catch((e) => e);
    expect(error instanceof ApiError).toBe(true);
    expect((error as ApiError).code).toBe('INVALID_RANGE');
    expect((error as ApiError).status).toBe(200);

    const ok = createApiClient(ORIGIN_A, { fetch: rangeServer(bytes, book.sha256).fetch });
    const mine = new Error('mine');
    const thrown = await ok
      .streamRange(book, 0, 1000, {
        onChunk: () => {
          throw mine;
        },
      })
      .catch((e) => e);
    expect(thrown).toBe(mine);
  });

  test('a short body is TRUNCATED_RANGE; another edition is INVALID_RANGE', async () => {
    const bytes = pattern(1000);
    const book = await bookOf(bytes);
    const short: FetchLike = async () =>
      new Response(bytes.slice(0, 10), {
        status: 206,
        headers: { 'content-range': 'bytes 0-999/1000', etag: `"${book.sha256}"` },
      });
    const e1 = await createApiClient(ORIGIN_A, { fetch: short })
      .streamRange(book, 0, 1000, { onChunk: () => undefined })
      .catch((e) => e);
    expect((e1 as ApiError).code).toBe('TRUNCATED_RANGE');
    const other: FetchLike = async () =>
      new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-999/1000', etag: '"other"' } });
    const e2 = await createApiClient(ORIGIN_A, { fetch: other })
      .streamRange(book, 0, 1000, { onChunk: () => undefined })
      .catch((e) => e);
    expect((e2 as ApiError).code).toBe('INVALID_RANGE');
  });
});

describe('progressive downloads', () => {
  test('parallel ranges, ZIP tail first, bounded connections, verified bytes', async () => {
    const bytes = pattern(3 * MiB + 777);
    const book = await bookOf(bytes);
    const server = rangeServer(bytes, book.sha256);
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    const entry = s.lib.entryFor(book)!;
    expect(entry.download.status).toBe('ready');
    const plan = planSegments(smallPolicy, bytes.length);
    expect(server.requests).toHaveLength(plan.length);
    const [first] = plan;
    expect(server.requests[0]!.range).toBe(`bytes=${first![0]}-${first![1] - 1}`);
    expect(server.maxInFlight).toBeGreaterThan(1);
    expect(server.maxInFlight).toBeLessThanOrEqual(smallPolicy.connections);
    const stored = (await s.blobs.get<Blob>(bookBlobKey(entry.id, book.sha256)))!;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  });

  test('books over the spill threshold verify and read back across spilled runs', async () => {
    const bytes = pattern(21 * MiB + 5);
    const book = await bookOf(bytes);
    const server = rangeServer(bytes, book.sha256, { piece: 256 * 1024 });
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A);
    await s.lib.load();
    let lease: Awaited<ReturnType<typeof s.lib.openFile>> | null = null;
    const unsubscribe = s.lib.subscribe(() => {
      const e = s.lib.entryFor(book);
      if (!lease && e && s.lib.isProvisional(e.id)) void s.lib.openFile(e.id).then((f) => (lease = f));
    });
    await s.lib.download(book);
    unsubscribe();
    const entry = s.lib.entryFor(book)!;
    expect(entry.download.status).toBe('ready');
    // A lease opened early keeps working after verification.
    expect(lease).not.toBeNull();
    const probe = await lease!.read(9 * MiB - 3, 9 * MiB + 3);
    expect(probe).toEqual(bytes.slice(9 * MiB - 3, 9 * MiB + 3));
    lease!.close();
    const file = await s.lib.openFile(entry.id);
    expect(file.provisional).toBe(false);
    expect(await file.read(17 * MiB, 17 * MiB + 10)).toEqual(bytes.slice(17 * MiB, 17 * MiB + 10));
  });

  test('early reading: readable after tail + 5%, a far demand jumps the queue', async () => {
    const bytes = pattern(3 * MiB);
    const book = await bookOf(bytes);
    const plan = planSegments(smallPolicy, bytes.length);
    const released = new Set<number>();
    const waiting = new Map<number, () => void>();
    const startOf = (r: Request) => Number(/bytes=(\d+)/.exec(r.range ?? '')?.[1] ?? 0);
    const server = rangeServer(bytes, book.sha256, {
      gate: (r) => {
        const start = startOf(r);
        // The tail and the opening segment arrive; everything else waits.
        if (start === plan[0]![0] || start === 0 || released.has(start)) return undefined;
        return new Promise<void>((resolve) => waiting.set(start, resolve));
      },
    });
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    const running = s.lib.download(book);
    const id = entryIdentity(book.id, ORIGIN_A);
    for (let i = 0; i < 50 && !s.lib.isProvisional(id); i++) await tick();
    expect(s.lib.canRead(id)).toBe(true);
    expect(s.lib.isProvisional(id)).toBe(true);
    expect(s.lib.getSnapshot().earlyReadable).toEqual([id]);
    expect(s.lib.entry(id)!.download.status).toBe('downloading');

    const file = await s.lib.openFile(id);
    expect(file.provisional).toBe(true);
    expect(file.size).toBe(bytes.length);
    expect(await file.read(10, 20)).toEqual(bytes.slice(10, 20));
    // 2 MiB + 100 sits inside a gated background segment: the demand splits it.
    const far = 2 * MiB + 100;
    const before = server.requests.length;
    const reading = file.read(far, far + 50);
    for (let i = 0; i < 20 && server.requests.length === before; i++) await tick();
    const demand = server.requests.slice(before).find((r) => startOf(r) === Math.floor(far / SEGMENT_ALIGNMENT) * SEGMENT_ALIGNMENT);
    expect(demand).toBeDefined();
    released.add(startOf(demand!));
    waiting.get(startOf(demand!))?.();
    expect(await reading).toEqual(bytes.slice(far, far + 50));
    expect(s.lib.entry(id)!.download.status).toBe('downloading');

    // Release the rest; the verified copy replaces the lease.
    const drain = setInterval(() => {
      for (const [start, resolve] of waiting) {
        released.add(start);
        resolve();
        waiting.delete(start);
      }
    }, 1);
    await running;
    clearInterval(drain);
    expect(s.lib.entry(id)!.download.status).toBe('ready');
    expect(s.lib.isProvisional(id)).toBe(false);
    expect(s.lib.getSnapshot().earlyReadable).toEqual([]);
    file.close();
  });

  test('openForReading waits for an early-readable download to verify', async () => {
    const bytes = pattern(1 * MiB);
    const book = await bookOf(bytes);
    let hold!: () => void;
    const held = new Promise<void>((r) => (hold = r));
    let requests = 0;
    const server = rangeServer(bytes, book.sha256, {
      gate: () => (requests++ === 0 || requests === 2 ? undefined : held),
    });
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    const running = s.lib.download(book);
    const id = entryIdentity(book.id, ORIGIN_A);
    for (let i = 0; i < 50 && !s.lib.isProvisional(id); i++) await tick();
    expect(s.lib.isProvisional(id)).toBe(true);
    let opened = false;
    const opening = s.lib.openForReading(id).then((b) => {
      opened = true;
      return b;
    });
    await tick();
    expect(opened).toBe(false);
    hold();
    await running;
    const blob = await opening;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe('application/epub+zip');
  });

  test('a server without range support falls back to one sequential stream', async () => {
    const bytes = pattern(1 * MiB + 3);
    const book = await bookOf(bytes);
    const server = rangeServer(bytes, book.sha256, { ignoreRanges: true, piece: 5000 });
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    expect(s.lib.entryFor(book)!.download.status).toBe('ready');
    // One ranged attempt answered 200, then one plain download; never parallel.
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.range).toBeNull();
    expect(server.maxInFlight).toBe(1);
  });

  test('transient failures retry with backoff; permanent ones fail the download', async () => {
    const bytes = pattern(1 * MiB);
    const book = await bookOf(bytes);
    const flaky = rangeServer(bytes, book.sha256, { fail: (_, i) => (i === 1 || i === 2 ? 503 : undefined) });
    const s = library({ [ORIGIN_A]: flaky.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    expect(s.lib.entryFor(book)!.download.status).toBe('ready');
    expect(flaky.requests.length).toBe(planSegments(smallPolicy, bytes.length).length + 2);

    const broken = rangeServer(bytes, book.sha256, { fail: (_, i) => (i === 1 ? 404 : undefined) });
    const t = library({ [ORIGIN_A]: broken.fetch }, () => ORIGIN_A, smallPolicy);
    await t.lib.load();
    await t.lib.download(book);
    const entry = t.lib.entryFor(book)!;
    expect(entry.download.status).toBe('failed');
    expect(entry.download.error).toBe('status 404');
    expect(await t.blobs.keys()).toHaveLength(0);
  });

  test('corrupt bytes fail verification and nothing is stored', async () => {
    const bytes = pattern(1 * MiB);
    const book = await bookOf(bytes);
    const tampered = bytes.slice();
    tampered[700_000] ^= 1;
    const s = library({ [ORIGIN_A]: rangeServer(tampered, book.sha256).fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    const entry = s.lib.entryFor(book)!;
    expect(entry.download.status).toBe('failed');
    expect(entry.download.error).toBe('The downloaded book failed its integrity check.');
    expect(await s.blobs.keys()).toHaveLength(0);
  });

  test('cancelling stops the requests, resets the entry and ends early reading', async () => {
    const bytes = pattern(2 * MiB);
    const book = await bookOf(bytes);
    let calls = 0;
    const server = rangeServer(bytes, book.sha256, {
      gate: () => (calls++ < 2 ? undefined : new Promise<void>(() => undefined)),
    });
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    const running = s.lib.download(book);
    const id = entryIdentity(book.id, ORIGIN_A);
    for (let i = 0; i < 50 && !s.lib.isProvisional(id); i++) await tick();
    const file = await s.lib.openFile(id);
    s.lib.cancelDownload(id);
    await running;
    const entry = s.lib.entry(id)!;
    expect(entry.download.status).toBe('none');
    expect(entry.download.error).toBeNull();
    expect(s.lib.canRead(id)).toBe(false);
    await expect(file.read(1 * MiB, 1 * MiB + 1)).rejects.toThrow();
    file.close();
    expect(await s.blobs.keys()).toHaveLength(0);
  });
});

describe('origins', () => {
  test('retries and updates use the entry origin, never the current API', async () => {
    const bytes = pattern(200_000);
    const book = await bookOf(bytes);
    const a = rangeServer(bytes, book.sha256);
    const b = rangeServer(bytes, book.sha256);
    let current = ORIGIN_A;
    const s = library({ [ORIGIN_A]: a.fetch, [ORIGIN_B]: b.fetch }, () => current, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    const id = entryIdentity(book.id, ORIGIN_A);
    expect(s.lib.entry(id)!.origin).toBe(ORIGIN_A);
    await s.lib.remove(id, { keepMetadata: true });

    // The user switched API address; re-downloading the A entry still uses A.
    current = ORIGIN_B;
    const requestsA = a.requests.length;
    await s.lib.downloadEntry(id);
    expect(a.requests.length).toBe(requestsA + 1);
    expect(b.requests).toHaveLength(0);
    expect(s.lib.entry(id)!.download.status).toBe('ready');
    expect(s.lib.entryFor(book)).toBeUndefined();
    expect(s.lib.entryFor(book, ORIGIN_A)!.id).toBe(id);

    // A newer edition of the A entry also comes from A.
    const v2 = pattern(200_001, 9);
    const book2 = await bookOf(v2);
    const a2 = rangeServer(v2, book2.sha256);
    const t = library({ [ORIGIN_A]: a2.fetch }, () => ORIGIN_B, smallPolicy);
    await t.lib.load();
    await t.lib.download(book, { origin: ORIGIN_A }).catch(() => undefined);
    await t.lib.downloadEntry(id, book2);
    expect(t.lib.entry(id)!.book.sha256).toBe(book2.sha256);
    expect(t.lib.entry(id)!.download.status).toBe('ready');
    await expect(t.lib.downloadEntry(id, makeBook({ id: 'other' }))).rejects.toThrow();

    // Without an origin, downloads come from the current API.
    await s.lib.download(book);
    expect(b.requests.length).toBeGreaterThan(0);
    expect(s.lib.entryFor(book)!.origin).toBe(ORIGIN_B);
  });
});

describe('offline reading', () => {
  test('a downloaded book opens with zero network requests', async () => {
    const bytes = pattern(300_000);
    const book = await bookOf(bytes);
    const server = rangeServer(bytes, book.sha256);
    const s = library({ [ORIGIN_A]: server.fetch }, () => ORIGIN_A, smallPolicy);
    await s.lib.load();
    await s.lib.download(book);
    const id = s.lib.entryFor(book)!.id;
    const count = server.requests.length;

    // A fresh session over the same storage: no client is even created.
    const reopened = new LibraryStoreImpl({
      kv: s.kv,
      books: s.blobs,
      currentOrigin: () => ORIGIN_A,
      clientFor: () => {
        throw new Error('network used');
      },
    });
    await reopened.load();
    expect(reopened.canRead(id)).toBe(true);
    const blob = await reopened.openForReading(id);
    expect(blob.size).toBe(bytes.length);
    const file = await reopened.openFile(id);
    expect(await file.read(299_990, 300_000)).toEqual(bytes.slice(299_990));
    const slice = await file.slice(0, 4, 'application/zip');
    expect(slice.type).toBe('application/zip');
    expect(server.requests.length).toBe(count);
  });

  test('a direct ProgressiveDownload rejects invalid sizes', () => {
    expect(() => new ProgressiveDownload(makeBook({ fileSize: 0 }), { openDownload: async () => new Response() }, {
      onProgress: () => undefined,
      onReadable: () => undefined,
    })).toThrow('The book has an invalid size.');
  });
});
