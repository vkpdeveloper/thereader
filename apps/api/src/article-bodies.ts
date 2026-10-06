import { isRecord } from "./body";
import { ApiError } from "./errors";
import { ARTICLE_SCHEMA, MAX_ARTICLE_BODY_BYTES } from "./sync";
import type { Env } from "./types";

/**
 * Extracted article documents (`Article` JSON, schema 1), stored once per
 * content hash. The device that saved an article uploads the exact JSON bytes
 * it hashed, optionally gzip-compressed; other devices download them instead
 * of fetching and extracting the page again. The Worker never extracts: it
 * only checks the size, the SHA-256 of the uncompressed bytes and that they
 * parse as a schema-1 article, then stores the bytes as sent.
 */

const JSON_TYPE = "application/json";
const GZIP_TYPE = "application/gzip";

export const articleBodyKey = (sha256: string): string => `articles/${sha256}`;

function tooLarge(): ApiError {
  return new ApiError(413, "TOO_LARGE", "Article documents are limited to 8 MB.");
}

function invalidArticle(): ApiError {
  return new ApiError(422, "INVALID_ARTICLE", "The upload is not a saved article document.");
}

async function readAll(stream: ReadableStream<Uint8Array>, maximum: number, onExceed: () => ApiError): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw onExceed();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  try {
    return await readAll(stream, MAX_ARTICLE_BODY_BYTES, tooLarge);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidArticle();
  }
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validArticle(json: unknown): boolean {
  return isRecord(json)
    && json.schema === ARTICLE_SCHEMA
    && typeof json.url === "string"
    && typeof json.title === "string"
    && Array.isArray(json.blocks);
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
  const sent = await readAll(request.body, MAX_ARTICLE_BODY_BYTES, tooLarge);
  const plain = contentType === GZIP_TYPE ? await gunzip(sent) : sent;
  if (plain.byteLength === 0) throw invalidArticle();
  const actual = hex(await crypto.subtle.digest("SHA-256", plain));
  if (actual !== sha256) throw new ApiError(422, "CHECKSUM_MISMATCH", "The document does not match its SHA-256.");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    throw invalidArticle();
  }
  if (!validArticle(json)) throw invalidArticle();

  // Content-addressed and immutable: a repeat upload (retry, or the same
  // document saved on another device) costs one metadata read and no write.
  const key = articleBodyKey(sha256);
  const existing = await env.BOOKS.head(key);
  if (existing !== null) return { status: 200, body: { sha256, size: plain.byteLength, created: false } };
  await env.BOOKS.put(key, sent, {
    httpMetadata: { contentType: contentType === GZIP_TYPE ? GZIP_TYPE : JSON_TYPE },
    customMetadata: { size: String(plain.byteLength) },
  });
  return { status: 201, body: { sha256, size: plain.byteLength, created: true } };
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
