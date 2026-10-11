import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { zlibSync, unzlibSync, unzipSync } from "fflate";
import { CharString, OutlineFont, parseCFF } from "../src/cff";
import { type3Outline } from "../src/type3";
import { decodeFax } from "../src/fax";
import { bytes } from "../src/syntax";
import { zlibBoundary } from "../src/deflate-boundary";
import { PDF } from "../src/parser";
import { Assets, encodePNG } from "../src/assets";
import { extract, epub } from "../src";

const cs = (...nums: number[]) =>
  nums.flatMap((n) =>
    n >= -107 && n <= 107 ? [n + 139] : [28, (n >> 8) & 255, n & 255],
  );
test("charstring subroutines preserve curves and bound recursion", () => {
  const f = new OutlineFont(),
    c = new CharString(f, [
      Uint8Array.from([...cs(100, 0, 0, 100, -100, 0), 8, 11]),
    ]);
  c.run(Uint8Array.from([...cs(10, 20), 21, ...cs(-107), 10, 14]), 0);
  expect(c.path).toContain("C110.000 20.000 110.000 120.000 10.000 120.000");
  const recursive = new CharString(f, [Uint8Array.from([...cs(-107), 10])]);
  expect(() => recursive.run(Uint8Array.from([...cs(-107), 10]), 0)).toThrow(
    "resource limit",
  );
  expect(() =>
    new CharString(f).run(Uint8Array.from([...cs(1, 2), 19]), 0),
  ).toThrow();
});
test("Type 3 bitmap and vector transforms retain the original coordinates", () => {
  for (const compressed of [false, true]) {
    let raw = Uint8Array.of(128, 64);
    if (compressed) raw = zlibSync(raw);
    const prefix = bytes(
        "500 0 10 20 12 22 d1 q 2 0 0 2 10 20 cm BI /W 2 /H 2 /IM true /D [1 0] " +
          (compressed ? "/F /Fl " : "") +
          "ID ",
      ),
      suffix = bytes("\nEI Q"),
      b = new Uint8Array(prefix.length + raw.length + suffix.length);
    b.set(prefix);
    b.set(raw, prefix.length);
    b.set(suffix, prefix.length + raw.length);
    const c = new CharString(new OutlineFont());
    type3Outline(c, b);
    expect(c.box).toEqual({ x: 10, y: 20, width: 2, height: 2 });
    expect(c.path.match(/M/g)?.length).toBe(2);
  }
  const c = new CharString(new OutlineFont());
  type3Outline(c, bytes("600 0 d0 2 0 0 2 10 20 cm 3 4 m 5 6 7 8 v f"));
  expect(c.path).toContain("C16.000 28.000 20.000 32.000 24.000 36.000");
  for (const bad of [
    "Q",
    "BI /W 999999 /H 999999 /IM true ID x EI",
    "BI /W 2 /H 2 /IM true ID x",
  ])
    expect(() =>
      type3Outline(new CharString(new OutlineFont()), bytes(bad)),
    ).toThrow();
});
test("zlib boundaries ignore embedded PDF delimiters in stored, fixed and dynamic blocks", () => {
  for (const level of [0, 1, 6, 9] as const) {
    const data = bytes("binary EI bytes ~> " + "abcdefgh".repeat(10000)),
      compressed = zlibSync(data, { level }),
      tail = new Uint8Array(compressed.length + 10);
    tail.set(compressed);
    tail.set(bytes(" EI Q end "), compressed.length);
    expect(zlibBoundary(tail, data.length)).toBe(compressed.length);
    expect(() => zlibBoundary(tail, 16)).toThrow("resource limit");
    for (const length of [0, 1, 3, compressed.length - 1])
      expect(() =>
        zlibBoundary(compressed.subarray(0, length), data.length),
      ).toThrow();
  }
});
test("CCITT T4/T6 match independent libtiff reference pixels", () => {
  for (const width of [17, 513])
    for (const group of [3, 4]) {
      const data = new Uint8Array(
          readFileSync(
            new URL(
              `../../pdf_go/testdata/fax/group${group}-${width}.bin`,
              import.meta.url,
            ),
          ),
        ),
        out = decodeFax(
          data,
          width,
          16,
          group === 4 ? -1 : 0,
          false,
          false,
          100000,
        );
      let matched = 0;
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < width; x++) {
          const value =
              ((out[y * Math.ceil(width / 8) + (x >> 3)] >> (7 - (x % 8))) &
                1) ===
              1,
            band = Math.floor(x / (y * 3 + 1)) + y,
            want = y === 1 || (y > 1 && (band % 4 === 0 || band % 4 === 1));
          if (value === want) matched++;
        }
      expect(matched).toBe(width * 16);
      expect(() =>
        decodeFax(data, width, 16, group === 4 ? -1 : 0, false, false, 1),
      ).toThrow("resource limit");
    }
  expect(
    decodeFax(Uint8Array.of(0x30, 0xfc), 8, 2, -1, false, false, 1000),
  ).toEqual(Uint8Array.of(0x1e, 0x1e));
});
test("PNG pixels and deterministic EPUB packaging are independent of compression", () => {
  const pixels = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128),
    png = encodePNG(pixels, 2, 1),
    view = new DataView(png.buffer);
  let at = 8,
    idat: Uint8Array | undefined;
  while (at < png.length) {
    const length = view.getUint32(at),
      name = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (name === "IDAT") idat = png.subarray(at + 8, at + 8 + length);
    at += length + 12;
  }
  expect(unzlibSync(idat!)).toEqual(Uint8Array.of(0, ...pixels));
  const data = new Uint8Array(
      readFileSync(
        new URL(
          "../../../eval/pdf/native/fixtures/398992071b456a1af0882dd6bac8f39bfb3b0b4be6d6e927f2f54c7c33ec3c27.pdf",
          import.meta.url,
        ),
      ),
    ),
    doc = extract(data),
    a = epub(doc),
    b = epub(doc);
  expect(a).toEqual(b);
  const files = unzipSync(a);
  expect(new TextDecoder().decode(files.mimetype)).toBe("application/epub+zip");
  expect(new TextDecoder().decode(files["OEBPS/page-1.xhtml"])).toContain(
    "After the image",
  );
  expect(Object.keys(files).some((n) => n.startsWith("OEBPS/assets/"))).toBe(
    true,
  );
});

for (const name of ["named-rgb", "named-icc"])
  test(`inline ${name} keeps RGB bytes and following text`, () => {
    const doc = extract(
      new Uint8Array(
        readFileSync(
          new URL(
            `../../../eval/pdf/native/edge-fixtures/${name}.pdf`,
            import.meta.url,
          ),
        ),
      ),
    );
    expect(
      doc.pages.flatMap((p) => p.blocks).some((b) => b.text === "After image"),
    ).toBe(true);
    expect(doc.assets.length).toBe(1);
    expect(doc.assets[0].mediaType).toBe("image/png");
    const png = doc.assets[0].data,
      view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let at = 8;
    while (at < png.length) {
      const n = view.getUint32(at);
      if (new TextDecoder().decode(png.subarray(at + 4, at + 8)) === "IDAT")
        expect(unzlibSync(png.subarray(at + 8, at + 8 + n))).toEqual(
          Uint8Array.of(0, 255, 0, 0, 255),
        );
      at += n + 12;
    }
  });
test("asset transfers never detach the PDF or duplicate a shared stream buffer", () => {
  const input = new Uint8Array(
      readFileSync(
        new URL(
          "../../../eval/pdf/native/edge-fixtures/named-rgb.pdf",
          import.meta.url,
        ),
      ),
    ),
    p = new PDF(input),
    assets = new Assets(p),
    size = input.length;
  assets.add(input.subarray(0, 5), "image/jpeg", "jpg", 1, 1);
  assets.add(input.subarray(5, 10), "image/jpeg", "jpg", 1, 1);
  const out = structuredClone(p.out, {
    transfer: p.out.assets.map((a) => a.data.buffer),
  });
  expect(out.assets).toHaveLength(2);
  expect(input.length).toBe(size);
  expect(out.assets[0].data).toEqual(input.subarray(0, 5));
});
