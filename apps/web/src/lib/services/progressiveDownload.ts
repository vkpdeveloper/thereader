import type { Book } from '../types';
import type { HttpApiClient } from './api';
import { ApiError, type BookFile } from './contract';
import { Sha256 } from './hash';
import { SEGMENT_ALIGNMENT, ZIP_TAIL_WINDOW, defaultSegmentPolicy, planSegments, type SegmentPolicy } from './segmentPlan';

export class DownloadFailure extends Error {
  constructor(message: string, readonly code = 'DOWNLOAD_FAILED') {
    super(message);
    this.name = 'DownloadFailure';
  }
}

export class DownloadCancelled extends Error {
  constructor() {
    super('The download was cancelled.');
    this.name = 'DownloadCancelled';
  }
}

export const EPUB_TYPE = 'application/epub+zip';

/** Where a download gets bytes. Clients without `streamRange` stream the whole file. */
export type DownloadClient = Pick<HttpApiClient, 'openDownload'> & Partial<Pick<HttpApiClient, 'streamRange'>>;

export interface ProgressiveOptions {
  onProgress(received: number, total: number): void;
  /** The ZIP directory and the opening 5% are local: early reading may start. */
  onReadable(): void;
  policy?: SegmentPolicy;
}

const CHUNK = SEGMENT_ALIGNMENT;
/** Verified prefix bytes are moved out of the JS heap into a Blob in runs of this size. */
const SPILL_BYTES = 8 * 1024 * 1024;
/** Hashing yields to the UI after this many bytes. */
const HASH_SLICE = 4 * 1024 * 1024;

/**
 * One contiguous byte range of the edition. Pieces partition the file and are
 * kept sorted by `start`; bytes `[start, next)` have arrived.
 */
class Piece {
  next: number;
  active = false;
  urgent = false;
  private controller: AbortController | null = null;

  /** `end` shrinks when a reader demand splits the piece while it streams. */
  constructor(
    readonly start: number,
    public end: number,
  ) {
    this.next = start;
  }

  get done(): boolean {
    return this.next >= this.end;
  }

  attempt(): AbortSignal {
    this.controller = new AbortController();
    return this.controller.signal;
  }

  stop(): void {
    this.controller?.abort();
  }
}

interface Spilled {
  start: number;
  end: number;
  blob: Blob;
}

/**
 * Downloads one edition as parallel, edition-pinned byte ranges while the
 * reader may already read it. Ported from mobile `_SparseDownload`
 * (progressive_download_io.dart): the ZIP tail is fetched first, then
 * segments front to back on a few connections; bytes a reader waits on jump
 * the queue (splitting a far-away segment). The contiguous prefix is hashed
 * while later segments arrive, so the full-file SHA-256 is known as soon as
 * the last byte lands. Sparse bytes live only in memory for this session and
 * become a durable offline book only after that verification.
 */
export class ProgressiveDownload {
  readonly size: number;
  private readonly policy: SegmentPolicy;
  /** Chunk `i` covers `[i * CHUNK, min((i + 1) * CHUNK, size))`. */
  private chunks: Array<Uint8Array | undefined>;
  /** Hashed prefix bytes moved out of `chunks`, contiguous from 0. */
  private spilled: Spilled[] = [];
  private spilledEnd = 0;
  /** The verified publication once committed. */
  private final: Blob | null = null;
  private pieces: Piece[] = [];
  private queue: Piece[] = [];
  private urgent: Piece[] = [];
  private changed = deferred();
  private readonly halted = deferred();
  private workers = 0;
  private received = 0;
  private leases = 0;
  // Until one 206 response arrives, a server that ignores Range would answer
  // every worker with the whole file, so only one request may be in flight.
  private rangesConfirmed = false;
  private sequential = false;
  private released = false;
  private committed = false;
  private stopped = false;
  private closed = false;
  private readable = false;
  private failure: unknown = null;

  constructor(
    readonly book: Book,
    private readonly client: DownloadClient,
    private readonly options: ProgressiveOptions,
  ) {
    if (!(book.fileSize > 0)) throw new DownloadFailure('The book has an invalid size.');
    this.size = book.fileSize;
    this.policy = options.policy ?? defaultSegmentPolicy;
    this.chunks = new Array(Math.ceil(this.size / CHUNK));
  }

  get canRead(): boolean {
    return this.readable && !this.stopped;
  }

  get receivedBytes(): number {
    return this.received;
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.stopped) throw new DownloadCancelled();
  }

  /** Wakes every waiter so it can re-check the bytes it needs. */
  private notify(): void {
    const changed = this.changed;
    this.changed = deferred();
    changed.resolve();
  }

  private halt(): void {
    this.halted.resolve();
    this.queue = [];
    this.urgent = [];
    for (const piece of this.pieces) piece.stop();
    this.notify();
  }

  private fail(error: unknown): void {
    // After cancel, the aborted requests' errors are not the outcome.
    if (!this.stopped) this.failure ??= error;
    this.halt();
  }

  private firstMissing(start: number, end: number): number | null {
    for (const piece of this.pieces) {
      if (piece.end <= start) continue;
      if (piece.start >= end) break;
      const missing = Math.max(start, piece.next);
      if (missing < Math.min(end, piece.end)) return missing;
    }
    return null;
  }

  private async waitFor(start: number, end: number, demand = false): Promise<void> {
    for (;;) {
      this.check();
      const missing = this.firstMissing(start, end);
      if (missing === null) return;
      if (demand) this.prioritize(missing);
      await this.changed.promise;
    }
  }

  /**
   * Moves the bytes at `offset` ahead of background segments. A demand far
   * from where its piece is (or would be) streaming splits the piece at a
   * chunk boundary, so the reader waits for one round trip instead of for a
   * multi-megabyte segment. Each split costs at most one extra request.
   */
  private prioritize(offset: number): void {
    if (this.sequential || !this.rangesConfirmed) return;
    const index = this.pieces.findIndex((p) => p.start <= offset && offset < p.end);
    const piece = this.pieces[index];
    if (!piece || piece.done) return;
    const from = piece.active ? piece.next : piece.start;
    if (offset < from + this.policy.demandSplitDistance) {
      if (!piece.active && !piece.urgent) {
        piece.urgent = true;
        this.urgent.push(piece);
        this.pump();
      }
      return;
    }
    const at = Math.floor(offset / CHUNK) * CHUNK;
    const rest = new Piece(at, piece.end);
    rest.urgent = true;
    // An active worker stops at its new end once it writes the preceding
    // chunk; chunk writes never straddle `at` because both are aligned.
    piece.end = at;
    this.pieces.splice(index + 1, 0, rest);
    this.urgent.push(rest);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.failure === null) {
      const limit = !this.rangesConfirmed
        ? 1
        : this.policy.connections + (this.urgent.length === 0 ? 0 : this.policy.demandConnections);
      if (this.workers >= limit) return;
      const queue = this.urgent.length > 0 ? this.urgent : this.queue;
      const piece = queue.shift();
      if (!piece) return;
      // A piece promoted to the urgent queue stays in the background queue.
      if (piece.active || piece.done) continue;
      piece.active = true;
      this.workers++;
      void this.fetch(piece);
    }
  }

  private write(piece: Piece, bytes: Uint8Array): void {
    this.check();
    const offset = piece.next;
    if (offset + bytes.length > piece.end) {
      throw new DownloadFailure(`Received more data than the catalog size (${this.size} bytes).`, 'SIZE_MISMATCH');
    }
    const index = offset / CHUNK;
    const expected = Math.min(CHUNK, this.size - offset);
    if (!Number.isInteger(index) || bytes.length !== expected) {
      throw new DownloadFailure('The download produced misaligned data.');
    }
    this.chunks[index] = bytes;
    piece.next = offset + bytes.length;
    this.received += bytes.length;
    this.options.onProgress(this.received, this.size);
    this.notify();
    if (!this.rangesConfirmed) {
      this.rangesConfirmed = true;
      this.pump();
    }
  }

  private async fetch(piece: Piece): Promise<void> {
    let attempt = 0;
    try {
      if (!this.client.streamRange) {
        await this.streamWhole();
        return;
      }
      while (!piece.done) {
        this.check();
        const requestedEnd = piece.end;
        try {
          await this.client.streamRange(this.book, piece.next, requestedEnd, {
            chunkSize: CHUNK,
            signal: piece.attempt(),
            onChunk: (bytes) => {
              // Split by a reader demand: the rest is another piece's work.
              if (piece.done) return;
              this.write(piece, bytes);
              if (piece.done && piece.end < requestedEnd) piece.stop();
            },
          });
        } catch (error) {
          if (piece.done) break;
          this.check();
          if (!this.rangesConfirmed && ignoresRanges(error)) {
            await this.streamWhole();
            return;
          }
          if (++attempt >= this.policy.maxAttempts || !retryable(error)) throw error;
          await Promise.race([sleep(this.policy.retryDelayMs * 2 ** (attempt - 1)), this.halted.promise]);
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      piece.active = false;
      this.workers--;
      this.pump();
    }
  }

  /**
   * Fallback for servers without byte ranges: one sequential response into
   * the same chunk store. Reader demands simply wait for it.
   */
  private async streamWhole(): Promise<void> {
    this.sequential = true;
    this.queue = [];
    this.urgent = [];
    const whole = new Piece(0, this.size);
    whole.active = true;
    this.pieces = [whole];
    try {
      const response = await this.client.openDownload(this.book, whole.attempt());
      this.check();
      const headerLength = Number(response.headers.get('content-length'));
      const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
      if (!encoded && headerLength > 0 && headerLength !== this.size) {
        throw new DownloadFailure(
          `The server reported ${headerLength} bytes but the catalog says ${this.size}.`,
          'SIZE_MISMATCH',
        );
      }
      if (!response.body) throw new DownloadFailure('The server sent no book data.');
      const reader = response.body.getReader();
      let buffer = new Uint8Array(Math.min(CHUNK, this.size));
      let filled = 0;
      let arrived = 0;
      try {
        for (;;) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch {
            this.check();
            throw new DownloadFailure('The book download was interrupted.', 'NETWORK');
          }
          this.check();
          if (result.done) break;
          const incoming = result.value;
          if (arrived + incoming.length > this.size) {
            throw new DownloadFailure(`Received more data than the catalog size (${this.size} bytes).`, 'SIZE_MISMATCH');
          }
          arrived += incoming.length;
          let offset = 0;
          while (offset < incoming.length) {
            const take = Math.min(incoming.length - offset, buffer.length - filled);
            buffer.set(incoming.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === buffer.length) {
              this.write(whole, buffer);
              buffer = new Uint8Array(Math.min(CHUNK, this.size - whole.next));
              filled = 0;
            }
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      if (!whole.done) {
        throw new DownloadFailure(`Download ended early: ${arrived} of ${this.size} bytes.`, 'SIZE_MISMATCH');
      }
    } finally {
      whole.active = false;
    }
  }

  /** Resolves with the verified publication. The caller stores it durably. */
  async run(): Promise<Blob> {
    try {
      for (const [start, end] of planSegments(this.policy, this.size)) {
        const piece = new Piece(start, end);
        this.pieces.push(piece);
        this.queue.push(piece);
      }
      this.pieces.sort((a, b) => a.start - b.start);
      this.pump();
      const hashing = this.hashPrefix();
      hashing.catch(() => undefined);
      // ZIP's central directory is at the tail, which the plan fetches first.
      // Keep the 5% readiness threshold so the opening chapters are local.
      await this.waitFor(Math.max(0, this.size - ZIP_TAIL_WINDOW), this.size);
      await this.waitFor(0, Math.ceil(this.size * 0.05));
      this.readable = true;
      this.options.onReadable();
      await this.waitFor(0, this.size);
      const digest = await hashing;
      this.check();
      if (digest !== this.book.sha256) {
        throw new DownloadFailure('The downloaded book failed its integrity check.', 'CHECKSUM_MISMATCH');
      }
      // Zero-copy for spilled runs; only the unspilled tail is copied once.
      const parts: BlobPart[] = this.spilled.map((s) => s.blob);
      for (let i = this.spilledEnd / CHUNK; i < this.chunks.length; i++) parts.push(this.chunks[i]! as BlobPart);
      this.final = new Blob(parts, { type: EPUB_TYPE });
      this.chunks = [];
      this.spilled = [];
      this.committed = true;
      return this.final;
    } catch (error) {
      this.failure ??= error;
      this.stopped = true;
      this.halt();
      this.cleanupIfUnused();
      throw error;
    }
  }

  /**
   * Hashes the contiguous downloaded prefix while later segments are still
   * arriving. Every byte arrives exactly once, so this is the same full-file
   * SHA-256 as a pass after the download, minus the wait.
   */
  private async hashPrefix(): Promise<string> {
    const hasher = new Sha256();
    let hashed = 0;
    while (hashed < this.size) {
      this.check();
      const available = this.firstMissing(hashed, this.size) ?? this.size;
      if (available === hashed) {
        await this.changed.promise;
        continue;
      }
      const end = Math.min(available, hashed + HASH_SLICE);
      for (let offset = hashed; offset < end; offset += CHUNK) {
        const chunk = this.chunks[offset / CHUNK];
        if (!chunk) throw new DownloadFailure('The local book cache is incomplete.');
        hasher.update(chunk);
      }
      hashed = end;
      if (hashed - this.spilledEnd >= SPILL_BYTES) this.spill(hashed);
      // Long books hash in slices so the reader stays responsive.
      if (hashed < this.size) await sleep(0);
    }
    return hasher.hex();
  }

  /** Moves verified prefix chunks out of the JS heap into blob storage. */
  private spill(end: number): void {
    const from = this.spilledEnd / CHUNK;
    const to = end / CHUNK;
    this.spilled.push({ start: this.spilledEnd, end, blob: new Blob(this.chunks.slice(from, to) as BlobPart[]) });
    for (let i = from; i < to; i++) this.chunks[i] = undefined;
    this.spilledEnd = end;
  }

  /** Bytes `[start, end)`, which must have arrived. Sources are captured synchronously. */
  private async gather(start: number, end: number): Promise<Uint8Array> {
    if (this.final) return new Uint8Array(await this.final.slice(start, end).arrayBuffer());
    const out = new Uint8Array(end - start);
    const pending: Promise<void>[] = [];
    let pos = start;
    for (const s of this.spilled) {
      if (s.end <= pos) continue;
      if (s.start >= end) break;
      const to = Math.min(end, s.end);
      const at = pos - start;
      pending.push(
        s.blob
          .slice(pos - s.start, to - s.start)
          .arrayBuffer()
          .then((buffer) => out.set(new Uint8Array(buffer), at)),
      );
      pos = to;
    }
    while (pos < end) {
      const index = Math.floor(pos / CHUNK);
      const chunk = this.chunks[index];
      if (!chunk) throw new DownloadFailure('The local book cache is incomplete.');
      const chunkStart = index * CHUNK;
      const to = Math.min(chunk.length, end - chunkStart);
      out.set(chunk.subarray(pos - chunkStart, to), pos - start);
      pos = chunkStart + to;
    }
    await Promise.all(pending);
    return out;
  }

  private async read(start: number, end: number): Promise<Uint8Array> {
    this.check();
    if (this.closed) throw new Error('This book is closed.');
    if (!(start >= 0 && end >= start && end <= this.size)) throw new RangeError('Invalid range');
    if (start === end) return new Uint8Array(0);
    if (!this.final) await this.waitFor(start, end, true);
    return this.gather(start, end);
  }

  /** A temporary online reader lease, never a verified offline file. */
  open(): BookFile {
    if (!this.canRead) throw new Error('This book is not ready for early reading.');
    this.leases++;
    let closed = false;
    return {
      size: this.size,
      provisional: true,
      read: (start, end) => (closed ? Promise.reject(new Error('This book is closed.')) : this.read(start, end)),
      slice: async (start, end, type) => {
        if (this.final) return this.final.slice(start, end, type ?? '');
        return new Blob([(await this.read(start, end)) as BlobPart], type ? { type } : undefined);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.leases--;
        this.cleanupIfUnused();
      },
    };
  }

  cancel(): void {
    this.stopped = true;
    this.halt();
  }

  /** The owner is done; memory goes once no reader lease is open. */
  release(): void {
    if (!this.committed && !this.stopped) this.cancel();
    this.released = true;
    this.cleanupIfUnused();
  }

  private cleanupIfUnused(): void {
    if (!this.released || this.leases !== 0 || this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.spilled = [];
    this.final = null;
  }
}

function ignoresRanges(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'INVALID_RANGE' && error.status === 200;
}

function retryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.isNetwork ||
      error.code === 'TRUNCATED_RANGE' ||
      error.status === 408 ||
      error.status === 429 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
