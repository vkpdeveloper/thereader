import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
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

function pngCover(width = 400, height = 600): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(encoder.encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegCover(width = 400, height = 600): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function epubWithPackage(packagePath: string, packageXml: string, extraEntries: TestZipEntry[]): Uint8Array {
  return zip([
    { name: "mimetype", bytes: encoder.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      bytes: encoder.encode(
        `<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="${packagePath}" media-type="application/oebps-package+xml"/></ocf:rootfiles></ocf:container>`,
      ),
    },
    { name: packagePath, bytes: encoder.encode(packageXml) },
    ...extraEntries,
  ]);
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
  return worker.fetch(new Request(`${origin}${path}`, init), env, createExecutionContext());
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
  async function uploadFixture(epub: Uint8Array, title: string): Promise<{ checksum: string; response: Response; book: any }> {
    const checksum = await sha256(epub);
    const prepare = await jsonRequest("/v1/uploads/prepare", {
      sha256: checksum,
      fileSize: epub.length,
      title,
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    });
    expect(prepare.status).toBe(200);
    const prepared: any = await prepare.json();
    const response = await request(prepared.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/epub+zip", "Content-Length": String(epub.length) },
      body: new Uint8Array(epub).buffer,
    });
    const body: any = await response.clone().json();
    return { checksum, response, book: body.book };
  }

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

  it("extracts EPUB 3 and EPUB 2 covers with package-relative paths", async () => {
    const cases = [
      {
        title: "EPUB 3 cover",
        bytes: pngCover(),
        contentType: "image/png",
        epub: (cover: Uint8Array) => epubWithPackage(
          "OEBPS/package/content.opf",
          '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:metadata/><opf:manifest><opf:item id="art" href="..&#x2F;Images/front.png" media-type="image/png" properties="nav cover-image"/></opf:manifest><opf:spine/></opf:package>',
          [{ name: "OEBPS/Images/front.png", bytes: cover }],
        ),
      },
      {
        title: "EPUB 2 cover",
        bytes: jpegCover(),
        contentType: "image/jpeg",
        epub: (cover: Uint8Array) => epubWithPackage(
          "OPS/content.opf",
          '<?xml version="1.0"?><package><metadata><meta name="cover" content="img-cover-jpg"/></metadata><manifest><item id="img-cover-jpg" href="Images/cover.jpg" media-type="image/jpeg"/></manifest><spine/></package>',
          [{ name: "OPS/Images/cover.jpg", bytes: cover }],
        ),
      },
      {
        title: "SVG cover",
        bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"><rect width="400" height="600" fill="#123456"/></svg>'),
        contentType: "image/svg+xml",
        epub: (cover: Uint8Array) => epubWithPackage(
          "EPUB/content.opf",
          '<?xml version="1.0"?><package><metadata/><manifest><item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/></manifest><spine/></package>',
          [{ name: "EPUB/cover.svg", bytes: cover }],
        ),
      },
    ];
    for (const value of cases) {
      const epub = value.epub(value.bytes);
      const uploaded = await uploadFixture(epub, value.title);
      expect(uploaded.response.status, await uploaded.response.clone().text()).toBe(201);
      expect(uploaded.book).toMatchObject({
        coverId: `cover-${uploaded.checksum}`,
        coverUrl: `/v1/books/epub-${uploaded.checksum}/cover`,
      });
      const cover = await request(uploaded.book.coverUrl);
      expect(cover.status).toBe(200);
      expect(cover.headers.get("Content-Type")).toBe(value.contentType);
      expect(cover.headers.get("Cache-Control")).toContain("immutable");
      expect(cover.headers.get("ETag")).not.toBeNull();
      expect(new Uint8Array(await cover.arrayBuffer())).toEqual(value.bytes);
      const head = await request(uploaded.book.coverUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(String(value.bytes.length));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      const unchanged = await request(uploaded.book.coverUrl, { headers: { "If-None-Match": cover.headers.get("ETag")! } });
      expect(unchanged.status).toBe(304);
    }
  });

  it("resolves a guide cover document and conventional cover-image IDs", async () => {
    const guideCover = pngCover(300, 500);
    const guideEpub = epubWithPackage(
      "OPS/package.opf",
      '<?xml version="1.0"?><package><metadata/><manifest><item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="art" href="Images/art.png" media-type="image/png"/></manifest><spine/><guide><reference type="cover" href="Text/cover.xhtml"/></guide></package>',
      [
        { name: "OPS/Text/cover.xhtml", bytes: encoder.encode('<html><body><img src="../Images/art.png"/></body></html>') },
        { name: "OPS/Images/art.png", bytes: guideCover },
      ],
    );
    const guide = await uploadFixture(guideEpub, "Guide cover");
    expect(guide.response.status).toBe(201);
    expect(guide.book.coverUrl).not.toBeNull();

    const conventional = await uploadFixture(epubWithPackage(
      "OEBPS/content.opf",
      '<?xml version="1.0"?><package><metadata/><manifest><item id="coverimage" href="gree_cvi.jpg" media-type="image/jpeg"/></manifest><spine/></package>',
      [{ name: "OEBPS/gree_cvi.jpg", bytes: jpegCover(320, 480) }],
    ), "Conventional cover");
    expect(conventional.response.status).toBe(201);
    expect(conventional.book.coverId).toBe(`cover-${conventional.checksum}`);
  });

  it("keeps truly coverless books coverless and rejects unsafe or oversized declared covers", async () => {
    const coverless = await uploadFixture(validEpub(), "No cover");
    expect(coverless.response.status).toBe(201);
    expect(coverless.book).toMatchObject({ coverId: null, coverUrl: null });

    const unsafeSvg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const unsafe = await uploadFixture(epubWithPackage(
      "OPS/content.opf",
      '<?xml version="1.0"?><package><metadata/><manifest><item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/></manifest><spine/></package>',
      [{ name: "OPS/cover.svg", bytes: unsafeSvg }],
    ), "Unsafe SVG");
    expect(unsafe.response.status).toBe(422);
    expect((await unsafe.response.json() as any).error.code).toBe("INVALID_EPUB");

    const oversized = await uploadFixture(epubWithPackage(
      "OPS/content.opf",
      '<?xml version="1.0"?><package><metadata><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.png" media-type="image/png"/></manifest><spine/></package>',
      [{ name: "OPS/cover.png", bytes: pngCover(), uncompressedSize: 4 * 1024 * 1024 + 1 }],
    ), "Cover bomb");
    expect(oversized.response.status).toBe(422);
    expect((await oversized.response.json() as any).error.code).toBe("INVALID_EPUB");
  });

  it("backfills a previously published D1 upload when prepare is repeated", async () => {
    const coverBytes = pngCover(240, 360);
    const epub = epubWithPackage(
      "OPS/content.opf",
      '<?xml version="1.0"?><package><metadata><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.png" media-type="image/png"/></manifest><spine/></package>',
      [{ name: "OPS/cover.png", bytes: coverBytes }],
    );
    const checksum = await sha256(epub);
    const objectKey = `uploads/${checksum}.epub`;
    await env.BOOKS.put(objectKey, epub, { sha256: await crypto.subtle.digest("SHA-256", new Uint8Array(epub).buffer) });
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO uploaded_books
        (id, sha256, version, title, author, description, language, subjects_json, file_size, object_key, updated_at)
       VALUES (?, ?, '1', 'Existing', 'Reader', '', 'en', '[]', ?, ?, ?)`,
    ).bind(`epub-${checksum}`, checksum, epub.length, objectKey, updatedAt).run();
    const prepare = await jsonRequest("/v1/uploads/prepare", {
      sha256: checksum,
      fileSize: epub.length,
      title: "Existing",
      author: "Reader",
      description: "",
      language: "en",
      subjects: [],
    });
    expect(prepare.status).toBe(200);
    expect(await prepare.json()).toMatchObject({
      uploaded: true,
      uploadUrl: null,
      book: { coverId: `cover-${checksum}`, coverUrl: `/v1/books/epub-${checksum}/cover` },
    });
    expect(await env.DB.prepare("SELECT cover_checked_at FROM uploaded_books WHERE sha256 = ?").bind(checksum).first("cover_checked_at")).not.toBeNull();
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
  }, 15_000);

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
  }, 15_000);
});

describe("shared personal sync", () => {
  const bookId = "sync-book";
  const edition = "b".repeat(64);
  const deviceId = "ios-device";

  function change(kind: string, id: string, payload: unknown, updatedAt: string, sha256 = edition) {
    return { id, bookId: kind === "preferences" ? "_preferences" : bookId, sha256: kind === "preferences" ? "0".repeat(64) : sha256, kind, updatedAt, payload };
  }

  it("merges LWW progress/library and retry-safe cumulative sessions", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const response = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("progress", "progress-z", { href: "chapter.xhtml", progression: 0.6 }, now),
        change("progress", "progress-a", { href: "stale.xhtml", progression: 0.1 }, now),
        change("library", "library-1", { present: true, addedAt: now }, now),
        change("session", "session-1", { readingMilliseconds: 12_000 }, now),
      ],
    });
    expect(response.status).toBe(200);
    const state: any = await response.json();
    expect(state.acceptedChangeIds).toHaveLength(4);
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

  it("rejects locator values that the Flutter client cannot safely decode", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const invalidPayloads = [
      change("progress", "missing-progression", { href: "chapter.xhtml" }, now),
      change("progress", "bad-progression", { href: "chapter.xhtml", progression: 1.1 }, now),
      change("progress", "bad-total", { href: "chapter.xhtml", progression: 0.2, totalProgression: "half" }, now),
      change("progress", "bad-raw", { href: "chapter.xhtml", progression: 0.2, raw: [] }, now),
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
      ],
    });
    expect(valid.status).toBe(200);
    expect((await valid.json() as any).books[0].progress).toMatchObject({ href: "chapter.xhtml", progression: 0 });
  });

  // Reader settings are per-device; installed clients may still push them.
  it("acknowledges legacy preference changes without storing or returning them", async () => {
    const now = new Date(Date.now() - 1_000).toISOString();
    const response = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [
        change("preferences", "prefs-1", { value: { fontSize: 18, themeId: "nord" } }, now),
        change("progress", "progress-1", { href: "chapter.xhtml", progression: 0.4 }, now),
        // Payloads the old validation rejected are dropped just the same.
        change("preferences", "prefs-2", { value: { fontSize: 100, futureSetting: null } }, now),
        change("library", "library-1", { present: true, addedAt: now }, now),
      ],
    });
    expect(response.status).toBe(200);
    const state: any = await response.json();
    expect(state.acceptedChangeIds).toEqual(["prefs-1", "progress-1", "prefs-2", "library-1"]);
    expect(state).not.toHaveProperty("preferences");
    expect(state.books).toEqual([
      expect.objectContaining({ bookId, inLibrary: true, progress: { href: "chapter.xhtml", progression: 0.4 } }),
    ]);

    const onlyPreferences = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [change("preferences", "prefs-3", { value: { font: "sans" } }, now)],
    });
    expect(onlyPreferences.status).toBe(200);
    expect((await onlyPreferences.json() as any).acceptedChangeIds).toEqual(["prefs-3"]);
    expect(await request("/v1/sync").then((value) => value.json())).not.toHaveProperty("preferences");
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'sync_preferences'").first()).toBeNull();

    const wrongEdition = await jsonRequest("/v1/sync", {
      deviceId,
      changes: [{ ...change("preferences", "prefs-4", { value: {} }, now), bookId }],
    });
    expect(wrongEdition.status).toBe(400);
    expect((await wrongEdition.json() as any).error.code).toBe("INVALID_SYNC");
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
      `INSERT INTO sync_progress (book_id, sha256, change_id, updated_at, updated_ms, payload_json)
       VALUES (?, ?, 'bad', ?, ?, '{"href":42,"progression":0.5}')`,
    ).bind(bookId, edition, now, Date.parse(now)).run();
    const progress = await request("/v1/sync");
    expect(progress.status).toBe(500);
    expect((await progress.json() as any).error.code).toBe("SYNC_STATE_INVALID");
  });

  describe("highlights", () => {
    const locator = {
      href: "chapter.xhtml",
      type: "application/xhtml+xml",
      locations: { progression: 0.25, cssSelector: "p:nth-child(3)" },
      text: { before: "It was ", highlight: "a dark night", after: " and" },
    };

    function highlight(changeId: string, highlightId: string, updatedAt: string, overrides: Record<string, unknown> = {}) {
      return change("highlight", changeId, {
        highlightId,
        locator,
        text: "a dark night",
        color: "yellow",
        createdAt: "2026-01-23T12:00:00.000Z",
        deleted: false,
        ...overrides,
      }, updatedAt);
    }

    it("leaves the response unchanged for clients that never ask for highlights", async () => {
      const now = new Date(Date.now() - 1_000).toISOString();
      const created = await jsonRequest("/v1/sync", { deviceId, changes: [highlight("h-1", "uuid-1", now)] });
      expect(created.status).toBe(200);
      const body: any = await created.json();
      expect(body.acceptedChangeIds).toEqual(["h-1"]);
      expect(body).not.toHaveProperty("highlights");
      expect((await request("/v1/sync").then((value) => value.json()) as any)).not.toHaveProperty("highlights");
    });

    it("piggybacks pushes and pulls on one request with LWW, tombstones and a rev cursor", async () => {
      const t0 = "2026-01-23T12:00:00.000000Z";
      const t1 = "2026-01-23T12:00:01.000000Z";
      const t2 = "2026-01-23T12:00:02.000000Z";
      const first = await jsonRequest("/v1/sync", {
        deviceId,
        highlightsSince: null,
        changes: [
          highlight("a", "uuid-1", t0, { note: "remember" }),
          highlight("b", "uuid-2", t0, { color: "blue" }),
        ],
      });
      expect(first.status).toBe(200);
      const full: any = (await first.json() as any).highlights;
      expect(full.more).toBe(false);
      expect(full.items).toEqual([
        {
          id: "uuid-1", bookId, sha256: edition, locator, text: "a dark night", color: "yellow", note: "remember",
          createdAt: "2026-01-23T12:00:00.000Z", updatedAt: t0, deleted: false,
        },
        expect.objectContaining({ id: "uuid-2", color: "blue", note: null }),
      ]);

      // Nothing changed: the cursor holds and no rows come back.
      const idle: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: full.cursor, changes: [] }).then((r) => r.json());
      expect(idle.highlights).toEqual({ items: [], cursor: full.cursor, more: false });

      // Another device recolours one and deletes the other.
      const other = await jsonRequest("/v1/sync", {
        deviceId: "android-device",
        highlightsSince: full.cursor,
        changes: [
          highlight("c", "uuid-1", t1, { color: "green", note: "remember" }),
          highlight("d", "uuid-2", t2, { color: "blue", deleted: true }),
        ],
      });
      const delta: any = (await other.json() as any).highlights;
      expect(delta.items.map((item: any) => [item.id, item.color, item.deleted])).toEqual([
        ["uuid-1", "green", false],
        ["uuid-2", "blue", true],
      ]);
      expect(delta.cursor).toBeGreaterThan(full.cursor);

      // A stale edit arriving late loses and does not bump the rev.
      const stale: any = await jsonRequest("/v1/sync", {
        deviceId,
        highlightsSince: delta.cursor,
        changes: [highlight("e", "uuid-2", t1, { color: "pink" })],
      }).then((r) => r.json());
      expect(stale.acceptedChangeIds).toEqual(["e"]);
      expect(stale.highlights.items).toEqual([]);

      const everything: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: 0, changes: [] }).then((r) => r.json());
      expect(everything.highlights.items).toEqual([
        expect.objectContaining({ id: "uuid-1", color: "green" }),
        expect.objectContaining({ id: "uuid-2", color: "blue", deleted: true }),
      ]);
    });

    it("pages large pulls instead of returning every row at once", async () => {
      await env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 501)
         INSERT INTO sync_highlights (id, book_id, sha256, locator_json, text, color, note, created_at,
                                      updated_at, updated_ms, deleted_at, change_id, rev)
         SELECT 'id-' || x, '${bookId}', '${edition}', '{"href":"c.xhtml"}', 't', 'yellow', NULL,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1767225600000000, NULL, 'c-' || x, x FROM n`,
      ).run();
      const page: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: null, changes: [] }).then((r) => r.json());
      expect(page.highlights.items).toHaveLength(500);
      expect(page.highlights).toMatchObject({ cursor: 500, more: true });
      const rest: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: 500, changes: [] }).then((r) => r.json());
      expect(rest.highlights).toMatchObject({ cursor: 501, more: false });
      expect(rest.highlights.items).toHaveLength(1);
    });

    it("rejects malformed highlights and cursors", async () => {
      const now = new Date(Date.now() - 1_000).toISOString();
      const invalid = [
        { deviceId, changes: [highlight("x", "uuid-x", now, { color: "#ff0" })] },
        { deviceId, changes: [highlight("x", "uuid-x", now, { locator: { locations: {} } })] },
        { deviceId, changes: [highlight("x", "uuid-x", now, { text: "x".repeat(4_001) })] },
        { deviceId, changes: [highlight("x", "uuid-x", now, { deleted: "no" })] },
        { deviceId, changes: [highlight("x", "not a uuid!", now)] },
        { deviceId, changes: [highlight("x", "uuid-x", now, { createdAt: "yesterday" })] },
        { deviceId, changes: [highlight("x", "uuid-x", now, { extra: 1 })] },
        { deviceId, highlightsSince: -1, changes: [] },
        { deviceId, highlightsSince: "0", changes: [] },
        { deviceId, highlightsSince: 1.5, changes: [] },
      ];
      for (const body of invalid) {
        const response = await jsonRequest("/v1/sync", body);
        expect(response.status).toBe(400);
        expect((await response.json() as any).error.code).toBe("INVALID_SYNC");
      }
    });

    it("refuses to move a highlight to another book", async () => {
      const t0 = "2026-01-23T12:00:00.000000Z";
      const t1 = "2026-01-23T12:00:01.000000Z";
      await jsonRequest("/v1/sync", { deviceId, changes: [highlight("a", "uuid-1", t0)] });
      const moved = change("highlight", "b", {
        highlightId: "uuid-1", locator, text: "x", color: "pink", createdAt: t0, deleted: false,
      }, t1, "c".repeat(64));
      const after: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: 0, changes: [moved] }).then((r) => r.json());
      expect(after.highlights.items).toEqual([expect.objectContaining({ id: "uuid-1", sha256: edition, color: "yellow" })]);
    });

    // Web article highlights (docs/cloud-sync.md): the article id in bookId, a
    // sentinel edition, and a block/offset locator. No server change needed.
    it("accepts article highlights on their sentinel edition and returns them as written", async () => {
      const t0 = "2026-01-23T12:00:00.000000Z";
      const articleId = "0123456789abcdef0123456789abcdef";
      const articleLocator = {
        type: "article", href: "https://example.org/post", articleId, block: 12, start: 5, endBlock: 13, end: 20,
        title: "A section", locations: { progression: 0.31, totalProgression: 0.31 },
        text: { before: "Earlier ", highlight: "the passage\nand more", after: " later" },
      };
      const articleHighlight = {
        id: "art-1", bookId: `article-${articleId}`, sha256: "0".repeat(64), kind: "highlight", updatedAt: t0,
        payload: { highlightId: "uuid-art", locator: articleLocator, text: "the passage\nand more", color: "green", note: "why", createdAt: t0, deleted: false },
      };
      const body: any = await jsonRequest("/v1/sync", { deviceId, highlightsSince: 0, changes: [articleHighlight] }).then((r) => r.json());
      expect(body.acceptedChangeIds).toEqual(["art-1"]);
      expect(body.highlights.items).toEqual([
        expect.objectContaining({ id: "uuid-art", bookId: `article-${articleId}`, sha256: "0".repeat(64), locator: articleLocator, note: "why" }),
      ]);
    });
  });
});
