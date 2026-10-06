import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { it } from "vitest";
import { checkArticleBody } from "../../src/article-bodies";
import worker from "../../src/index";

// Wall time of article body validation for documents of ~200 KB, ~2 MB and
// ~8 MB, the current check against the first version (full gunzip into memory,
// SHA-256, UTF-8 decode and JSON.parse), interleaved so machine load hits both
// alike. Then the whole PUT: a first upload validates and writes to R2; a
// repeat validates and finds the object.

const encoder = new TextEncoder();
const WORDS = "the quick brown fox jumps over a lazy dog while reading über café naïve résumé 日本語 текст".split(" ");

function articleOfSize(target: number, seed: number): Uint8Array<ArrayBuffer> {
  const blocks: unknown[] = [];
  let size = 0;
  let n = seed;
  while (size < target) {
    const text = Array.from({ length: 70 }, () => WORDS[(n = (n * 1103515245 + 12345) % 2147483648) % WORDS.length]).join(" ");
    const block = {
      type: "paragraph",
      content: [
        { type: "text", text },
        { type: "link", href: `https://example.com/${n}`, content: [{ type: "text", text: "a link", marks: ["em"] }] },
        { type: "text", text: "." },
      ],
    };
    size += JSON.stringify(block).length + 1;
    blocks.push(block);
  }
  return encoder.encode(JSON.stringify({
    schema: 1, url: "https://example.com/story", title: "A story", subtitle: null, byline: null, authors: [],
    siteName: null, publishedAt: null, modifiedAt: null, language: "en", dir: "ltr", excerpt: null,
    leadImage: null, favicon: null, wordCount: 1, readingMinutes: 1, blocks,
  }));
}

const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The first version's validation, kept verbatim in spirit for comparison.
async function firstVersion(sent: Uint8Array<ArrayBuffer>, gzipped: boolean, sha256: string): Promise<number> {
  let plain = sent;
  if (gzipped) {
    const reader = new Blob([sent]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8 * 1024 * 1024) throw new Error("too large");
      chunks.push(value);
    }
    plain = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      plain.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  if (hex(await crypto.subtle.digest("SHA-256", plain)) !== sha256) throw new Error("mismatch");
  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  if (json.schema !== 1 || !Array.isArray(json.blocks)) throw new Error("invalid");
  return plain.byteLength;
}

async function timedPut(sha: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<[number, number]> {
  const start = performance.now();
  const response = await worker.fetch(
    new Request(`https://reader.test/v1/article-bodies/${sha}`, { method: "PUT", headers: { "Content-Type": contentType }, body }),
    env,
    createExecutionContext(),
  );
  await response.arrayBuffer();
  return [performance.now() - start, response.status];
}

function stats(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  return `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0).padStart(3)} ms, min ${sorted[0]!.toFixed(0).padStart(3)} ms`;
}

const ROUNDS = 15;

it("times article body validation and uploads", async () => {
  const rows: string[] = [];
  for (const [label, target, seed] of [["200 KB", 200_000, 1], ["2 MB", 2_000_000, 2], ["8 MB", 7_400_000, 3]] as const) {
    const plain = articleOfSize(target, seed);
    const compressed = await gzip(plain);
    const sha = hex(await crypto.subtle.digest("SHA-256", plain));
    rows.push(`${label}: ${plain.byteLength} B JSON, ${compressed.byteLength} B gzip`);
    for (const [kind, body, gzipped] of [["gzip", compressed, true], ["json", plain, false]] as const) {
      const before: number[] = [];
      const after: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        let start = performance.now();
        await firstVersion(body, gzipped, sha);
        before.push(performance.now() - start);
        start = performance.now();
        await checkArticleBody(body, gzipped, sha);
        after.push(performance.now() - start);
      }
      rows.push(`  ${kind} validation  before: ${stats(before)}   after: ${stats(after)}`);
      await env.BOOKS.delete(`articles/${sha}`);
      const type = gzipped ? "application/gzip" : "application/json";
      const [first, status] = await timedPut(sha, body, type);
      const repeats: number[] = [];
      for (let i = 0; i < 5; i++) repeats.push((await timedPut(sha, body, type))[0]);
      rows.push(`  ${kind} PUT         first: ${first.toFixed(0)} ms (${status}), repeat ${stats(repeats)}`);
    }
  }
  console.log(rows.join("\n"));
});
