import { inflateSync } from 'fflate';

/**
 * Lazy zip reader over range reads. Only the central directory is read on
 * open; each entry is read and inflated on demand, so a large EPUB full of
 * images never gets inflated (or even fully read) at once, and a book that
 * is still downloading opens as soon as its directory and first sections
 * have arrived.
 */

/** Random-access bytes: the library's `BookFile`, or a Blob via `blobSource`. */
export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  slice(start: number, end: number, type?: string): Promise<Blob>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    slice: async (start, end, type) => blob.slice(start, end, type ?? ''),
  };
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Entries larger than this inflate through the native stream when available. */
const STREAM_THRESHOLD = 512 * 1024;

export class ZipArchive {
  private readonly byName = new Map<string, ZipEntry>();
  private readonly byLowerName = new Map<string, ZipEntry>();

  private constructor(private readonly source: ByteSource, entries: ZipEntry[]) {
    for (const e of entries) {
      this.byName.set(e.name, e);
      const lower = e.name.toLowerCase();
      if (!this.byLowerName.has(lower)) this.byLowerName.set(lower, e);
    }
  }

  static async open(input: ByteSource | Blob): Promise<ZipArchive> {
    const source = input instanceof Blob ? blobSource(input) : input;
    const size = source.size;
    if (size < 22) throw new Error('Not a zip file.');
    const tailLength = Math.min(size, 65535 + 22 + 20);
    const tail = await bytes(source, size - tailLength, size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file.');
    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tv.getUint32(loc, true) === ZIP64_LOCATOR) {
        const z64Offset = u64(tv, loc + 8);
        const z = await bytes(source, z64Offset, z64Offset + 56);
        const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
        if (zv.getUint32(0, true) === ZIP64_EOCD) {
          count = u64(zv, 32);
          cdSize = u64(zv, 40);
          cdOffset = u64(zv, 48);
        }
      }
    }

    // Some writers prepend data; shift offsets if the directory is not where it claims.
    const expectedCdStart = size - tailLength + eocd - cdSize;
    const shift = cdOffset + cdSize <= size && expectedCdStart >= 0 ? expectedCdStart - cdOffset : 0;
    const cdStart = cdOffset + (shift > 0 ? shift : 0);
    const cd = await bytes(source, cdStart, cdStart + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const utf8 = new TextDecoder('utf-8');
    const latin1 = new TextDecoder('latin1');
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cv.getUint32(p, true) !== CENTRAL) break;
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      let compressedSize = cv.getUint32(p + 20, true);
      let uncompressedSize = cv.getUint32(p + 24, true);
      const nameLength = cv.getUint16(p + 28, true);
      const extraLength = cv.getUint16(p + 30, true);
      const commentLength = cv.getUint16(p + 32, true);
      let offset = cv.getUint32(p + 42, true);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
      const name = flags & 0x800 ? utf8.decode(nameBytes) : decodeName(nameBytes, utf8, latin1);
      // Zip64 extended information.
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = cv.getUint16(e, true);
        const len = cv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= e + 4 + len) {
            uncompressedSize = u64(cv, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) {
            compressedSize = u64(cv, q);
            q += 8;
          }
          if (offset === 0xffffffff && q + 8 <= e + 4 + len) offset = u64(cv, q);
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) {
        entries.push({
          name: name.replace(/\\/g, '/').replace(/^\/+/, ''),
          method,
          compressedSize,
          size: uncompressedSize,
          offset: offset + (shift > 0 ? shift : 0),
        });
      }
      p += 46 + nameLength + extraLength + commentLength;
    }
    if (entries.length === 0) throw new Error('The zip file is empty.');
    return new ZipArchive(source, entries);
  }

  /** Exact path first, then a case-insensitive match (common authoring slip). */
  entry(path: string): ZipEntry | null {
    return this.byName.get(path) ?? this.byLowerName.get(path.toLowerCase()) ?? null;
  }

  has(path: string): boolean {
    return this.entry(path) !== null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const e = this.entry(path);
    if (!e) return null;
    const slack = 1024;
    const chunk = await bytes(this.source, e.offset, e.offset + 30 + slack + e.compressedSize);
    const lv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk.length < 30 || lv.getUint32(0, true) !== LOCAL) throw new Error(`Corrupt zip entry ${e.name}`);
    const start = 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    let data: Uint8Array;
    if (start + e.compressedSize <= chunk.length) {
      data = chunk.subarray(start, start + e.compressedSize);
    } else {
      data = await bytes(this.source, e.offset + start, e.offset + start + e.compressedSize);
    }
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error(`Unsupported compression in ${e.name}`);
    if (e.compressedSize > STREAM_THRESHOLD && typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        // Fall through to the synchronous inflater.
      }
    }
    return inflateSync(data, e.size > 0 ? { out: new Uint8Array(e.size) } : undefined);
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.read(path);
    return b === null ? null : decodeText(b);
  }

  async readBlob(path: string, type: string): Promise<Blob | null> {
    const e = this.entry(path);
    if (!e) return null;
    if (e.method === 0) {
      // Stored entries (images usually are) are sliced without copying.
      const head = await bytes(this.source, e.offset, e.offset + 30);
      const lv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      if (lv.getUint32(0, true) === LOCAL) {
        const start = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
        return this.source.slice(start, start + e.compressedSize, type);
      }
    }
    const b = await this.read(path);
    return b === null ? null : new Blob([b], { type });
  }
}

function bytes(source: ByteSource, start: number, end: number): Promise<Uint8Array> {
  return source.read(Math.max(0, start), Math.min(end, source.size));
}

function u64(v: DataView, at: number): number {
  return v.getUint32(at, true) + v.getUint32(at + 4, true) * 0x100000000;
}

function decodeName(b: Uint8Array, utf8: TextDecoder, latin1: TextDecoder): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return b.every((c) => c < 0x80) ? utf8.decode(b) : latin1.decode(b);
  }
}

/** Decodes markup/CSS honouring a BOM or an XML/CSS encoding declaration. */
export function decodeText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 256)));
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head) ?? /^@charset\s+"([A-Za-z0-9._-]+)"/.exec(head);
  const label = m?.[1]?.toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(b);
    } catch {
      // Unknown label: fall back to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(b);
}
