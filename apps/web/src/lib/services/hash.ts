/**
 * SHA-256 helpers. Library identities must be computed synchronously
 * (`entryFor(book)`), and downloads hash segments as they arrive, so this
 * module carries a small incremental implementation; whole small blobs use
 * `crypto.subtle`.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Incremental SHA-256. Downloads hash each segment as it becomes part of the
 * contiguous prefix, so verification needs no second pass over the book and
 * never holds the whole file in one buffer.
 */
export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private buffered = 0;
  private length = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    this.length += input.length;
    let offset = 0;
    if (this.buffered > 0) {
      const take = Math.min(64 - this.buffered, input.length);
      this.block.set(input.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered < 64) return this;
      this.compress(this.blockView, 0);
      this.buffered = 0;
    }
    const whole = offset + ((input.length - offset) & ~63);
    if (whole > offset) {
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      for (; offset < whole; offset += 64) this.compress(view, offset);
    }
    if (offset < input.length) {
      this.block.set(input.subarray(offset), 0);
      this.buffered = input.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    const bitLength = this.length * 8;
    const pad = new Uint8Array(((this.buffered + 9 + 63) >> 6) << 6);
    pad[0] = 0x80;
    const tail = new DataView(pad.buffer);
    tail.setUint32(pad.length - 8 - this.buffered, Math.floor(bitLength / 0x100000000));
    tail.setUint32(pad.length - 4 - this.buffered, bitLength >>> 0);
    this.update(pad.subarray(0, pad.length - this.buffered));
    this.finished = true;
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i]!);
    return out;
  }

  hex(): string {
    return toHex(this.digest());
  }

  private compress(view: DataView, offset: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
}

export function sha256Bytes(input: Uint8Array): Uint8Array {
  return new Sha256().update(input).digest();
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function sha256Hex(text: string): string {
  return toHex(sha256Bytes(new TextEncoder().encode(text)));
}

/** Blobs up to this size hash in one native WebCrypto call. */
const ONE_SHOT_LIMIT = 32 * 1024 * 1024;
const BLOB_READ = 4 * 1024 * 1024;

/**
 * SHA-256 of a Blob. Small blobs go through WebCrypto; larger ones are read
 * in 4 MiB slices so a big book never sits in memory as one ArrayBuffer.
 */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  if (blob.size <= ONE_SHOT_LIMIT && typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return toHex(new Uint8Array(digest));
  }
  const hasher = new Sha256();
  for (let offset = 0; offset < blob.size; offset += BLOB_READ) {
    hasher.update(new Uint8Array(await blob.slice(offset, offset + BLOB_READ).arrayBuffer()));
  }
  return hasher.hex();
}

/** 32 random hex chars, valid as a sync client ID. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
