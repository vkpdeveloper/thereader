import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CATALOG_KEY } from "../src/catalog";
import { downloadBook } from "../src/download";
import type { CatalogBook, Env } from "../src/types";

const origin = "https://reader.test";
const bookBytes = new TextEncoder().encode("PK\u0003\u0004deterministic-epub-test-bytes");

async function sha256Digest(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await sha256Digest(bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function manifest(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = "the-quiet-hour";
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-22T00:00:00.000Z",
    books: [
      {
        id,
        version: "1",
        title: "The Quiet Hour",
        author: "The Reader",
        description: "An original short reading sample.",
        language: "en",
        subjects: ["Essays"],
        coverUrl: null,
        downloadUrl: `/v1/books/${id}/download`,
        fileSize: bookBytes.length,
        sha256: await sha256(bookBytes),
        updatedAt: "2026-09-22T00:00:00.000Z",
        objectKey: `books/${id}/v1.epub`,
        cover: null,
        ...overrides,
      },
    ],
  };
}

async function seed(options: {
  bytes?: Uint8Array;
  includeFile?: boolean;
  manifest?: Record<string, unknown>;
  r2Sha256?: boolean;
} = {}): Promise<void> {
  const catalog = options.manifest ?? (await manifest());
  await env.BOOKS.put(CATALOG_KEY, JSON.stringify(catalog), {
    httpMetadata: { contentType: "application/json" },
  });
  if (options.includeFile !== false) {
    const bytes = options.bytes ?? bookBytes;
    const firstBook = (catalog.books as Array<Record<string, unknown>>)[0]!;
    const putOptions: R2PutOptions = {
      httpMetadata: { contentType: "application/epub+zip" },
    };
    if (options.r2Sha256 === true) putOptions.sha256 = await sha256Digest(bytes);
    await env.BOOKS.put(firstBook.objectKey as string, bytes, putOptions);
  }
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

async function body(response: Response): Promise<any> {
  return response.json();
}

beforeEach(async () => {
  await reset();
});

describe("public API", () => {
  it("serves health and CORS without authentication", async () => {
    const response = await request("/health", { headers: { Origin: "http://127.0.0.1:5173" } });

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "ok", service: "thereader-api" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("WWW-Authenticate")).toBeNull();

    const preflight = await request("/v1/books", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("lists, searches, and paginates public book metadata", async () => {
    const first = await manifest();
    const firstBook = (first.books as Array<Record<string, unknown>>)[0]!;
    first.books = [
      firstBook,
      {
        ...firstBook,
        id: "notes-on-attention",
        title: "Notes on Attention",
        subjects: ["Mindfulness"],
        downloadUrl: "/v1/books/notes-on-attention/download",
        objectKey: "books/notes-on-attention/v1.epub",
      },
    ];
    await seed({ manifest: first });

    const firstPage = await request("/v1/books?limit=1");
    expect(firstPage.status).toBe(200);
    const firstPayload = await body(firstPage);
    expect(firstPayload.items).toHaveLength(1);
    expect(firstPayload.items[0].id).toBe("the-quiet-hour");
    expect(firstPayload.items[0].objectKey).toBeUndefined();
    expect(firstPayload.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(`/v1/books?limit=1&cursor=${firstPayload.nextCursor}`);
    expect((await body(secondPage)).items[0].id).toBe("notes-on-attention");

    const search = await request("/v1/books?q=mindfulness");
    const searchPayload = await body(search);
    expect(searchPayload.items.map((item: { id: string }) => item.id)).toEqual(["notes-on-attention"]);
  });

  it("returns book detail and a structured missing-book error", async () => {
    await seed();
    const detail = await request("/v1/books/the-quiet-hour");
    expect(detail.status).toBe(200);
    expect((await body(detail)).book).toMatchObject({ id: "the-quiet-hour", author: "The Reader" });

    const missing = await request("/v1/books/absent-book");
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({ error: { code: "NOT_FOUND", message: "Book not found." } });
  });

  it.each([
    ["/v1/books?limit=0", "INVALID_QUERY"],
    ["/v1/books?limit=101", "INVALID_QUERY"],
    ["/v1/books?limit=2&limit=3", "INVALID_QUERY"],
    ["/v1/books?sort=title", "INVALID_QUERY"],
    ["/v1/books?cursor=not-json", "INVALID_CURSOR"],
    ["/v1/books/UPPERCASE", "INVALID_BOOK_ID"],
    ["/v1/books/%2E%2E", "NOT_FOUND"],
    ["/v2/books", "NOT_FOUND"],
  ])("rejects invalid query or path %s", async (path, code) => {
    await seed();
    const response = await request(path);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await body(response)).error.code).toBe(code);
  });

  it("rejects a cursor used with a different search", async () => {
    const catalog = await manifest();
    const firstBook = (catalog.books as Array<Record<string, unknown>>)[0]!;
    catalog.books = [firstBook, { ...firstBook, id: "second-book", downloadUrl: "/v1/books/second-book/download" }];
    await seed({ manifest: catalog });
    const response = await request("/v1/books?limit=1&q=quiet");
    const cursor = (await body(response)).nextCursor;
    const mismatch = await request(`/v1/books?limit=1&q=other&cursor=${cursor}`);
    expect(mismatch.status).toBe(400);
    expect((await body(mismatch)).error.code).toBe("INVALID_CURSOR");
  });
});

describe("catalog failures", () => {
  it("returns a service error when the catalog is missing", async () => {
    const response = await request("/v1/books");
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({
      error: { code: "CATALOG_UNAVAILABLE", message: "Catalog is unavailable." },
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid book metadata", JSON.stringify({ schemaVersion: 1, generatedAt: "yesterday", books: [] })],
  ])("does not leak malformed manifest details: %s", async (_label, value) => {
    await env.BOOKS.put(CATALOG_KEY, value);
    const response = await request("/v1/books");
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: { code: "CATALOG_INVALID", message: "Catalog data is invalid." } });
  });
});

describe("EPUB download", () => {
  it("streams the complete object with immutable metadata", async () => {
    await seed();
    const response = await request("/v1/books/the-quiet-hour/download");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/epub+zip");
    expect(response.headers.get("Content-Length")).toBe(String(bookBytes.length));
    expect(response.headers.get("Content-Disposition")).toContain("the-quiet-hour.epub");
    expect(response.headers.get("ETag")).toBe(`"${await sha256(bookBytes)}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bookBytes);
  });

  it("supports HEAD, conditional GET, and valid single ranges", async () => {
    await seed();
    const etag = `"${await sha256(bookBytes)}"`;

    const head = await request("/v1/books/the-quiet-hour/download", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(bookBytes.length));
    expect(await head.text()).toBe("");

    const conditional = await request("/v1/books/the-quiet-hour/download", {
      headers: { "If-None-Match": etag },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");

    const ranged = await request("/v1/books/the-quiet-hour/download", {
      headers: { Range: "bytes=2-8" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe(`bytes 2-8/${bookBytes.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bookBytes.slice(2, 9));

    const suffix = await request("/v1/books/the-quiet-hour/download", {
      headers: { Range: "bytes=-5" },
    });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bookBytes.slice(-5));
  });

  it("ignores Range on HEAD and returns full representation metadata", async () => {
    await seed();
    const response = await request("/v1/books/the-quiet-hour/download", {
      method: "HEAD",
      headers: { Range: "bytes=2-8" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(bookBytes.length));
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
  });

  it("honors validator precedence and If-Range fallback semantics", async () => {
    await seed();
    const etag = `"${await sha256(bookBytes)}"`;

    for (const validator of [etag, `W/${etag}`, `"another", ${etag}`, "*"]) {
      const response = await request("/v1/books/the-quiet-hour/download", {
        headers: { "If-None-Match": validator, Range: "bytes=0-3" },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get("Content-Range")).toBeNull();
      expect(await response.text()).toBe("");
    }

    const matching = await request("/v1/books/the-quiet-hour/download", {
      headers: { "If-Range": etag, Range: "bytes=0-3" },
    });
    expect(matching.status).toBe(206);
    expect(new Uint8Array(await matching.arrayBuffer())).toEqual(bookBytes.slice(0, 4));

    const stale = await request("/v1/books/the-quiet-hour/download", {
      headers: { "If-Range": '"stale-edition"', Range: "bytes=0-3" },
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("Content-Range")).toBeNull();
    expect(stale.headers.get("Content-Length")).toBe(String(bookBytes.length));
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(bookBytes);
  });

  it("serves exact disjoint ranges from a large ZIP representation", async () => {
    const largeBytes = new Uint8Array(2 * 1024 * 1024 + 70_003);
    for (let index = 0; index < largeBytes.length; index += 1) largeBytes[index] = (index * 31 + 17) % 251;
    largeBytes.set(new TextEncoder().encode("PK\u0005\u0006large-zip-tail"), largeBytes.length - 20);
    const checksum = await sha256(largeBytes);
    const catalog = await manifest({ fileSize: largeBytes.length, sha256: checksum });
    await seed({ bytes: largeBytes, manifest: catalog, r2Sha256: true });
    const etag = `"${checksum}"`;
    const requested = [
      { start: 0, end: 131_071 },
      { start: 1_000_003, end: 1_131_073 },
      { start: largeBytes.length - 65_557, end: largeBytes.length - 1 },
    ];

    for (const range of requested) {
      const response = await request("/v1/books/the-quiet-hour/download", {
        headers: { "If-Range": etag, Range: `bytes=${range.start}-${range.end}` },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect(response.headers.get("Content-Range")).toBe(
        `bytes ${range.start}-${range.end}/${largeBytes.length}`,
      );
      expect(response.headers.get("Content-Length")).toBe(String(range.end - range.start + 1));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(largeBytes.slice(range.start, range.end + 1));
    }
  });

  it("validates an R2 SHA-256 when present while accepting legacy objects without one", async () => {
    await seed();
    const legacy = await request("/v1/books/the-quiet-hour/download", { headers: { Range: "bytes=0-3" } });
    expect(legacy.status).toBe(206);

    await reset();
    await seed({ r2Sha256: true });
    const verified = await request("/v1/books/the-quiet-hour/download", { headers: { Range: "bytes=0-3" } });
    expect(verified.status).toBe(206);

    const badCatalog = await manifest({ sha256: "0".repeat(64) });
    await env.BOOKS.put(CATALOG_KEY, JSON.stringify(badCatalog));
    const rejected = await request("/v1/books/the-quiet-hour/download", { headers: { Range: "bytes=0-3" } });
    expect(rejected.status).toBe(500);
    expect(await body(rejected)).toEqual({
      error: { code: "BOOK_FILE_INVALID", message: "Book file metadata is invalid." },
    });
  });

  it("pins a resumed range to the R2 ETag observed by HEAD", async () => {
    const checksum = await sha256(bookBytes);
    const book: CatalogBook = {
      id: "the-quiet-hour",
      version: "1",
      title: "The Quiet Hour",
      author: "The Reader",
      description: "An original short reading sample.",
      language: "en",
      subjects: ["Essays"],
      coverUrl: null,
      downloadUrl: "/v1/books/the-quiet-hour/download",
      fileSize: bookBytes.length,
      sha256: checksum,
      updatedAt: "2026-09-22T00:00:00.000Z",
      objectKey: "books/the-quiet-hour/v1.epub",
      cover: null,
    };
    const metadata = {
      key: book.objectKey,
      version: "storage-version-1",
      size: book.fileSize,
      etag: "storage-etag-1",
      httpEtag: '"storage-etag-1"',
      uploaded: new Date(book.updatedAt),
      httpMetadata: {},
      customMetadata: {},
      checksums: {},
      storageClass: "Standard",
      writeHttpMetadata() {},
    } as unknown as R2Object;
    let observedOptions: R2GetOptions | undefined;
    const fakeBucket = {
      async head() {
        return metadata;
      },
      async get(_key: string, options?: R2GetOptions) {
        observedOptions = options;
        return metadata; // R2 returns metadata without a body when onlyIf fails.
      },
    } as unknown as R2Bucket;
    const responsePromise = downloadBook(
      new Request(`${origin}${book.downloadUrl}`, {
        headers: { "If-Range": `"${checksum}"`, Range: "bytes=0-3" },
      }),
      { BOOKS: fakeBucket } satisfies Env,
      book,
    );

    await expect(responsePromise).rejects.toMatchObject({ status: 409, code: "BOOK_FILE_CHANGED" });
    expect(observedOptions?.onlyIf).toEqual({ etagMatches: metadata.etag });
    expect(observedOptions?.range).toEqual({ offset: 0, length: 4 });
  });

  it("uses a single R2 GET for an ordinary range", async () => {
    const checksum = await sha256(bookBytes);
    const book: CatalogBook = {
      id: "the-quiet-hour",
      version: "1",
      title: "The Quiet Hour",
      author: "The Reader",
      description: "An original short reading sample.",
      language: "en",
      subjects: ["Essays"],
      coverUrl: null,
      downloadUrl: "/v1/books/the-quiet-hour/download",
      fileSize: bookBytes.length,
      sha256: checksum,
      updatedAt: "2026-09-22T00:00:00.000Z",
      objectKey: "books/the-quiet-hour/v1.epub",
      cover: null,
    };
    let headCalls = 0;
    let getCalls = 0;
    const fakeBucket = {
      async head() {
        headCalls += 1;
        return null;
      },
      async get(_key: string, options?: R2GetOptions) {
        getCalls += 1;
        const range = options?.range as { offset: number; length: number };
        const bytes = bookBytes.slice(range.offset, range.offset + range.length);
        return {
          size: book.fileSize,
          checksums: {},
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        } as unknown as R2ObjectBody;
      },
    } as unknown as R2Bucket;

    const response = await downloadBook(
      new Request(`${origin}${book.downloadUrl}`, { headers: { Range: "bytes=2-8" } }),
      { BOOKS: fakeBucket } satisfies Env,
      book,
    );

    expect(response.status).toBe(206);
    expect(headCalls).toBe(0);
    expect(getCalls).toBe(1);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bookBytes.slice(2, 9));
  });

  it("returns 416 for malformed, multiple, and unsatisfiable ranges", async () => {
    await seed();
    for (const range of ["items=0-1", "bytes=0-1,4-5", `bytes=${bookBytes.length}-`]) {
      const response = await request("/v1/books/the-quiet-hour/download", { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe(`bytes */${bookBytes.length}`);
      expect((await body(response)).error.code).toBe("RANGE_NOT_SATISFIABLE");
    }
  });

  it("reports a missing or size-mismatched R2 object without exposing its key", async () => {
    await seed({ includeFile: false });
    const missing = await request("/v1/books/the-quiet-hour/download");
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({ error: { code: "NOT_FOUND", message: "Book file not found." } });

    await env.BOOKS.put("books/the-quiet-hour/v1.epub", "wrong-size");
    const mismatched = await request("/v1/books/the-quiet-hour/download");
    expect(mismatched.status).toBe(500);
    expect(await body(mismatched)).toEqual({
      error: { code: "BOOK_FILE_INVALID", message: "Book file metadata is invalid." },
    });
  });

  it("returns 404 for an optional cover that is absent", async () => {
    await seed();
    const response = await request("/v1/books/the-quiet-hour/cover");
    expect(response.status).toBe(404);
    expect((await body(response)).error.code).toBe("NOT_FOUND");
  });
});
