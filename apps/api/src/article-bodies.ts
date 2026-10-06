import { ApiError } from "./errors";
import { ARTICLE_SCHEMA, MAX_ARTICLE_BODY_BYTES } from "./sync";
import type { Env } from "./types";

/**
 * Extracted article documents (`Article` JSON, schema 1), stored once per
 * content hash. The device that saved an article uploads the exact JSON bytes
 * it hashed, optionally gzip-compressed; other devices download them instead
 * of fetching and extracting the page again. The Worker never extracts or
 * parses: within the free plan's CPU budget it streams the uncompressed bytes
 * through the 8 MB cap and a native SHA-256, checks that the document has the
 * shape of a schema-1 article at both ends, then stores the bytes as sent.
 *
 * The shape check is deliberately not a full parse (a multi-MB document would
 * cost tens of milliseconds of CPU). It is safe because bodies are content
 * addressed and only reached through the uploader's own sync rows, and every
 * client verifies the hash and parses the document fully before showing it:
 * a malformed upload can only fail on the devices of the profile that sent it.
 */

const JSON_TYPE = "application/json";
const GZIP_TYPE = "application/gzip";

// Both clients serialize `Article` compactly with `schema` as its first key
// (packages/extract/src/extract.ts, packages/extract_dart/lib/src/model.dart).
const ARTICLE_HEAD = new TextEncoder().encode(`{"schema":${ARTICLE_SCHEMA},`);
const CLOSING_BRACE = 0x7d;
// How much of the document's start is kept to check its shape.
const HEAD_BYTES = 256;
// Streams are read with bring-your-own-buffer reads of 256 KB. Default readers
// yield chunks of a few KB, and for a multi-MB document the per-chunk overhead
// costs more CPU than inflating and hashing it.
const READ_CHUNK_BYTES = 256 * 1024;

export const articleBodyKey = (sha256: string): string => `articles/${sha256}`;

function tooLarge(): ApiError {
  return new ApiError(413, "TOO_LARGE", "Article documents are limited to 8 MB.");
}

function invalidArticle(): ApiError {
  return new ApiError(422, "INVALID_ARTICLE", "The upload is not a saved article document.");
}

// Reads up to `maximum` bytes, 256 KB per read where the stream allows it
// (request bodies from the network do; streams built in JS may not).
async function readAll(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  await readChunks(stream, (chunk) => {
    total += chunk.byteLength;
    if (total > maximum) throw tooLarge();
    chunks.push(chunk);
  });
  if (chunks.length === 1 && chunks[0]!.byteLength === chunks[0]!.buffer.byteLength) return chunks[0] as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Hands each chunk to `onChunk`; if it throws, the stream is cancelled and the
// error rethrown.
async function readChunks(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
  let byob: ReadableStreamBYOBReader | null = null;
  try {
    byob = stream.getReader({ mode: "byob" });
  } catch {
    // Not a byte stream.
  }
  const reader = byob ?? stream.getReader();
  try {
    while (true) {
      const { done, value } = byob === null
        ? await (reader as ReadableStreamDefaultReader<Uint8Array>).read()
        : await byob.read(new Uint8Array(READ_CHUNK_BYTES));
      if (done) break;
      if (value.byteLength > 0) await onChunk(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What validation needs from an uncompressed document, gathered in one pass. */
interface Scan {
  size: number;
  sha256: string;
  head: Uint8Array;
  last: number | undefined;
}

function scanPlain(bytes: Uint8Array<ArrayBuffer>): Promise<Scan> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => ({
    size: bytes.byteLength,
    sha256: hex(digest),
    head: bytes.subarray(0, HEAD_BYTES),
    last: bytes[bytes.byteLength - 1],
  }));
}

// Inflates without materializing the document: each chunk is counted against
// the cap (so a small gzip bomb stops at 8 MB) and handed to the native digest.

async function scanGzip(bytes: Uint8Array<ArrayBuffer>): Promise<Scan> {
  const workerCrypto = crypto as typeof crypto & { DigestStream: typeof DigestStream };
  const digest = new workerCrypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const head = new Uint8Array(HEAD_BYTES);
  let size = 0;
  let last: number | undefined;
  try {
    await readChunks(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), async (chunk) => {
      if (size < HEAD_BYTES) head.set(chunk.subarray(0, HEAD_BYTES - size), size);
      size += chunk.byteLength;
      if (size > MAX_ARTICLE_BODY_BYTES) throw tooLarge();
      last = chunk[chunk.byteLength - 1];
      await writer.write(chunk);
    });
    await writer.close();
  } catch (error) {
    // Aborting rejects the pending digest too; nothing reads it.
    digest.digest.catch(() => undefined);
    await writer.abort().catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw invalidArticle(); // Not gzip, or truncated.
  }
  return { size, sha256: hex(await digest.digest), head: head.subarray(0, Math.min(size, HEAD_BYTES)), last };
}

function looksLikeArticle(scan: Scan): boolean {
  if (scan.last !== CLOSING_BRACE || scan.head.byteLength < ARTICLE_HEAD.byteLength) return false;
  if (!ARTICLE_HEAD.every((byte, index) => scan.head[index] === byte)) return false;
  try {
    // `stream` tolerates a character cut off at the window's end.
    new TextDecoder("utf-8", { fatal: true }).decode(scan.head, { stream: true });
  } catch {
    return false;
  }
  return true;
}

/** Validates an upload as sent; returns the uncompressed document's size. */
export async function checkArticleBody(sent: Uint8Array<ArrayBuffer>, gzipped: boolean, sha256: string): Promise<number> {
  const scan = gzipped ? await scanGzip(sent) : await scanPlain(sent);
  if (scan.size === 0) throw invalidArticle();
  if (scan.sha256 !== sha256) throw new ApiError(422, "CHECKSUM_MISMATCH", "The document does not match its SHA-256.");
  if (!looksLikeArticle(scan)) throw invalidArticle();
  return scan.size;
}

export async function putArticleBody(request: Request, env: Env, sha256: string): Promise<{ status: number; body: unknown }> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE && contentType !== GZIP_TYPE) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json or application/gzip.");
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    if (length > MAX_ARTICLE_BODY_BYTES) throw tooLarge();
  }
  if (request.body === null) throw new ApiError(400, "BODY_REQUIRED", "An article document is required.");
  const sent = await readAll(request.body, MAX_ARTICLE_BODY_BYTES);
  const size = await checkArticleBody(sent, contentType === GZIP_TYPE, sha256);

  // Content-addressed and immutable: a repeat upload (retry, or the same
  // document saved on another device) costs one metadata read and no write.
  const key = articleBodyKey(sha256);
  const existing = await env.BOOKS.head(key);
  if (existing !== null) return { status: 200, body: { sha256, size, created: false } };
  await env.BOOKS.put(key, sent, {
    httpMetadata: { contentType: contentType === GZIP_TYPE ? GZIP_TYPE : JSON_TYPE },
    customMetadata: { size: String(size) },
  });
  return { status: 201, body: { sha256, size, created: true } };
}

export async function getArticleBody(request: Request, env: Env, sha256: string): Promise<Response> {
  const key = articleBodyKey(sha256);
  const object = request.method === "HEAD" ? await env.BOOKS.head(key) : await env.BOOKS.get(key);
  if (object === null) throw new ApiError(404, "NOT_FOUND", "Article document not found.");
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(object.size),
    // The stored bytes as uploaded: gzip-compressed JSON or plain JSON.
    // Clients decompress `application/gzip` themselves and verify the hash.
    "Content-Type": object.httpMetadata?.contentType === GZIP_TYPE ? GZIP_TYPE : `${JSON_TYPE}; charset=utf-8`,
    ETag: `"${sha256}"`,
    "X-Content-Type-Options": "nosniff",
  });
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === "*" || ifNoneMatch?.split(",").some((value) => value.trim().replace(/^W\//, "") === `"${sha256}"`)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  const body = request.method === "HEAD" || !("body" in object) ? null : (object as R2ObjectBody).body;
  return new Response(body, { headers });
}
