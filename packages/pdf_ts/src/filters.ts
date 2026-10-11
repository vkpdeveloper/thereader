import { Unzlib } from "fflate";
import { invalid, limit, unsupported } from "./model";
import { type Dict, integer, white, hexDecode } from "./syntax";

export class ByteSink {
  private data: Uint8Array;
  length = 0;
  constructor(
    readonly maximum: number,
    initial = 4096,
  ) {
    if (maximum < 0) limit();
    this.data = new Uint8Array(Math.min(initial, maximum));
  }
  reserve(n: number): void {
    if (n < 0 || n > this.maximum - this.length) limit();
    if (this.length + n <= this.data.length) return;
    const next = new Uint8Array(
      Math.min(
        this.maximum,
        Math.max(this.length + n, this.data.length * 2, 64),
      ),
    );
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(...bytes: number[]): void {
    this.reserve(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }
  append(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }
  repeat(value: number, count: number): void {
    this.reserve(count);
    this.data.fill(value, this.length, this.length + count);
    this.length += count;
  }
  finish(): Uint8Array {
    return this.data.slice(0, this.length);
  }
}
export function inflate(b: Uint8Array, maximum: number): Uint8Array {
  const out = new ByteSink(maximum);
  const decoder = new Unzlib((chunk) => out.append(chunk));
  if (!b.length) invalid("Empty Flate stream");
  for (let i = 0; i < b.length; ) {
    const size = Math.min(
      16384,
      Math.max(1, Math.floor((maximum - out.length) / 1032)),
    );
    const end = Math.min(b.length, i + size);
    decoder.push(b.subarray(i, end), end === b.length);
    i = end;
  }
  return out.finish();
}
export function asciiHex(b: Uint8Array, maximum: number): Uint8Array {
  let h = "";
  for (const c of b) {
    if (c === 62) break;
    if (!white(c)) h += String.fromCharCode(c);
    if (h.length > maximum * 2) limit();
  }
  if (h.length % 2) h += "0";
  return hexDecode(h);
}
export function ascii85(b: Uint8Array, maximum: number): Uint8Array {
  const out = new ByteSink(maximum);
  let n = 0,
    count = 0;
  for (let pos = 0; pos < b.length; pos++) {
    const c = b[pos];
    if (white(c)) continue;
    if (c === 126 && b[pos + 1] === 62) break;
    if (c === 122) {
      if (count) invalid("Invalid ASCII85 zero tuple");
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) invalid("Invalid ASCII85 digit");
    n = n * 85 + c - 33;
    count++;
    if (count === 5) {
      if (n > 0xffffffff) invalid("ASCII85 overflow");
      out.push(
        Math.floor(n / 16777216),
        Math.floor(n / 65536) & 255,
        Math.floor(n / 256) & 255,
        n & 255,
      );
      n = count = 0;
    }
  }
  if (count === 1) invalid("Truncated ASCII85 tuple");
  if (count) {
    const length = count - 1;
    while (count++ < 5) n = n * 85 + 84;
    for (let i = 0; i < length; i++)
      out.push(Math.floor(n / 2 ** (24 - i * 8)) & 255);
  }
  return out.finish();
}
export function runLength(b: Uint8Array, maximum: number): Uint8Array {
  const out = new ByteSink(maximum);
  for (let i = 0; i < b.length; ) {
    const n = b[i++];
    if (n === 128) return out.finish();
    const count = n < 128 ? n + 1 : 257 - n;
    if (n < 128) {
      if (count > b.length - i) invalid();
      out.append(b.subarray(i, i + count));
      i += count;
    } else {
      if (i === b.length) invalid();
      out.repeat(b[i++], count);
    }
  }
  return invalid("Unterminated RunLength stream");
}
export function lzwDecode(
  b: Uint8Array,
  maximum: number,
  early = 1,
): Uint8Array {
  if (early !== 0 && early !== 1) invalid("Invalid LZW EarlyChange");
  const table = new Array<Uint8Array>(4096);
  for (let i = 0; i < 256; i++) table[i] = Uint8Array.of(i);
  let bits = 9,
    next = 258,
    pos = 0;
  let previous: Uint8Array | undefined;
  const out = new ByteSink(maximum);
  while (pos + bits <= b.length * 8) {
    let code = 0;
    for (let j = 0; j < bits; j++, pos++)
      code = code * 2 + ((b[Math.floor(pos / 8)] >> (7 - (pos % 8))) & 1);
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = undefined;
      continue;
    }
    if (code === 257) return out.finish();
    let entry: Uint8Array;
    if (code < next) entry = table[code];
    else if (code === next && previous?.length) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0];
    } else return invalid("Invalid LZW code");
    if (!entry?.length) invalid("Empty LZW entry");
    out.append(entry);
    if (previous?.length && next < 4096) {
      const added = new Uint8Array(previous.length + 1);
      added.set(previous);
      added[previous.length] = entry[0];
      table[next++] = added;
      if (bits < 12 && next + early === 2 ** bits) bits++;
    }
    previous = entry;
  }
  return invalid("Truncated LZW stream");
}
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c,
    x = Math.abs(p - a),
    y = Math.abs(p - b),
    z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}
export function predict(b: Uint8Array, d: Dict, maximum: number): Uint8Array {
  const pred = integer(d.Predictor);
  if (pred <= 1) return b;
  const colors = integer(d.Colors) || 1,
    cols = integer(d.Columns) || 1,
    bits = integer(d.BitsPerComponent) || 8;
  if (
    colors < 1 ||
    colors > 32 ||
    cols < 1 ||
    cols > 1000000 ||
    bits < 1 ||
    bits > 16
  )
    limit();
  const row = Math.ceil((colors * cols * bits) / 8),
    bpp = Math.ceil((colors * bits) / 8);
  if (row > maximum) limit();
  if (pred === 2) {
    if (bits !== 8) unsupported(`Unsupported TIFF predictor bit depth ${bits}`);
    if (b.length % row) invalid("Invalid TIFF predictor");
    const out = b.slice();
    for (let y = 0; y < out.length; y += row)
      for (let x = colors; x < row; x++) out[y + x] += out[y + x - colors];
    return out;
  }
  if (pred < 10 || pred > 15 || b.length % (row + 1))
    invalid("Invalid predictor");
  const out = new Uint8Array((b.length / (row + 1)) * row);
  for (let y = 0, pos = 0; pos < b.length; y += row, pos += row + 1) {
    const f = b[pos];
    if (f > 4) invalid("Invalid PNG predictor");
    for (let x = 0; x < row; x++) {
      let v = b[pos + 1 + x];
      const a = x >= bpp ? out[y + x - bpp] : 0;
      const u = y > 0 ? out[y - row + x] : 0,
        c = y > 0 && x >= bpp ? out[y - row + x - bpp] : 0;
      if (f === 1) v += a;
      else if (f === 2) v += u;
      else if (f === 3) v += Math.floor((a + u) / 2);
      else if (f === 4) v += paeth(a, u, c);
      out[y + x] = v;
    }
  }
  return out;
}
