import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { mediaRelay } from "../src/media";
import type { Env } from "../src/types";

const relay = (url: string, headers: Record<string, string> = {}) =>
  new Request(`https://reader.test/v1/media?url=${encodeURIComponent(url)}`, { headers });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const file = (bytes: Uint8Array<ArrayBuffer>, type: string, extra: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength), ...extra } });
let n = 0;
/** A fresh URL per case: the edge cache outlives a test. */
const unique = (path: string) => `https://media.example.org/${++n}/${path}`;

async function run(request: Request, fetcher: (url: string, init?: RequestInit) => Promise<Response>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await mediaRelay(request, ctx, fetcher as unknown as typeof fetch);
  const body = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: response.status, headers: response.headers });
}

describe("media relay", () => {
  it("rejects unsafe URLs, and this API itself, before making a request", async () => {
    const fetcher = vi.fn();
    for (const url of ["", "data:image/png;base64,AAAA", "https://localhost/a.png", "https://127.0.0.1/a.png", "http://[::1]/a.png",
      "https://user:pass@example.org/a.png", "https://example.org:8443/a.png", "https://printer.local/a.png", "https://reader.test/v1/media?url=x"]) {
      await expect(mediaRelay(relay(url), createExecutionContext(), fetcher)).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("relays an image with sandboxing, long caching and browser-like headers", async () => {
    const fetcher = vi.fn(async () => file(png, "image/png", { "Cross-Origin-Resource-Policy": "same-origin", "Set-Cookie": "a=b" }));
    const url = unique("still.png");
    const response = await run(relay(url), fetcher);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(png.byteLength));
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=2592000");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const [target, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(target).toBe(url);
    expect(init.redirect).toBe("manual");
    expect(headers["User-Agent"]).toContain("Chrome/");
    expect(headers.Referer).toBe("https://media.example.org/");
    expect(headers.Range).toBeUndefined();
  });

  it("serves a repeat view from the edge cache, ranges included", async () => {
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const fetcher = vi.fn(async () => file(bytes, "video/mp4"));
    const url = unique("clip.mp4");
    expect((await run(relay(url), fetcher)).status).toBe(200);
    const again = await run(relay(url), fetcher);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    const seek = await run(relay(url, { Range: "bytes=100-199" }), fetcher);
    expect(seek.status).toBe(206);
    expect(seek.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(new Uint8Array(await seek.arrayBuffer())).toEqual(bytes.slice(100, 200));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("answers a video's opening range with the whole file, and forwards a seek", async () => {
    const bytes = new Uint8Array(500).fill(7);
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>).Range;
      if (range === undefined) return file(bytes, "video/mp4");
      return new Response(bytes.slice(300), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": "200", "Content-Range": "bytes 300-499/500" } });
    });
    const opening = await run(relay(unique("a.mp4"), { Range: "bytes=0-" }), fetcher);
    expect(opening.status).toBe(206);
    expect(opening.headers.get("Content-Range")).toBe("bytes 0-499/500");
    expect(opening.headers.get("Content-Length")).toBe("500");
    expect((await opening.arrayBuffer()).byteLength).toBe(500);
    const seek = await run(relay(unique("b.mp4"), { Range: "bytes=300-" }), fetcher);
    expect(seek.status).toBe(206);
    expect(seek.headers.get("Content-Range")).toBe("bytes 300-499/500");
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).Range).toBe("bytes=300-");
  });

  it("follows redirects, re-validating every hop", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/short.png")) return new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/long.png" } });
      return file(png, "image/png");
    });
    const response = await run(relay(unique("short.png")), fetcher);
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).Referer).toBe("https://cdn.example.net/");
    const toPrivate = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/a.png" } }));
    await expect(mediaRelay(relay(unique("x.png")), createExecutionContext(), toPrivate as unknown as typeof fetch)).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    let hops = 0;
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { Location: `https://media.example.org/hop/${++hops}` } }));
    await expect(mediaRelay(relay(unique("loop.png")), createExecutionContext(), loop as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "TOO_MANY_REDIRECTS" });
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it("refuses anything that is not image, video or audio", async () => {
    for (const type of ["text/html", "application/javascript", "application/octet-stream", "image", ""]) {
      const fetcher = vi.fn(async () => new Response("x", { headers: type ? { "Content-Type": type } : {} }));
      await expect(mediaRelay(relay(unique("f")), createExecutionContext(), fetcher as unknown as typeof fetch)).rejects.toMatchObject({ status: 415 });
    }
    for (const type of ["image/svg+xml", "audio/mpeg", "video/webm; codecs=vp9"]) {
      expect((await run(relay(unique("ok")), async () => file(png, type))).status).toBe(200);
    }
  });

  it("caps images at 20 MB, declared or streamed", async () => {
    const declared = vi.fn(async () => new Response("x", { headers: { "Content-Type": "image/jpeg", "Content-Length": String(21 * 1024 * 1024) } }));
    await expect(mediaRelay(relay(unique("big.jpg")), createExecutionContext(), declared as unknown as typeof fetch)).rejects.toMatchObject({ status: 413, code: "TOO_LARGE" });
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 21) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "image/jpeg" } }));
    const response = await mediaRelay(relay(unique("big.jpg")), createExecutionContext(), streamed as unknown as typeof fetch);
    await expect(response.arrayBuffer()).rejects.toBeDefined();
  });

  it("maps upstream failures to API errors", async () => {
    const missing = vi.fn(async () => new Response("gone", { status: 404, headers: { "Content-Type": "image/png" } }));
    await expect(mediaRelay(relay(unique("gone.png")), createExecutionContext(), missing as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_STATUS" });
    const offline = vi.fn(async () => {
      throw new TypeError("Network connection lost.");
    });
    await expect(mediaRelay(relay(unique("a.png")), createExecutionContext(), offline as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
    const unsatisfiable = vi.fn(async () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */10" } }));
    await expect(mediaRelay(relay(unique("a.mp4"), { Range: "bytes=50-" }), createExecutionContext(), unsatisfiable as unknown as typeof fetch))
      .rejects.toMatchObject({ status: 416, code: "RANGE_NOT_SATISFIABLE" });
  });

  it("is routed with CORS, GET only", async () => {
    const ctx = createExecutionContext();
    const bad = await worker.fetch(relay("https://localhost/a.png"), env as Env, ctx);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await bad.json()).toEqual({ error: { code: "INVALID_URL", message: "Invalid media URL." } });
    const post = await worker.fetch(new Request("https://reader.test/v1/media?url=https%3A%2F%2Fexample.org%2Fa.png", { method: "POST" }), env as Env, ctx);
    expect(post.status).toBe(405);
    await waitOnExecutionContext(ctx);
  });
});
