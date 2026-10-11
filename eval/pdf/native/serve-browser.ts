// Local evaluation only. Exposes an explicit corpus and build directory.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const root = resolve(import.meta.dir, "../../..");
const allowed = (base: string, path: string) => {
  const full = resolve(base, path);
  return full.startsWith(base + "/") ? full : undefined;
};
Bun.serve({
  hostname: "127.0.0.1",
  port: 5199,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    let file: string | undefined;
    if (req.method === "POST" && path === "/results") {
      if (req.headers.get("origin") !== "http://127.0.0.1:5199")
        return new Response("Origin refused", { status: 403 });
      if (Number(req.headers.get("content-length")) > 8 * 1048576)
        return new Response("Too large", { status: 413 });
      const row = await req.json();
      if (
        !["ts", "dart"].includes(row.engine) ||
        typeof row.pdf !== "string" ||
        !row.pdf.endsWith(".pdf")
      )
        return new Response("Invalid", { status: 400 });
      const base = resolve(
          root,
          "test-corpus/pdf/olmocr/browser-" + row.engine,
        ),
        target = allowed(base, row.pdf.replace(/\.pdf$/, "_pg1_repeat1.md"));
      if (!target) return new Response("Invalid", { status: 400 });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, row.markdown || "");
      const record = allowed(
        resolve(root, "test-corpus/pdf/native/browser/records"),
        row.engine + "/" + row.pdf + ".json",
      )!;
      mkdirSync(dirname(record), { recursive: true });
      delete row.markdown;
      writeFileSync(record, JSON.stringify(row));
      return new Response("ok");
    }

    if (path === "/browser-timing.js")
      file = resolve(import.meta.dir, "browser-timing.js");
    else if (path === "/") file = resolve(import.meta.dir, "browser.html");
    else if (
      path === "/ts-worker.js" ||
      path === "/dart-worker.js" ||
      path === "/dart-client-smoke.js"
    )
      file = resolve(root, "test-corpus/pdf/native/browser", path.slice(1));
    else if (path.startsWith("/pdf/"))
      file = allowed(
        resolve(root, "test-corpus/pdf/real-world"),
        path.slice(5),
      );
    else if (path.startsWith("/corpus/"))
      file = allowed(
        resolve(root, "test-corpus/pdf/olmocr/pdfs"),
        path.slice(8),
      );
    else if (path === "/manifest.json")
      file = resolve(root, "eval/pdf/coverage-v03/olmocr-corpus.json");
    if (!file) return new Response("Not found", { status: 404 });
    const data = Bun.file(file);
    if (!(await data.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(data, { headers: { "Cache-Control": "no-store" } });
  },
});
console.log("Browser evaluation at http://127.0.0.1:5199");
