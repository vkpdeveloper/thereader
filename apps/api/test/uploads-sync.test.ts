import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CATALOG_KEY } from "../src/catalog";

const origin = "https://reader.test";
const encoder = new TextEncoder();

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

interface TestZipEntry {
  name: string;
  bytes: Uint8Array;
  method?: number;
  uncompressedSize?: number;
}

function epubEntries(): TestZipEntry[] {
  return [
    { name: "mimetype", bytes: encoder.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      bytes: encoder.encode(
        '<?xml version="1.0"?><!DOCTYPE container PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    },
    {
      name: "OEBPS/content.opf",
      bytes: encoder.encode(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest/><spine/></package>',
      ),
    },
  ];
}

function zip(entries: TestZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const uncompressedSize = entry.uncompressedSize ?? entry.bytes.length;
    const local = little(30, [
      [0, 0x04034b50, 4],
      [4, 20, 2],
      [8, method, 2],
      [18, entry.bytes.length, 4],
      [22, uncompressedSize, 4],
      [26, name.length, 2],
    ]);
    locals.push(local, name, entry.bytes);
    const central = little(46, [
      [0, 0x02014b50, 4],
      [4, 20, 2],
      [6, 20, 2],
      [10, method, 2],
      [20, entry.bytes.length, 4],
      [24, uncompressedSize, 4],
      [28, name.length, 2],
      [42, localOffset, 4],
    ]);
    centrals.push(central, name);
    localOffset += local.length + name.length + entry.bytes.length;
  }
  const central = concat(centrals);
  const eocd = little(22, [
    [0, 0x06054b50, 4],
    [8, entries.length, 2],
    [10, entries.length, 2],
    [12, central.length, 4],
    [16, localOffset, 4],
  ]);
  return concat([...locals, central, eocd]);
}

function validEpub(): Uint8Array {
  return zip(epubEntries());
}

function validMultipartEpub(): Uint8Array {
  return zip([
    ...epubEntries(),
    { name: "OEBPS/padding.bin", bytes: new Uint8Array(5 * 1024 * 1024) },
  ]);
}

async function validDeflatedEpub(): Promise<Uint8Array> {
  const entries = epubEntries();
  const compressed: TestZipEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (index === 0) {
      compressed.push(entry);
      continue;
    }
    const stream = new Blob([new Uint8Array(entry.bytes)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw" as "deflate"));
    compressed.push({
      name: entry.name,
      bytes: new Uint8Array(await new Response(stream).arrayBuffer()),
      method: 8,
      uncompressedSize: entry.bytes.length,
    });
  }
  return zip(compressed);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

function jsonRequest(path: string, value: unknown): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

beforeEach(async () => {
  await reset();
  const migrations = (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});

describe("personal EPUB upload", () => {
  it("prepares, validates, publishes, downloads, and deduplicates an EPUB without authentication", async () => {
    const epub = validEpub();
    const checksum = await sha256(epub);
    const metadata = {
      sha256: checksum,
      fileSize: epub.length,
      title: "My EPUB",
      author: "A Reader",
      description: "Uploaded from the device.",
      language: "en",
      subjects: ["Personal"],
    };
    const prepare = await jsonRequest("/v1/uploads/prepare", metadata);
    expect(prepare.status).toBe(200);
    expect(prepare.headers.get("WWW-Authenticate")).toBeNull();
    const prepared: any = await prepare.json();
    expect(prepared).toMatchObject({
      uploaded: false,
      uploadUrl: `/v1/uploads/${checksum}`,
      book: { id: `epub-${checksum}`, sha256: checksum, fileSize: epub.length },
    });

    const upload = await request(prepared.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Length": String(epub.length),
      },
      body: new Uint8Array(epub).buffer,
    });
    expect(upload.status, await upload.clone().text()).toBe(201);
    expect((await upload.json() as any).book.id).toBe(`epub-${checksum}`);

    const catalog = await request("/v1/books");
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as any).items).toEqual([
      expect.objectContaining({ id: `epub-${checksum}`, sha256: checksum }),
    ]);
    const download = await request(`/v1/books/epub-${checksum}/download`);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(epub);

    const duplicate = await jsonRequest("/v1/uploads/prepare", metadata);
    expect(await duplicate.json()).toMatchObject({ uploaded: true, uploadUrl: null, book: { id: `epub-${checksum}` } });
    const repeatedPut = await request(`/v1/uploads/${checksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(epub.length) },
      body: new Uint8Array(epub).buffer,
    });
    expect(repeatedPut.status).toBe(200);
  });

  it("returns a verified legacy catalog identity for a duplicate SHA", async () => {
    const epub = validEpub();
    const checksum = await sha256(epub);
    await env.BOOKS.put("books/legacy/v1.epub", epub, {
      sha256: await crypto.subtle.digest("SHA-256", new Uint8Array(epub).buffer),
    });
    await env.BOOKS.put(
      CATALOG_KEY,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        books: [{
          id: "legacy-book",
          version: "1",
          title: "Legacy",
          author: "Reader",
          description: "Already present.",
          language: "en",
          subjects: [],
          coverUrl: null,
          downloadUrl: "/v1/books/legacy-book/download",
          fileSize: epub.length,
          sha256: checksum,
          updatedAt: new Date().toISOString(),
          objectKey: "books/legacy/v1.epub",
          cover: null,
        }],
      }),
    );
    const response = await jsonRequest("/v1/uploads/prepare", {
      sha256: checksum,
      fileSize: epub.length,
      title: "Different metadata",
      author: "Someone",
      description: "",
      language: "en",
      subjects: [],
    });
    expect(await response.json()).toMatchObject({ uploaded: true, uploadUrl: null, book: { id: "legacy-book" } });
  });

  it("accepts ordinary deflated container and package entries", async () => {
    const epub = await validDeflatedEpub();
    const checksum = await sha256(epub);
    const prepare = await jsonRequest("/v1/uploads/prepare", {
      sha256: checksum,
      fileSize: epub.length,
      title: "Compressed EPUB",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    });
    expect(prepare.status).toBe(200);
    const upload = await request(`/v1/uploads/${checksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(epub.length) },
      body: new Uint8Array(epub).buffer,
    });
    expect(upload.status, await upload.clone().text()).toBe(201);
  });

  it("keeps checksum and structurally invalid uploads out of the catalog", async () => {
    const bytes = encoder.encode("not an epub");
    const checksum = await sha256(bytes);
    const metadata = {
      sha256: checksum,
      fileSize: bytes.length,
      title: "Bad",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    };
    await jsonRequest("/v1/uploads/prepare", metadata);
    const invalid = await request(`/v1/uploads/${checksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(bytes.length) },
      body: bytes,
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as any).error.code).toBe("INVALID_EPUB");
    expect(await env.BOOKS.head(`uploads/${checksum}.epub`)).toBeNull();
    expect((await request("/v1/books")).status).toBe(503);

    const epub = validEpub();
    const wrongSha = "0".repeat(64);
    await jsonRequest("/v1/uploads/prepare", { ...metadata, sha256: wrongSha, fileSize: epub.length });
    const mismatch = await request(`/v1/uploads/${wrongSha}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(epub.length) },
      body: new Uint8Array(epub).buffer,
    });
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json() as any).error.code).toBe("CHECKSUM_MISMATCH");
  });

  it("rejects unprepared, oversized, wrong-length, and wrong-content-type uploads", async () => {
    const checksum = "a".repeat(64);
    const unprepared = await request(`/v1/uploads/${checksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": "1" },
      body: "x",
    });
    expect(unprepared.status).toBe(404);
    const oversized = await jsonRequest("/v1/uploads/prepare", {
      sha256: checksum,
      fileSize: 512 * 1024 * 1024 + 1,
      title: "Large",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    });
    expect(oversized.status).toBe(400);

    const epub = validEpub();
    const actualChecksum = await sha256(epub);
    await jsonRequest("/v1/uploads/prepare", {
      sha256: actualChecksum,
      fileSize: epub.length,
      title: "Headers",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    });
    const wrongType = await request(`/v1/uploads/${actualChecksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(epub.length) },
      body: new Uint8Array(epub).buffer,
    });
    expect(wrongType.status).toBe(415);
    const wrongLength = await request(`/v1/uploads/${actualChecksum}`, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(epub.length - 1) },
      body: new Uint8Array(epub).buffer,
    });
    expect(wrongLength.status).toBe(400);
    expect(await env.BOOKS.head(`uploads/${actualChecksum}.epub`)).toBeNull();
  });

  it("prepares and resumes a bounded multipart session for a large EPUB", async () => {
    const checksum = "d".repeat(64);
    const metadata = {
      sha256: checksum,
      fileSize: 64 * 1024 * 1024 + 1,
      title: "Large EPUB",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    };
    const first = await jsonRequest("/v1/uploads/prepare", metadata);
    expect(first.status, await first.clone().text()).toBe(200);
    const prepared: any = await first.json();
    expect(prepared).toMatchObject({
      uploaded: false,
      uploadUrl: null,
      multipart: { partSize: 8 * 1024 * 1024, parts: [] },
    });
    expect(prepared.multipart.uploadId).toEqual(expect.any(String));

    const resumed = await jsonRequest("/v1/uploads/prepare", metadata);
    expect(await resumed.json()).toMatchObject({ multipart: { uploadId: prepared.multipart.uploadId, parts: [] } });
    await env.BOOKS.resumeMultipartUpload(`uploads/${checksum}.epub`, prepared.multipart.uploadId).abort();
    const expiredPart = await request(`/v1/uploads/${checksum}/parts/1`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(8 * 1024 * 1024),
        "X-Upload-Id": prepared.multipart.uploadId,
      },
      body: new Uint8Array(8 * 1024 * 1024),
    });
    expect(expiredPart.status).toBe(409);
    const restarted: any = await (await jsonRequest("/v1/uploads/prepare", metadata)).json();
    expect(restarted.multipart.uploadId).not.toBe(prepared.multipart.uploadId);
    await env.BOOKS.resumeMultipartUpload(`uploads/${checksum}.epub`, restarted.multipart.uploadId).abort();
  });

  it("uploads multipart bytes, requires every exact part, verifies the full SHA, and publishes", async () => {
    const epub = validMultipartEpub();
    const checksum = await sha256(epub);
    const objectKey = `uploads/${checksum}.epub`;
    const partSize = 5 * 1024 * 1024;
    const multipart = await env.BOOKS.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: "application/epub+zip" },
      customMetadata: { sha256: checksum },
    });
    const preparedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO pending_uploads
        (sha256, title, author, description, language, subjects_json, file_size,
         object_key, prepared_at, upload_id, part_size)
       VALUES (?, 'Multipart EPUB', 'Reader', '', 'en', '[]', ?, ?, ?, ?, ?)`,
    ).bind(checksum, epub.length, objectKey, preparedAt, multipart.uploadId, partSize).run();

    const uploadPart = (partNumber: number, bytes: Uint8Array, uploadId = multipart.uploadId) => request(
      `/v1/uploads/${checksum}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "X-Upload-Id": uploadId,
        },
        body: new Uint8Array(bytes).buffer,
      },
    );
    const firstBytes = epub.slice(0, partSize);
    const stale = await uploadPart(1, firstBytes, "stale-session");
    expect(stale.status).toBe(409);
    const first = await uploadPart(1, firstBytes);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ partNumber: 1, etag: expect.any(String) });

    const incomplete = await jsonRequest(`/v1/uploads/${checksum}/complete`, { uploadId: multipart.uploadId });
    expect(incomplete.status).toBe(409);
    expect((await incomplete.json() as any).error.code).toBe("MULTIPART_INCOMPLETE");

    const last = await uploadPart(2, epub.slice(partSize));
    expect(last.status).toBe(200);
    const completed = await jsonRequest(`/v1/uploads/${checksum}/complete`, { uploadId: multipart.uploadId });
    expect(completed.status, await completed.clone().text()).toBe(201);
    expect(await completed.json()).toMatchObject({ uploaded: true, book: { sha256: checksum, fileSize: epub.length } });
    expect(new Uint8Array(await (await request(`/v1/books/epub-${checksum}/download`)).arrayBuffer())).toEqual(epub);
  });

  it("discards a completed multipart object and clears resumable parts when the full SHA is wrong", async () => {
    const bytes = validMultipartEpub();
    const actual = await sha256(bytes);
    const checksum = `${actual[0] === "0" ? "1" : "0"}${actual.slice(1)}`;
    const objectKey = `uploads/${checksum}.epub`;
    const partSize = 5 * 1024 * 1024;
    const multipart = await env.BOOKS.createMultipartUpload(objectKey);
    await env.DB.prepare(
      `INSERT INTO pending_uploads
        (sha256, title, author, description, language, subjects_json, file_size,
         object_key, prepared_at, upload_id, part_size)
       VALUES (?, 'Wrong hash', 'Reader', '', 'en', '[]', ?, ?, ?, ?, ?)`,
    ).bind(checksum, bytes.length, objectKey, new Date().toISOString(), multipart.uploadId, partSize).run();
    for (let partNumber = 1; partNumber <= 2; partNumber += 1) {
      const part = partNumber === 1 ? bytes.slice(0, partSize) : bytes.slice(partSize);
      const response = await request(`/v1/uploads/${checksum}/parts/${partNumber}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(part.length),
          "X-Upload-Id": multipart.uploadId,
        },
        body: new Uint8Array(part).buffer,
      });
      expect(response.status).toBe(200);
    }
    const completed = await jsonRequest(`/v1/uploads/${checksum}/complete`, { uploadId: multipart.uploadId });
    expect(completed.status).toBe(422);
    expect((await completed.json() as any).error.code).toBe("CHECKSUM_MISMATCH");
    expect(await env.BOOKS.head(objectKey)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE sha256 = ?").bind(checksum).first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT upload_id FROM pending_uploads WHERE sha256 = ?").bind(checksum).first("upload_id")).toBeNull();
  });
});

describe("shared personal sync", () => {
  const bookId = "sync-book";
  const edition = "b".repeat(64);
  const deviceId = "ios-device";

  function change(kind: string, id: string, payload: unknown, updatedAt: string, sha256 = edition) {
    return { id, bookId: kind === "preferences" ? "_preferences" : bookId, sha256: kind === "preferences" ? "0".repeat(64) : sha256, kind, updatedAt, payload };
  }

  it("merges LWW progress/library/preferences and retry-safe cumulative sessions", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const response = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "progress-z", { href: "chapter.xhtml", progression: 0.6 }, now),
        change("progress", "progress-a", { href: "stale.xhtml", progression: 0.1 }, now),
        change("library", "library-1", { present: true, addedAt: now }, now),
        change("session", "session-1", { readingMilliseconds: 12_000 }, now),
        change("preferences", "prefs-1", { value: { fontSize: 18, flow: "paginated" } }, now),
      ],
    });
    expect(response.status).toBe(200);
    const state: any = await response.json();
    expect(state.acceptedChangeIds).toHaveLength(5);
    expect(state.books).toEqual([
      expect.objectContaining({
        bookId,
        sha256: edition,
        inLibrary: true,
        progress: { href: "chapter.xhtml", progression: 0.6 },
        readingMilliseconds: 12_000,
        lastOpenedAt: now,
      }),
    ]);
    expect(state.preferences).toEqual({ value: { fontSize: 18, flow: "paginated" }, updatedAt: now });

    const retry = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [change("session", "session-1", { readingMilliseconds: 12_000 }, now)],
    });
    expect((await retry.json() as any).books[0].readingMilliseconds).toBe(12_000);
    const increased = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [change("session", "session-1", { readingMilliseconds: 15_000 }, now)],
    });
    expect((await increased.json() as any).books[0].readingMilliseconds).toBe(15_000);
  });

  it("accepts Dart microsecond timestamps and orders changes at microsecond precision", async () => {
    const earlier = "2026-01-23T12:00:00.123400Z";
    const later = "2026-01-23T12:00:00.123900Z";
    const response = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "z-earlier", { href: "early.xhtml", progression: 0.1 }, earlier),
        change("progress", "a-later", { href: "late.xhtml", progression: 0.9 }, later),
        change("library", "micro-library", { present: true, addedAt: later }, later),
      ],
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).books[0]).toMatchObject({
      progress: { href: "late.xhtml", progression: 0.9 },
      progressUpdatedAt: later,
      addedAt: later,
    });
  });

  it("isolates editions and rejects a malformed batch atomically", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const otherEdition = "c".repeat(64);
    const editions = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "one", { href: "one.xhtml", progression: 0.1 }, now),
        change("progress", "two", { href: "two.xhtml", progression: 0.2 }, now, otherEdition),
      ],
    });
    expect((await editions.json() as any).books).toHaveLength(2);

    await reset();
    const migrations = (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
    await applyD1Migrations(env.DB, migrations);
    const invalid = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "valid", { href: "one.xhtml", progression: 0.1 }, now),
        change("session", "invalid", { readingMilliseconds: -1 }, now),
      ],
    });
    expect(invalid.status).toBe(400);
    expect((await request("/v1/sync").then((value) => value.json()) as any).books).toEqual([]);
  });

  it("rejects locator and reader preference values that the Flutter client cannot safely decode", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const invalidPayloads = [
      change("progress", "missing-progression", { href: "chapter.xhtml" }, now),
      change("progress", "bad-progression", { href: "chapter.xhtml", progression: 1.1 }, now),
      change("progress", "bad-total", { href: "chapter.xhtml", progression: 0.2, totalProgression: "half" }, now),
      change("progress", "bad-raw", { href: "chapter.xhtml", progression: 0.2, raw: [] }, now),
      change("preferences", "bad-font-size", { value: { fontSize: 100 } }, now),
      change("preferences", "bad-font", { value: { font: "comic" } }, now),
      change("preferences", "bad-boolean", { value: { keepAwake: "yes" } }, now),
      change("preferences", "bad-null", { value: { lineHeight: null } }, now),
    ];
    for (const invalidChange of invalidPayloads) {
      const response = await jsonRequest("/v1/sync", { deviceId, changes: [invalidChange] });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe("INVALID_SYNC");
    }

    const valid = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "locator", {
          href: "chapter.xhtml",
          progression: 0,
          totalProgression: null,
          title: null,
          engine: "dart",
          raw: null,
        }, now),
        change("preferences", "prefs", {
          value: {
            fontSize: 14,
            lineHeight: 2.2,
            font: "sans",
            flow: "scrolled",
            marginScale: 0.5,
            justify: true,
            keepAwake: false,
            futureSetting: "retained",
          },
        }, now),
      ],
    });
    expect(valid.status).toBe(200);
    expect((await valid.json() as any).preferences.value.futureSetting).toBe("retained");
  });

  it("rejects future timestamps and explicitly fails instead of truncating oversized state", async () => {
    const future = new Date(Date.now() + 6 * 60 * 1_000).toISOString();
    const invalid = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [change("progress", "future", { href: "x", progression: 0.1 }, future)],
    });
    expect(invalid.status).toBe(400);

    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x <= 1000)
       INSERT INTO sync_progress (book_id, sha256, change_id, updated_at, updated_ms, payload_json)
       SELECT 'book-' || x, '${edition}', 'id-' || x, '2026-01-01T00:00:00.000Z', 1767225600000, '{}' FROM n`,
    ).run();
    const tooLarge = await request("/v1/sync");
    expect(tooLarge.status).toBe(409);
    expect((await tooLarge.json() as any).error.code).toBe("SYNC_STATE_TOO_LARGE");
  });

  it("does not return malformed D1 state that would break client decoding", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sync_preferences (slot, change_id, updated_at, updated_ms, value_json)
       VALUES ('default', 'bad', ?, ?, '{"flow":"sideways"}')`,
    ).bind(now, Date.parse(now)).run();
    const preferences = await request("/v1/sync");
    expect(preferences.status).toBe(500);
    expect((await preferences.json() as any).error.code).toBe("SYNC_STATE_INVALID");

    await env.DB.prepare("DELETE FROM sync_preferences").run();
    await env.DB.prepare(
      `INSERT INTO sync_progress (book_id, sha256, change_id, updated_at, updated_ms, payload_json)
       VALUES (?, ?, 'bad', ?, ?, '{"href":42,"progression":0.5}')`,
    ).bind(bookId, edition, now, Date.parse(now)).run();
    const progress = await request("/v1/sync");
    expect(progress.status).toBe(500);
    expect((await progress.json() as any).error.code).toBe("SYNC_STATE_INVALID");
  });
});
