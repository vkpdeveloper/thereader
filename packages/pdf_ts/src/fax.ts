import { invalid, limit, unsupported } from "./model";
import { faxWhiteCodes, faxBlackCodes, faxSharedCodes } from "./fax-data";
interface Node {
  next: [number, number];
  run: number;
}
function tree(table: string): Node[] {
  const nodes: Node[] = [{ next: [0, 0], run: -1 }],
    fields = (table + "\n" + faxSharedCodes).trim().split(/\s+/);
  for (let i = 0; i < fields.length; i += 2) {
    let at = 0;
    for (const c of fields[i]) {
      const bit = Number(c);
      if (!nodes[at].next[bit]) {
        nodes[at].next[bit] = nodes.length;
        nodes.push({ next: [0, 0], run: -1 });
      }
      at = nodes[at].next[bit];
    }
    nodes[at].run = Number(fields[i + 1]);
  }
  return nodes;
}
const trees = [tree(faxWhiteCodes), tree(faxBlackCodes)];
class FaxBits {
  at = 0;
  constructor(readonly data: Uint8Array) {}
  bit(): number {
    if (Math.floor(this.at / 8) >= this.data.length)
      invalid("Truncated CCITT stream");
    const v = (this.data[Math.floor(this.at / 8)] >> (7 - (this.at % 8))) & 1;
    this.at++;
    return v;
  }
  eol(): boolean {
    const old = this.at;
    try {
      for (let n = 0; n < 128; n++) {
        const v = this.bit();
        if (v === 1) {
          if (n >= 11) return true;
          break;
        }
      }
    } catch {}
    this.at = old;
    return false;
  }
  run(black: number, remaining: number): number {
    let total = 0;
    for (let count = 0; count <= Math.floor(remaining / 64) + 1; count++) {
      let at = 0;
      const t = trees[black];
      while (t[at].run < 0) {
        at = t[at].next[this.bit()];
        if (!at) invalid("Invalid CCITT code");
      }
      const n = t[at].run;
      if (n > remaining - total) invalid("CCITT row overflow");
      total += n;
      if (n < 64) return total;
    }
    return invalid("Invalid CCITT run");
  }
  mode(): number {
    let code = 0;
    for (let n = 1; n <= 7; n++) {
      code = code * 2 + this.bit();
      if (n === 1 && code === 1) return 0;
      if (n === 3) {
        if (code === 1) return 10;
        if (code === 2) return -1;
        if (code === 3) return 1;
      }
      if (n === 4 && code === 1) return 20;
      if (n === 6) {
        if (code === 2) return -2;
        if (code === 3) return 2;
      }
      if (n === 7) {
        if (code === 2) return -3;
        if (code === 3) return 3;
        if (code === 1) unsupported("Unsupported CCITT extension mode");
      }
    }
    return invalid("Invalid CCITT mode");
  }
}
function paintBlack(row: Uint8Array, start: number, end: number): void {
  while (start < end && start % 8) {
    row[Math.floor(start / 8)] |= 1 << (7 - (start % 8));
    start++;
  }
  while (start + 8 <= end) {
    row[Math.floor(start / 8)] = 255;
    start += 8;
  }
  while (start < end) {
    row[Math.floor(start / 8)] |= 1 << (7 - (start % 8));
    start++;
  }
}
export function decodeFax(
  data: Uint8Array,
  w: number,
  h: number,
  k: number,
  eol: boolean,
  align: boolean,
  maximum: number,
  check: () => void = () => {},
): Uint8Array {
  const stride = Math.ceil(w / 8);
  if (
    w < 1 ||
    h < 1 ||
    w > 1 << 24 ||
    stride > maximum / h ||
    w + 2 > (maximum - stride * h) / 16
  )
    limit();
  const out = new Uint8Array(stride * h),
    bits = new FaxBits(data);
  let reference = new Int32Array(w + 2),
    current = new Int32Array(w + 2),
    referenceLength = 2;
  reference[0] = reference[1] = w;
  for (let y = 0; y < h; y++) {
    check();
    let oneD = k === 0;
    if (k >= 0) {
      let hasEOL = bits.eol();
      if (!hasEOL && align) {
        bits.at = Math.ceil(bits.at / 8) * 8;
        hasEOL = bits.eol();
      }
      if (eol && !hasEOL) invalid("CCITT EOL");
      if (k > 0) oneD = bits.bit() === 1;
    } else if (align) bits.at = Math.ceil(bits.at / 8) * 8;
    const row = out.subarray(y * stride, (y + 1) * stride);
    let a0 = 0,
      black = 0,
      initial = true,
      length = 0;
    const append = (n: number) => {
      if (length >= current.length) invalid("CCITT transition overflow");
      current[length++] = n;
    };
    for (let steps = 0; a0 < w; steps++) {
      if (steps > 2 * w + 2) invalid("CCITT step limit");
      if (steps % 256 === 0) check();
      if (oneD) {
        const run = bits.run(black, w - a0);
        if (run === 0 && steps !== 0) invalid("Interior zero CCITT run");
        if (black === 1) paintBlack(row, a0, a0 + run);
        a0 += run;
        append(a0);
        black ^= 1;
        continue;
      }
      const mode = bits.mode();
      if (mode === 10) {
        const first = bits.run(black, w - a0),
          second = bits.run(black ^ 1, w - a0 - first);
        if (
          first + second === 0 ||
          (first === 0 && !initial) ||
          (second === 0 && a0 + first < w)
        )
          invalid("Invalid CCITT horizontal run");
        if (black === 1) paintBlack(row, a0, a0 + first);
        else paintBlack(row, a0 + first, a0 + first + second);
        append(a0 + first);
        append(a0 + first + second);
        a0 += first + second;
      } else {
        const threshold = initial ? 0 : a0 + 1;
        let lo = 0,
          hi = referenceLength;
        while (lo < hi) {
          const m = Math.floor((lo + hi) / 2);
          if (reference[m] < threshold) lo = m + 1;
          else hi = m;
        }
        let j = lo;
        if (j % 2 !== black) j++;
        const b1 = j < referenceLength ? reference[j] : w;
        let end = b1 + mode;
        if (mode === 20) end = j + 1 < referenceLength ? reference[j + 1] : w;
        if (end < a0 || end > w || (end === a0 && !initial))
          invalid("Invalid CCITT vertical run");
        if (black === 1) paintBlack(row, a0, end);
        a0 = end;
        if (mode !== 20) {
          append(a0);
          black ^= 1;
        }
      }
      initial = false;
    }
    while (length && current[length - 1] === w) length--;
    append(w);
    append(w);
    [reference, current] = [current, reference];
    referenceLength = length;
  }
  return out;
}
