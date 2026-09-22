import { loadCatalog, toPublicBook, validateBookId } from "./catalog";
import { downloadBook } from "./download";
import { ApiError, errorResponse } from "./errors";
import { encodeCursor, parseListQuery } from "./query";
import type { CatalogBook, Env } from "./types";

const METHODS = "GET, HEAD, OPTIONS";

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type, Range, If-None-Match, If-Range",
    "Access-Control-Allow-Methods": METHODS,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag, Last-Modified",
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

async function getCover(env: Env, book: CatalogBook): Promise<Response> {
  if (book.cover === null) throw new ApiError(404, "NOT_FOUND", "Book cover not found.");
  const object = await env.BOOKS.get(book.cover.objectKey);
  if (object === null || object.size !== book.cover.fileSize) {
    throw new ApiError(404, "NOT_FOUND", "Book cover not found.");
  }
  return new Response(object.body, {
    headers: {
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Length": String(object.size),
      "Content-Type": book.cover.contentType,
      ETag: object.httpEtag,
    },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, HEAD, OPTIONS" });
    }
    const response = json({ status: "ok", service: "thereader-api" });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }

  if (url.pathname === "/v1/books") {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, OPTIONS" });
    }
    return listBooks(request, env);
  }

  const match = /^\/v1\/books\/([^/]+)(?:\/(download|cover))?$/.exec(url.pathname);
  if (match !== null) {
    const id = decodeBookId(match[1]!);
    const action = match[2];
    const isDownload = action === "download";
    const allowed = isDownload ? ["GET", "HEAD"] : ["GET"];
    if (!allowed.includes(request.method)) {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
        Allow: `${allowed.join(", ")}, OPTIONS`,
      });
    }
    const catalog = await loadCatalog(env);
    const book = findBook(catalog.books, id);
    if (isDownload) return downloadBook(request, env, book);
    if (action === "cover") return getCover(env, book);
    return json({ book: toPublicBook(book) });
  }

  throw new ApiError(404, "NOT_FOUND", "Route not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await route(request, env));
    } catch (error) {
      if (error instanceof ApiError) return withCors(errorResponse(error, request.method === "HEAD"));
      console.error("Unhandled request error", error instanceof Error ? error.message : "Unknown error");
      return withCors(errorResponse(new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred."), request.method === "HEAD"));
    }
  },
} satisfies ExportedHandler<Env>;
