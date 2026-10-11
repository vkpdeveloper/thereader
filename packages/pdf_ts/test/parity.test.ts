import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { extract, PdfError } from "../src";

// PNG encoders may choose different lossless compression. Replace only generated
// asset URLs; text, block order, cell structure, warning categories and geometry
// remain compared. Pixel equivalence is tested separately.
function comparable(doc: any): any {
  const names = new Map<string, string>(
    (doc.assets || []).map((a: any, i: number) => [a.name, `asset-${i}`]),
  );
  const visit = (v: any, key = ""): any => {
    if (key === "durationMs") return 0;
    if (typeof v === "string") {
      for (const [a, b] of names) v = v.split(a).join(b);
      return v;
    }
    if (typeof v === "number") return Math.round(v * 1e8) / 1e8;
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "data" || k === "durationMs") continue;
        if (
          x === undefined ||
          x === null ||
          x === "" ||
          x === false ||
          x === 0 ||
          (Array.isArray(x) && !x.length)
        )
          continue;
        out[k] = visit(x, k);
      }
      return out;
    }
    return v;
  };
  const value = visit(doc);
  value.warnings = (doc.warnings || []).map((w: any) => [w.code, w.page || 0]);
  return value;
}
describe("Go fixture extraction parity", () => {
  const root = resolve(import.meta.dir, "../../../eval/pdf/native/fixtures");
  for (const file of readdirSync(root).filter((n) => n.endsWith(".pdf"))) {
    test(file, () => {
      const input = new Uint8Array(readFileSync(resolve(root, file))),
        gold = JSON.parse(
          readFileSync(resolve(root, file.replace(".pdf", ".json")), "utf8"),
        );
      if (gold.error) {
        let error: unknown;
        try {
          extract(input);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(PdfError);
        expect((error as PdfError).code).toBe(gold.error);
        return;
      }
      expect(comparable(extract(input))).toEqual(comparable(gold.document));
    });
  }
});
