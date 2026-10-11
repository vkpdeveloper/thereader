import { OutlineFont, parseCFF, u16 } from "./cff";
import { Font, Fonts, glyphName } from "./font";
import { type Matrix, IDENTITY, validMatrix } from "./geometry";
import { PdfError, invalid, limit } from "./model";
import { PDF } from "./parser";
import {
  Lexer,
  Stream,
  asArray,
  binary,
  hexDecode,
  integer,
  named,
  number,
} from "./syntax";
import { TrueTypeFont } from "./truetype";
import { type3Outline } from "./type3";

export function type1Decrypt(
  b: Uint8Array,
  seed: number,
  skip: number,
): Uint8Array {
  const out = new Uint8Array(b.length);
  b.forEach((c, j) => {
    out[j] = c ^ (seed >> 8);
    seed = ((c + seed) * 52845 + 22719) & 65535;
  });
  return skip < 0 || skip > out.length ? new Uint8Array() : out.subarray(skip);
}
export function parseType1(
  b: Uint8Array,
  length1: number,
  length2: number,
): [OutlineFont, string[]] {
  if (
    length1 <= 0 ||
    length1 > b.length ||
    length2 < 0 ||
    length2 > b.length - length1
  )
    invalid();
  const clear = b.subarray(0, length1),
    text = binary(clear),
    names = Array<string>(256).fill("");
  for (const m of text.matchAll(/\bdup\s+(\d+)\s+\/([^\s]+)\s+put\b/g)) {
    const n = Number(m[1]);
    if (n >= 0 && n < 256) names[n] = m[2];
  }
  let encrypted = b.subarray(length1, length1 + length2);
  const compact = binary(encrypted).replace(/\s/g, "");
  if (
    compact.length >= 4 &&
    /^[\da-f]{4}/i.test(compact) &&
    compact.length % 2 === 0 &&
    /^[\da-f]+$/i.test(compact)
  )
    encrypted = hexDecode(compact);
  const privateData = type1Decrypt(encrypted, 55665, 4);
  if (!privateData.length) invalid();
  let header = binary(privateData),
    lenIV = 4;
  const subrsAt = header.indexOf("/Subrs");
  if (subrsAt >= 0) header = header.slice(0, subrsAt);
  const match = /\/lenIV\s+(-?\d+)/.exec(header);
  if (match) {
    lenIV = Number(match[1]);
    if (lenIV < -1 || lenIV > 32) invalid();
  }
  const f = new OutlineFont();
  f.type1 = true;
  f.names = new Map();
  const matrixAt = text.indexOf("/FontMatrix");
  if (matrixAt >= 0) {
    const a = asArray(new Lexer(clear, matrixAt + 11).value());
    if (a.length === 6) {
      f.matrix = a.map(number) as Matrix;
      validMatrix(f.matrix);
    }
  }
  let at = 0;
  const token = (): string => {
    while (at < privateData.length && privateData[at] <= 32) at++;
    const start = at;
    while (at < privateData.length && privateData[at] > 32) at++;
    return binary(privateData.subarray(start, at));
  };
  const intToken = (): number => {
    const s = token();
    return /^[-+]?\d+$/.test(s) ? Number(s) : NaN;
  };
  const decode = (n: number): Uint8Array => {
    if (
      !Number.isSafeInteger(n) ||
      n < 0 ||
      n > privateData.length - at - 1 ||
      at >= privateData.length ||
      privateData[at] > 32
    )
      invalid();
    at++;
    const v = privateData.subarray(at, at + n);
    at += n;
    if (lenIV === -1) return v;
    if (n < lenIV) invalid();
    return type1Decrypt(v, 4330, lenIV);
  };
  let subrs: Uint8Array[] = [],
    inChars = false;
  while (at < privateData.length) {
    const t = token();
    if (t === "/Subrs") {
      const n = intToken();
      if (!Number.isInteger(n) || n < 0 || n > 65536) invalid();
      subrs = Array.from({ length: n }, () => new Uint8Array());
    } else if (t === "/CharStrings") inChars = true;
    else if (!inChars && t === "dup" && subrs.length) {
      const idx = intToken();
      if (Number.isNaN(idx)) continue;
      const n = intToken();
      if (Number.isNaN(n)) continue;
      const op = token();
      if (op !== "RD" && op !== "-|") continue;
      if (idx < 0 || idx >= subrs.length) invalid();
      subrs[idx] = decode(n);
    } else if (inChars && t.startsWith("/")) {
      const name = t.slice(1),
        n = intToken();
      if (Number.isNaN(n)) continue;
      const op = token();
      if (op !== "RD" && op !== "-|") continue;
      if (f.chars.length >= 65536) limit();
      const v = decode(n);
      f.names.set(name, f.chars.length);
      f.chars.push(v);
    }
  }
  if (!f.chars.length) invalid();
  f.fd = Array(f.chars.length).fill(0);
  f.local = [subrs];
  return [f, names];
}
export class FontPrograms {
  readonly cache = new WeakMap<Font, OutlineFont | null>();
  constructor(
    readonly p: PDF,
    fonts: Fonts,
  ) {
    fonts.recoverEncoding = (f, page) => !!this.get(f, page);
  }
  get(f: Font, page: number): OutlineFont | undefined {
    if (this.cache.has(f)) return this.cache.get(f) || undefined;
    this.cache.set(f, null);
    const p = this.p;
    let prog: OutlineFont | undefined;
    try {
      if (named(f.source.Subtype) === "Type3") {
        prog = new OutlineFont();
        prog.type3 = true;
        prog.names = new Map();
        const a = p.array(f.source.FontMatrix);
        if (a.length === 6) prog.matrix = a.map(number) as Matrix;
        const chars = p.dict(f.source.CharProcs);
        for (const name of Object.keys(chars).sort()) {
          const s = p.resolve(chars[name]);
          if (!(s instanceof Stream)) continue;
          const b = p.decode(s);
          prog.names.set(name, prog.chars.length);
          prog.chars.push(b);
        }
        if (!prog.chars.length) invalid();
        const current = prog;
        prog.draw = (c, gid) => type3Outline(c, current.chars[gid]);
      } else {
        const cff = p.resolve(f.descriptor.FontFile3),
          ttf = p.resolve(f.descriptor.FontFile2),
          type1 = p.resolve(f.descriptor.FontFile);
        if (cff instanceof Stream) {
          prog = parseCFF(p.decode(cff));
          if (prog.names) {
            const byGID = new Map<number, string>(),
              byUnicode = new Map<string, string>();
            for (const name of [...prog.names.keys()].sort()) {
              byGID.set(prog.names.get(name)!, name);
              const u = glyphName(name);
              if (u && u !== "�") byUnicode.set(u, name);
            }
            for (let code = 0; code < 256; code++)
              if (!f.names[code]) {
                const gid = prog.codes.get(code);
                f.names[code] =
                  f.source.Encoding == null
                    ? gid !== undefined
                      ? byGID.get(gid) || ""
                      : ""
                    : byUnicode.get(f.encoding[code]) || "";
              }
          }
        } else if (ttf instanceof Stream) {
          const tt = new TrueTypeFont(p.decode(ttf));
          prog = new OutlineFont();
          prog.glyphCount = tt.glyphs;
          prog.matrix = [1 / tt.units, 0, 0, 1 / tt.units, 0, 0];
          prog.draw = (c, gid) => tt.draw(c, gid, IDENTITY);
          if (f.cid) {
            const s = p.resolve(f.gidMap);
            if (s instanceof Stream) {
              const v = p.decode(s);
              if (v.length > 131072) limit();
              for (let j = 0; j + 1 < v.length; j += 2) {
                const gid = u16(v, j);
                if (gid < tt.glyphs) prog.codes.set(j / 2, gid);
              }
            } else for (let j = 0; j < tt.glyphs; j++) prog.codes.set(j, j);
          } else
            for (let code = 0; code < 256; code++) {
              const [u] = f.glyph(Uint8Array.of(code));
              let gid = tt.lookup(u.codePointAt(0) ?? 0xfffd);
              if (!gid) gid = tt.lookup(code + 0xf000);
              if (gid > 0) prog.codes.set(code, gid);
            }
        } else if (type1 instanceof Stream) {
          let names: string[];
          [prog, names] = parseType1(
            p.decode(type1),
            integer(p.resolve(type1.dict.Length1)),
            integer(p.resolve(type1.dict.Length2)),
          );
          const byUnicode = new Map<string, string>();
          for (const key of [...prog.names!.keys()].sort()) {
            const u = glyphName(key);
            if (u && u !== "�") byUnicode.set(u, key);
          }
          for (let code = 0; code < 256; code++) {
            f.names[code] ||= names[code];
            if (!f.names[code])
              f.names[code] =
                byUnicode.get(f.glyph(Uint8Array.of(code))[0]) || "";
          }
        } else invalid("no supported embedded CFF/Type 1 program");
      }
      this.cache.set(f, prog);
      return prog;
    } catch (e) {
      if (
        e instanceof PdfError &&
        (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
      )
        throw e;
      p.warn(
        "font-outline",
        page,
        `Positioned graphics use Unicode fallback for ${f.base}: ${e instanceof Error ? e.message : e}`,
      );
      return undefined;
    }
  }
}
