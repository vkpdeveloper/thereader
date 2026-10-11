import { invalid, limit, unsupported } from "./model";
import { CharString, i16, u16, u32 } from "./cff";
import { type Matrix, mul, point } from "./geometry";
import { binary } from "./syntax";

export function sfntTable(b: Uint8Array, name: string): Uint8Array {
  if (b.length < 12) invalid();
  const n = u16(b, 4);
  if (n > 4096 || n * 16 > b.length - 12) invalid();
  for (let j = 0; j < n; j++) {
    const at = 12 + j * 16;
    if (binary(b.subarray(at, at + 4)) !== name) continue;
    const start = u32(b, at + 8),
      length = u32(b, at + 12);
    if (start > b.length || length > b.length - start) invalid();
    return b.subarray(start, start + length);
  }
  return invalid(`Missing font table ${name}`);
}
interface TTPoint {
  x: number;
  y: number;
  on: boolean;
}
export class TrueTypeFont {
  readonly glyphs: number;
  readonly long: boolean;
  readonly units: number;
  readonly glyf: Uint8Array;
  readonly loca: Uint8Array;
  readonly cmap: Uint8Array;
  constructor(b: Uint8Array) {
    const head = sfntTable(b, "head"),
      maxp = sfntTable(b, "maxp");
    if (head.length < 54 || maxp.length < 6) invalid();
    this.glyphs = u16(maxp, 4);
    this.long = u16(head, 50) === 1;
    this.units = u16(head, 18);
    if (this.units < 16 || this.units > 16384 || this.glyphs < 1) invalid();
    this.glyf = sfntTable(b, "glyf");
    this.loca = sfntTable(b, "loca");
    if (this.loca.length < (this.glyphs + 1) * (this.long ? 4 : 2)) invalid();
    try {
      this.cmap = sfntTable(b, "cmap");
    } catch {
      this.cmap = new Uint8Array();
    }
  }
  lookup(r: number): number {
    const b = this.cmap;
    if (b.length < 4) return 0;
    const n = u16(b, 2);
    if (n * 8 > b.length - 4) return 0;
    for (let j = 0; j < n; j++) {
      const at = u32(b, 8 + j * 8);
      if (at + 2 > b.length) continue;
      let sub = b.subarray(at);
      const format = u16(sub, 0);
      if (format === 4) {
        if (sub.length < 16 || r > 65535) continue;
        const length = u16(sub, 2);
        if (length < 16 || length > sub.length) continue;
        sub = sub.subarray(0, length);
        const count = Math.floor(u16(sub, 6) / 2);
        if (count < 1 || count * 8 > sub.length - 16) continue;
        for (let k = 0; k < count; k++) {
          const end = u16(sub, 14 + k * 2),
            start = u16(sub, 16 + count * 2 + k * 2);
          if (r < start || r > end) continue;
          const delta = i16(sub, 16 + count * 4 + k * 2),
            roff = 16 + count * 6 + k * 2,
            offset = u16(sub, roff);
          let gid = r;
          if (offset > 0) {
            const pos = roff + offset + 2 * (r - start);
            if (pos < 0 || pos + 2 > sub.length) continue;
            gid = u16(sub, pos);
            if (!gid) continue;
          }
          gid = (gid + delta) & 65535;
          if (gid > 0 && gid < this.glyphs) return gid;
        }
      } else if (format === 12) {
        if (sub.length < 16) continue;
        const count = u32(sub, 12);
        if (count > Math.floor((sub.length - 16) / 12)) continue;
        for (let k = 0; k < count; k++) {
          const at = 16 + k * 12,
            first = u32(sub, at),
            last = u32(sub, at + 4);
          if (r < first || r > last) continue;
          const gid = u32(sub, at + 8) + r - first;
          if (gid > 0 && gid < this.glyphs) return gid;
        }
      }
    }
    return 0;
  }
  data(gid: number): Uint8Array {
    if (gid < 0 || gid >= this.glyphs) invalid();
    const offset = (n: number) =>
      this.long ? u32(this.loca, n * 4) : u16(this.loca, n * 2) * 2;
    const a = offset(gid),
      z = offset(gid + 1);
    if (a > z || z > this.glyf.length) invalid();
    return this.glyf.subarray(a, z);
  }
  draw(c: CharString, gid: number, m: Matrix, depth = 0): void {
    if (++c.ops > 10000 || depth > 16) limit();
    const b = this.data(gid);
    if (!b.length) return;
    if (b.length < 10) invalid();
    const contours = i16(b, 0);
    let at = 10;
    const read = () => {
      const n = u16(b, at);
      at += 2;
      return n;
    };
    const signed = (n: number) => (n >= 32768 ? n - 65536 : n);
    if (contours < 0) {
      for (;;) {
        const flags = read(),
          child = read();
        let x: number, y: number;
        if (flags & 1) {
          x = signed(read());
          y = signed(read());
        } else {
          if (at + 2 > b.length) invalid();
          x = (b[at++] << 24) >> 24;
          y = (b[at++] << 24) >> 24;
        }
        if (!(flags & 2))
          unsupported("point-matched composite font glyph needs review");
        const cm: Matrix = [1, 0, 0, 1, x, y],
          scale = () => signed(read()) / 16384;
        if (flags & 8) cm[0] = cm[3] = scale();
        else if (flags & 64) {
          cm[0] = scale();
          cm[3] = scale();
        } else if (flags & 128) for (let j = 0; j < 4; j++) cm[j] = scale();
        if (flags & 0x800) {
          cm[4] = cm[0] * x + cm[2] * y;
          cm[5] = cm[1] * x + cm[3] * y;
        }
        this.draw(c, child, mul(m, cm), depth + 1);
        if (!(flags & 32)) return;
      }
    }
    if (!contours) return;
    if (contours > 4096) limit();
    const ends: number[] = [];
    for (let j = 0; j < contours; j++) {
      const n = read();
      if (j && n <= ends[j - 1]) invalid();
      ends.push(n);
    }
    const count = ends[contours - 1] + 1;
    if (count > 20000) limit();
    const ins = read();
    if (ins > b.length - at) invalid();
    at += ins;
    const flags: number[] = [];
    while (flags.length < count) {
      if (at >= b.length) invalid();
      const v = b[at++];
      let repeat = 1;
      if (v & 8) {
        if (at >= b.length) invalid();
        repeat += b[at++];
      }
      if (repeat > count - flags.length) invalid();
      for (let j = 0; j < repeat; j++) flags.push(v);
    }
    const points = Array.from({ length: count }, () => ({
      x: 0,
      y: 0,
      on: false,
    }));
    for (let axis = 0; axis < 2; axis++) {
      let pos = 0;
      const short = axis ? 4 : 2,
        same = axis ? 32 : 16;
      flags.forEach((flag, j) => {
        let delta = 0;
        if (flag & short) {
          if (at >= b.length) invalid();
          delta = b[at++];
          if (!(flag & same)) delta = -delta;
        } else if (!(flag & same)) delta = signed(read());
        pos += delta;
        if (Math.abs(pos) > 1e7) limit();
        if (axis) points[j].y = pos;
        else points[j].x = pos;
        points[j].on = !!(flag & 1);
      });
    }
    const command = (op: string, ...pts: TTPoint[]) =>
      c.point(op, ...pts.flatMap((p) => point(m, p.x, p.y)));
    const mid = (a: TTPoint, b: TTPoint): TTPoint => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      on: true,
    });
    let first = 0;
    for (const end of ends) {
      let segment = points.slice(first, end + 1);
      first = end + 1;
      const a = segment[0],
        z = segment[segment.length - 1];
      let start = a;
      if (a.on) segment = segment.slice(1);
      else if (z.on) {
        start = z;
        segment = segment.slice(0, -1);
      } else start = mid(z, a);
      command("M", start);
      let control: TTPoint | undefined;
      for (const pt of segment) {
        if (pt.on) {
          if (control) {
            command("Q", control, pt);
            control = undefined;
          } else command("L", pt);
        } else {
          if (control) command("Q", control, mid(control, pt));
          control = pt;
        }
      }
      if (control) command("Q", control, start);
      c.path += "Z";
    }
  }
}
