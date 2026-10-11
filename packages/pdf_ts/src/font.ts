import { PdfError, invalid, limit } from "./model";
import {
  type Dict,
  type Value,
  Keyword,
  Lexer,
  Literal,
  Name,
  Ref,
  Stream,
  asDict,
  binary,
  integer,
  named,
  number,
} from "./syntax";
import { PDF } from "./parser";
import { GLYPHS, TEX_GLYPHS } from "./glyph-data";
const GREEK: Record<string, string> = {
  Alpha: "Α",
  Beta: "Β",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
};

export function utf16(b: Uint8Array): string {
  return new TextDecoder("utf-16be").decode(
    b.subarray(0, b.length - (b.length % 2)),
  );
}
export function decodeText(b: Uint8Array): string {
  if (b[0] === 254 && b[1] === 255) return utf16(b.subarray(2));
  if (b[0] === 255 && b[1] === 254)
    return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 239 && b[1] === 187 && b[2] === 191)
    return new TextDecoder().decode(b.subarray(3));
  const extra = [..."•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž�€"];
  return Array.from(b, (c) =>
    c >= 128 && c - 128 < extra.length
      ? extra[c - 128]
      : String.fromCharCode(c),
  ).join("");
}
export const textString = (v: Value | undefined): string =>
  v instanceof Literal ? decodeText(v.bytes) : "";
export function baseEncoding(kind: string): string[] {
  const e = Array<string>(256).fill("");
  for (let i = 32; i < 127; i++) e[i] = String.fromCharCode(i);
  if (kind === "WinAnsiEncoding") {
    for (let i = 160; i < 256; i++) e[i] = String.fromCharCode(i);
    [..."€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ"].forEach(
      (c, i) => (e[128 + i] = c),
    );
  } else if (kind === "MacRomanEncoding") {
    [
      ..."ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ",
    ].forEach((c, i) => {
      if (128 + i < 256) e[128 + i] = c;
    });
  } else {
    e[39] = "’";
    e[96] = "‘";
    const more: Record<number, string> = {
      161: "¡",
      162: "¢",
      163: "£",
      164: "⁄",
      165: "¥",
      166: "ƒ",
      167: "§",
      168: "¤",
      169: "'",
      170: "“",
      171: "«",
      172: "‹",
      173: "›",
      174: "fi",
      175: "fl",
      177: "–",
      178: "†",
      179: "‡",
      180: "·",
      182: "¶",
      183: "•",
      184: "‚",
      185: "„",
      186: "”",
      187: "»",
      188: "…",
      189: "‰",
      191: "¿",
      193: "`",
      194: "´",
      195: "ˆ",
      196: "˜",
      197: "¯",
      198: "˘",
      199: "˙",
      200: "¨",
      202: "˚",
      203: "¸",
      205: "˝",
      206: "˛",
      207: "ˇ",
      208: "—",
      225: "Æ",
      227: "ª",
      232: "Ł",
      233: "Ø",
      234: "Œ",
      235: "º",
      241: "æ",
      245: "ı",
      248: "ł",
      249: "ø",
      250: "œ",
      251: "ß",
    };
    for (const [k, v] of Object.entries(more)) e[Number(k)] = v;
  }
  return e;
}
export function glyphName(value: string): string {
  const s = value.split(".")[0];
  if (Object.hasOwn(GREEK, s)) return GREEK[s];
  if (Object.hasOwn(GLYPHS, s)) return GLYPHS[s];
  if (s.includes("_")) return s.split("_").map(glyphName).join("");
  if ([...s].length === 1) return s;
  if (/^uni(?:[\da-f]{4})+$/i.test(s)) {
    const units = s
      .slice(3)
      .match(/.{4}/g)!
      .map((n) => parseInt(n, 16));
    const b = new Uint8Array(units.length * 2);
    units.forEach((n, i) => {
      b[i * 2] = n >> 8;
      b[i * 2 + 1] = n;
    });
    return utf16(b);
  }
  if (/^u[\da-f]{4,6}$/i.test(s)) {
    const n = parseInt(s.slice(1), 16);
    if (n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))
      return String.fromCodePoint(n);
  }
  for (const suffix of ["Bigg", "bigg", "Big", "big", "display", "text"]) {
    if (s.endsWith(suffix)) {
      const base = s.slice(0, -suffix.length);
      if (Object.hasOwn(GLYPHS, base)) return GLYPHS[base];
    }
  }
  return Object.hasOwn(TEX_GLYPHS, s) ? TEX_GLYPHS[s] : "�";
}
export function codeValue(b: Uint8Array): number {
  let n = 0;
  for (const c of b) n = n * 256 + c;
  return n;
}
export function codeBytes(n: number, length: number): string {
  const b = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    b[i] = n & 255;
    n = Math.floor(n / 256);
  }
  return binary(b);
}
export function parseCMap(b: Uint8Array): {
  unicode: Map<string, string>;
  lengths: number[];
} {
  const unicode = new Map<string, string>(),
    lengths = new Set<number>(),
    l = new Lexer(b);
  let expanded = 0,
    previous: Value = null;
  while (l.pos < b.length) {
    l.skip();
    if (l.pos === b.length) break;
    const v = l.value();
    if (!(v instanceof Keyword)) {
      previous = v;
      continue;
    }
    const count = integer(previous);
    if (count < 0 || count > 65536) limit();
    if (v.value === "beginbfchar") {
      expanded += count;
      if (expanded > 100000) limit();
      for (let i = 0; i < count; i++) {
        const src = l.value(),
          dst = l.value();
        if (
          !(src instanceof Literal) ||
          !(dst instanceof Literal) ||
          src.bytes.length < 1 ||
          src.bytes.length > 4
        )
          invalid("Invalid CMap character");
        if (dst.bytes.length > 256) limit();
        unicode.set(binary(src.bytes), utf16(dst.bytes));
        lengths.add(src.bytes.length);
      }
    } else if (v.value === "beginbfrange") {
      for (let i = 0; i < count; i++) {
        const a = l.value(),
          z = l.value(),
          dest = l.value();
        if (
          !(a instanceof Literal) ||
          !(z instanceof Literal) ||
          a.bytes.length < 1 ||
          a.bytes.length > 4 ||
          a.bytes.length !== z.bytes.length
        )
          invalid("Invalid CMap range");
        const start = codeValue(a.bytes),
          end = codeValue(z.bytes);
        if (end < start || end - start > 65536) limit();
        expanded += end - start + 1;
        if (expanded > 100000) limit();
        lengths.add(a.bytes.length);
        for (let offset = 0; offset <= end - start; offset++) {
          const key = codeBytes(start + offset, a.bytes.length);
          if (dest instanceof Literal) {
            if (dest.bytes.length > 256) limit();
            const dst = dest.bytes.slice();
            let carry = offset;
            for (let j = dst.length - 1; j >= 0 && carry > 0; j--) {
              carry += dst[j];
              dst[j] = carry & 255;
              carry = Math.floor(carry / 256);
            }
            unicode.set(key, utf16(dst));
          } else if (Array.isArray(dest) && offset < dest.length) {
            const d = dest[offset];
            const dst = d instanceof Literal ? d.bytes : new Uint8Array();
            if (dst.length > 256) limit();
            unicode.set(key, utf16(dst));
          }
        }
      }
    }
    previous = null;
  }
  return { unicode, lengths: [...lengths].sort((a, b) => b - a) };
}
export class Font {
  base = "";
  bold = false;
  italic = false;
  mono = false;
  cid = false;
  vertical = false;
  math = false;
  encoding = baseEncoding("");
  unicode = new Map<string, string>();
  lengths: number[] = [];
  widths = new Map<number, number>();
  defaultWidth = 500;
  names = Array<string>(256).fill("");
  source: Dict = Object.create(null);
  descriptor: Dict = Object.create(null);
  gidMap: Value | undefined;
  glyph(s: Uint8Array): [string, number, number] {
    for (const n of this.lengths)
      if (n <= s.length) {
        const u = this.unicode.get(binary(s.subarray(0, n)));
        if (u !== undefined) return [u, codeValue(s.subarray(0, n)), n];
      }
    const n = Math.min(this.cid ? 2 : 1, s.length),
      code = codeValue(s.subarray(0, n));
    return [this.cid ? "�" : this.encoding[code & 255] || "�", code, n];
  }
  width(code: number, text: string): number {
    const value = this.widths.get(code);
    if (value !== undefined) return value;
    if (this.mono || this.cid) return this.defaultWidth;
    if (text.length === 1) {
      if (text === " ") return 278;
      if ("ilI.,'!:;|".includes(text)) return 250;
      if ("mwMW@".includes(text)) return 800;
      if (text >= "A" && text <= "Z") return 667;
    }
    return this.defaultWidth;
  }
}
export class Fonts {
  readonly cache = new Map<string, Font>();
  // Embedded-font reader is supplied by the outline module to avoid a module cycle.
  recoverEncoding?: (font: Font, page: number) => boolean;
  constructor(readonly p: PDF) {}
  get(v: Value | undefined, page: number): Font {
    const p = this.p,
      ref = v instanceof Ref ? v : undefined;
    const cached = ref && this.cache.get(ref.key);
    if (cached) return cached;
    const d = p.dict(v),
      f = new Font();
    f.base = named(d.BaseFont);
    f.source = d;
    const lower = f.base.toLowerCase(),
      bare = lower.slice(lower.lastIndexOf("+") + 1);
    f.bold = /bold|black|demi|-bd$/.test(lower) || /^(cmbx|sfbx)/.test(bare);
    f.italic = /ital|oblique/.test(lower) || /^(cmti|sfti)/.test(bare);
    f.mono =
      /courier|mono|consolas/.test(lower) ||
      /^(cmtt|sftt|sfvt|sfit)/.test(bare);
    f.math =
      lower.includes("math") ||
      /^(cmmi|cmsy|cmex|msam|msbm|eurm|eufm)/.test(bare);
    f.cid = named(d.Subtype) === "Type0";
    const enc = p.resolve(d.Encoding);
    let kind = named(enc);
    f.vertical = kind.endsWith("-V");
    if (f.vertical)
      p.warn(
        "vertical-text",
        page,
        "Vertical writing is preserved but reading order needs review.",
      );
    if (f.cid && kind !== "Identity-H" && kind !== "Identity-V")
      p.warn(
        "font-cmap",
        page,
        `Non-Identity CID encodings need review: ${kind}`,
      );
    const ed = asDict(enc);
    if (Object.keys(ed).length) kind = named(ed.BaseEncoding);
    f.encoding = baseEncoding(kind);
    if (f.mono) f.defaultWidth = 600;
    const differences = p.array(ed.Differences);
    for (let i = 0; i < differences.length; ) {
      let code = integer(differences[i++]);
      while (i < differences.length && differences[i] instanceof Name) {
        const n = named(differences[i++]);
        if (code >= 0 && code < 256) {
          f.encoding[code] = glyphName(n);
          f.names[code] = n;
        }
        code++;
      }
    }
    let fd = d;
    if (f.cid) {
      const descendants = p.array(d.DescendantFonts);
      if (descendants.length) fd = p.dict(descendants[0]);
      f.defaultWidth = "DW" in fd ? number(p.resolve(fd.DW)) : 1000;
      const w = p.array(fd.W);
      let expanded = 0;
      for (let i = 0; i < w.length; ) {
        p.check();
        const start = integer(w[i++]);
        if (i === w.length) break;
        const value = p.resolve(w[i]);
        if (Array.isArray(value)) {
          i++;
          expanded += value.length;
          if (expanded > 100000) limit();
          value.forEach((v, j) => f.widths.set(start + j, number(v)));
        } else {
          const end = integer(w[i++]);
          if (i === w.length) break;
          const width = number(w[i++]);
          if (start < 0 || end < start || end - start > 65536) limit();
          expanded += end - start + 1;
          if (expanded > 100000) limit();
          for (let c = start; c <= end; c++) f.widths.set(c, width);
        }
      }
    } else {
      const first = integer(d.FirstChar),
        matrix = p.array(d.FontMatrix);
      const scale =
        named(d.Subtype) === "Type3" && matrix.length === 6
          ? number(matrix[0]) * 1000
          : 1;
      p.array(d.Widths).forEach((w, i) =>
        f.widths.set(first + i, number(w) * scale),
      );
    }
    f.descriptor = p.dict(fd.FontDescriptor);
    f.gidMap = fd.CIDToGIDMap;
    const flags = integer(f.descriptor.Flags);
    f.mono ||= !!(flags & 1);
    f.italic ||= !!(flags & 64);
    if (number(f.descriptor.MissingWidth) > 0)
      f.defaultWidth = number(f.descriptor.MissingWidth);
    const cmap = p.resolve(d.ToUnicode);
    if (cmap instanceof Stream) {
      try {
        const parsed = parseCMap(p.decode(cmap));
        f.unicode = parsed.unicode;
        f.lengths = parsed.lengths;
      } catch (e) {
        if (
          e instanceof PdfError &&
          (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
        )
          throw e;
        p.warn(
          "font-unicode",
          page,
          String(e instanceof Error ? e.message : e),
        );
      }
    }
    if (
      !f.cid &&
      d.Encoding == null &&
      (f.descriptor.FontFile != null || f.descriptor.FontFile3 != null)
    ) {
      if (this.recoverEncoding?.(f, page))
        f.names.forEach((n, code) => {
          if (n) f.encoding[code] = glyphName(n);
        });
      else
        p.warn(
          "font-encoding",
          page,
          "Embedded simple-font encoding could not be resolved; StandardEncoding fallback is approximate.",
        );
    }
    if (f.cid && !f.unicode.size)
      p.warn(
        "missing-unicode",
        page,
        `CID font ${f.base} has no usable ToUnicode map; unmapped glyphs are marked �.`,
      );
    if (/symbol|dingbat/.test(lower) && !f.unicode.size)
      p.warn(
        "symbol-font",
        page,
        `Symbol font ${f.base} has no ToUnicode map; glyphs need review.`,
      );
    if (ref) this.cache.set(ref.key, f);
    return f;
  }
}
