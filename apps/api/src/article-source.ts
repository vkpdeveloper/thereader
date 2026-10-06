import { ApiError } from "./errors";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

const UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Public http(s) pages on default ports only: no credentials, IP literals,
 * single-label or reserved hostnames, so the relay cannot reach private hosts.
 */
export function articleUrl(value: string): URL {
  const invalid = () => new ApiError(400, "INVALID_URL", "Invalid article URL.");
  if (!value || value.length > MAX_URL_LENGTH) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port ||
    !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|arpa|home|lan)$/.test(host)) {
    throw invalid();
  }
  url.hash = "";
  return url;
}

async function readCapped(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ApiError(413, "TOO_LARGE", "The page is larger than 8 MB.");
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw tooLarge();
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function upstreamFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ApiError(504, "UPSTREAM_TIMEOUT", "The page took too long to respond.");
  }
  return new ApiError(502, "UPSTREAM_UNREACHABLE", "Could not reach the page.");
}

/**
 * Byte relay for article HTML, which browsers cannot read cross-origin. No
 * parsing: the client decodes and extracts. Redirects are followed by hand so
 * every hop is re-validated. The body is served sandboxed so opening the
 * relay URL directly never runs the page's scripts on this origin.
 */
export async function articleSource(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  let target = articleUrl(new URL(request.url).searchParams.get("url") ?? "");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetcher(target.href, { redirect: "manual", signal, headers: UPSTREAM_HEADERS });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("Location");
        if (!location) throw new ApiError(502, "UPSTREAM_STATUS", "The page redirected nowhere.");
        target = articleUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApiError(502, "UPSTREAM_STATUS", `The page answered with HTTP ${response.status}.`);
      }
      const contentType = response.headers.get("Content-Type") ?? "";
      if (!/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "The link is not a web page.");
      }
      const body = await readCapped(response);
      return new Response(body, {
        headers: {
          "Content-Type": contentType,
          "X-Final-Url": target.href,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch (error) {
    throw upstreamFailure(error);
  }
  throw new ApiError(502, "TOO_MANY_REDIRECTS", "The page redirected too many times.");
}
