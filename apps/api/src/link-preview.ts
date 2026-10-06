import { ApiError } from "./errors";
import { UPSTREAM_HEADERS } from "./article-source";

const MAX_HTML_BYTES = 128 * 1024;
const MAX_URL_LENGTH = 2048;
/** A page's title, description and icon rarely change; an unreachable page is retried sooner. */
const PREVIEW_CACHE = "public, max-age=86400";
const FALLBACK_CACHE = "public, max-age=300";

function safeUrl(value: string): URL {
  if (!value || value.length > MAX_URL_LENGTH) throw new ApiError(400, "INVALID_URL", "Invalid preview URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "INVALID_URL", "Invalid preview URL.");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host)) {
    throw new ApiError(400, "INVALID_URL", "Invalid preview URL.");
  }
  url.hash = "";
  return url;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#")) {
      const code = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[key] ?? "";
  });
}

function clean(value: string, limit: number): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, limit);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

export function parseLinkMetadata(html: string, pageUrl: URL): { title: string; description: string; faviconUrl: string } {
  const head = html.split(/<\/head\s*>/i, 1)[0] ?? html;
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const key = (a.property ?? a.name)?.toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, a.content);
  }
  const title = clean(meta.get("og:title") ?? head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? pageUrl.hostname, 160);
  const description = clean(meta.get("og:description") ?? meta.get("description") ?? "", 320);
  const iconTag = (head.match(/<link\b[^>]*>/gi) ?? []).map(attrs).find((a) => /(?:^|\s)(?:icon|shortcut icon)(?:\s|$)/i.test(a.rel ?? "") && a.href);
  let faviconUrl = "";
  try {
    const icon = new URL(iconTag?.href ?? "/favicon.ico", pageUrl);
    if (icon.protocol === "https:") faviconUrl = icon.href;
  } catch { /* A publisher icon is optional. */ }
  return { title: title || pageUrl.hostname, description, faviconUrl };
}

async function readHead(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = MAX_HTML_BYTES - bytes;
      const data = chunk.value.subarray(0, remaining);
      bytes += data.byteLength;
      html += decoder.decode(data, { stream: true });
      if (/<\/head\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

/**
 * Title, description and icon of a public https page, read from its head.
 * Redirects are followed by hand so every hop is re-validated. Results are
 * kept in the edge cache of each data centre, so a link previewed again (by
 * any reader) does not fetch the page again.
 */
export async function linkPreview(request: Request, ctx: ExecutionContext, fetcher: typeof fetch = fetch): Promise<Response> {
  const requested = safeUrl(new URL(request.url).searchParams.get("url") ?? "");
  const cache = await caches.open("link-preview");
  const cacheKey = new Request(`${new URL(request.url).origin}/v1/link-preview?url=${encodeURIComponent(requested.href)}`);
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;
  const response = await fetchPreview(requested, fetcher);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function fetchPreview(requested: URL, fetcher: typeof fetch): Promise<Response> {
  let target = requested;
  const fallback = () => ({ url: target.href, title: target.hostname, description: "", faviconUrl: "" });
  try {
    for (let redirect = 0; redirect < 3; redirect++) {
      const response = await fetcher(target.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(6000),
        headers: { ...UPSTREAM_HEADERS, Accept: "text/html,application/xhtml+xml" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        if (!location) break;
        target = safeUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("Content-Type") ?? "")) break;
      const metadata = parseLinkMetadata(await readHead(response), target);
      return Response.json({ url: target.href, ...metadata }, { headers: { "Cache-Control": PREVIEW_CACHE } });
    }
  } catch { /* Unavailable pages still show a domain preview. */ }
  return Response.json(fallback(), { headers: { "Cache-Control": FALLBACK_CACHE } });
}
