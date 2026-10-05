import { ApiError } from "./errors";
import type { Env } from "./types";

export const CDN_PREFIX = "/cdn/";
const KEY = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves `/cdn/<key>` from the CDN bucket. Keys are versioned and never
 * overwritten, so responses are immutable for browsers and kept in the
 * Cloudflare edge cache of each data centre after the first R2 read.
 */
export async function serveCdn(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: "GET, HEAD, OPTIONS" });
  }
  const url = new URL(request.url);
  const key = url.pathname.slice(CDN_PREFIX.length);
  if (key.length > 512 || !KEY.test(key)) throw new ApiError(404, "NOT_FOUND", "Asset not found.");

  const cache = await caches.open("cdn");
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  let response = await cache.match(cacheKey);
  if (response === undefined) {
    const object = await env.CDN.get(key);
    if (object === null) throw new ApiError(404, "NOT_FOUND", "Asset not found.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", IMMUTABLE);
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    response = new Response(object.body, { headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  const etag = response.headers.get("ETag");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null && ifNoneMatch.split(",").some((value) => value.trim() === "*" || value.trim() === etag)) {
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers: response.headers });
  return response;
}
