import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CATALOG_KEY } from "../src/catalog";
import { orderPages } from "../src/comic";

const origin = "https://reader.test";
const encoder = new TextEncoder();
const CBZ = "application/vnd.comicbook+zip";
// A real 1×1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

interface Entry {
  name: string;
  bytes: Uint8Array;
  method?: number;
  flags?: number;
  uncompressedSize?: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function little(size: number, fields: Array<[number, number, 2 | 4]>): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [offset, value, width] of fields) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
  }
  return bytes;
}

function zip(entries: Entry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const uncompressedSize = entry.uncompressedSize ?? entry.bytes.length;
    const local = little(30, [
      [0, 0x04034b50, 4], [4, 10, 2], [6, flags, 2], [8, method, 2], [12, 0x21, 2],
      [18, entry.bytes.length, 4], [22, uncompressedSize, 4], [26, name.length, 2],
    ]);
    locals.push(local, name, entry.bytes);
    centrals.push(little(46, [
      [0, 0x02014b50, 4], [4, 10, 2], [6, 10, 2], [8, flags, 2], [10, method, 2], [14, 0x21, 2],
      [20, entry.bytes.length, 4], [24, uncompressedSize, 4], [28, name.length, 2], [42, localOffset, 4],
    ]), name);
    localOffset += local.length + name.length + entry.bytes.length;
  }
  const central = concat(centrals);
  const eocd = little(22, [
    [0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, central.length, 4], [16, localOffset, 4],
  ]);
  return concat([...locals, central, eocd]);
}

function jpeg(width = 400, height = 600): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d]);
  const view = new DataView(bytes.buffer);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  return bytes;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw" as "deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pages whose code-unit order differs from page order, plus non-pages that sort first. */
function comic(): Uint8Array {
  return zip([
    { name: "Comic/ComicInfo.xml", bytes: encoder.encode("<ComicInfo><Series>Test</Series></ComicInfo>") },
    { name: "Comic/page10.jpg", bytes: jpeg() },
    { name: "Comic/page2.png", bytes: PNG },
    { name: "Comic/__MACOSX/._page1.jpg", bytes: encoder.encode("junk") },
    { name: "Comic/.hidden.jpg", bytes: encoder.encode("hidden") },
    { name: "Comic/notes.txt", bytes: encoder.encode("notes") },
  ]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env, createExecutionContext());
}

function jsonRequest(path: string, value: unknown): Promise<Response> {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

function metadata(checksum: string, fileSize: number, extra: Record<string, unknown> = {}) {
  return {
    format: "comic",
    sha256: checksum,
    fileSize,
    title: "Test #1",
    author: "Writer",
    description: "",
    language: "en",
    subjects: ["Comics"],
    ...extra,
  };
}

async function uploadComic(bytes: Uint8Array, contentType = CBZ): Promise<{ checksum: string; response: Response; body: any }> {
  const checksum = await sha256(bytes);
  const prepare = await jsonRequest("/v1/uploads/prepare", metadata(checksum, bytes.length));
  expect(prepare.status, await prepare.clone().text()).toBe(200);
  const prepared: any = await prepare.json();
  const response = await request(prepared.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: new Uint8Array(bytes).buffer,
  });
  return { checksum, response, body: await response.clone().json() };
}

beforeEach(async () => {
  await reset();
  const migrations = (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});

describe("comic page order", () => {
  it("matches the docs/comics.md sort and selection vectors", () => {
    const names = ["p1.jpg", "p01.jpg", "p001.jpg", "p2.jpg", "P3.jpg", "p10.jpg", "a/p9.jpg", "a/p10.jpg", "b/p1.jpg", "cover.jpg", "x 2.jpg", "x 10.jpg"];
    expect(orderPages(names)).toEqual([
      "a/p9.jpg", "a/p10.jpg", "b/p1.jpg", "cover.jpg", "p1.jpg", "p01.jpg", "p001.jpg", "p2.jpg", "P3.jpg", "p10.jpg", "x 2.jpg", "x 10.jpg",
    ]);
    expect(orderPages([
      "Comic/ComicInfo.xml", "Comic/page10.jpg", "Comic/page2.JPG", "Comic/page02b.png", "Comic/Cover.webp",
      "Comic/__MACOSX/._page2.jpg", "Comic/.hidden.jpg", "Comic/notes.txt", "Comic/extras/001.jpg",
    ])).toEqual(["Comic/Cover.webp", "Comic/extras/001.jpg", "Comic/page2.JPG", "Comic/page02b.png", "Comic/page10.jpg"]);
  });
});

describe("comic upload", () => {
  it("prepares, validates, publishes with the first page as cover, lists, and deduplicates a CBZ", async () => {
    const bytes = comic();
    const checksum = await sha256(bytes);
    const prepare = await jsonRequest("/v1/uploads/prepare", metadata(checksum, bytes.length));
    const prepared: any = await prepare.json();
    expect(prepared).toMatchObject({
      uploaded: false,
      uploadUrl: `/v1/uploads/${checksum}`,
      multipart: null,
      book: { id: `comic-${checksum}`, format: "comic", downloadUrl: `/v1/books/comic-${checksum}/download` },
    });
    expect(await env.DB.prepare("SELECT format, object_key FROM pending_uploads WHERE sha256 = ?").bind(checksum).first())
      .toEqual({ format: "comic", object_key: `uploads/${checksum}.cbz` });

    const upload = await request(prepared.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": CBZ, "Content-Length": String(bytes.length) },
      body: new Uint8Array(bytes).buffer,
    });
    expect(upload.status, await upload.clone().text()).toBe(201);
    const book = (await upload.json() as any).book;
    expect(book).toMatchObject({
      id: `comic-${checksum}`,
      format: "comic",
      coverId: `cover-${checksum}`,
      coverUrl: `/v1/books/comic-${checksum}/cover`,
    });
    const stored = await env.BOOKS.head(`uploads/${checksum}.cbz`);
    expect(stored?.httpMetadata?.contentType).toBe(CBZ);

    // Page 1 in natural order is page2.png, not page10.jpg (code-unit first) or the skipped junk.
    const cover = await request(book.coverUrl);
    expect(cover.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);

    const detail: any = await (await request(`/v1/books/comic-${checksum}`)).json();
    expect(detail.book.format).toBe("comic");

    const duplicate = await jsonRequest("/v1/uploads/prepare", metadata(checksum, bytes.length, { title: "Other" }));
    expect(await duplicate.json()).toMatchObject({ uploaded: true, uploadUrl: null, book: { id: `comic-${checksum}`, title: "Test #1" } });
    // The same bytes prepared as an EPUB still return the published comic.
    const asEpub = await jsonRequest("/v1/uploads/prepare", metadata(checksum, bytes.length, { format: "epub" }));
    expect(await asEpub.json()).toMatchObject({ uploaded: true, book: { id: `comic-${checksum}`, format: "comic" } });
  });

  it("lists format for comics, uploaded EPUBs and legacy manifest books", async () => {
    const comicUpload = await uploadComic(comic());
    expect(comicUpload.response.status).toBe(201);
    const epub = zip([{ name: "x.jpg", bytes: jpeg() }]);
    await env.BOOKS.put("books/legacy/v1.epub", epub);
    await env.BOOKS.put(CATALOG_KEY, JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      books: [{
        id: "legacy-book", version: "1", title: "Legacy", author: "Reader", description: "", language: "en", subjects: [],
        coverUrl: null, downloadUrl: "/v1/books/legacy-book/download", fileSize: epub.length, sha256: "e".repeat(64),
        updatedAt: new Date().toISOString(), objectKey: "books/legacy/v1.epub", cover: null,
      }],
    }));
    const items = (await (await request("/v1/books")).json() as any).items;
    expect(items.map((item: any) => [item.id, item.format])).toEqual([
      ["legacy-book", "epub"],
      [`comic-${comicUpload.checksum}`, "comic"],
    ]);
  });

  it("serves a comic download as CBZ with ranges, If-Range, ETag and HEAD", async () => {
    const bytes = comic();
    const { checksum, response } = await uploadComic(bytes);
    expect(response.status).toBe(201);
    const path = `/v1/books/comic-${checksum}/download`;

    const full = await request(path);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe(CBZ);
    expect(full.headers.get("Content-Disposition")).toBe(
      `attachment; filename="comic-${checksum}.cbz"; filename*=UTF-8''Test%20%231.cbz`,
    );
    expect(full.headers.get("ETag")).toBe(`"${checksum}"`);
    expect(full.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const tail = await request(path, { headers: { Range: "bytes=-22", "If-Range": `"${checksum}"` } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Type")).toBe(CBZ);
    expect(tail.headers.get("Content-Range")).toBe(`bytes ${bytes.length - 22}-${bytes.length - 1}/${bytes.length}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-22));

    const stale = await request(path, { headers: { Range: "bytes=0-3", "If-Range": '"other"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();

    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(head.headers.get("Content-Type")).toBe(CBZ);
    expect((await request(path, { headers: { "If-None-Match": `"${checksum}"` } })).status).toBe(304);
  });

  it("inflates a deflated first page and skips covers it cannot use", async () => {
    const deflated = await uploadComic(zip([{ name: "001.png", bytes: await deflate(PNG), method: 8, uncompressedSize: PNG.length }]));
    expect(deflated.response.status, JSON.stringify(deflated.body)).toBe(201);
    expect(deflated.body.book.coverId).toBe(`cover-${deflated.checksum}`);

    const bitmap = await uploadComic(zip([{ name: "001.bmp", bytes: bmp(300, -400) }]));
    expect(bitmap.response.status).toBe(201);
    expect((await request(bitmap.body.book.coverUrl)).headers.get("Content-Type")).toBe("image/bmp");

    const cases = [
      zip([{ name: "001.jpg", bytes: new Uint8Array(4 * 1024 * 1024 + 1) }]), // Too large for a cover.
      zip([{ name: "001.jpg", bytes: encoder.encode("not an image") }]),
      zip([{ name: "001.avif", bytes: encoder.encode("\0\0\0\x1cftypavif") }]), // Not dimension-checked.
      zip([{ name: "001.jpg", bytes: jpeg(20_000, 100) }]),
      zip([{ name: "001.png", bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>') }]),
    ];
    for (const bytes of cases) {
      const uploaded = await uploadComic(bytes);
      expect(uploaded.response.status, JSON.stringify(uploaded.body)).toBe(201);
      expect(uploaded.body.book).toMatchObject({ format: "comic", coverId: null, coverUrl: null });
    }
  });

  it("accepts Windows-style and leading-slash names by their normalized form", async () => {
    const uploaded = await uploadComic(zip([{ name: "\\Comic\\001.png", bytes: PNG }]));
    expect(uploaded.response.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.book.coverId).not.toBeNull();
  });

  it("rejects archives without pages, with encryption, traversal, duplicates, or too many entries", async () => {
    const many: Entry[] = Array.from({ length: 10_001 }, (_, index) => ({ name: `p${index}.jpg`, bytes: new Uint8Array(0) }));
    const cases: Array<[string, Uint8Array]> = [
      ["not a zip", encoder.encode("Rar!\x1a\x07\x01\x00 not a zip at all")],
      ["no pages", zip([{ name: "ComicInfo.xml", bytes: encoder.encode("<ComicInfo/>") }, { name: "__MACOSX/._1.jpg", bytes: PNG }])],
      ["encrypted", zip([{ name: "001.png", bytes: PNG }, { name: "002.png", bytes: PNG, flags: 0x0801 }])],
      ["traversal", zip([{ name: "001.png", bytes: PNG }, { name: "Comic/../../evil.jpg", bytes: PNG }])],
      ["windows traversal", zip([{ name: "001.png", bytes: PNG }, { name: "..\\evil.jpg", bytes: PNG }])],
      ["normalized duplicate", zip([{ name: "a/001.png", bytes: PNG }, { name: "a\\001.png", bytes: PNG }])],
      ["unsupported method", zip([{ name: "001.png", bytes: PNG, method: 12 }])],
      ["too many entries", zip(many)],
    ];
    for (const [label, bytes] of cases) {
      const { checksum, response, body } = await uploadComic(bytes);
      expect(response.status, label).toBe(422);
      expect(body.error.code, label).toBe("INVALID_COMIC");
      expect(await env.BOOKS.head(`uploads/${checksum}.cbz`), label).toBeNull();
    }
    expect((await request("/v1/books")).status).toBe(503);
  });

  it("enforces the comic size limit, format and content type", async () => {
    const checksum = "a".repeat(64);
    const atLimit = await jsonRequest("/v1/uploads/prepare", metadata(checksum, 1024 * 1024 * 1024));
    const prepared: any = await atLimit.json();
    expect(prepared).toMatchObject({ uploadUrl: null, multipart: { partSize: 8 * 1024 * 1024 }, book: { id: `comic-${checksum}` } });
    await env.BOOKS.resumeMultipartUpload(`uploads/${checksum}.cbz`, prepared.multipart.uploadId).abort();
    expect((await jsonRequest("/v1/uploads/prepare", metadata("b".repeat(64), 1024 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await jsonRequest("/v1/uploads/prepare", metadata("b".repeat(64), 512 * 1024 * 1024 + 1, { format: "epub" }))).status).toBe(400);
    expect((await jsonRequest("/v1/uploads/prepare", metadata("b".repeat(64), 10, { format: "cbr" }))).status).toBe(400);

    const bytes = comic();
    const wrongType = await uploadComic(bytes, "application/epub+zip");
    expect(wrongType.response.status).toBe(415);
    expect(wrongType.body.error.message).toBe(`Content-Type must be ${CBZ}.`);
  });

  it("restarts a pending upload prepared again as the other format", async () => {
    const checksum = "c".repeat(64);
    const size = 64 * 1024 * 1024 + 1;
    const asEpub: any = await (await jsonRequest("/v1/uploads/prepare", metadata(checksum, size, { format: "epub" }))).json();
    expect(asEpub.book.id).toBe(`epub-${checksum}`);
    const asComic: any = await (await jsonRequest("/v1/uploads/prepare", metadata(checksum, size))).json();
    expect(asComic.book.id).toBe(`comic-${checksum}`);
    expect(asComic.multipart.uploadId).not.toBe(asEpub.multipart.uploadId);
    expect(await env.DB.prepare("SELECT format, object_key, upload_id FROM pending_uploads WHERE sha256 = ?").bind(checksum).first())
      .toEqual({ format: "comic", object_key: `uploads/${checksum}.cbz`, upload_id: asComic.multipart.uploadId });
    await env.BOOKS.resumeMultipartUpload(`uploads/${checksum}.cbz`, asComic.multipart.uploadId).abort();
  });

  it("uploads a multipart comic, validates it and publishes it with its cover", async () => {
    const bytes = zip([
      { name: "Comic/01.png", bytes: PNG },
      { name: "Comic/02.jpg", bytes: new Uint8Array(5 * 1024 * 1024) },
    ]);
    const checksum = await sha256(bytes);
    const objectKey = `uploads/${checksum}.cbz`;
    const partSize = 5 * 1024 * 1024;
    const multipart = await env.BOOKS.createMultipartUpload(objectKey, { httpMetadata: { contentType: CBZ } });
    await env.DB.prepare(
      `INSERT INTO pending_uploads
        (sha256, format, title, author, description, language, subjects_json, file_size,
         object_key, prepared_at, upload_id, part_size)
       VALUES (?, 'comic', 'Multipart comic', 'Writer', '', 'en', '["Comics"]', ?, ?, ?, ?, ?)`,
    ).bind(checksum, bytes.length, objectKey, new Date().toISOString(), multipart.uploadId, partSize).run();
    for (const [partNumber, part] of [[1, bytes.slice(0, partSize)], [2, bytes.slice(partSize)]] as const) {
      const response = await request(`/v1/uploads/${checksum}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(part.length), "X-Upload-Id": multipart.uploadId },
        body: new Uint8Array(part).buffer,
      });
      expect(response.status).toBe(200);
    }
    const completed = await jsonRequest(`/v1/uploads/${checksum}/complete`, { uploadId: multipart.uploadId });
    expect(completed.status, await completed.clone().text()).toBe(201);
    expect(await completed.json()).toMatchObject({
      uploaded: true,
      book: { id: `comic-${checksum}`, format: "comic", coverId: `cover-${checksum}`, fileSize: bytes.length },
    });
    const range = await request(`/v1/books/comic-${checksum}/download`, { headers: { Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(0, 4));
  }, 15_000);

  it("discards a multipart comic that is not a valid archive", async () => {
    const bytes = zip([{ name: "notes.txt", bytes: new Uint8Array(5 * 1024 * 1024 + 10) }]);
    const checksum = await sha256(bytes);
    const objectKey = `uploads/${checksum}.cbz`;
    const partSize = 5 * 1024 * 1024;
    const multipart = await env.BOOKS.createMultipartUpload(objectKey);
    await env.DB.prepare(
      `INSERT INTO pending_uploads
        (sha256, format, title, author, description, language, subjects_json, file_size,
         object_key, prepared_at, upload_id, part_size)
       VALUES (?, 'comic', 'No pages', 'Writer', '', 'en', '[]', ?, ?, ?, ?, ?)`,
    ).bind(checksum, bytes.length, objectKey, new Date().toISOString(), multipart.uploadId, partSize).run();
    for (const [partNumber, part] of [[1, bytes.slice(0, partSize)], [2, bytes.slice(partSize)]] as const) {
      await request(`/v1/uploads/${checksum}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(part.length), "X-Upload-Id": multipart.uploadId },
        body: new Uint8Array(part).buffer,
      });
    }
    const completed = await jsonRequest(`/v1/uploads/${checksum}/complete`, { uploadId: multipart.uploadId });
    expect(completed.status).toBe(422);
    expect((await completed.json() as any).error.code).toBe("INVALID_COMIC");
    expect(await env.BOOKS.head(objectKey)).toBeNull();
  }, 15_000);
});

describe("comic sync", () => {
  it("accepts comic progress locators and comic category items", async () => {
    const bookId = `comic-${"f".repeat(64)}`;
    const now = new Date(Date.now() - 1_000).toISOString();
    const locator = {
      href: "Comic/page10.jpg",
      progression: 0,
      totalProgression: 0.75,
      title: "Page 5 of 5",
      engine: "comic",
      raw: { page: 4, pages: 5 },
    };
    const response = await jsonRequest("/v1/sync", {
      deviceId: "web-device",
      changes: [
        { id: "progress-1", bookId, sha256: "f".repeat(64), kind: "progress", updatedAt: now, payload: locator },
        { id: "library-1", bookId, sha256: "f".repeat(64), kind: "library", updatedAt: now, payload: { present: true, addedAt: now } },
        {
          id: "category-1", bookId: "_categories", sha256: "0".repeat(64), kind: "category", updatedAt: now,
          payload: { categoryId: "3f2c0e4a-8b1d-4c2e-9f3a-1b2c3d4e5f60", name: "Comics", color: "blue", createdAt: now, deleted: false },
        },
        {
          id: "item-1", bookId: "_categories", sha256: "0".repeat(64), kind: "categoryItem", updatedAt: now,
          payload: { itemType: "book", itemId: bookId, categoryId: "3f2c0e4a-8b1d-4c2e-9f3a-1b2c3d4e5f60" },
        },
      ],
      categoriesSince: 0,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const state: any = await response.json();
    expect(state.acceptedChangeIds).toHaveLength(4);
    expect(state.books).toEqual([expect.objectContaining({ bookId, inLibrary: true, progress: locator })]);
    expect(state.categories.assignments).toEqual([expect.objectContaining({ itemType: "book", itemId: bookId })]);
  });
});
