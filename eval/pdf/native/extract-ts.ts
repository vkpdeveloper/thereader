// Run from the repository root with Bun. This harness is not part of the engine.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { extract } from "../../../packages/pdf_ts/src";

const root = join(import.meta.dir, "../../.."),
  local = join(root, "test-corpus/pdf/olmocr");
const manifest = JSON.parse(
  readFileSync(join(root, "eval/pdf/coverage-v03/olmocr-corpus.json"), "utf8"),
);
const files = manifest.files.filter((r: any) => r.path.endsWith(".pdf")),
  records: any[] = [];
for (const r of files) {
  const source = join(local, r.path.replace(/^bench_data\//, "")),
    relative = r.path.replace(/^bench_data\/pdfs\//, ""),
    data = new Uint8Array(readFileSync(source));
  const sha = createHash("sha256").update(data).digest("hex");
  const valid =
    data.length === r.size &&
    (r.lfs
      ? sha === r.lfs.oid
      : createHash("sha1")
          .update(`blob ${data.length}\0`)
          .update(data)
          .digest("hex") === r.oid);
  if (!valid) throw new Error("Pinned corpus hash mismatch: " + r.path);
  const target = join(
    local,
    "native-ts",
    relative.replace(/\.pdf$/, "_pg1_repeat1.md"),
  );
  mkdirSync(dirname(target), { recursive: true });
  const row: any = { pdf: relative, sha256: sha },
    start = performance.now();
  let markdown = "";
  try {
    const d = extract(data, { timeoutMs: 60000 });
    markdown = d.markdown;
    Object.assign(row, {
      version: d.version,
      complete: d.complete,
      stats: d.stats,
      warnings: d.warnings,
      needsOCR: d.pages.some((p) => p.needsOCR),
    });
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    row.errorCode = (e as any)?.code;
  }
  writeFileSync(target, markdown);
  row.markdownSHA256 = createHash("sha256").update(markdown).digest("hex");
  row.diagnosticWallSeconds = (performance.now() - start) / 1000;
  records.push(row);
  if (records.length % 100 === 0)
    console.log(
      records.length,
      "errors",
      records.filter((r) => r.error).length,
    );
}
writeFileSync(
  join(import.meta.dir, "olmocr-ts-extraction.json"),
  JSON.stringify(
    {
      datasetRevision: manifest.revision,
      scope:
        "Sequential Bun process; diagnostic timings, not browser performance. Original PDF bytes only; no ground truth read by the extractor.",
      documents: records,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Done",
  records.length,
  "errors",
  records.filter((r) => r.error).length,
);
