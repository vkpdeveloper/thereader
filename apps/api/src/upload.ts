import { isRecord, readBoundedJson } from "./body";
import { findPublishedBookBySha, toPublicBook } from "./catalog";
import { ApiError } from "./errors";
import type { Book, CatalogBook, Env } from "./types";

export const MAX_SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_EPUB_BYTES = 512 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
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
  upload_id: string | null;
  part_size: number | null;
}

interface UploadedPartRow {
  part_number: number;
  etag: string;
  byte_size: number;
}

interface MultipartState {
  uploadId: string;
  partSize: number;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface PrepareUploadResult {
  book: Book;
  uploaded: boolean;
  uploadUrl: string | null;
  multipart: MultipartState | null;
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

export async function prepareUpload(request: Request, env: Env): Promise<PrepareUploadResult> {
  const metadata = parseMetadata(await readBoundedJson(request, MAX_PREPARE_BYTES));
  const published = await findPublishedBookBySha(env, metadata.sha256);
  if (published !== null) {
    if (await hasPublishedObject(env, published)) {
      return { book: toPublicBook(published), uploaded: true, uploadUrl: null, multipart: null };
    }
    throw new ApiError(409, "PUBLISHED_OBJECT_MISSING", "The published EPUB object is unavailable.");
  }

  const preparedAt = new Date().toISOString();
  const book = uploadedBook(metadata, preparedAt);
  const existingPending = await env.DB.prepare("SELECT * FROM pending_uploads WHERE sha256 = ?")
    .bind(metadata.sha256)
    .first<PendingUploadRow>();
  if (existingPending !== null && existingPending.file_size !== metadata.fileSize) {
    throw new ApiError(409, "UPLOAD_METADATA_CONFLICT", "The prepared file size conflicts with this checksum.");
  }
  if (existingPending === null) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM upload_parts WHERE sha256 IN (SELECT sha256 FROM pending_uploads WHERE prepared_at < ?)",
      ).bind(cutoff),
      env.DB.prepare("DELETE FROM pending_uploads WHERE prepared_at < ?").bind(cutoff),
    ]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM pending_uploads").first<{ count: number }>();
    if (count !== null && count.count >= MAX_PENDING_UPLOADS) {
      throw new ApiError(429, "UPLOAD_QUEUE_FULL", "Too many uploads are waiting to finish.");
    }
  }
  const needsMultipart = metadata.fileSize > MAX_SINGLE_UPLOAD_BYTES;
  let uploadId = existingPending?.upload_id ?? null;
  let createdUpload: R2MultipartUpload | null = null;
  if (needsMultipart && uploadId === null) {
    createdUpload = await env.BOOKS.createMultipartUpload(book.objectKey, {
      httpMetadata: { contentType: "application/epub+zip" },
      customMetadata: { sha256: book.sha256 },
    });
    uploadId = createdUpload.uploadId;
  }
  if (!needsMultipart && uploadId !== null) {
    throw new ApiError(500, "UPLOAD_STATE_INVALID", "Upload state is invalid.");
  }
  const partSize = needsMultipart ? (existingPending?.part_size ?? MULTIPART_PART_BYTES) : null;
  if (needsMultipart && partSize !== MULTIPART_PART_BYTES) {
    throw new ApiError(500, "UPLOAD_STATE_INVALID", "Upload state is invalid.");
  }
  try {
    await env.DB.prepare(
      `INSERT INTO pending_uploads
         (sha256, title, author, description, language, subjects_json, file_size,
          object_key, prepared_at, upload_id, part_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET
         title = excluded.title, author = excluded.author, description = excluded.description,
         language = excluded.language, subjects_json = excluded.subjects_json,
         file_size = excluded.file_size, object_key = excluded.object_key,
         prepared_at = excluded.prepared_at, upload_id = excluded.upload_id,
         part_size = excluded.part_size`,
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
        uploadId,
        partSize,
      )
      .run();
  } catch (error) {
    if (createdUpload !== null) await createdUpload.abort().catch(() => undefined);
    throw error;
  }
  if (!needsMultipart) {
    return {
      book: toPublicBook(book),
      uploaded: false,
      uploadUrl: `/v1/uploads/${metadata.sha256}`,
      multipart: null,
    };
  }
  const parts = await env.DB.prepare(
    "SELECT part_number, etag, byte_size FROM upload_parts WHERE sha256 = ? ORDER BY part_number",
  ).bind(metadata.sha256).all<UploadedPartRow>();
  return {
    book: toPublicBook(book),
    uploaded: false,
    uploadUrl: null,
    multipart: {
      uploadId: uploadId!,
      partSize: MULTIPART_PART_BYTES,
      parts: parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
    },
  };
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

function validMultipartRow(row: PendingUploadRow): row is PendingUploadRow & { upload_id: string; part_size: number } {
  return (
    typeof row.upload_id === "string" &&
    row.upload_id.length > 0 &&
    row.upload_id.length <= 1_024 &&
    Number.isSafeInteger(row.part_size) &&
    (row.part_size as number) >= 5 * 1024 * 1024 &&
    (row.part_size as number) <= 64 * 1024 * 1024
  );
}

function multipartPartLength(row: PendingUploadRow & { part_size: number }, partNumber: number): number | null {
  const partCount = Math.ceil(row.file_size / row.part_size);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) return null;
  return partNumber === partCount
    ? row.file_size - row.part_size * (partCount - 1)
    : row.part_size;
}

async function pendingMultipart(env: Env, sha256: string): Promise<PendingUploadRow & { upload_id: string; part_size: number }> {
  const row = await env.DB.prepare("SELECT * FROM pending_uploads WHERE sha256 = ?")
    .bind(sha256)
    .first<PendingUploadRow>();
  if (row === null) throw new ApiError(404, "UPLOAD_NOT_PREPARED", "Upload must be prepared first.");
  if (!validMultipartRow(row)) {
    throw new ApiError(409, "MULTIPART_NOT_REQUIRED", "This upload does not use multipart transfer.");
  }
  return row;
}

function requireUploadId(request: Request, expected: string): void {
  const uploadId = request.headers.get("X-Upload-Id");
  if (uploadId === null || uploadId !== expected) {
    throw new ApiError(409, "MULTIPART_SESSION_MISMATCH", "The multipart upload session has changed. Prepare the upload again.");
  }
}

function r2ErrorCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  if (typeof error.code === "number") return error.code;
  if (typeof error.message === "string" && /\(10024\)$/.test(error.message)) return 10024;
  return null;
}

async function clearMultipartState(env: Env, sha256: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_parts WHERE sha256 = ?").bind(sha256),
    env.DB.prepare("UPDATE pending_uploads SET upload_id = NULL, part_size = NULL WHERE sha256 = ?").bind(sha256),
  ]);
}

export async function uploadEpubPart(
  request: Request,
  env: Env,
  sha256: string,
  partNumber: number,
): Promise<{ partNumber: number; etag: string }> {
  if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, "INVALID_UPLOAD_ID", "Upload ID is invalid.");
  const row = await pendingMultipart(env, sha256);
  requireUploadId(request, row.upload_id);
  const expectedLength = multipartPartLength(row, partNumber);
  if (expectedLength === null) throw new ApiError(400, "INVALID_PART_NUMBER", "Multipart part number is invalid.");
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/octet-stream") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/octet-stream.");
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedLength) {
    throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length does not match the multipart part size.");
  }
  if (request.body === null) throw new ApiError(400, "UPLOAD_BODY_REQUIRED", "EPUB part bytes are required.");
  let part: R2UploadedPart;
  try {
    part = await env.BOOKS.resumeMultipartUpload(row.object_key, row.upload_id).uploadPart(partNumber, request.body);
  } catch (error) {
    if (r2ErrorCode(error) === 10024) {
      const completedObject = await env.BOOKS.head(row.object_key);
      if (completedObject === null) await clearMultipartState(env, row.sha256);
    }
    throw new ApiError(409, "MULTIPART_SESSION_EXPIRED", "The multipart upload session is unavailable. Prepare the upload again.");
  }
  if (part.partNumber !== partNumber || part.etag.length === 0 || part.etag.length > 512) {
    throw new ApiError(502, "MULTIPART_PART_FAILED", "R2 returned an invalid multipart acknowledgement.");
  }
  await env.DB.prepare(
    `INSERT INTO upload_parts (sha256, part_number, etag, byte_size)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sha256, part_number) DO UPDATE SET
       etag = excluded.etag, byte_size = excluded.byte_size`,
  ).bind(sha256, partNumber, part.etag, expectedLength).run();
  return { partNumber, etag: part.etag };
}

async function resetMultipart(env: Env, row: PendingUploadRow): Promise<void> {
  await env.BOOKS.delete(row.object_key);
  await clearMultipartState(env, row.sha256);
}

async function objectSha256(env: Env, book: CatalogBook): Promise<string> {
  const object = await env.BOOKS.get(book.objectKey);
  if (object === null || object.size !== book.fileSize) {
    throw new ApiError(422, "UPLOAD_INCOMPLETE", "The EPUB upload was incomplete.");
  }
  const workerCrypto = crypto as typeof crypto & { DigestStream: typeof DigestStream };
  const digestStream = new workerCrypto.DigestStream("SHA-256");
  const piping = object.body.pipeTo(digestStream);
  const digest = await digestStream.digest;
  await piping;
  return digestHex(digest);
}

async function publishBook(env: Env, book: CatalogBook): Promise<{ status: number; body: { book: Book; uploaded: true } }> {
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
    env.DB.prepare("DELETE FROM upload_parts WHERE sha256 = ?").bind(book.sha256),
    env.DB.prepare("DELETE FROM pending_uploads WHERE sha256 = ?").bind(book.sha256),
  ]);
  const canonical = await findPublishedBookBySha(env, book.sha256);
  if (canonical === null) throw new ApiError(500, "UPLOAD_PUBLISH_FAILED", "The uploaded book could not be published.");
  return {
    status: (publishResults[0]?.meta.changes ?? 0) > 0 ? 201 : 200,
    body: { book: toPublicBook(canonical), uploaded: true },
  };
}

export async function completeMultipartUpload(
  request: Request,
  env: Env,
  sha256: string,
): Promise<{ status: number; body: { book: Book; uploaded: true } }> {
  if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, "INVALID_UPLOAD_ID", "Upload ID is invalid.");
  const published = await findPublishedBookBySha(env, sha256);
  if (published !== null && (await hasPublishedObject(env, published))) {
    return { status: 200, body: { book: toPublicBook(published), uploaded: true } };
  }
  const raw = await readBoundedJson(request, 4 * 1024);
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "uploadId") || typeof raw.uploadId !== "string") {
    throw invalidUpload("Multipart completion body is invalid.");
  }
  const row = await pendingMultipart(env, sha256);
  if (raw.uploadId !== row.upload_id) {
    throw new ApiError(409, "MULTIPART_SESSION_MISMATCH", "The multipart upload session has changed. Prepare the upload again.");
  }
  const parts = await env.DB.prepare(
    "SELECT part_number, etag, byte_size FROM upload_parts WHERE sha256 = ? ORDER BY part_number",
  ).bind(sha256).all<UploadedPartRow>();
  const expectedCount = Math.ceil(row.file_size / row.part_size);
  const complete = parts.results.length === expectedCount && parts.results.every((part, index) => (
    part.part_number === index + 1 &&
    part.byte_size === multipartPartLength(row, part.part_number) &&
    part.etag.length > 0 &&
    part.etag.length <= 512
  ));
  if (!complete) throw new ApiError(409, "MULTIPART_INCOMPLETE", "Upload all EPUB parts before completing the upload.");
  const book = pendingBook(row);
  try {
    await env.BOOKS.resumeMultipartUpload(row.object_key, row.upload_id).complete(
      parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
    );
  } catch (error) {
    const existing = await env.BOOKS.head(row.object_key);
    if (existing === null || existing.size !== book.fileSize) {
      if (r2ErrorCode(error) === 10024) await clearMultipartState(env, row.sha256);
      throw new ApiError(409, "MULTIPART_SESSION_EXPIRED", "The multipart upload session is unavailable. Prepare the upload again.");
    }
  }
  try {
    if (await objectSha256(env, book) !== book.sha256) {
      throw new ApiError(422, "CHECKSUM_MISMATCH", "The uploaded bytes do not match sha256.");
    }
    await validateEpub(env, book);
  } catch (error) {
    await resetMultipart(env, row);
    throw error;
  }
  return publishBook(env, book);
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
  if (row.upload_id !== null || row.file_size > MAX_SINGLE_UPLOAD_BYTES) {
    throw new ApiError(409, "USE_MULTIPART_UPLOAD", "This EPUB must be uploaded with the multipart endpoints.");
  }
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

  return publishBook(env, book);
}
