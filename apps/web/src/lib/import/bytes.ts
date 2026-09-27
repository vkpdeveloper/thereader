import { sha256Bytes, toHex } from '../services/hash';

/** Byte helpers shared by the EPUB inspector and the MOBI converter. */

const utf8Lenient = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Like Dart `utf8.decode(bytes, allowMalformed: true)`. */
export function utf8Decode(bytes: Uint8Array): string {
  return utf8Lenient.decode(bytes);
}

/** Like Dart `utf8.decode(bytes)`: throws on malformed input. */
export function utf8DecodeStrict(bytes: Uint8Array): string {
  return utf8Strict.decode(bytes);
}

/** ISO-8859-1 (Dart `latin1`), one char per byte. `TextDecoder('latin1')` is windows-1252. */
export function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return out;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Growable byte buffer (Dart `BytesBuilder`). */
export class ByteBuilder {
  private chunks: Uint8Array[] = [];
  length = 0;

  add(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  toBytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

export function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * WebCrypto only exists in secure contexts; a self-host served over plain
 * http on a LAN address has no `crypto.subtle`, so hash in JS there.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (subtle === undefined) return toHex(sha256Bytes(bytes));
  return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource)));
}

/** Copies `bytes` into a fresh ArrayBuffer so it can back a Blob / BufferSource. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
