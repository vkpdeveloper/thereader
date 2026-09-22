import { resolve } from "node:path";

const BUCKET = "thereader-books-example";
const generated = resolve(import.meta.dir, "../fixtures/generated");
const objects = [
  { key: "catalog/v1/manifest.json", file: "manifest.json", contentType: "application/json" },
  { key: "books/the-quiet-hour/v1.epub", file: "the-quiet-hour-v1.epub", contentType: "application/epub+zip" },
  { key: "books/a-walk-in-the-rain/v1.epub", file: "a-walk-in-the-rain-v1.epub", contentType: "application/epub+zip" },
  { key: "books/notes-on-attention/v1.epub", file: "notes-on-attention-v1.epub", contentType: "application/epub+zip" },
];

for (const object of objects) {
  const process = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "put",
      `${BUCKET}/${object.key}`,
      "--file",
      resolve(generated, object.file),
      "--content-type",
      object.contentType,
      "--local",
      "--persist-to",
      ".wrangler/state",
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Wrangler failed while storing ${object.key}.`);
}

console.log(`Seeded ${objects.length} objects into local R2 bucket ${BUCKET}.`);
