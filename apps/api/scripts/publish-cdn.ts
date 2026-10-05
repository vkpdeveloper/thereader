import { readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

/**
 * Uploads every file under `cdn/` to the CDN bucket at the same relative key,
 * served by the Worker as `/cdn/<key>`. Keys are versioned and immutable:
 * publish changed bytes under a new path, never over an existing key.
 *
 *   bun run scripts/publish-cdn.ts           production bucket
 *   bun run scripts/publish-cdn.ts --local   local Wrangler state
 */
const local = process.argv.includes("--local");
const bucket = local ? "thereader-cdn-example" : "thereader-cdn";
const root = resolve(import.meta.dir, "../cdn");
const contentTypes: Record<string, string> = {
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
  .map((entry) => resolve(entry.parentPath, entry.name));

for (const file of files) {
  const key = relative(root, file).split("\\").join("/");
  const contentType = contentTypes[extname(file)];
  if (contentType === undefined) throw new Error(`No content type for ${key}.`);
  const target = local ? ["--local", "--persist-to", ".wrangler/state"] : ["--remote"];
  const child = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--file",
      file,
      "--content-type",
      contentType,
      "--cache-control",
      "public, max-age=31536000, immutable",
      ...target,
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Wrangler failed while storing ${key}.`);
}

console.log(`Published ${files.length} objects to ${local ? "local" : "remote"} R2 bucket ${bucket}.`);
