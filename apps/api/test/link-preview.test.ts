import { describe, expect, it, vi } from "vitest";
import { linkPreview, parseLinkMetadata } from "../src/link-preview";

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
      await expect(linkPreview(new Request(`https://reader.test/v1/link-preview?url=${encodeURIComponent(url)}`), fetcher)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a local URL and falls back to the original host", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://localhost/private" } })) as typeof fetch;
    const response = await linkPreview(new Request("https://reader.test/v1/link-preview?url=https%3A%2F%2Fexample.org%2Farticle"), fetcher);
    expect(await response.json()).toEqual({ url: "https://example.org/article", title: "example.org", description: "", faviconUrl: "" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
