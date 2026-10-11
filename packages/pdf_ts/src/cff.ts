import { type Rect, invalid, limit, unsupported } from "./model";
import { type Matrix, fnum, union, validMatrix } from "./geometry";
import { binary } from "./syntax";
import {
  cffStrings,
  cffExpert,
  cffExpertSubset,
  cffStandardEncoding,
} from "./cff-data";

export function u16(b: Uint8Array, at: number): number {
  if (at < 0 || at + 2 > b.length) invalid("Truncated font data");
  return b[at] * 256 + b[at + 1];
}
export function i16(b: Uint8Array, at: number): number {
  const n = u16(b, at);
  return n >= 32768 ? n - 65536 : n;
}
export function u32(b: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > b.length) invalid("Truncated font data");
  return b[at] * 16777216 + b[at + 1] * 65536 + b[at + 2] * 256 + b[at + 3];
}
export interface GlyphOutline {
  path: string;
  box?: Rect;
  operations: number;
  error?: unknown;
}
export class OutlineFont {
  chars: Uint8Array[] = [];
  global: Uint8Array[] = [];
  local: Uint8Array[][] = [];
  fd: number[] = [];
  codes = new Map<number, number>();
  names?: Map<string, number>;
  matrix: Matrix = [0.001, 0, 0, 0.001, 0, 0];
  cache = new Map<number, GlyphOutline>();
  type1 = false;
  type3 = false;
  glyphCount?: number;
  draw?: (c: CharString, gid: number) => void;
  outline(code: number, name: string): GlyphOutline {
    const gid = this.names ? this.names.get(name) : this.codes.get(code),
      maximum = this.glyphCount ?? this.chars.length;
    if (gid === undefined || gid < 0 || gid >= maximum)
      invalid("Invalid glyph ID");
    const cached = this.cache.get(gid);
    if (cached) {
      if (cached.error) throw cached.error;
      return cached;
    }
    const c = new CharString(this, this.local[this.fd[gid]] || []);
    let error: unknown;
    try {
      if (this.draw) this.draw(c, gid);
      else {
        c.run(this.chars[gid], 0);
        c.close();
        if (!c.done) invalid("Unterminated charstring");
      }
    } catch (e) {
      error = e;
    }
    const result: GlyphOutline = {
      path: c.path,
      box: c.box,
      operations: c.ops,
      ...(error ? { error } : {}),
    };
    this.cache.set(gid, result);
    if (error) throw error;
    return result;
  }
}
export function cffIndex(b: Uint8Array, start: number): [Uint8Array[], number] {
  let at = start;
  const n = u16(b, at);
  at += 2;
  if (!n) return [[], at];
  if (at >= b.length) invalid();
  const width = b[at++];
  if (width < 1 || width > 4 || (n + 1) * width > b.length - at) invalid();
  const offsets: number[] = [];
  for (let i = 0; i <= n; i++) {
    let value = 0;
    for (let j = 0; j < width; j++) value = value * 256 + b[at++];
    offsets.push(value);
  }
  if (offsets[0] !== 1 || offsets[n] < 1 || offsets[n] - 1 > b.length - at)
    invalid();
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    if (
      offsets[i] < 1 ||
      offsets[i] > offsets[i + 1] ||
      offsets[i + 1] > offsets[n]
    )
      invalid();
    out.push(b.subarray(at + offsets[i] - 1, at + offsets[i + 1] - 1));
  }
  return [out, at + offsets[n] - 1];
}
export function cffNumber(
  b: Uint8Array,
  cursor: { at: number },
  dictMode: boolean,
  type1: boolean,
): number {
  if (cursor.at >= b.length) invalid();
  const v = b[cursor.at++];
  if (v >= 32 && v <= 246) return v - 139;
  if (v >= 247 && v <= 254) {
    if (cursor.at >= b.length) invalid();
    const w = b[cursor.at++];
    return v < 251 ? (v - 247) * 256 + w + 108 : -(v - 251) * 256 - w - 108;
  }
  if (v === 28) {
    const n = i16(b, cursor.at);
    cursor.at += 2;
    return n;
  }
  if ((v === 29 && dictMode) || v === 255) {
    let n = u32(b, cursor.at);
    cursor.at += 4;
    if (n >= 2147483648) n -= 4294967296;
    return v === 255 && !type1 ? n / 65536 : n;
  }
  if (v === 30 && dictMode) {
    let s = "";
    while (cursor.at < b.length && s.length < 64) {
      const w = b[cursor.at++];
      for (const c of [w >> 4, w & 15]) {
        if (c < 10) s += c;
        else if (c === 10) s += ".";
        else if (c === 11) s += "E";
        else if (c === 12) s += "E-";
        else if (c === 14) s += "-";
        else if (c === 15) {
          const n = Number(s);
          if (!s || !Number.isFinite(n)) invalid();
          return n;
        } else invalid();
      }
    }
  }
  return invalid("Invalid CFF number");
}
export function cffDict(b: Uint8Array): Map<number, number[]> {
  const d = new Map<number, number[]>(),
    cursor = { at: 0 };
  let stack: number[] = [];
  while (cursor.at < b.length) {
    const v = b[cursor.at];
    if (v >= 28) {
      stack.push(cffNumber(b, cursor, true, false));
      if (stack.length > 64) limit();
      continue;
    }
    cursor.at++;
    let op = v;
    if (v === 12) {
      if (cursor.at === b.length) invalid();
      op = 1200 + b[cursor.at++];
    }
    d.set(op, stack);
    stack = [];
  }
  return d;
}
const cffInt = (d: Map<number, number[]>, k: number): number => {
  const n = d.get(k)?.[0];
  return n !== undefined && Math.abs(n) < 1 << 30 ? Math.trunc(n) : 0;
};
function namedCharset(
  f: OutlineFont,
  b: Uint8Array,
  d: Map<number, number[]>,
  custom: Uint8Array[],
): void {
  const nameFor = (sid: number): string => {
    if (sid < 0 || sid >= 65000) invalid();
    if (sid < cffStrings.length) return cffStrings[sid];
    sid -= cffStrings.length;
    if (sid >= custom.length || !custom[sid].length || custom[sid].length > 127)
      invalid();
    return binary(custom[sid]);
  };
  f.names = new Map([[".notdef", 0]]);
  const charset = Array<number>(f.chars.length).fill(0);
  let at = cffInt(d, 15);
  if (at >= 0 && at <= 2) {
    const predefined =
      at === 1
        ? cffExpert
        : at === 2
          ? cffExpertSubset
          : cffStrings.slice(0, 229);
    if (f.chars.length > predefined.length) invalid();
    predefined.slice(0, f.chars.length).forEach((name, gid) => {
      f.names!.set(name, gid);
      const sid = cffStrings.indexOf(name);
      if (sid >= 0) charset[gid] = sid;
    });
  } else {
    if (at < 3 || at >= b.length) invalid();
    const format = b[at++];
    for (let gid = 1; gid < f.chars.length; ) {
      const first = u16(b, at);
      at += 2;
      let n = 0;
      if (format === 1) {
        if (at >= b.length) invalid();
        n = b[at++];
      } else if (format === 2) {
        n = u16(b, at);
        at += 2;
      } else if (format !== 0) invalid();
      if (n >= f.chars.length - gid) invalid();
      for (let j = 0; j <= n; j++) {
        const name = nameFor(first + j);
        if (f.names.has(name)) invalid();
        charset[gid] = first + j;
        f.names.set(name, gid++);
      }
    }
  }
  at = cffInt(d, 16);
  if (at === 0) {
    cffStandardEncoding.forEach((name, code) => {
      const gid = f.names!.get(name);
      if (gid !== undefined && name !== ".notdef") f.codes.set(code, gid);
    });
    return;
  }
  if (at === 1) unsupported("CFF ExpertEncoding is unsupported");
  if (at < 2 || at + 2 > b.length) invalid();
  const format = b[at++],
    n = b[at++];
  const set = (code: number, gid: number) => {
    if (code > 255 || gid >= f.chars.length || f.codes.has(code)) invalid();
    f.codes.set(code, gid);
  };
  if ((format & 127) === 0) {
    if (n > b.length - at) invalid();
    for (let j = 0; j < n; j++) set(b[at + j], j + 1);
    at += n;
  } else if ((format & 127) === 1) {
    if (n * 2 > b.length - at) invalid();
    let gid = 1;
    for (let j = 0; j < n; j++) {
      const first = b[at++],
        last = b[at++];
      for (let k = 0; k <= last; k++) set(first + k, gid++);
    }
  } else invalid();
  if (format & 128) {
    if (at >= b.length) invalid();
    const n = b[at++];
    if (n * 3 > b.length - at) invalid();
    const bySID = new Map<number, number>();
    charset.forEach((sid, gid) => bySID.set(sid, gid));
    for (let j = 0; j < n; j++) {
      const code = b[at++],
        sid = u16(b, at);
      at += 2;
      const gid = bySID.get(sid);
      if (gid === undefined || f.codes.has(code)) invalid();
      f.codes.set(code, gid);
    }
  }
}
export function parseCFF(b: Uint8Array): OutlineFont {
  if (b.length < 4 || b[0] !== 1 || b[2] < 4 || b[2] > b.length) invalid();
  let [, at] = cffIndex(b, b[2]);
  const [top, next] = cffIndex(b, at);
  if (top.length !== 1) invalid();
  at = next;
  const [custom, next2] = cffIndex(b, at);
  at = next2;
  const [global] = cffIndex(b, at),
    d = cffDict(top[0]),
    [chars] = cffIndex(b, cffInt(d, 17));
  if (!chars.length) invalid();
  const f = new OutlineFont();
  f.chars = chars;
  f.global = global;
  f.fd = Array(chars.length).fill(0);
  const matrix = d.get(1207);
  if (matrix?.length === 6) {
    f.matrix = matrix.slice() as Matrix;
    validMatrix(f.matrix);
  }
  const local = (dict: Map<number, number[]>): Uint8Array[] => {
    const a = dict.get(18);
    if (a?.length !== 2) return [];
    if (a.some((n) => n < 0 || n > b.length)) invalid();
    const size = Math.trunc(a[0]),
      start = Math.trunc(a[1]);
    if (size > b.length - start) invalid();
    const priv = cffDict(b.subarray(start, start + size)),
      off = cffInt(priv, 19);
    return off ? cffIndex(b, start + off)[0] : [];
  };
  if (d.has(1230)) {
    const [dicts] = cffIndex(b, cffInt(d, 1236));
    if (!dicts.length || dicts.length > 256) invalid();
    for (const raw of dicts) {
      const fd = cffDict(raw);
      if (fd.get(1207)?.length) unsupported("CFF FD FontMatrix not supported");
      f.local.push(local(fd));
    }
    at = cffInt(d, 1237);
    if (at < 0 || at >= b.length) invalid();
    let format = b[at++];
    if (format === 0) {
      if (chars.length > b.length - at) invalid();
      for (let j = 0; j < f.fd.length; j++) f.fd[j] = b[at + j];
    } else if (format === 3) {
      const n = u16(b, at);
      at += 2;
      if (n < 1 || n * 3 + 2 > b.length - at) invalid();
      for (let j = 0; j < n; j++) {
        const start = u16(b, at + j * 3),
          end = u16(b, at + (j + 1) * 3),
          fd = b[at + j * 3 + 2];
        if (
          start >= end ||
          end > chars.length ||
          (j === 0 && start !== 0) ||
          (j === n - 1 && end !== chars.length)
        )
          invalid();
        for (let k = start; k < end; k++) f.fd[k] = fd;
      }
    } else invalid();
    if (f.fd.some((fd) => fd >= f.local.length)) invalid();
    at = cffInt(d, 15);
    if (at < 3 || at >= b.length) invalid();
    format = b[at++];
    for (let gid = 1; gid < chars.length; ) {
      const first = u16(b, at);
      at += 2;
      let n = 0;
      if (format === 1) {
        if (at >= b.length) invalid();
        n = b[at++];
      } else if (format === 2) {
        n = u16(b, at);
        at += 2;
      } else if (format !== 0) invalid();
      if (n >= chars.length - gid || first + n > 65535) invalid();
      for (let j = 0; j <= n; j++) f.codes.set(first + j, gid++);
    }
  } else {
    f.local = [local(d)];
    namedCharset(f, b, d, custom);
  }
  return f;
}
const subrBias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
export class CharString {
  stack: number[] = [];
  x = 0;
  y = 0;
  stems = 0;
  ops = 0;
  path = "";
  open = false;
  done = false;
  flex = false;
  flexPoints: [number, number][] = [];
  others: number[] = [];
  box?: Rect;
  constructor(
    readonly font: OutlineFont,
    readonly local: Uint8Array[] = [],
  ) {}
  close(): void {
    if (this.open) {
      this.path += "Z";
      this.open = false;
    }
  }
  point(op: string, ...v: number[]): void {
    if (
      ++this.ops > 100000 ||
      v.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e7)
    )
      limit();
    for (let j = 0; j + 1 < v.length; j += 2) {
      const r = { x: v[j], y: v[j + 1], width: 0, height: 0 };
      this.box = this.box ? union(this.box, r) : r;
    }
    this.path += op + v.map((n) => fnum(n) + " ").join("");
    if (this.path.length > 1 << 20) limit();
  }
  move(x: number, y: number): void {
    if (this.flex) {
      this.x += x;
      this.y += y;
      return;
    }
    this.close();
    this.x += x;
    this.y += y;
    this.open = true;
    this.point("M", this.x, this.y);
  }
  line(x: number, y: number): void {
    this.x += x;
    this.y += y;
    this.point("L", this.x, this.y);
  }
  curve(...v: number[]): void {
    const x1 = this.x + v[0],
      y1 = this.y + v[1],
      x2 = x1 + v[2],
      y2 = y1 + v[3];
    this.x = x2 + v[4];
    this.y = y2 + v[5];
    this.point("C", x1, y1, x2, y2, this.x, this.y);
  }
  run(b: Uint8Array, depth: number): void {
    if (depth > 16) limit();
    const cursor = { at: 0 };
    while (cursor.at < b.length && !this.done) {
      if (++this.ops > 100000) limit();
      let op = b[cursor.at];
      if (op >= 32 || op === 28) {
        this.stack.push(cffNumber(b, cursor, false, this.font.type1));
        if (this.stack.length > 96) limit();
        continue;
      }
      cursor.at++;
      if (op === 12) {
        if (cursor.at === b.length) invalid();
        op = 1200 + b[cursor.at++];
      }
      let a = this.stack,
        n = a.length;
      switch (op) {
        case 1:
        case 3:
        case 18:
        case 23:
        case 19:
        case 20:
          this.stems += Math.floor(n / 2);
          if (this.stems > 96) limit();
          if (op === 19 || op === 20) {
            cursor.at += Math.ceil(this.stems / 8);
            if (cursor.at > b.length) invalid();
          }
          break;
        case 4:
        case 21:
        case 22: {
          const want = op === 21 ? 2 : 1;
          if (n === want + 1) {
            a = a.slice(1);
            n--;
          }
          if (n !== want) invalid();
          if (op === 4) this.move(0, a[0]);
          else if (op === 22) this.move(a[0], 0);
          else this.move(a[0], a[1]);
          break;
        }
        case 5:
          if (n < 2 || n % 2) invalid();
          for (let j = 0; j < n; j += 2) this.line(a[j], a[j + 1]);
          break;
        case 6:
        case 7: {
          let horizontal = op === 6;
          for (const v of a) {
            if (horizontal) this.line(v, 0);
            else this.line(0, v);
            horizontal = !horizontal;
          }
          break;
        }
        case 8:
          if (n < 6 || n % 6) invalid();
          for (let j = 0; j < n; j += 6) this.curve(...a.slice(j, j + 6));
          break;
        case 24:
          if (n < 8 || (n - 2) % 6) invalid();
          for (let j = 0; j < n - 2; j += 6) this.curve(...a.slice(j, j + 6));
          this.line(a[n - 2], a[n - 1]);
          break;
        case 25:
          if (n < 8 || (n - 6) % 2) invalid();
          for (let j = 0; j < n - 6; j += 2) this.line(a[j], a[j + 1]);
          this.curve(...a.slice(n - 6));
          break;
        case 26:
        case 27: {
          if (n < 4 || n % 4 > 1) invalid();
          let extra = 0;
          if (n % 4 === 1) {
            extra = a[0];
            a = a.slice(1);
            n--;
          }
          for (let j = 0; j < n; j += 4) {
            if (op === 26)
              this.curve(extra, a[j], a[j + 1], a[j + 2], 0, a[j + 3]);
            else this.curve(a[j], extra, a[j + 1], a[j + 2], a[j + 3], 0);
            extra = 0;
          }
          break;
        }
        case 30:
        case 31: {
          if (n < 4 || n % 4 > 1) invalid();
          let h = op === 31;
          for (let j = 0; j + 3 < n; j += 4) {
            const extra = j + 5 === n ? a[j + 4] : 0;
            if (h) this.curve(a[j], 0, a[j + 1], a[j + 2], extra, a[j + 3]);
            else this.curve(0, a[j], a[j + 1], a[j + 2], a[j + 3], extra);
            h = !h;
          }
          break;
        }
        case 10:
        case 29: {
          if (n < 1) invalid();
          let idx = Math.trunc(a[n - 1]);
          this.stack = this.stack.slice(0, n - 1);
          const sub = op === 29 ? this.font.global : this.local;
          if (!this.font.type1) idx += subrBias(sub.length);
          if (idx < 0 || idx >= sub.length) invalid();
          this.run(sub[idx], depth + 1);
          continue;
        }
        case 11:
          return;
        case 14:
          if (n > 1) unsupported("Composite endchar not supported");
          this.close();
          this.done = true;
          break;
        case 1234:
          if (n !== 7) invalid();
          this.curve(a[0], 0, a[1], a[2], a[3], 0);
          this.curve(a[4], 0, a[5], -a[2], a[6], 0);
          break;
        case 1235:
          if (n !== 13) invalid();
          this.curve(...a.slice(0, 6));
          this.curve(...a.slice(6, 12));
          break;
        case 1236:
          if (n !== 9) invalid();
          this.curve(a[0], a[1], a[2], a[3], a[4], 0);
          this.curve(a[5], 0, a[6], a[7], a[8], -a[1] - a[3] - a[7]);
          break;
        case 1237: {
          if (n !== 11) invalid();
          let dx = 0,
            dy = 0;
          for (let j = 0; j < 10; j += 2) {
            dx += a[j];
            dy += a[j + 1];
          }
          let x = -dx,
            y = a[10];
          if (Math.abs(dx) > Math.abs(dy)) {
            x = a[10];
            y = -dy;
          }
          this.curve(...a.slice(0, 6));
          this.curve(a[6], a[7], a[8], a[9], x, y);
          break;
        }
        case 1212:
          if (n < 2 || a[n - 1] === 0) invalid();
          this.stack[n - 2] /= a[n - 1];
          this.stack = this.stack.slice(0, n - 1);
          continue;
        case 9:
          if (!this.font.type1) invalid();
          this.close();
          break;
        case 13:
          if (!this.font.type1 || n !== 2) invalid();
          this.x = a[0];
          this.y = 0;
          break;
        case 1200:
        case 1201:
        case 1202:
          if (!this.font.type1) invalid();
          break;
        case 1207:
          if (!this.font.type1 || n !== 4) invalid();
          this.x = a[0];
          this.y = a[1];
          break;
        case 1216: {
          if (!this.font.type1 || n < 2) invalid();
          const count = Math.trunc(a[n - 2]),
            sub = Math.trunc(a[n - 1]);
          if (count < 0 || count > n - 2) invalid();
          const args = a.slice(n - 2 - count, n - 2);
          this.others = [];
          if (sub === 0) {
            if (count !== 3 || this.flexPoints.length !== 7 || !this.flex)
              invalid();
            const v = this.flexPoints;
            this.point("C", ...v[1], ...v[2], ...v[3]);
            this.point("C", ...v[4], ...v[5], ...v[6]);
            this.flex = false;
            this.others = [args[1], args[2]];
          } else if (sub === 1) {
            if (count !== 0) invalid();
            this.flex = true;
            this.flexPoints = [];
          } else if (sub === 2) {
            if (count !== 0 || !this.flex || this.flexPoints.length >= 7)
              invalid();
            this.flexPoints.push([this.x, this.y]);
          } else if (sub === 3) {
            if (count !== 1) invalid();
            this.others.push(args[0]);
          } else unsupported(`Unsupported Type 1 OtherSubr ${sub}`);
          this.stack = this.stack.slice(0, n - 2 - count);
          continue;
        }
        case 1217:
          if (!this.font.type1 || !this.others.length) invalid();
          this.stack.push(this.others.shift()!);
          continue;
        case 1233:
          if (!this.font.type1 || n !== 2) invalid();
          this.x = a[0];
          this.y = a[1];
          break;
        default:
          unsupported(`Unsupported charstring operator ${op}`);
      }
      this.stack = [];
    }
  }
}
