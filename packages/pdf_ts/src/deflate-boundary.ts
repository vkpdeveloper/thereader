import { invalid, limit } from "./model";

// Locate a zlib member without searching binary data for a PDF EI marker.
// This bounded RFC 1951 scanner counts output and validates back-references;
// actual decompression is delegated to the generic compression codec.
export function zlibBoundary(b: Uint8Array, maximum: number): number {
  if (
    b.length < 6 ||
    (b[0] & 15) !== 8 ||
    b[0] >> 4 > 7 ||
    (b[0] * 256 + b[1]) % 31 ||
    b[1] & 32
  )
    invalid("Invalid zlib header");
  let pos = 16,
    output = 0;
  const bits = (n: number): number => {
    if (pos + n > b.length * 8) invalid("Truncated deflate stream");
    let v = 0;
    for (let j = 0; j < n; j++, pos++)
      v |= ((b[pos >> 3] >> (pos & 7)) & 1) << j;
    return v;
  };
  const tree = (lengths: number[]): Map<number, number>[] => {
    const count = Array<number>(16).fill(0),
      next = Array<number>(16).fill(0),
      tables = Array.from({ length: 16 }, () => new Map<number, number>());
    for (const n of lengths) {
      if (n < 0 || n > 15) invalid();
      if (n) count[n]++;
    }
    let code = 0;
    for (let n = 1; n <= 15; n++) {
      code = (code + count[n - 1]) << 1;
      if (code + count[n] > 1 << n) invalid("Oversubscribed Huffman tree");
      next[n] = code;
    }
    lengths.forEach((length, symbol) => {
      if (!length) return;
      let code = next[length]++,
        reversed = 0;
      for (let n = 0; n < length; n++) {
        reversed = reversed * 2 + (code & 1);
        code >>= 1;
      }
      tables[length].set(reversed, symbol);
    });
    return tables;
  };
  const symbol = (tables: Map<number, number>[]): number => {
    let code = 0;
    for (let n = 1; n <= 15; n++) {
      code |= bits(1) << (n - 1);
      const v = tables[n].get(code);
      if (v !== undefined) return v;
    }
    return invalid("Invalid Huffman code");
  };
  const lengthBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258,
  ];
  const lengthExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
    5, 5, 5, 0,
  ];
  const distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const order = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
  ];
  let final = 0;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      pos = Math.ceil(pos / 8) * 8;
      const length = bits(16),
        inverse = bits(16);
      if ((length ^ inverse) !== 65535) invalid();
      pos += length * 8;
      if (pos > b.length * 8) invalid();
      output += length;
      if (output > maximum) limit();
      continue;
    }
    let lit: Map<number, number>[], dist: Map<number, number>[];
    if (type === 1) {
      lit = tree(
        Array.from({ length: 288 }, (_, n) =>
          n < 144 ? 8 : n < 256 ? 9 : n < 280 ? 7 : 8,
        ),
      );
      dist = tree(Array(32).fill(5));
    } else if (type === 2) {
      const nl = bits(5) + 257,
        nd = bits(5) + 1,
        nc = bits(4) + 4;
      if (nl > 286 || nd > 32) invalid();
      const lengths = Array(19).fill(0);
      for (let j = 0; j < nc; j++) lengths[order[j]] = bits(3);
      const codes = tree(lengths),
        all: number[] = [];
      while (all.length < nl + nd) {
        const n = symbol(codes);
        if (n < 16) all.push(n);
        else {
          const count =
            n === 16 ? bits(2) + 3 : n === 17 ? bits(3) + 3 : bits(7) + 11;
          if ((n === 16 && !all.length) || all.length + count > nl + nd)
            invalid();
          const value = n === 16 ? all[all.length - 1] : 0;
          for (let j = 0; j < count; j++) all.push(value);
        }
      }
      if (!all[256]) invalid();
      lit = tree(all.slice(0, nl));
      dist = tree(all.slice(nl));
    } else return invalid("Reserved deflate block type");
    for (;;) {
      const n = symbol(lit);
      if (n === 256) break;
      if (n < 256) output++;
      else {
        if (n > 285) invalid();
        const length = lengthBase[n - 257] + bits(lengthExtra[n - 257]),
          d = symbol(dist);
        if (d > 29) invalid();
        const distance = distBase[d] + bits(d < 4 ? 0 : (d >> 1) - 1);
        if (distance > output) invalid("Invalid deflate distance");
        output += length;
      }
      if (output > maximum) limit();
    }
  } while (!final);
  const end = Math.ceil(pos / 8) + 4;
  if (end > b.length) invalid("Missing zlib checksum");
  return end;
}
