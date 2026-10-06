import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://reader.test";
const deviceId = "web-device";
const SENTINEL = { bookId: "_categories", sha256: "0".repeat(64) };

function sync(value: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${origin}/v1/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    env,
    createExecutionContext(),
  );
}

async function syncJson(value: unknown): Promise<any> {
  const response = await sync(value);
  expect(response.status).toBe(200);
  return response.json();
}

const CAT_A = "3f2c0e4a-8b1d-4c2e-9f3a-1b2c3d4e5f60";
const CAT_B = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BOOK = "epub-" + "ab12".repeat(16);
const ARTICLE = "a".repeat(32);

function category(changeId: string, categoryId: string, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id: changeId,
    ...SENTINEL,
    kind: "category",
    updatedAt,
    payload: { categoryId, name: "Programming", color: "blue", createdAt: "2026-01-23T12:00:00.000Z", deleted: false, ...overrides },
  };
}

function tombstone(changeId: string, categoryId: string, updatedAt: string) {
  return { id: changeId, ...SENTINEL, kind: "category", updatedAt, payload: { categoryId, deleted: true } };
}

function assign(changeId: string, itemType: string, itemId: string, categoryId: string | null, updatedAt: string) {
  return { id: changeId, ...SENTINEL, kind: "categoryItem", updatedAt, payload: { itemType, itemId, categoryId } };
}

beforeEach(async () => {
  await reset();
  const migrations = (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});

describe("category sync", () => {
  const t0 = "2026-01-23T12:00:00.000Z";
  const t1 = "2026-01-23T12:00:01.000Z";
  const t2 = "2026-01-23T12:00:02.000Z";
  const t3 = "2026-01-23T12:00:03.000Z";

  it("creates both tables with unique rev indexes", async () => {
    const categories = await env.DB.prepare("PRAGMA table_info(sync_categories)").all<{ name: string }>();
    expect(categories.results.map((column) => column.name)).toEqual([
      "id", "name", "color", "created_at", "updated_at", "updated_ms", "deleted_at", "change_id", "rev",
    ]);
    const items = await env.DB.prepare("PRAGMA table_info(sync_category_items)").all<{ name: string; pk: number }>();
    expect(items.results.map((column) => column.name)).toEqual([
      "item_type", "item_id", "category_id", "updated_at", "updated_ms", "change_id", "rev",
    ]);
    expect(items.results.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(["item_type", "item_id"]);
    for (const table of ["sync_categories", "sync_category_items"]) {
      const indexes = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string; unique: number }>();
      expect(indexes.results).toContainEqual(expect.objectContaining({ name: `${table}_rev`, unique: 1 }));
    }
  });

  it("finds the next shared rev with one index seek per table", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT COALESCE(MAX(rev), 0) + 1 FROM (
         SELECT MAX(rev) AS rev FROM sync_categories UNION ALL SELECT MAX(rev) FROM sync_category_items)`,
    ).all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join("\n");
    expect(detail).toContain("sync_categories_rev");
    expect(detail).toContain("sync_category_items_rev");
  });

  it("leaves the response unchanged for clients that never ask for categories", async () => {
    const body = await syncJson({ deviceId, changes: [category("c-1", CAT_A, t0), assign("i-1", "book", BOOK, CAT_A, t0)] });
    expect(body.acceptedChangeIds).toEqual(["c-1", "i-1"]);
    expect(body).not.toHaveProperty("categories");
    // The writes landed anyway and show up once a client asks.
    const pulled = await syncJson({ deviceId, categoriesSince: null, changes: [] });
    expect(pulled.categories.items).toHaveLength(1);
    expect(pulled.categories.assignments).toHaveLength(1);
  });

  it("pulls categories and assignments on one rev sequence with last-write-wins ordering", async () => {
    const first = await syncJson({
      deviceId,
      categoriesSince: null,
      changes: [
        assign("i-1", "book", BOOK, CAT_A, t0),
        category("c-1", CAT_A, t0, { name: "  Programming  " }),
        assign("i-2", "article", ARTICLE, CAT_A, t0),
        category("c-2", CAT_B, t0, { name: "Philosophy", color: "purple" }),
      ],
    });
    expect(first.acceptedChangeIds).toEqual(["i-1", "c-1", "i-2", "c-2"]);
    expect(first.categories).toEqual({
      items: [
        { id: CAT_A, name: "Programming", color: "blue", createdAt: t0, updatedAt: t0, deleted: false, rev: 2 },
        { id: CAT_B, name: "Philosophy", color: "purple", createdAt: t0, updatedAt: t0, deleted: false, rev: 4 },
      ],
      assignments: [
        { itemType: "book", itemId: BOOK, categoryId: CAT_A, updatedAt: t0, rev: 1 },
        { itemType: "article", itemId: ARTICLE, categoryId: CAT_A, updatedAt: t0, rev: 3 },
      ],
      cursor: 4,
      more: false,
    });

    const idle = await syncJson({ deviceId, categoriesSince: 4, changes: [] });
    expect(idle.categories).toEqual({ items: [], assignments: [], cursor: 4, more: false });

    // Older writes are ignored, still acknowledged, and take no rev.
    const stale = await syncJson({
      deviceId,
      categoriesSince: 4,
      changes: [category("c-0", CAT_A, "2026-01-23T11:00:00.000Z", { name: "Old" }), assign("i-0", "book", BOOK, CAT_B, "2026-01-23T11:00:00.000Z")],
    });
    expect(stale.acceptedChangeIds).toEqual(["c-0", "i-0"]);
    expect(stale.categories).toEqual({ items: [], assignments: [], cursor: 4, more: false });

    // Equal timestamps break ties by change id; a rename keeps createdAt.
    const renamed = await syncJson({
      deviceId,
      categoriesSince: 4,
      changes: [
        category("c-3", CAT_A, t0, { name: "Code", color: "green", createdAt: t1 }),
        category("c-00", CAT_A, t0, { name: "Lost the tie" }),
        assign("i-3", "book", BOOK, CAT_B, t1),
      ],
    });
    expect(renamed.categories.items).toEqual([{ id: CAT_A, name: "Code", color: "green", createdAt: t0, updatedAt: t0, deleted: false, rev: 5 }]);
    expect(renamed.categories.assignments).toEqual([{ itemType: "book", itemId: BOOK, categoryId: CAT_B, updatedAt: t1, rev: 6 }]);
    expect(renamed.categories.cursor).toBe(6);

    // Null takes the item out of its category.
    const removed = await syncJson({ deviceId, categoriesSince: 6, changes: [assign("i-4", "book", BOOK, null, t2)] });
    expect(removed.categories.assignments).toEqual([{ itemType: "book", itemId: BOOK, categoryId: null, updatedAt: t2, rev: 7 }]);

    // The full set is always available from zero, each row once at its latest rev.
    const everything = await syncJson({ deviceId, categoriesSince: 0, changes: [] });
    expect(everything.categories.items.map((item: any) => [item.id, item.rev])).toEqual([[CAT_B, 4], [CAT_A, 5]]);
    expect(everything.categories.assignments.map((item: any) => [item.itemId, item.rev])).toEqual([[ARTICLE, 3], [BOOK, 7]]);
  });

  it("keeps tombstones final", async () => {
    await syncJson({ deviceId, changes: [category("c-1", CAT_A, t1, { name: "Programming" })] });
    // A tombstone wins even over a newer rename that reached the server first,
    // so devices converge whatever order their writes arrive in.
    const deleted = await syncJson({ deviceId, categoriesSince: 1, changes: [tombstone("d-1", CAT_A, t0)] });
    expect(deleted.categories.items).toEqual([
      { id: CAT_A, name: "Programming", color: "blue", createdAt: t0, updatedAt: t0, deleted: true, rev: 2 },
    ]);

    // Later live writes are acknowledged but cannot bring it back.
    const blocked = await syncJson({
      deviceId,
      categoriesSince: 2,
      changes: [category("c-2", CAT_A, t3, { name: "Back" }), category("c-3", CAT_A, t2)],
    });
    expect(blocked.acceptedChangeIds).toEqual(["c-2", "c-3"]);
    expect(blocked.categories.items).toEqual([]);

    // Resending a tombstone, or a newer one, changes nothing.
    const again = await syncJson({ deviceId, categoriesSince: 2, changes: [tombstone("d-1", CAT_A, t0), tombstone("d-2", CAT_A, t3)] });
    expect(again.categories.items).toEqual([]);
    const row = await env.DB.prepare("SELECT change_id, deleted_at FROM sync_categories WHERE id = ?").bind(CAT_A).first();
    expect(row).toEqual({ change_id: "d-1", deleted_at: t0 });

    // Assignments are not rewritten and still sync; clients treat them as uncategorized.
    const assigned = await syncJson({ deviceId, categoriesSince: 2, changes: [assign("i-1", "book", BOOK, CAT_A, t3)] });
    expect(assigned.categories.assignments).toEqual([{ itemType: "book", itemId: BOOK, categoryId: CAT_A, updatedAt: t3, rev: 3 }]);
  });

  it("stores tombstones for ids the server never saw and keeps them final", async () => {
    const body = await syncJson({ deviceId, categoriesSince: null, changes: [tombstone("d-1", CAT_B, t1), category("c-1", CAT_B, t2)] });
    expect(body.categories.items).toEqual([{ id: CAT_B, name: "", color: "", createdAt: t1, updatedAt: t1, deleted: true, rev: 1 }]);
  });

  it("bounds a pull to 500 rows across both tables and pages with the cursor", async () => {
    // Revs alternate between the tables: odd revs are categories, even revs assignments.
    const statements = [];
    for (let rev = 1; rev <= 1_001; rev++) {
      const hex = rev.toString(16).padStart(12, "0");
      statements.push(rev % 2 === 1
        ? env.DB.prepare(
          `INSERT INTO sync_categories (id, name, color, created_at, updated_at, updated_ms, change_id, rev)
           VALUES (?, 'c', 'blue', ?, ?, 0, 'c', ?)`,
        ).bind(`00000000-0000-4000-8000-${hex}`, t0, t0, rev)
        : env.DB.prepare(
          `INSERT INTO sync_category_items (item_type, item_id, category_id, updated_at, updated_ms, change_id, rev)
           VALUES ('article', ?, NULL, ?, 0, 'c', ?)`,
        ).bind(hex.padStart(32, "0"), t0, rev));
    }
    await env.DB.batch(statements);

    const first = await syncJson({ deviceId, categoriesSince: null, changes: [] });
    expect(first.categories.items).toHaveLength(250);
    expect(first.categories.assignments).toHaveLength(250);
    expect(first.categories).toMatchObject({ cursor: 500, more: true });
    const revs = [...first.categories.items, ...first.categories.assignments].map((row: any) => row.rev).sort((a: number, b: number) => a - b);
    expect(revs).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));

    const second = await syncJson({ deviceId, categoriesSince: 500, changes: [] });
    expect(second.categories).toMatchObject({ cursor: 1_000, more: true });
    expect(second.categories.items[0].rev).toBe(501);
    expect(second.categories.assignments[0].rev).toBe(502);

    const last = await syncJson({ deviceId, categoriesSince: 1_000, changes: [] });
    expect(last.categories).toMatchObject({ cursor: 1_001, more: false });
    expect(last.categories.items).toHaveLength(1);
    expect(last.categories.assignments).toEqual([]);

    // A new write continues the shared sequence after the larger maximum.
    const next = await syncJson({ deviceId, categoriesSince: 1_001, changes: [assign("i-1", "book", BOOK, CAT_A, t1)] });
    expect(next.categories.assignments).toEqual([expect.objectContaining({ rev: 1_002 })]);
  });

  it("pages a table that runs far ahead of the other", async () => {
    const statements = [];
    for (let rev = 1; rev <= 600; rev++) {
      statements.push(env.DB.prepare(
        `INSERT INTO sync_category_items (item_type, item_id, category_id, updated_at, updated_ms, change_id, rev)
         VALUES ('article', ?, NULL, ?, 0, 'c', ?)`,
      ).bind(rev.toString(16).padStart(32, "0"), t0, rev));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO sync_categories (id, name, color, created_at, updated_at, updated_ms, change_id, rev)
       VALUES (?, 'c', 'blue', ?, ?, 0, 'c', 601)`,
    ).bind(CAT_A, t0, t0));
    await env.DB.batch(statements);
    const first = await syncJson({ deviceId, categoriesSince: 0, changes: [] });
    expect(first.categories).toMatchObject({ items: [], cursor: 500, more: true });
    expect(first.categories.assignments).toHaveLength(500);
    const rest = await syncJson({ deviceId, categoriesSince: 500, changes: [] });
    expect(rest.categories).toMatchObject({ cursor: 601, more: false });
    expect(rest.categories.assignments).toHaveLength(100);
    expect(rest.categories.items).toEqual([expect.objectContaining({ id: CAT_A, rev: 601 })]);
  });

  it("applies categories atomically alongside books, highlights and articles", async () => {
    const SHA = "1".repeat(64);
    const body = await syncJson({
      deviceId,
      highlightsSince: null,
      articlesSince: null,
      categoriesSince: null,
      changes: [
        { id: "l-1", bookId: "pride-and-prejudice", sha256: SHA, kind: "library", updatedAt: t0, payload: { present: true, addedAt: t0 } },
        category("c-1", CAT_A, t0),
        {
          id: "h-1", bookId: "pride-and-prejudice", sha256: SHA, kind: "highlight", updatedAt: t0,
          payload: { highlightId: "h-uuid", locator: { href: "ch1.xhtml" }, text: "It is a truth", color: "yellow", createdAt: t0, deleted: false },
        },
        {
          id: "a-1", bookId: "_articles", sha256: "0".repeat(64), kind: "article", updatedAt: t0,
          payload: { articleId: ARTICLE, deleted: true },
        },
        assign("i-1", "book", "pride-and-prejudice", CAT_A, t0),
        assign("i-2", "article", ARTICLE, CAT_A, t0),
      ],
    });
    expect(body.acceptedChangeIds).toEqual(["l-1", "c-1", "h-1", "a-1", "i-1", "i-2"]);
    expect(body.books).toEqual([expect.objectContaining({ bookId: "pride-and-prejudice", inLibrary: true })]);
    expect(body.highlights.items).toHaveLength(1);
    expect(body.articles.items).toHaveLength(1);
    // The other sequences are independent of the category sequence.
    expect(body.highlights.cursor).toBe(1);
    expect(body.articles.cursor).toBe(1);
    expect(body.categories.cursor).toBe(3);
    expect(body.categories.items).toHaveLength(1);
    expect(body.categories.assignments).toHaveLength(2);

    // One invalid change rejects the whole batch, categories included.
    const rejected = await sync({
      deviceId,
      changes: [category("c-2", CAT_B, t1), assign("i-3", "book", "Not A Book", CAT_B, t1)],
    });
    expect(rejected.status).toBe(400);
    const after = await syncJson({ deviceId, categoriesSince: 3, changes: [] });
    expect(after.categories.items).toEqual([]);
  });

  it("rejects malformed category changes and cursors", async () => {
    const bad = [
      { deviceId, categoriesSince: -1, changes: [] },
      { deviceId, categoriesSince: "1", changes: [] },
      { deviceId, categoriesSince: 1.5, changes: [] },
      // Sentinel edition.
      { deviceId, changes: [{ ...category("x", CAT_A, t0), bookId: "_articles" }] },
      { deviceId, changes: [{ ...category("x", CAT_A, t0), sha256: "1".repeat(64) }] },
      { deviceId, changes: [{ ...assign("x", "book", BOOK, CAT_A, t0), bookId: "pride-and-prejudice", sha256: "1".repeat(64) }] },
      // Category payloads.
      { deviceId, changes: [category("x", CAT_A.toUpperCase(), t0)] },
      { deviceId, changes: [category("x", "not-a-uuid", t0)] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "   " })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "x".repeat(61) })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "Line\nbreak" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "Bell\u0007" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: "C1\u0085" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { name: 42 })] },
      { deviceId, changes: [category("x", CAT_A, t0, { color: "Blue" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { color: "#52a8ff" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { color: "x".repeat(21) })] },
      { deviceId, changes: [category("x", CAT_A, t0, { color: "" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { createdAt: "yesterday" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { createdAt: "2099-01-01T00:00:00.000Z" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { deleted: "no" })] },
      { deviceId, changes: [category("x", CAT_A, t0, { extra: true })] },
      { deviceId, changes: [{ ...category("x", CAT_A, t0), payload: { categoryId: CAT_A, name: "Programming", color: "blue", deleted: false } }] },
      { deviceId, changes: [{ ...tombstone("x", CAT_A, t0), payload: { categoryId: CAT_A, deleted: true, name: "x" } }] },
      // Assignment payloads.
      { deviceId, changes: [assign("x", "folder", BOOK, CAT_A, t0)] },
      { deviceId, changes: [assign("x", "book", "Not A Book", CAT_A, t0)] },
      { deviceId, changes: [assign("x", "book", `b${"-x".repeat(64)}`, CAT_A, t0)] },
      { deviceId, changes: [assign("x", "article", BOOK, CAT_A, t0)] },
      { deviceId, changes: [assign("x", "article", "A".repeat(32), CAT_A, t0)] },
      { deviceId, changes: [assign("x", "article", "a".repeat(31), CAT_A, t0)] },
      { deviceId, changes: [assign("x", "book", BOOK, "not-a-uuid", t0)] },
      { deviceId, changes: [{ ...assign("x", "book", BOOK, CAT_A, t0), payload: { itemType: "book", itemId: BOOK } }] },
      { deviceId, changes: [{ ...assign("x", "book", BOOK, CAT_A, t0), payload: { itemType: "book", itemId: BOOK, categoryId: CAT_A, at: 1 } }] },
      { deviceId, changes: [{ ...assign("x", "book", BOOK, CAT_A, t0), updatedAt: "2099-01-01T00:00:00.000Z" }] },
    ];
    for (const value of bad) {
      const response = await sync(value);
      expect(response.status, JSON.stringify(value).slice(0, 200)).toBe(400);
      expect((await response.json() as any).error.code).toBe("INVALID_SYNC");
    }
    // The limits themselves are accepted: 60 characters after trimming, a
    // 20-letter colour this server has never heard of, a 128-character book id.
    const edges = await syncJson({
      deviceId,
      categoriesSince: null,
      changes: [
        category("x-1", CAT_A, t0, { name: ` ${"é".repeat(60)} `, color: "x".repeat(20) }),
        assign("x-2", "book", `b${"-x".repeat(63)}6`.slice(0, 128), CAT_A, t0),
      ],
    });
    expect(edges.categories.items[0]).toMatchObject({ name: "é".repeat(60), color: "x".repeat(20) });
    expect(edges.categories.assignments[0].itemId).toHaveLength(128);
  });
});
