import { decode as decodeJPEG } from "jpeg-js";
import { Assets } from "./assets";
import { PDF } from "./parser";
import { type ImageReader, Interpreter } from "./content";
import {
  type Dict,
  type Value,
  Keyword,
  Lexer,
  Literal,
  Name,
  Stream,
  asArray,
  integer,
  named,
  number,
  white,
} from "./syntax";
import { PdfError, invalid, limit, unsupported } from "./model";
import { finiteRect, rect } from "./geometry";
import { decodeFax } from "./fax";
import { zlibBoundary } from "./deflate-boundary";

export const cmykRGB = (
  c: number,
  m: number,
  y: number,
  k: number,
): [number, number, number] =>
  [c, m, y].map(
    (v) => Math.floor(((255 - v) * (255 - k) * 257) / 255) >> 8,
  ) as [number, number, number];
const gray = (r: number, g: number, b: number) =>
  Math.floor(
    (19595 * r * 257 + 38470 * g * 257 + 7471 * b * 257 + 32768) / 65536,
  ) >> 8;
const clamp = (n: number, max = 255) => Math.max(0, Math.min(max, n));
export function jpegSize(b: Uint8Array): [number, number] {
  if (b[0] !== 255 || b[1] !== 216) invalid("Invalid JPEG image");
  let at = 2;
  while (at < b.length) {
    if (b[at++] !== 255) invalid("Invalid JPEG marker");
    while (b[at] === 255) at++;
    const marker = b[at++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (at + 2 > b.length) invalid();
    const length = b[at] * 256 + b[at + 1];
    if (length < 2 || length > b.length - at) invalid();
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) invalid();
      return [b[at + 5] * 256 + b[at + 6], b[at + 3] * 256 + b[at + 4]];
    }
    at += length;
  }
  return invalid("Missing JPEG frame");
}
export class Images implements ImageReader {
  constructor(
    readonly p: PDF,
    readonly assets: Assets,
  ) {}
  budget(size: number): void {
    if (size > this.p.limits.decodedBytes - this.p.decodedSize) limit();
    this.p.decodedSize += size;
  }
  jpeg(b: Uint8Array, w: number, h: number): Uint8Array {
    const [width, height] = jpegSize(b);
    if (w !== width || h !== height) invalid("Invalid JPEG dimensions");
    const remaining = this.p.limits.decodedBytes - this.p.decodedSize;
    this.budget(w * h * 8);
    return decodeJPEG(b, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: this.p.limits.imagePixels / 1e6,
      maxMemoryUsageInMB: remaining / 1048576,
    }).data;
  }
  image(s: Stream, page: number): string {
    const p = this.p,
      cached = p.assetIDs.get(s);
    if (cached) return cached;
    const w = integer(p.resolve(s.dict.Width)),
      h = integer(p.resolve(s.dict.Height));
    if (w <= 0 || h <= 0 || w > p.limits.imagePixels / h) limit();
    let [b, kind] = p.decodeFilters(s),
      id: string;
    if (kind === "DCTDecode" || kind === "DCT") {
      if (s.dict.Mask != null)
        p.warn(
          "image-mask",
          page,
          "Color-key or explicit image masks are not applied.",
        );
      const [width, height] = jpegSize(b);
      if (width !== w || height !== h) invalid("Invalid JPEG dimensions");
      if (s.dict.SMask != null || s.dict.Decode != null)
        id = this.assets.png(this.jpegRaster(s, b, w, h, page), w, h);
      else id = this.assets.add(b, "image/jpeg", "jpg", w, h);
    } else if (kind === "CCITTFaxDecode" || kind === "CCF")
      id = this.assets.png(
        this.raster(s, this.faxImage(s, b, w, h), w, h, page),
        w,
        h,
      );
    else if (kind === "JPXDecode")
      return unsupported("JPEG 2000 images require an unsupported decoder");
    else if (kind === "")
      id = this.assets.png(this.raster(s, b, w, h, page), w, h);
    else return unsupported(`unsupported image encoding ${kind}`);
    p.assetIDs.set(s, id);
    return id;
  }
  faxImage(s: Stream, b: Uint8Array, w: number, h: number): Uint8Array {
    const p = this.p,
      params = p.array(s.dict.DecodeParms),
      d = p.dict(
        params.length ? params[params.length - 1] : s.dict.DecodeParms,
      );
    const columns = "Columns" in d ? integer(p.resolve(d.Columns)) : 1728,
      rows = integer(p.resolve(d.Rows));
    if (columns !== w || (rows !== 0 && rows !== h))
      invalid("CCITT dimensions");
    const out = decodeFax(
      b,
      w,
      h,
      integer(p.resolve(d.K)),
      p.resolve(d.EndOfLine) === true,
      p.resolve(d.EncodedByteAlign) === true,
      p.limits.decodedBytes - p.decodedSize,
      () => p.check(),
    );
    p.decodedSize += out.length + 16 * (w + 2);
    if (p.resolve(d.BlackIs1) !== true)
      for (let j = 0; j < out.length; j++) out[j] ^= 255;
    return out;
  }
  baseColor(v: Value | undefined, page: number): number {
    const p = this.p;
    v = p.resolve(v);
    let kind = named(v);
    const a = asArray(v);
    if (a.length) {
      kind = named(p.resolve(a[0]));
      if (kind === "ICCBased") {
        if (a.length < 2) invalid();
        const n = integer(p.resolve(p.dict(a[1]).N));
        if (![1, 3, 4].includes(n)) invalid();
        p.warn(
          "icc-profile",
          page,
          "Embedded image ICC profiles are approximated in device color space.",
        );
        return n;
      }
      if (kind === "CalGray") {
        p.warn(
          "color-space",
          page,
          "Calibrated grayscale image colors are approximated in device color space.",
        );
        return 1;
      }
      if (kind === "CalRGB") {
        p.warn(
          "color-space",
          page,
          "Calibrated RGB image colors are approximated in device color space.",
        );
        return 3;
      }
    }
    if (["DeviceGray", "G"].includes(kind)) return 1;
    if (["DeviceRGB", "RGB"].includes(kind)) return 3;
    if (["DeviceCMYK", "CMYK"].includes(kind)) return 4;
    return unsupported(`unsupported indexed image base color space ${kind}`);
  }
  raster(
    s: Stream,
    b: Uint8Array,
    w: number,
    h: number,
    page: number,
  ): Uint8Array {
    const p = this.p,
      mask = s.dict.ImageMask === true;
    const bits = mask ? 1 : integer(p.resolve(s.dict.BitsPerComponent));
    if (![1, 2, 4, 8, 16].includes(bits))
      unsupported(`unsupported image bit depth ${bits}`);
    const cs = p.resolve(s.dict.ColorSpace);
    let kind = named(cs),
      palette = new Uint8Array(),
      indexed = false,
      high = 255,
      channels = 1;
    const a = asArray(cs);
    if (a.length) {
      kind = named(a[0]);
      if (kind === "ICCBased") {
        if (a.length > 1)
          kind =
            (
              { 1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK" } as Record<
                number,
                string
              >
            )[integer(p.dict(a[1]).N)] || kind;
        p.warn(
          "icc-profile",
          page,
          "Embedded image ICC profiles are approximated in device color space.",
        );
      } else if (kind === "Indexed" || kind === "I") {
        if (a.length < 4) invalid();
        const base = this.baseColor(a[1], page);
        indexed = true;
        high = integer(p.resolve(a[2]));
        if (bits > 8 || high < 0 || high > 255) invalid();
        const v = p.resolve(a[3]),
          data =
            v instanceof Literal
              ? v.bytes
              : v instanceof Stream
                ? p.decode(v)
                : new Uint8Array();
        if (data.length < (high + 1) * base) invalid();
        palette = new Uint8Array((high + 1) * 3);
        for (let j = 0; j <= high; j++) {
          const at = j * base;
          palette.set(
            base === 1
              ? [data[at], data[at], data[at]]
              : base === 3
                ? data.subarray(at, at + 3)
                : cmykRGB(data[at], data[at + 1], data[at + 2], data[at + 3]),
            j * 3,
          );
        }
      } else if (kind === "CalRGB") kind = "DeviceRGB";
      else if (kind === "CalGray") kind = "DeviceGray";
    }
    if (mask) {
      kind = "DeviceGray";
      p.warn(
        "image-stencil",
        page,
        "A stencil image is preserved as grayscale.",
      );
    }
    if (["DeviceRGB", "RGB"].includes(kind)) channels = 3;
    else if (["DeviceCMYK", "CMYK"].includes(kind)) channels = 4;
    else if (!["DeviceGray", "G", "Indexed", "I"].includes(kind))
      unsupported(
        kind
          ? `unsupported image color space ${kind}`
          : "image is missing its color space",
      );
    const row = Math.ceil((w * channels * bits) / 8);
    if (h > b.length / row) invalid("truncated image");
    this.budget(w * h * 4);
    const out = new Uint8Array(w * h * 4),
      decode = p.array(s.dict.Decode);
    // Most book illustrations are ordinary 8-bit RGB/grayscale. Avoid three
    // sample calls and a temporary array per pixel on this common path.
    if (bits === 8 && !indexed && decode.length === 0 && channels !== 4) {
      for (let y = 0; y < h; y++) {
        if (y % 128 === 0) p.check();
        for (let x = 0; x < w; x++) {
          const source = (y * w + x) * channels,
            target = (y * w + x) * 4;
          out[target] = b[source];
          out[target + 1] = b[source + (channels === 3 ? 1 : 0)];
          out[target + 2] = b[source + (channels === 3 ? 2 : 0)];
          out[target + 3] = 255;
        }
      }
      this.softMask(s, out, w, h, page);
      return out;
    }
    const sample = (y: number, index: number): number => {
      const bit = index * bits,
        offset = y * row + Math.floor(bit / 8);
      let v: number;
      if (bits >= 8) v = b[offset];
      else {
        const mask = (1 << bits) - 1;
        v = (b[offset] >> (8 - bits - (bit % 8))) & mask;
        if (!indexed) v = Math.floor((v * 255) / mask);
      }
      const c = index % channels;
      if (indexed) {
        if (decode.length >= 2)
          v = Math.floor(
            number(decode[0]) +
              (v / ((1 << bits) - 1)) *
                (number(decode[1]) - number(decode[0])) +
              0.5,
          );
        return clamp(v, high);
      }
      if (decode.length >= 2 * channels)
        v = clamp(
          Math.trunc(
            (number(decode[2 * c]) +
              (v / 255) * (number(decode[2 * c + 1]) - number(decode[2 * c]))) *
              255,
          ),
        );
      return v;
    };
    for (let y = 0; y < h; y++) {
      if (y % 128 === 0) p.check();
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4,
          v = sample(y, x * channels);
        if (channels === 1) {
          out[at] = indexed ? palette[v * 3] : v;
          out[at + 1] = indexed ? palette[v * 3 + 1] : v;
          out[at + 2] = indexed ? palette[v * 3 + 2] : v;
        } else if (channels === 3) {
          out[at] = v;
          out[at + 1] = sample(y, x * 3 + 1);
          out[at + 2] = sample(y, x * 3 + 2);
        } else {
          out.set(
            cmykRGB(
              v,
              sample(y, x * 4 + 1),
              sample(y, x * 4 + 2),
              sample(y, x * 4 + 3),
            ),
            at,
          );
        }
        out[at + 3] = 255;
      }
    }
    this.softMask(s, out, w, h, page);
    return out;
  }
  jpegRaster(
    s: Stream,
    b: Uint8Array,
    w: number,
    h: number,
    page: number,
  ): Uint8Array {
    const out = this.jpeg(b, w, h),
      decode = this.p.array(s.dict.Decode);
    const map = (v: number, component: number): number =>
      Math.floor(
        clamp(
          (number(decode[component * 2]) +
            (v / 255) *
              (number(decode[component * 2 + 1]) -
                number(decode[component * 2]))) *
            255,
        ) + 0.5,
      );
    if (![0, 2, 6, 8].includes(decode.length))
      unsupported("unsupported JPEG Decode array");
    for (let y = 0; y < h; y++) {
      if (y % 128 === 0) this.p.check();
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4,
          r = out[at],
          g = out[at + 1],
          b = out[at + 2];
        if (decode.length === 2)
          out[at] = out[at + 1] = out[at + 2] = map(gray(r, g, b), 0);
        else if (decode.length === 6) {
          out[at] = map(r, 0);
          out[at + 1] = map(g, 1);
          out[at + 2] = map(b, 2);
        } else if (decode.length === 8) {
          const max = Math.max(r, g, b);
          const c = max ? Math.floor(((max - r) * 255) / max) : 0,
            m = max ? Math.floor(((max - g) * 255) / max) : 0,
            yy = max ? Math.floor(((max - b) * 255) / max) : 0;
          out.set(
            cmykRGB(map(c, 0), map(m, 1), map(yy, 2), map(255 - max, 3)),
            at,
          );
        }
      }
    }
    this.softMask(s, out, w, h, page);
    return out;
  }
  maskSamples(s: Stream, w: number, h: number): Uint8Array {
    const p = this.p,
      bits = integer(p.resolve(s.dict.BitsPerComponent));
    if (![1, 2, 4, 8, 16].includes(bits))
      unsupported(`unsupported soft mask bit depth ${bits}`);
    let [b, kind] = p.decodeFilters(s);
    if (kind === "CCITTFaxDecode" || kind === "CCF") {
      b = this.faxImage(s, b, w, h);
      kind = "";
    }
    if (kind === "DCTDecode" || kind === "DCT") {
      const pixels = this.jpeg(b, w, h),
        out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        p.check();
        for (let x = 0; x < w; x++) {
          const at = (y * w + x) * 4;
          out[y * w + x] = gray(pixels[at], pixels[at + 1], pixels[at + 2]);
        }
      }
      return out;
    }
    if (kind) unsupported(`unsupported soft mask encoding ${kind}`);
    const stride = Math.ceil((w * bits) / 8);
    if (h > b.length / stride) invalid();
    if (bits === 8) return b.subarray(0, w * h);
    this.budget(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      p.check();
      for (let x = 0; x < w; x++) {
        const at = y * stride + Math.floor((x * bits) / 8),
          mask = (1 << bits) - 1;
        out[y * w + x] =
          bits === 16
            ? b[at]
            : ((b[at] >> (8 - bits - ((x * bits) % 8))) & mask) *
              Math.floor(255 / mask);
      }
    }
    return out;
  }
  softMask(
    s: Stream,
    out: Uint8Array,
    w: number,
    h: number,
    page: number,
  ): void {
    const p = this.p,
      sm = p.resolve(s.dict.SMask);
    if (sm instanceof Stream) {
      const mw = integer(p.resolve(sm.dict.Width)),
        mh = integer(p.resolve(sm.dict.Height));
      if (mw < 1 || mh < 1 || mw > p.limits.imagePixels / mh) limit();
      if (sm.dict.Matte != null) {
        if (mw !== w || mh !== h)
          unsupported("matte soft mask dimensions must match the image");
        p.warn(
          "image-matte",
          page,
          "Soft-mask matte colors are not unblended; edge colors need visual review.",
        );
      }
      const alpha = this.maskSamples(sm, mw, mh),
        decode = p.array(sm.dict.Decode),
        interpolate = sm.dict.Interpolate === true;
      if (alpha.length < mw * mh) invalid();
      for (let y = 0; y < h; y++) {
        if (y % 128 === 0) p.check();
        for (let x = 0; x < w; x++) {
          const sy = Math.floor(((2 * y + 1) * mh) / (2 * h)),
            sx = Math.floor(((2 * x + 1) * mw) / (2 * w));
          let a = alpha[sy * mw + sx] / 255;
          if (interpolate && (mw !== w || mh !== h)) {
            const fx = ((x + 0.5) * mw) / w - 0.5,
              fy = ((y + 0.5) * mh) / h - 0.5,
              x0 = Math.floor(fx),
              y0 = Math.floor(fy),
              tx = fx - x0,
              ty = fy - y0;
            const at = (xx: number, yy: number) =>
              alpha[clamp(yy, mh - 1) * mw + clamp(xx, mw - 1)] / 255;
            a =
              (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
              (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
          }
          if (decode.length === 2)
            a = number(decode[0]) + a * (number(decode[1]) - number(decode[0]));
          out[(y * w + x) * 4 + 3] = Math.floor(clamp(a, 1) * 255 + 0.5);
        }
      }
    }
    if (s.dict.Mask != null)
      p.warn(
        "image-mask",
        page,
        "Color-key or explicit image masks are not applied.",
      );
  }
  inline(i: Interpreter, l: Lexer): void {
    const d: Dict = Object.create(null),
      aliases: Record<string, string> = {
        W: "Width",
        H: "Height",
        BPC: "BitsPerComponent",
        CS: "ColorSpace",
        F: "Filter",
        DP: "DecodeParms",
        D: "Decode",
        IM: "ImageMask",
        I: "Interpolate",
      };
    for (let n = 0; n < 100; n++) {
      const v = l.value();
      if (v instanceof Keyword && v.value === "ID") break;
      if (!(v instanceof Name)) invalid("inline image dictionary");
      d[aliases[v.value] || v.value] = l.value();
      if (n === 99) limit();
    }
    if (l.pos >= l.data.length || !white(l.data[l.pos])) invalid();
    if (l.data[l.pos] === 13 && l.data[l.pos + 1] === 10) l.pos++;
    l.pos++;
    const cs = named(d.ColorSpace);
    if (cs) {
      const v = this.p.dict(i.resources.ColorSpace)[cs];
      if (v != null) d.ColorSpace = v;
    }
    const start = l.pos,
      tail = l.data.subarray(start);
    let length = 0;
    const filters = asArray(d.Filter),
      filter = named(filters.length ? filters[0] : d.Filter);
    if (!filter) {
      const w = integer(d.Width),
        h = integer(d.Height),
        bits = d.ImageMask === true ? 1 : integer(d.BitsPerComponent),
        color = this.p.resolve(d.ColorSpace),
        array = asArray(color),
        kind = named(array.length ? this.p.resolve(array[0]) : color);
      let channels = ["RGB", "DeviceRGB", "CalRGB", "Lab"].includes(kind)
        ? 3
        : ["CMYK", "DeviceCMYK"].includes(kind)
          ? 4
          : 1;
      if (kind === "ICCBased") channels = integer(this.p.dict(array[1]).N);
      if (d.ImageMask === true) channels = 1;
      if (![1, 3, 4].includes(channels))
        invalid("Inline image color components");
      if (
        w < 1 ||
        h < 1 ||
        bits < 1 ||
        bits > 16 ||
        w > this.p.limits.imagePixels / h
      )
        limit();
      length = Math.ceil((w * channels * bits) / 8) * h;
    } else if (filter === "Fl" || filter === "FlateDecode")
      length = zlibBoundary(
        tail,
        this.p.limits.decodedBytes - this.p.decodedSize,
      );
    else {
      let first = 0,
        last = 0;
      if (filter === "A85" || filter === "ASCII85Decode") {
        first = 126;
        last = 62;
      } else if (filter === "AHx" || filter === "ASCIIHexDecode") first = 62;
      else if (filter === "DCT" || filter === "DCTDecode") {
        first = 255;
        last = 217;
      } else unsupported(`unsupported inline image filter ${filter}`);
      let end = -1;
      for (let at = 0; at < tail.length; at++)
        if (tail[at] === first && (!last || tail[at + 1] === last)) {
          end = at;
          break;
        }
      if (end < 0) invalid();
      length = end + (last ? 2 : 1);
    }
    if (length < 0 || length > tail.length) invalid();
    l.pos = start + length;
    if (l.word() !== "EI") invalid("inline image terminator");
    try {
      const id = this.image(
          new Stream(d, tail.subarray(0, length)),
          i.page.page.number,
        ),
        box = rect(i.g.ctm, 0, 0, 1, 1);
      finiteRect(box);
      i.page.images.push({ kind: "image", asset: id, alt: "Image", box });
    } catch (e) {
      if (
        e instanceof PdfError &&
        (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
      )
        throw e;
      this.p.warn(
        "image",
        i.page.page.number,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}
