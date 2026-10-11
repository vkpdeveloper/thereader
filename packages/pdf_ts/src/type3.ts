import { CharString } from "./cff";
import { type Matrix, IDENTITY, mul, point, validMatrix } from "./geometry";
import {
  type Dict,
  Keyword,
  Lexer,
  Name,
  asArray,
  integer,
  named,
  number,
  white,
} from "./syntax";
import { invalid, limit } from "./model";
import { inflate } from "./filters";
import { zlibBoundary } from "./deflate-boundary";

function type3Mask(c: CharString, l: Lexer, ctm: Matrix): void {
  const d: Dict = Object.create(null);
  for (let n = 0; n < 32; n++) {
    const v = l.value();
    if (v instanceof Keyword && v.value === "ID") break;
    if (!(v instanceof Name)) invalid();
    d[v.value] = l.value();
    if (n === 31) limit();
  }
  const get = (short: string, long: string) => d[long] ?? d[short];
  const w = integer(get("W", "Width")),
    h = integer(get("H", "Height"));
  if (get("IM", "ImageMask") !== true || w < 1 || h < 1 || w > 65536 / h)
    limit();
  const bpc = get("BPC", "BitsPerComponent");
  if ((bpc != null && integer(bpc) !== 1) || get("DP", "DecodeParms") != null)
    invalid();
  let paint = 0;
  const decode = asArray(get("D", "Decode"));
  if (decode.length) {
    if (decode.length !== 2 || number(decode[0]) + number(decode[1]) !== 1)
      invalid();
    if (number(decode[0]) === 1) paint = 1;
    else if (number(decode[0]) !== 0) invalid();
  }
  if (l.pos >= l.data.length || !white(l.data[l.pos])) invalid();
  if (l.data[l.pos] === 13 && l.data[l.pos + 1] === 10) l.pos++;
  l.pos++;
  const stride = Math.ceil(w / 8),
    length = stride * h;
  let data: Uint8Array;
  switch (named(get("F", "Filter"))) {
    case "":
      if (length > l.data.length - l.pos) invalid();
      data = l.data.subarray(l.pos, l.pos + length);
      l.pos += length;
      break;
    case "Fl":
    case "FlateDecode": {
      const tail = l.data.subarray(l.pos),
        size = zlibBoundary(tail, length);
      data = inflate(tail.subarray(0, size), length);
      l.pos += size;
      break;
    }
    default:
      return invalid();
  }
  if (data.length !== length || l.word() !== "EI") invalid();
  const pixel = (x: number, y: number) =>
    ((data[y * stride + (x >> 3)] >> (7 - (x % 8))) & 1) === paint;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; ) {
      if (!pixel(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < w && pixel(x, y)) x++;
      const coords = [
        [start / w, 1 - y / h],
        [x / w, 1 - y / h],
        [x / w, 1 - (y + 1) / h],
        [start / w, 1 - (y + 1) / h],
      ];
      coords.forEach(([x, y], j) =>
        c.point(j ? "L" : "M", ...point(ctm, x, y)),
      );
      c.path += "Z";
    }
}
export function type3Outline(c: CharString, b: Uint8Array): void {
  const l = new Lexer(b),
    stack: Matrix[] = [];
  let a: number[] = [],
    ctm: Matrix = [...IDENTITY];
  const draw = (op: string, ...coords: number[]) => {
    const transformed: number[] = [];
    for (let j = 0; j + 1 < coords.length; j += 2)
      transformed.push(...point(ctm, coords[j], coords[j + 1]));
    c.point(op, ...transformed);
  };
  const need = (n: number) => {
    if (a.length !== n) invalid();
  };
  while (l.pos < b.length) {
    l.skip();
    if (l.pos === b.length) break;
    const v = l.value();
    if (!(v instanceof Keyword)) {
      if (typeof v !== "number") invalid();
      a.push(v);
      if (a.length > 6) limit();
      continue;
    }
    if (++c.ops > 100000) limit();
    switch (v.value) {
      case "d0":
      case "d1":
        break;
      case "q":
        if (stack.length >= 32) limit();
        stack.push(ctm);
        break;
      case "Q":
        if (!stack.length) invalid();
        ctm = stack.pop()!;
        break;
      case "cm":
        need(6);
        ctm = mul(ctm, a as Matrix);
        validMatrix(ctm);
        break;
      case "BI":
        type3Mask(c, l, ctm);
        break;
      case "m":
      case "l":
        need(2);
        if (v.value === "m") {
          c.close();
          c.open = true;
          draw("M", ...a);
        } else draw("L", ...a);
        [c.x, c.y] = a;
        break;
      case "c":
        need(6);
        draw("C", ...a);
        [c.x, c.y] = a.slice(4);
        break;
      case "v":
      case "y":
        need(4);
        draw("C", ...(v.value === "v" ? [c.x, c.y, ...a] : [...a, a[2], a[3]]));
        [c.x, c.y] = a.slice(2);
        break;
      case "h":
      case "f":
      case "F":
        c.close();
        break;
      default:
        invalid();
    }
    a = [];
  }
  c.close();
}
