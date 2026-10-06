import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { linkPreview, parseLinkMetadata } from "../src/link-preview";

const preview = (url: string) => new Request(`https://reader.test/v1/link-preview?url=${encodeURIComponent(url)}`);

describe("link previews", () => {
  it("reads Open Graph metadata even when attribute order varies", () => {
    const html = `<head><title>Fallback title</title>
      <meta content="A &amp; B" property="og:title">
      <meta name='description' content='A short description'>
      <link href="/icon.png" rel="shortcut icon"></head>`;
    expect(parseLinkMetadata(html, new URL("https://example.org/article"))).toEqual({
      title: "A & B",
      description: "A short description",
      faviconUrl: "https://example.org/icon.png",
    });
  });

  it("rejects unsafe URLs before making a request", async () => {
    const fetcher = vi.fn();
    for (const url of ["http://example.org", "https://localhost/admin", "https://127.0.0.1/", "https://user:pass@example.org/"]) {
      await expect(linkPreview(preview(url), createExecutionContext(), fetcher)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a local URL and falls back to the original host", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://localhost/private" } })) as typeof fetch;
    const response = await linkPreview(preview("https://example.org/article"), createExecutionContext(), fetcher);
    expect(await response.json()).toEqual({ url: "https://example.org/article", title: "example.org", description: "", faviconUrl: "" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat preview from the edge cache without fetching the page again", async () => {
    const fetcher = vi.fn(async () => new Response(
      `<head><title>Cached page</title><meta name="description" content="Read once"></head>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    )) as typeof fetch;
    const ctx = createExecutionContext();
    const first = await linkPreview(preview("https://example.org/cached#section"), ctx, fetcher);
    await waitOnExecutionContext(ctx);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const again = await linkPreview(preview("https://example.org/cached"), createExecutionContext(), fetcher);
    expect(await again.json()).toEqual({ url: "https://example.org/cached", title: "Cached page", description: "Read once", faviconUrl: "https://example.org/favicon.ico" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
