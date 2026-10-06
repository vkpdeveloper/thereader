import { articleUrl } from "./article-source";
import { ApiError } from "./errors";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Larger files stream through but are not kept in the edge cache. */
const MAX_CACHED_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Until the upstream answers; a playing video then streams for as long as it needs. */
const TIMEOUT_MS = 15_000;
const CACHE_CONTROL = "public, max-age=2592000";
const MEDIA_TYPE = /^\s*(image|video|audio)\/[\w.+-]+\s*(?:;|$)/i;

const UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,video/*,audio/*;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Public http(s) files only, by the same rules as article pages, and never this API itself. */
function mediaUrl(value: string, self: string): URL {
  let url: URL;
  try {
    url = articleUrl(value);
  } catch {
    throw new ApiError(400, "INVALID_URL", "Invalid media URL.");
  }
  if (url.hostname.toLowerCase().replace(/\.$/, "") === self) throw new ApiError(400, "INVALID_URL", "Invalid media URL.");
  return url;
}

/** `bytes=0-`, the open range browsers start a video with, which a whole file answers. */
function fromStart(range: string | null): boolean {
  return range === null || /^bytes=0-$/.test(range.trim());
}

/** Errors the stream once more than `max` bytes went through. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > max) controller.error(new ApiError(413, "TOO_LARGE", "The image is larger than 20 MB."));
      else controller.enqueue(chunk);
    },
  }));
}

function upstreamFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ApiError(504, "UPSTREAM_TIMEOUT", "The file took too long to respond.");
  }
  return new ApiError(502, "UPSTREAM_UNREACHABLE", "Could not reach the file.");
}

/** Fetches `target`, following redirects by hand so every hop is re-validated. */
async function fetchUpstream(target: URL, range: string | null, self: string, fetcher: typeof fetch): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("The file took too long to respond.", "TimeoutError")), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Hotlink protection usually accepts the file's own site as the referrer.
      const headers: Record<string, string> = { ...UPSTREAM_HEADERS, Referer: `${target.origin}/` };
      if (range !== null) headers.Range = range;
      const response = await fetcher(target.href, { redirect: "manual", signal: abort.signal, headers });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("Location");
        if (!location) throw new ApiError(502, "UPSTREAM_STATUS", "The file redirected nowhere.");
        target = mediaUrl(new URL(location, target).href, self);
        continue;
      }
      return response;
    }
  } catch (error) {
    throw upstreamFailure(error);
  } finally {
    clearTimeout(timer);
  }
  throw new ApiError(502, "TOO_MANY_REDIRECTS", "The file redirected too many times.");
}

/**
 * Relay for article images, video and audio whose hosts refuse to be embedded
 * on another site (`Cross-Origin-Resource-Policy: same-origin`, hotlink
 * checks). The web reader only asks for it once a direct load failed. Only
 * image, video and audio responses pass; bodies stream, `Range` works so
 * videos can seek, and whole files are kept in the edge cache so a repeat
 * view costs no upstream fetch. Served sandboxed so an SVG opened directly
 * never runs script on this origin.
 */
export async function mediaRelay(request: Request, ctx: ExecutionContext, fetcher: typeof fetch = fetch): Promise<Response> {
  const self = new URL(request.url);
  const target = mediaUrl(self.searchParams.get("url") ?? "", self.hostname.toLowerCase());
  const range = request.headers.get("Range");

  const cache = await caches.open("media");
  const cacheKey = new Request(`${self.origin}/v1/media?url=${encodeURIComponent(target.href)}`);
  // The cache answers a range itself (206) from the whole file it holds.
  const cached = await cache.match(range === null ? cacheKey : new Request(cacheKey, { headers: { Range: range } }));
  if (cached !== undefined) return cached;

  // A request from the start fetches the whole file, which can be cached; a seek forwards its range.
  const whole = fromStart(range);
  const response = await fetchUpstream(target, whole ? null : range, self.hostname.toLowerCase(), fetcher);
  if (response.status === 416) {
    await response.body?.cancel().catch(() => undefined);
    const total = response.headers.get("Content-Range");
    throw new ApiError(416, "RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable.", total ? { "Content-Range": total } : undefined);
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "UPSTREAM_STATUS", `The file answered with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  const kind = MEDIA_TYPE.exec(contentType)?.[1]?.toLowerCase();
  if (kind === undefined) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "The link is not an image, video or audio file.");
  }
  const declared = Number(response.headers.get("Content-Length") ?? NaN);
  const length = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
  if (kind === "image" && length !== null && length > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "TOO_LARGE", "The image is larger than 20 MB.");
  }

  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": CACHE_CONTROL,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (length !== null) headers.set("Content-Length", String(length));
  // A declared length bounds the body already (and a stream piped through a cap would lose it).
  const body = response.body && kind === "image" && length === null ? capped(response.body, MAX_IMAGE_BYTES) : response.body;

  if (response.status === 206) {
    const contentRange = response.headers.get("Content-Range");
    if (contentRange !== null) headers.set("Content-Range", contentRange);
    return new Response(body, { status: 206, headers });
  }
  const full = new Response(body, { status: 200, headers });
  if (length !== null && length <= MAX_CACHED_BYTES) ctx.waitUntil(cache.put(cacheKey, full.clone()).catch(() => undefined));
  // A forwarded range the upstream ignored gets the whole file, which a 200 says.
  if (range === null || !whole || length === null || length === 0) return full;
  // `bytes=0-` answered with the whole file, as the range it asked for.
  const partial = new Headers(headers);
  partial.set("Content-Range", `bytes 0-${length - 1}/${length}`);
  return new Response(full.body, { status: 206, headers: partial });
}
