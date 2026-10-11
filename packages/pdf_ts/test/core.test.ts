import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zlibSync } from "fflate";
import { PDF } from "../src/parser";
import { Lexer, Ref, bytes, named } from "../src/syntax";
import { parseCMap, textString } from "../src/font";
import { inflate, predict, runLength } from "../src/filters";
import { sha256 } from "../src/hash";

test("lexer keeps names, references, escaped strings and UTF-16 distinct", () => {
  const l = new Lexer(
    bytes(
      "[12 0 R /A#20B (one\\n\\050two\\051\\\nthree) <FEFF0041> << /Flag true /X null >>]",
    ),
  );
  const a = l.value() as any[];
  expect(a[0]).toEqual(new Ref(12, 0));
  expect(named(a[1])).toBe("A B");
  expect(textString(a[2])).toBe("one\n(two)three");
  expect(textString(a[3])).toBe("A");
});
test("CMap preserves ligatures, surrogate pairs and range arrays", () => {
  const { unicode, lengths } = parseCMap(
    bytes(
      "2 beginbfchar <0001> <00660069> <0002> <D83DDE80> endbfchar 1 beginbfrange <0003> <0005> [<0041> <0042> <0043>] endbfrange",
    ),
  );
  expect(unicode.get("\x00\x01")).toBe("fi");
  expect(unicode.get("\x00\x02")).toBe("🚀");
  expect(unicode.get("\x00\x05")).toBe("C");
  expect(lengths).toEqual([2]);
});
test("Flate and predictors are bounded, and malformed RunLength fails", () => {
  const raw = Uint8Array.of(0, 10, 20, 30, 2, 5, 5, 5),
    compressed = zlibSync(raw);
  expect(inflate(compressed, 100)).toEqual(raw);
  const d = Object.assign(Object.create(null), { Predictor: 12, Columns: 3 });
  expect(predict(raw, d, 100)).toEqual(Uint8Array.of(10, 20, 30, 15, 25, 35));
  expect(() => inflate(compressed, 4)).toThrow("resource limit");
  expect(runLength(Uint8Array.of(2, 97, 98, 99, 254, 120, 128), 100)).toEqual(
    bytes("abcxxx"),
  );
  expect(() => runLength(Uint8Array.of(129, 120, 128), 12)).toThrow(
    "resource limit",
  );
  expect(() => runLength(Uint8Array.of(0, 97), 100)).toThrow("Unterminated");
});
test("native SHA-256 matches platform SHA for every padding boundary", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 8193]) {
    const b = Uint8Array.from({ length }, (_, i) => (i * 31) & 255);
    expect(sha256(b)).toBe(createHash("sha256").update(b).digest("hex"));
  }
});
describe("Go-generated synthetic PDF objects", () => {
  const root = resolve(import.meta.dir, "../../../eval/pdf/native/fixtures");
  for (const file of readdirSync(root).filter((n) => n.endsWith(".pdf"))) {
    test(file, () => {
      const data = new Uint8Array(readFileSync(resolve(root, file))),
        gold = JSON.parse(
          readFileSync(resolve(root, file.replace(".pdf", ".json")), "utf8"),
        );
      if (gold.error === "ENCRYPTED_PDF") {
        expect(() => new PDF(data)).toThrow("Encrypted");
        return;
      }
      const p = new PDF(data);
      expect(named(p.dict(p.trailer.Root).Type)).toBe("Catalog");
      expect(() => new PDF(data, { limits: { inputBytes: 32 } })).toThrow(
        "resource limit",
      );
    });
  }
});
