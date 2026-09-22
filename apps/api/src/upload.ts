import { isRecord, readBoundedJson } from "./body";
import { findPublishedBookBySha, toPublicBook } from "./catalog";
import { ApiError } from "./errors";
import type { Book, CatalogBook, Env } from "./types";

export const MAX_EPUB_BYTES = 64 * 1024 * 1024;
const MAX_PREPARE_BYTES = 64 * 1024;
const MAX_PENDING_UPLOADS = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

interface UploadMetadata {
  sha256: string;
  fileSize: number;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
}

interface PendingUploadRow {
  sha256: string;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects_json: string;
  file_size: number;
  object_key: string;
  prepared_at: string;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function invalidUpload(message: string): ApiError {
  return new ApiError(400, "INVALID_UPLOAD", message);
}

function cleanText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw invalidUpload(`${name} is invalid.`);
  const text = value.trim();
  if ((!allowEmpty && text.length === 0) || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw invalidUpload(`${name} is invalid.`);
  }
  return text;
}

function parseMetadata(value: unknown): UploadMetadata {
  if (!isRecord(value)) throw invalidUpload("Upload metadata is invalid.");
  const allowed = new Set(["sha256", "fileSize", "title", "author", "description", "language", "subjects"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidUpload("Upload metadata is invalid.");
  const sha256 = value.sha256;
  const fileSize = value.fileSize;
  const language = value.language;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) throw invalidUpload("sha256 is invalid.");
  if (!Number.isSafeInteger(fileSize) || (fileSize as number) < 1 || (fileSize as number) > MAX_EPUB_BYTES) {
    throw invalidUpload(`fileSize must be between 1 and ${MAX_EPUB_BYTES}.`);
  }
  if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) throw invalidUpload("language is invalid.");
  if (!Array.isArray(value.subjects) || value.subjects.length > 32) throw invalidUpload("subjects is invalid.");
  const subjects = value.subjects.map((subject) => cleanText(subject, "subject", 100));
  if (new Set(subjects).size !== subjects.length) throw invalidUpload("subjects must be unique.");
  return {
    sha256,
    fileSize: fileSize as number,
    title: cleanText(value.title, "title", 300),
    author: cleanText(value.author, "author", 300),
    description: cleanText(value.description, "description", 4_000, true),
    language,
    subjects,
  };
}

function uploadedBook(metadata: UploadMetadata, updatedAt: string): CatalogBook {
  const id = `epub-${metadata.sha256}`;
  return {
    id,
    version: "1",
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    language: metadata.language,
    subjects: metadata.subjects,
    coverUrl: null,
    downloadUrl: `/v1/books/${id}/download`,
    fileSize: metadata.fileSize,
    sha256: metadata.sha256,
    updatedAt,
    objectKey: `uploads/${metadata.sha256}.epub`,
    cover: null,
  };
}

function hexDigest(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function digestHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hasPublishedObject(env: Env, book: CatalogBook): Promise<boolean> {
  const object = await env.BOOKS.head(book.objectKey);
  if (object === null || object.size !== book.fileSize) return false;
  return object.checksums.sha256 === undefined || digestHex(object.checksums.sha256) === book.sha256;
}

export async function prepareUpload(request: Request, env: Env): Promise<{ book: Book; uploaded: boolean; uploadUrl: string | null }> {
  const metadata = parseMetadata(await readBoundedJson(request, MAX_PREPARE_BYTES));
  const published = await findPublishedBookBySha(env, metadata.sha256);
  if (published !== null) {
    if (await hasPublishedObject(env, published)) {
      return { book: toPublicBook(published), uploaded: true, uploadUrl: null };
    }
    throw new ApiError(409, "PUBLISHED_OBJECT_MISSING", "The published EPUB object is unavailable.");
  }

  const preparedAt = new Date().toISOString();
  const book = uploadedBook(metadata, preparedAt);
  const existingPending = await env.DB.prepare("SELECT sha256 FROM pending_uploads WHERE sha256 = ?")
    .bind(metadata.sha256)
    .first<{ sha256: string }>();
  if (existingPending === null) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    await env.DB.prepare("DELETE FROM pending_uploads WHERE prepared_at < ?").bind(cutoff).run();
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM pending_uploads").first<{ count: number }>();
    if (count !== null && count.count >= MAX_PENDING_UPLOADS) {
      throw new ApiError(429, "UPLOAD_QUEUE_FULL", "Too many uploads are waiting to finish.");
    }
  }
  await env.DB.prepare(
    `INSERT INTO pending_uploads
       (sha256, title, author, description, language, subjects_json, file_size, object_key, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET
       title = excluded.title, author = excluded.author, description = excluded.description,
       language = excluded.language, subjects_json = excluded.subjects_json,
       file_size = excluded.file_size, object_key = excluded.object_key,
       prepared_at = excluded.prepared_at`,
  )
    .bind(
      metadata.sha256,
      metadata.title,
      metadata.author,
      metadata.description,
      metadata.language,
      JSON.stringify(metadata.subjects),
      metadata.fileSize,
      book.objectKey,
      preparedAt,
    )
    .run();
  return { book: toPublicBook(book), uploaded: false, uploadUrl: `/v1/uploads/${metadata.sha256}` };
}

function pendingBook(row: PendingUploadRow): CatalogBook {
  let subjects: unknown;
  try {
    subjects = JSON.parse(row.subjects_json);
  } catch {
    throw new ApiError(500, "UPLOAD_STATE_INVALID", "Upload state is invalid.");
  }
  if (!Array.isArray(subjects) || !subjects.every((value) => typeof value === "string")) {
    throw new ApiError(500, "UPLOAD_STATE_INVALID", "Upload state is invalid.");
  }
  return uploadedBook(
    {
      sha256: row.sha256,
      fileSize: row.file_size,
      title: row.title,
      author: row.author,
      description: row.description,
      language: row.language,
      subjects,
    },
    row.prepared_at,
  );
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function r2Range(env: Env, key: string, offset: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  }
  const object = await env.BOOKS.get(key, { range: { offset, length } });
  if (object === null || !("body" in object)) throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  return bytes;
}

function safeZipName(name: string): boolean {
  return name.length > 0 && name.length <= 1_024 && !name.startsWith("/") && !name.includes("\\") && !name.includes("\0") && !name.split("/").includes("..");
}

async function centralDirectory(env: Env, book: CatalogBook): Promise<Map<string, ZipEntry>> {
  const tailLength = Math.min(book.fileSize, 65_557);
  const tailOffset = book.fileSize - tailLength;
  const tail = await r2Range(env, book.objectKey, tailOffset, tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (u32(tail, index) === 0x06054b50 && index + 22 + u16(tail, index + 20) === tail.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0 || u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0) {
    throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  }
  const entriesOnDisk = u16(tail, eocd + 8);
  const entryCount = u16(tail, eocd + 10);
  const directorySize = u32(tail, eocd + 12);
  const directoryOffset = u32(tail, eocd + 16);
  if (
    entryCount === 0 ||
    entryCount !== entriesOnDisk ||
    entryCount > MAX_ZIP_ENTRIES ||
    entryCount === 0xffff ||
    directorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > book.fileSize
  ) {
    throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  }
  const directory = await r2Range(env, book.objectKey, directoryOffset, directorySize);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map<string, ZipEntry>();
  let offset = 0;
  try {
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > directory.length || u32(directory, offset) !== 0x02014b50) throw new Error();
      const flags = u16(directory, offset + 8);
      const method = u16(directory, offset + 10);
      const compressedSize = u32(directory, offset + 20);
      const uncompressedSize = u32(directory, offset + 24);
      const nameLength = u16(directory, offset + 28);
      const extraLength = u16(directory, offset + 30);
      const commentLength = u16(directory, offset + 32);
      const localOffset = u32(directory, offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (
        end > directory.length ||
        (flags & 1) !== 0 ||
        (method !== 0 && method !== 8) ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new Error();
      }
      const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
      if (!safeZipName(name) || entries.has(name) || localOffset >= directoryOffset) throw new Error();
      entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
      offset = end;
    }
    if (offset !== directory.length) throw new Error();
  } catch {
    throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  }
  return entries;
}

async function boundedStream(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("expanded entry is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readEntry(env: Env, book: CatalogBook, entry: ZipEntry, maximum: number): Promise<Uint8Array> {
  if (entry.compressedSize > maximum || entry.uncompressedSize > maximum) throw new Error("entry is too large");
  const header = await r2Range(env, book.objectKey, entry.localOffset, 30);
  if (u32(header, 0) !== 0x04034b50 || u16(header, 6) !== entry.flags || u16(header, 8) !== entry.method) {
    throw new Error("invalid local header");
  }
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  const localName = new TextDecoder("utf-8", { fatal: true }).decode(
    await r2Range(env, book.objectKey, entry.localOffset + 30, nameLength),
  );
  if (localName !== entry.name) throw new Error("local name mismatch");
  const compressed = await r2Range(env, book.objectKey, entry.localOffset + 30 + nameLength + extraLength, entry.compressedSize);
  const output = entry.method === 0
    ? compressed
    : await boundedStream(
        new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream("deflate-raw" as "deflate")),
        maximum,
      );
  if (output.byteLength !== entry.uncompressedSize) throw new Error("entry size mismatch");
  return output;
}

function decodeXmlPath(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt);/g, (_, entity: string) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity]!);
}

async function validateEpub(env: Env, book: CatalogBook): Promise<void> {
  try {
    if (book.fileSize < 80) throw new Error();
    const first = await r2Range(env, book.objectKey, 0, Math.min(book.fileSize, 80));
    if (
      u32(first, 0) !== 0x04034b50 ||
      (u16(first, 6) & 0x09) !== 0 ||
      u16(first, 8) !== 0 ||
      u32(first, 18) !== 20 ||
      u32(first, 22) !== 20 ||
      u16(first, 26) !== 8 ||
      u16(first, 28) !== 0 ||
      new TextDecoder().decode(first.subarray(30, 38)) !== "mimetype" ||
      new TextDecoder().decode(first.subarray(38, 58)) !== "application/epub+zip"
    ) {
      throw new Error();
    }
    const entries = await centralDirectory(env, book);
    const mimetype = entries.get("mimetype");
    const container = entries.get("META-INF/container.xml");
    if (mimetype?.localOffset !== 0 || mimetype.method !== 0 || container === undefined) throw new Error();
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(await readEntry(env, book, container, 256 * 1024));
    const rootfile = /<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/i.exec(xml);
    if (!/<container\b/i.test(xml) || rootfile === null) throw new Error();
    const packagePath = decodeXmlPath(rootfile[1] ?? rootfile[2] ?? "");
    if (!safeZipName(packagePath)) throw new Error();
    const packageEntry = entries.get(packagePath);
    if (packageEntry === undefined) throw new Error();
    const packageXml = new TextDecoder("utf-8", { fatal: true }).decode(await readEntry(env, book, packageEntry, 2 * 1024 * 1024));
    if (!/<package\b/i.test(packageXml) || !/<metadata\b/i.test(packageXml) || !/<manifest\b/i.test(packageXml) || !/<spine\b/i.test(packageXml)) {
      throw new Error();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "INVALID_EPUB", "The uploaded file is not a valid EPUB.");
  }
}

export async function uploadEpub(request: Request, env: Env, sha256: string): Promise<{ status: number; body: { book: Book; uploaded: true } }> {
  if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, "INVALID_UPLOAD_ID", "Upload ID is invalid.");
  const published = await findPublishedBookBySha(env, sha256);
  if (published !== null && (await hasPublishedObject(env, published))) {
    return { status: 200, body: { book: toPublicBook(published), uploaded: true } };
  }
  const row = await env.DB.prepare("SELECT * FROM pending_uploads WHERE sha256 = ?")
    .bind(sha256)
    .first<PendingUploadRow>();
  if (row === null) throw new ApiError(404, "UPLOAD_NOT_PREPARED", "Upload must be prepared first.");
  const book = pendingBook(row);
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/epub+zip") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/epub+zip.");
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== book.fileSize) {
    throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length must match the prepared file size.");
  }
  if (request.body === null) throw new ApiError(400, "UPLOAD_BODY_REQUIRED", "EPUB bytes are required.");

  let stored: R2Object;
  try {
    stored = await env.BOOKS.put(book.objectKey, request.body, {
      sha256: hexDigest(book.sha256),
      httpMetadata: { contentType: "application/epub+zip" },
      customMetadata: { sha256: book.sha256 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("10037") || message.toLowerCase().includes("digest")) {
      throw new ApiError(422, "CHECKSUM_MISMATCH", "The uploaded bytes do not match sha256.");
    }
    throw new ApiError(422, "UPLOAD_INCOMPLETE", "The EPUB upload was incomplete.");
  }
  if (stored.size !== book.fileSize || stored.checksums.sha256 === undefined || digestHex(stored.checksums.sha256) !== book.sha256) {
    throw new ApiError(422, "CHECKSUM_MISMATCH", "The uploaded bytes do not match sha256.");
  }
  try {
    await validateEpub(env, book);
  } catch (error) {
    await env.BOOKS.delete(book.objectKey);
    throw error;
  }

  const publishedAt = new Date().toISOString();
  const publishResults = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO uploaded_books
         (id, sha256, version, title, author, description, language, subjects_json, file_size, object_key, updated_at)
       VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO NOTHING`,
    ).bind(
      book.id,
      book.sha256,
      book.title,
      book.author,
      book.description,
      book.language,
      JSON.stringify(book.subjects),
      book.fileSize,
      book.objectKey,
      publishedAt,
    ),
    env.DB.prepare("DELETE FROM pending_uploads WHERE sha256 = ?").bind(book.sha256),
  ]);
  const canonical = await findPublishedBookBySha(env, sha256);
  if (canonical === null) throw new ApiError(500, "UPLOAD_PUBLISH_FAILED", "The uploaded book could not be published.");
  return {
    status: (publishResults[0]?.meta.changes ?? 0) > 0 ? 201 : 200,
    body: { book: toPublicBook(canonical), uploaded: true },
  };
}
