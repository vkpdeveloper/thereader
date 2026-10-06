import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { articleSource, articleUrl } from "../src/article-source";
import worker from "../src/index";
import type { Env } from "../src/types";

const relay = (url: string) => new Request(`https://reader.test/v1/article-source?url=${encodeURIComponent(url)}`);
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=windows-1252", ...headers } });

describe("article source relay", () => {
  it("accepts public http and https pages and drops the fragment", () => {
    expect(articleUrl("http://example.org/a?b=1#c").href).toBe("http://example.org/a?b=1");
    expect(articleUrl("https://blog.example.co.uk/post").href).toBe("https://blog.example.co.uk/post");
    expect(articleUrl("https://example.org:443/x").href).toBe("https://example.org/x");
  });

  it("rejects unsafe URLs before making a request", async () => {
    const fetcher = vi.fn();
    for (const url of [
      "",
      "ftp://example.org/file",
      "file:///etc/passwd",
      "https://localhost/admin",
      "http://localhost./admin",
      "https://127.0.0.1/",
      "http://2130706433/",
      "http://[::1]/",
      "https://user:pass@example.org/",
      "https://example.org:8443/",
      "http://example.org:8080/",
      "https://intranet/",
      "https://printer.local/",
      "https://metadata.internal/",
      `https://example.org/${"a".repeat(2100)}`,
    ]) {
      await expect(articleSource(relay(url), fetcher)).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("relays the raw bytes with the upstream type, final URL and browser-like headers", async () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes, { headers: { "Content-Type": "text/html; charset=windows-1252" } }));
    const response = await articleSource(relay("https://example.org/story"), fetcher as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=windows-1252");
    expect(response.headers.get("X-Final-Url")).toBe("https://example.org/story");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const init = fetcher.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe("manual");
    expect(headers["User-Agent"]).toContain("Chrome/129.0.0.0");
    expect(headers.Accept).toBe("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("follows redirects, re-validating every hop", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "http://example.org/short") return new Response(null, { status: 301, headers: { Location: "https://example.org/long" } });
      if (url === "https://example.org/long") return new Response(null, { status: 302, headers: { Location: "/final?x=1" } });
      return html("<p>ok</p>", { "Content-Type": "application/xhtml+xml" });
    });
    const response = await articleSource(relay("http://example.org/short"), fetcher as unknown as typeof fetch);
    expect(response.headers.get("X-Final-Url")).toBe("https://example.org/final?x=1");
    expect(await response.text()).toBe("<p>ok</p>");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("blocks a redirect to a private host", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } }));
    await expect(articleSource(relay("https://example.org/a"), fetcher as unknown as typeof fetch)).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops after five redirects", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: `https://example.org/${++n}` } }));
    await expect(articleSource(relay("https://example.org/0"), fetcher as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "TOO_MANY_REDIRECTS" });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("refuses anything that is not HTML", async () => {
    for (const type of ["application/pdf", "image/png", "application/json", "text/plain", ""]) {
      const fetcher = vi.fn(async () => new Response("x", { headers: type ? { "Content-Type": type } : {} }));
      await expect(articleSource(relay("https://example.org/file"), fetcher as unknown as typeof fetch)).rejects.toMatchObject({ status: 415 });
    }
  });

  it("maps upstream failures to API errors", async () => {
    const notFound = vi.fn(async () => new Response("gone", { status: 404, headers: { "Content-Type": "text/html" } }));
    await expect(articleSource(relay("https://example.org/missing"), notFound as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_STATUS" });
    const offline = vi.fn(async () => {
      throw new TypeError("Network connection lost.");
    });
    await expect(articleSource(relay("https://example.org/a"), offline as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
    const slow = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(articleSource(relay("https://example.org/a"), slow as unknown as typeof fetch)).rejects.toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
  });

  it("caps the body at 8 MB, declared or streamed", async () => {
    const declared = vi.fn(async () => html("x", { "Content-Length": String(9 * 1024 * 1024) }));
    await expect(articleSource(relay("https://example.org/big"), declared as unknown as typeof fetch)).rejects.toMatchObject({ status: 413 });
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 9) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "text/html" } }));
    await expect(articleSource(relay("https://example.org/big"), streamed as unknown as typeof fetch)).rejects.toMatchObject({ status: 413, code: "TOO_LARGE" });
  });

  it("is routed with CORS exposing the final URL, GET only", async () => {
    const ctx = createExecutionContext();
    const bad = await worker.fetch(relay("https://localhost/"), env as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Access-Control-Expose-Headers")).toContain("X-Final-Url");
    expect(await bad.json()).toEqual({ error: { code: "INVALID_URL", message: "Invalid article URL." } });
    const post = await worker.fetch(new Request("https://reader.test/v1/article-source?url=https%3A%2F%2Fexample.org", { method: "POST" }), env as Env, ctx);
    expect(post.status).toBe(405);
  });
});
