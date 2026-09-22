// Imports an explicitly supplied private corpus into LOCAL R2 only. Never deploys.
// bun run scripts/import-local.ts ../../artifacts/private/corpus.json
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const input = process.argv[2];
if (!input) throw new Error("Pass a private corpus manifest with selected: [{source, role}].");
const manifest = await Bun.file(resolve(input)).json();
const base = await Bun.file(resolve(import.meta.dir, "../fixtures/generated/manifest.json")).json();
const bucket = "thereader-books-example";
async function put(key: string, file: string, type: string) {
  const child = Bun.spawn(["bunx", "wrangler", "r2", "object", "put", `${bucket}/${key}`,
    "--file", file, "--content-type", type, "--local", "--persist-to", ".wrangler/state"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Local import failed: ${key}`);
}
for (const item of manifest.selected) {
  if (!/^[a-z-]+$/.test(item.role)) throw new Error("Invalid corpus role");
  const source = resolve(item.source);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const checksum = hash.digest("hex");
  const id = `corpus-${item.role}`;
  const fileSize = Bun.file(source).size;
  const key = `books/${id}/v1.epub`;
  await put(key, source, "application/epub+zip");
  base.books.push({ id, version: "1", title: `Corpus · ${item.role}`, author: "Local private corpus",
    description: "Locally imported EPUB for native verification.", language: "en", subjects: ["Corpus"],
    coverId: null, coverUrl: null, downloadUrl: `/v1/books/${id}/download`, fileSize, sha256: checksum,
    updatedAt: new Date().toISOString(), objectKey: key, cover: null });
  console.log(JSON.stringify({ role: item.role, fileSize, sha256: checksum }));
}
const output = resolve(import.meta.dir, "../.wrangler/private-catalog.json");
await Bun.write(output, JSON.stringify(base));
await put("catalog/v1/manifest.json", output, "application/json");
