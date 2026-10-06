import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://reader.test";
const encoder = new TextEncoder();
const deviceId = "web-device";
const SENTINEL = { bookId: "_articles", sha256: "0".repeat(64) };

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env, createExecutionContext());
}

function sync(value: unknown): Promise<Response> {
  return request("/v1/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

async function syncJson(value: unknown): Promise<any> {
  const response = await sync(value);
  expect(response.status).toBe(200);
  return response.json();
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function articleChange(changeId: string, articleId: string, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id: changeId,
    ...SENTINEL,
    kind: "article",
    updatedAt,
    payload: {
      articleId,
      url: "https://example.com/story",
      title: "A story",
      siteName: "Example",
      byline: "Jane Doe",
      excerpt: "It begins.",
      leadImage: "https://example.com/lead.jpg",
      favicon: null,
      language: "en",
      dir: "ltr",
      wordCount: 1200,
      readingMinutes: 6,
      blockCount: 24,
      publishedAt: "2026-10-01T08:00:00+02:00",
      savedAt: updatedAt,
      bodySha256: "c".repeat(64),
      bodySize: 4096,
      schema: 1,
      deleted: false,
      ...overrides,
    },
  };
}

function tombstone(changeId: string, articleId: string, updatedAt: string) {
  return { id: changeId, ...SENTINEL, kind: "article", updatedAt, payload: { articleId, deleted: true } };
}

function position(changeId: string, articleId: string, updatedAt: string, block: number, percent = 0.5) {
  return { id: changeId, ...SENTINEL, kind: "articleProgress", updatedAt, payload: { articleId, position: { block, offset: 0.25, percent } } };
}

beforeEach(async () => {
  await reset();
  const migrations = (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});

describe("article sync", () => {
  const t0 = "2026-01-23T12:00:00.000Z";
  const t1 = "2026-01-23T12:00:01.000Z";
  const t2 = "2026-01-23T12:00:02.000Z";
  const t3 = "2026-01-23T12:00:03.000Z";

  it("creates the table with a unique rev index", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(sync_articles)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id", "url", "title", "body_sha256", "body_size", "schema", "position_json", "position_updated_ms",
      "updated_ms", "deleted_at", "change_id", "rev",
    ]));
    const indexes = await env.DB.prepare("PRAGMA index_list(sync_articles)").all<{ name: string; unique: number }>();
    expect(indexes.results).toContainEqual(expect.objectContaining({ name: "sync_articles_rev", unique: 1 }));
    expect(indexes.results).toContainEqual(expect.objectContaining({ name: "sync_articles_live_body", partial: 1 }));
  });

  it("leaves the response unchanged for clients that never ask for articles", async () => {
    const body = await syncJson({ deviceId, changes: [articleChange("a-1", ID_A, t0)] });
    expect(body.acceptedChangeIds).toEqual(["a-1"]);
    expect(body).not.toHaveProperty("articles");
  });

  it("pulls saves, positions and tombstones by rev with last-write-wins ordering", async () => {
    const first = await syncJson({
      deviceId,
      articlesSince: null,
      // A position sent before its save in the same batch still lands.
      changes: [position("p-1", ID_A, t1, 3), articleChange("a-1", ID_A, t0), articleChange("b-1", ID_B, t0, { url: "https://example.org/b" })],
    });
    expect(first.acceptedChangeIds).toEqual(["p-1", "a-1", "b-1"]);
    expect(first.articles.more).toBe(false);
    expect(first.articles.items.map((item: any) => item.id)).toEqual([ID_B, ID_A]);
    const a = first.articles.items.find((item: any) => item.id === ID_A);
    expect(a).toMatchObject({
      url: "https://example.com/story",
      title: "A story",
      siteName: "Example",
      favicon: null,
      dir: "ltr",
      wordCount: 1200,
      blockCount: 24,
      savedAt: t0,
      bodySha256: "c".repeat(64),
      bodySize: 4096,
      schema: 1,
      position: { block: 3, offset: 0.25, percent: 0.5 },
      positionUpdatedAt: t1,
      updatedAt: t0,
      deleted: false,
    });

    const idle = await syncJson({ deviceId, articlesSince: first.articles.cursor, changes: [] });
    expect(idle.articles).toEqual({ items: [], cursor: first.articles.cursor, more: false });

    // An older position and an older save are ignored and do not bump the rev.
    const stale = await syncJson({
      deviceId,
      articlesSince: first.articles.cursor,
      changes: [position("p-0", ID_A, t0, 1), articleChange("a-0", ID_A, "2026-01-23T11:00:00.000Z", { title: "Old" })],
    });
    expect(stale.articles.items).toEqual([]);

    // Equal timestamps break ties by change id.
    const tie = await syncJson({ deviceId, articlesSince: first.articles.cursor, changes: [position("p-2", ID_A, t1, 9)] });
    expect(tie.articles.items).toHaveLength(1);
    expect(tie.articles.items[0].position.block).toBe(9);

    const deleted = await syncJson({ deviceId, articlesSince: tie.articles.cursor, changes: [tombstone("d-1", ID_A, t2)] });
    expect(deleted.articles.items).toHaveLength(1);
    expect(deleted.articles.items[0]).toMatchObject({ id: ID_A, deleted: true, updatedAt: t2, title: "A story" });

    // Positions do not move a deleted article; an older save cannot undo the delete.
    const blocked = await syncJson({
      deviceId,
      articlesSince: deleted.articles.cursor,
      changes: [position("p-9", ID_A, t3, 12), articleChange("a-old", ID_A, t1)],
    });
    expect(blocked.articles.items).toEqual([]);

    // Saving the URL again resurrects it with a fresh position.
    const resurrected = await syncJson({ deviceId, articlesSince: deleted.articles.cursor, changes: [articleChange("a-2", ID_A, t3, { title: "Again" })] });
    expect(resurrected.articles.items).toHaveLength(1);
    expect(resurrected.articles.items[0]).toMatchObject({ id: ID_A, deleted: false, title: "Again", position: null, positionUpdatedAt: null, savedAt: t3 });

    // The full set is always available from zero.
    const everything = await syncJson({ deviceId, articlesSince: 0, changes: [] });
    expect(everything.articles.items.map((item: any) => item.id)).toEqual([ID_B, ID_A]);
  });

  it("keeps a live article's position when another device saves the same URL later", async () => {
    await syncJson({ deviceId, changes: [articleChange("a-1", ID_A, t0), position("p-1", ID_A, t1, 4)] });
    const body = await syncJson({ deviceId: "phone", articlesSince: 0, changes: [articleChange("a-2", ID_A, t2, { bodySha256: "d".repeat(64) })] });
    expect(body.articles.items[0]).toMatchObject({ bodySha256: "d".repeat(64), position: { block: 4 }, savedAt: t2 });
  });

  it("stores tombstones for ids the server never saw", async () => {
    const body = await syncJson({ deviceId, articlesSince: 0, changes: [tombstone("d-1", ID_B, t0)] });
    expect(body.articles.items).toEqual([expect.objectContaining({ id: ID_B, deleted: true, url: "", title: "" })]);
  });

  it("bounds a pull to 200 rows and pages with the cursor", async () => {
    const statements = [];
    for (let rev = 1; rev <= 201; rev++) {
      statements.push(env.DB.prepare(
        `INSERT INTO sync_articles (id, url, title, updated_at, updated_ms, change_id, rev, saved_at, body_sha256, body_size)
         VALUES (?, 'https://example.com/x', 'x', ?, ?, 'c', ?, ?, ?, 10)`,
      ).bind(rev.toString(16).padStart(32, "0"), t0, Date.parse(t0) * 1_000, rev, t0, "e".repeat(64)));
    }
    await env.DB.batch(statements);
    const page = await syncJson({ deviceId, articlesSince: null, changes: [] });
    expect(page.articles.items).toHaveLength(200);
    expect(page.articles).toMatchObject({ cursor: 200, more: true });
    const rest = await syncJson({ deviceId, articlesSince: 200, changes: [] });
    expect(rest.articles).toMatchObject({ cursor: 201, more: false });
    expect(rest.articles.items).toHaveLength(1);
  });

  it("deletes a deleted article's document once no live article references it", async () => {
    const X = "1".repeat(64);
    const Y = "2".repeat(64);
    const ID_C = "c".repeat(32);
    for (const sha of [X, Y]) await env.BOOKS.put(`articles/${sha}`, "{}");
    const exists = async (sha: string) => (await env.BOOKS.head(`articles/${sha}`)) !== null;

    // Two stories whose documents happen to be identical share one object.
    await syncJson({
      deviceId,
      changes: [
        articleChange("a-1", ID_A, t0, { bodySha256: X }),
        articleChange("b-1", ID_B, t0, { bodySha256: X, url: "https://example.org/b" }),
        articleChange("c-1", ID_C, t1, { bodySha256: Y, url: "https://example.org/c" }),
      ],
    });
    await syncJson({ deviceId, changes: [tombstone("d-a", ID_A, t1)] });
    expect(await exists(X)).toBe(true);
    // A tombstone older than the save is not accepted and deletes nothing.
    await syncJson({ deviceId, changes: [tombstone("d-c0", ID_C, t0)] });
    expect(await exists(Y)).toBe(true);
    // A tombstone for an id the server never saw has no document.
    await syncJson({ deviceId, changes: [tombstone("d-x", "f".repeat(32), t1)] });

    await syncJson({ deviceId, changes: [tombstone("d-b", ID_B, t2), tombstone("d-c", ID_C, t2)] });
    expect(await exists(X)).toBe(false);
    expect(await exists(Y)).toBe(false);

    // Saving again re-uploads the document.
    const article = encoder.encode(JSON.stringify({ schema: 1, url: "https://example.com/story", title: "A story", blocks: [] }));
    const sha = await sha256(article);
    await syncJson({ deviceId, changes: [articleChange("a-2", ID_A, t3, { bodySha256: sha })] });
    const upload = await request(`/v1/article-bodies/${sha}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: article });
    expect(upload.status).toBe(201);
    // Resending an accepted tombstone is harmless: the live save keeps it.
    await syncJson({ deviceId, changes: [tombstone("d-a", ID_A, t1)] });
    expect(await exists(sha)).toBe(true);
  });

  it("finds live references through the partial index", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM sync_articles b WHERE b.body_sha256 = ? AND b.deleted_at IS NULL",
    ).bind("1".repeat(64)).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n")).toContain("sync_articles_live_body");
  });

  it("rejects malformed article changes and cursors", async () => {
    const bad = [
      { deviceId, articlesSince: -1, changes: [] },
      { deviceId, articlesSince: "1", changes: [] },
      { deviceId, changes: [{ ...articleChange("x", ID_A, t0), bookId: "story" }] },
      { deviceId, changes: [articleChange("x", "not-an-id", t0)] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { url: "ftp://example.com/x" })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { url: `https://example.com/${"x".repeat(2_100)}` })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { title: "x".repeat(1_001) })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { excerpt: "x".repeat(2_001) })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { leadImage: "javascript:alert(1)" })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { dir: "up" })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { schema: 2 })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { bodySha256: "nope" })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { bodySize: 8 * 1024 * 1024 + 1 })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { readingMinutes: 0 })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { savedAt: "yesterday" })] },
      { deviceId, changes: [articleChange("x", ID_A, t0, { extra: true })] },
      { deviceId, changes: [{ ...tombstone("x", ID_A, t0), payload: { articleId: ID_A, deleted: true, title: "x" } }] },
      { deviceId, changes: [position("x", ID_A, t0, -1)] },
      { deviceId, changes: [position("x", ID_A, t0, 1, 1.5)] },
      { deviceId, changes: [{ ...position("x", ID_A, t0, 1), payload: { articleId: ID_A, position: { block: 1, offset: 0, percent: 0, y: 3 } } }] },
    ];
    for (const value of bad) {
      const response = await sync(value);
      expect(response.status, JSON.stringify(value).slice(0, 200)).toBe(400);
      expect((await response.json() as any).error.code).toBe("INVALID_SYNC");
    }
  });
});

describe("article bodies", () => {
  const article = { schema: 1, url: "https://example.com/story", title: "A story", blocks: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

  async function put(sha: string, bytes: Uint8Array, contentType = "application/gzip"): Promise<Response> {
    return request(`/v1/article-bodies/${sha}`, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) });
  }

  it("stores a gzip upload once and serves it immutably", async () => {
    const plain = encoder.encode(JSON.stringify(article));
    const sha = await sha256(plain);
    const compressed = await gzip(plain);
    const created = await put(sha, compressed);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ sha256: sha, size: plain.byteLength, created: true });
    const repeat = await put(sha, compressed);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ created: false });

    const download = await request(`/v1/article-bodies/${sha}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/gzip");
    expect(download.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(download.headers.get("ETag")).toBe(`"${sha}"`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes).toEqual(compressed);
    const head = await request(`/v1/article-bodies/${sha}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(compressed.byteLength));
    const cached = await request(`/v1/article-bodies/${sha}`, { headers: { "If-None-Match": `"${sha}"` } });
    expect(cached.status).toBe(304);
  });

  it("streams large chunked uploads in pieces", async () => {
    const blocks = Array.from({ length: 4_000 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Paragraph ${index} über café 日本語. ${"Words ".repeat(40)}` }] }));
    const plain = encoder.encode(JSON.stringify({ ...article, blocks }));
    expect(plain.byteLength).toBeGreaterThan(1024 * 1024);
    const sha = await sha256(plain);
    const compressed = await gzip(plain);
    // No Content-Length, delivered in uneven pieces.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < compressed.byteLength; offset += 7_919) controller.enqueue(compressed.slice(offset, offset + 7_919));
        controller.close();
      },
    });
    const response = await request(`/v1/article-bodies/${sha}`, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sha256: sha, size: plain.byteLength, created: true });
    const stored = await env.BOOKS.get(`articles/${sha}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(compressed);
    expect(stored!.customMetadata).toEqual({ size: String(plain.byteLength) });
  });

  it("accepts plain JSON uploads", async () => {
    const plain = encoder.encode(JSON.stringify(article));
    const sha = await sha256(plain);
    expect((await put(sha, plain, "application/json")).status).toBe(201);
    const download = await request(`/v1/article-bodies/${sha}`);
    expect(download.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await download.json()).toEqual(article);
  });

  it("rejects mismatched hashes, non-articles, other schemas, oversize and other media types", async () => {
    const plain = encoder.encode(JSON.stringify(article));
    const mismatch = await put("f".repeat(64), await gzip(plain));
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json() as any).error.code).toBe("CHECKSUM_MISMATCH");

    // The shape check looks at the document's ends only: `{"schema":1,` first
    // (both clients serialize `schema` first, compactly) and `}` last.
    const json = JSON.stringify(article);
    const { schema, ...rest } = article;
    const notArticles = [
      JSON.stringify({ ...article, schema: 2 }),
      JSON.stringify({ ...article, schema: 10 }),
      JSON.stringify({ ...rest, schema }),
      JSON.stringify(article, null, 2),
      `${json}\n`,
      json.slice(0, -1),
      JSON.stringify([1, 2]),
      JSON.stringify("text"),
      "{nope",
    ];
    for (const value of notArticles) {
      const bytes = encoder.encode(value);
      for (const response of [await put(await sha256(bytes), await gzip(bytes)), await put(await sha256(bytes), bytes, "application/json")]) {
        expect(response.status, value.slice(0, 40)).toBe(422);
        expect((await response.json() as any).error.code).toBe("INVALID_ARTICLE");
      }
    }
    // Not UTF-8 within the checked head.
    const latin1 = new Uint8Array([...encoder.encode('{"schema":1,"url":"'), 0xe9, ...encoder.encode('"}')]);
    expect((await put(await sha256(latin1), latin1, "application/json")).status).toBe(422);
    const empty = new Uint8Array(0);
    expect((await put(await sha256(empty), await gzip(empty))).status).toBe(422);
    const garbage = encoder.encode("not gzip at all");
    expect((await put(await sha256(garbage), garbage)).status).toBe(422);
    const truncated = (await gzip(encoder.encode(json))).slice(0, -12);
    expect((await put(await sha256(encoder.encode(json)), truncated)).status).toBe(422);

    // 8 MB is measured on the uncompressed document, so a small gzip bomb fails too.
    const huge = encoder.encode(JSON.stringify({ ...article, padding: "x".repeat(8 * 1024 * 1024) }));
    const bomb = await put(await sha256(huge), await gzip(huge));
    expect(bomb.status).toBe(413);
    expect((await put(await sha256(huge), huge, "application/json")).status).toBe(413);

    // A highly compressible bomb is cut off while inflating, not after.
    const zeros = await gzip(new Uint8Array(64 * 1024 * 1024));
    expect(zeros.byteLength).toBeLessThan(1024 * 1024);
    expect((await put("1".repeat(64), zeros)).status).toBe(413);

    const text = await put(await sha256(plain), plain, "text/plain");
    expect(text.status).toBe(415);
    expect((await request(`/v1/article-bodies/${"0".repeat(64)}`)).status).toBe(404);
    expect((await request(`/v1/article-bodies/${"0".repeat(64)}`, { method: "POST" })).status).toBe(405);
    expect((await request("/v1/article-bodies/ABC")).status).toBe(404);
  });
});
