import { getArticleBody, putArticleBody } from "./article-bodies";
import { articleSource } from "./article-source";
import { loadCatalog, toPublicBook, validateBookId } from "./catalog";
import { CDN_PREFIX, serveCdn } from "./cdn";
import { downloadBook } from "./download";
import { ApiError, errorResponse } from "./errors";
import { linkPreview } from "./link-preview";
import { encodeCursor, parseListQuery } from "./query";
import { getSyncState, pushSync } from "./sync";
import type { CatalogBook, Env } from "./types";
import { completeMultipartUpload, prepareUpload, uploadEpub, uploadEpubPart } from "./upload";

const METHODS = "GET, HEAD, POST, PUT, OPTIONS";

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type, Range, If-None-Match, If-Range, X-Upload-Id",
    "Access-Control-Allow-Methods": METHODS,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag, Last-Modified, X-Final-Url",
    "Access-Control-Max-Age": "86400",
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders()) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function findBook(books: CatalogBook[], id: string): CatalogBook {
  const book = books.find((candidate) => candidate.id === id);
  if (book === undefined) throw new ApiError(404, "NOT_FOUND", "Book not found.");
  return book;
}

function decodeBookId(segment: string): string {
  try {
    const id = decodeURIComponent(segment);
    validateBookId(id);
    return id;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_BOOK_ID", "Book ID is invalid.");
  }
}

async function listBooks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { limit, offset, query } = parseListQuery(url);
  const catalog = await loadCatalog(env);
  const needle = query.toLowerCase();
  const matching = needle.length === 0
    ? catalog.books
    : catalog.books.filter((book) =>
        [book.id, book.title, book.author, book.description, ...book.subjects]
          .some((value) => value.toLowerCase().includes(needle)),
      );
  if (offset > matching.length) {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor is outside the result set.");
  }
  const page = matching.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return json({
    items: page.map(toPublicBook),
    nextCursor: nextOffset < matching.length ? encodeCursor(nextOffset, query) : null,
  });
}

async function getCover(request: Request, env: Env, book: CatalogBook): Promise<Response> {
  if (book.cover === null) throw new ApiError(404, "NOT_FOUND", "Book cover not found.");
  const object = request.method === "HEAD"
    ? await env.BOOKS.head(book.cover.objectKey)
    : await env.BOOKS.get(book.cover.objectKey);
  if (object === null || object.size !== book.cover.fileSize || (book.cover.etag !== null && object.httpEtag !== book.cover.etag)) {
    throw new ApiError(404, "NOT_FOUND", "Book cover not found.");
  }
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(object.size),
    "Content-Type": book.cover.contentType,
    "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === "*" || ifNoneMatch?.split(",").some((value) => value.trim() === object.httpEtag)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  const body = request.method === "HEAD" || !("body" in object) ? null : (object as R2ObjectBody).body;
  return new Response(body, { headers });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (url.pathname.startsWith(CDN_PREFIX)) return serveCdn(request, env, ctx);

  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, HEAD, OPTIONS" });
    }
    const response = json({ status: "ok", service: "thereader-api" });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }

  if (url.pathname === "/v1/link-preview") {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, OPTIONS" });
    return linkPreview(request, ctx);
  }

  if (url.pathname === "/v1/article-source") {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, OPTIONS" });
    return articleSource(request);
  }

  const articleBodyMatch = /^\/v1\/article-bodies\/([a-f0-9]{64})$/.exec(url.pathname);
  if (articleBodyMatch !== null) {
    if (request.method === "GET" || request.method === "HEAD") return getArticleBody(request, env, articleBodyMatch[1]!);
    if (request.method === "PUT") {
      const result = await putArticleBody(request, env, articleBodyMatch[1]!);
      return json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, HEAD, PUT, OPTIONS" });
  }

  if (url.pathname === "/v1/books") {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, OPTIONS" });
    }
    return listBooks(request, env);
  }

  if (url.pathname === "/v1/uploads/prepare") {
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "POST, OPTIONS" });
    }
    return json(await prepareUpload(request, env), { headers: { "Cache-Control": "no-store" } });
  }

  const uploadPartMatch = /^\/v1\/uploads\/([a-f0-9]{64})\/parts\/([1-9][0-9]{0,3})$/.exec(url.pathname);
  if (uploadPartMatch !== null) {
    if (request.method !== "PUT") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "PUT, OPTIONS" });
    }
    const body = await uploadEpubPart(request, env, uploadPartMatch[1]!, Number(uploadPartMatch[2]));
    return json(body, { headers: { "Cache-Control": "no-store" } });
  }

  const uploadCompleteMatch = /^\/v1\/uploads\/([a-f0-9]{64})\/complete$/.exec(url.pathname);
  if (uploadCompleteMatch !== null) {
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "POST, OPTIONS" });
    }
    const result = await completeMultipartUpload(request, env, uploadCompleteMatch[1]!);
    return json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }

  const uploadMatch = /^\/v1\/uploads\/([a-f0-9]{64})$/.exec(url.pathname);
  if (uploadMatch !== null) {
    if (request.method !== "PUT") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "PUT, OPTIONS" });
    }
    const result = await uploadEpub(request, env, uploadMatch[1]!);
    return json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/v1/sync") {
    if (request.method === "GET") return json(await getSyncState(env), { headers: { "Cache-Control": "no-store" } });
    if (request.method === "POST") return json(await pushSync(request, env), { headers: { "Cache-Control": "no-store" } });
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, POST, OPTIONS" });
  }

  const match = /^\/v1\/books\/([^/]+)(?:\/(download|cover))?$/.exec(url.pathname);
  if (match !== null) {
    const id = decodeBookId(match[1]!);
    const action = match[2];
    const isDownload = action === "download";
    const isCover = action === "cover";
    const allowed = isDownload || isCover ? ["GET", "HEAD"] : ["GET"];
    if (!allowed.includes(request.method)) {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
        Allow: `${allowed.join(", ")}, OPTIONS`,
      });
    }
    const catalog = await loadCatalog(env);
    const book = findBook(catalog.books, id);
    if (isDownload) return downloadBook(request, env, book);
    if (action === "cover") return getCover(request, env, book);
    return json({ book: toPublicBook(book) });
  }

  throw new ApiError(404, "NOT_FOUND", "Route not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withCors(await route(request, env, ctx));
    } catch (error) {
      if (error instanceof ApiError) return withCors(errorResponse(error, request.method === "HEAD"));
      console.error("Unhandled request error", error instanceof Error ? error.message : "Unknown error");
      return withCors(errorResponse(new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred."), request.method === "HEAD"));
    }
  },
} satisfies ExportedHandler<Env>;
