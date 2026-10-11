import { describe, expect, it, vi } from 'vitest';
import { extractPdf, MAX_PDF_BYTES } from '../src/pdf';

const config = { PDF_EXTRACTOR_URL: 'https://pdf.example.org', PDF_EXTRACTOR_TOKEN: 'test-only-token' };
const request = (headers?: Record<string, string>) => new Request('https://reader.example.org/v1/pdf/extract', {
  method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body: '%PDF-1.7\n',
});

describe('PDF conversion relay', () => {
  it('uses only the configured service and streams a bounded EPUB back', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://pdf.example.org/v1/pdf/extract?format=epub');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-only-token');
      expect(init?.redirect).toBe('manual');
      expect(await new Response(init?.body).text()).toBe('%PDF-1.7\n');
      return new Response('PK-epub', { headers: { 'Content-Type': 'application/epub+zip', 'X-PDF-Pages': '12', 'X-PDF-Warnings': '1' } });
    });
    const response = await extractPdf(request(), config, fetcher as unknown as typeof fetch);
    expect(await response.text()).toBe('PK-epub');
    expect(response.headers.get('X-PDF-Pages')).toBe('12');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects unavailable configuration, bad media and oversized declared uploads before fetching', async () => {
    const fetcher = vi.fn();
    await expect(extractPdf(request(), {}, fetcher)).rejects.toMatchObject({ status: 503, code: 'PDF_UNAVAILABLE' });
    await expect(extractPdf(request(), { PDF_EXTRACTOR_URL: 'file:///tmp/pdf' }, fetcher)).rejects.toMatchObject({ status: 503 });
    await expect(extractPdf(request({ 'Content-Type': 'text/html' }), config, fetcher)).rejects.toMatchObject({ status: 415 });
    await expect(extractPdf(request({ 'Content-Length': String(MAX_PDF_BYTES + 1) }), config, fetcher)).rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps useful conversion errors and refuses redirects and service auth failures', async () => {
    const message = JSON.stringify({ error: { code: 'PDF_NEEDS_OCR', message: 'This scan has no text layer.' } });
    const response = await extractPdf(request(), config, vi.fn(async () => new Response(message, { status: 422, headers: { 'Content-Type': 'application/json' } })));
    expect(response.status).toBe(422);
    expect(await response.text()).toBe(message);
    for (const status of [302, 401, 500]) {
      await expect(extractPdf(request(), config, vi.fn(async () => new Response('bad', { status })))).rejects.toMatchObject({ code: 'PDF_SERVICE_ERROR' });
    }
  });
});
