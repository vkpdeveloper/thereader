import { ApiError } from './errors';
import type { Env } from './types';

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024 * 1024;

/** The Worker only relays to the operator-configured Go service. It never parses PDF. */
export async function extractPdf(request: Request, env: Pick<Env, 'PDF_EXTRACTOR_URL' | 'PDF_EXTRACTOR_TOKEN'>, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!env.PDF_EXTRACTOR_URL) throw new ApiError(503, 'PDF_UNAVAILABLE', 'PDF importing is not configured on this server yet.');
  let service: URL;
  try {
    service = new URL('/v1/pdf/extract?format=epub', env.PDF_EXTRACTOR_URL);
    if (service.username || service.password || (service.protocol !== 'https:' && !(service.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(service.hostname)))) throw new Error();
  } catch {
    throw new ApiError(503, 'PDF_UNAVAILABLE', 'The PDF service configuration is invalid.');
  }
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') {
    throw new ApiError(415, 'INVALID_MEDIA_TYPE', 'Send a PDF file.');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new ApiError(400, 'INVALID_CONTENT_LENGTH', 'The upload length is invalid.');
  if (length !== null && Number(length) > MAX_PDF_BYTES) throw new ApiError(413, 'TOO_LARGE', 'PDF imports are limited to 64 MiB.');
  if (!request.body) throw new ApiError(400, 'INVALID_PDF', 'Choose a PDF file.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let tooLarge = false;
  let bytes = 0;
  const input = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, writer) {
      bytes += chunk.byteLength;
      if (bytes > MAX_PDF_BYTES) { tooLarge = true; controller.abort(); throw new Error('PDF too large'); }
      writer.enqueue(chunk);
    },
  }));
  try {
    const headers = new Headers({ 'Content-Type': 'application/pdf', Accept: 'application/epub+zip' });
    if (env.PDF_EXTRACTOR_TOKEN) headers.set('Authorization', `Bearer ${env.PDF_EXTRACTOR_TOKEN}`);
    const upstream = await fetcher(service.href, { method: 'POST', headers, body: input, signal: controller.signal, redirect: 'manual' });
    const allowed = [200, 400, 413, 415, 422, 429, 504];
    const type = upstream.headers.get('Content-Type')?.split(';')[0]?.trim();
    if (!allowed.includes(upstream.status) || (upstream.ok ? type !== 'application/epub+zip' : type !== 'application/json')) {
      await upstream.body?.cancel();
      throw new ApiError(502, 'PDF_SERVICE_ERROR', 'The PDF service returned an invalid response.');
    }
    if (!upstream.body) throw new ApiError(502, 'PDF_SERVICE_ERROR', 'The PDF service returned an empty response.');
    const resultHeaders = new Headers({ 'Content-Type': upstream.headers.get('Content-Type')!, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['X-PDF-Pages', 'X-PDF-Warnings', 'Server-Timing', 'Retry-After']) {
      const value = upstream.headers.get(name); if (value !== null) resultHeaders.set(name, value);
    }
    const reader = upstream.body.getReader();
    let resultBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(writer) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearTimeout(timeout); writer.close(); return; }
          resultBytes += value.byteLength;
          if (resultBytes > (upstream.ok ? MAX_RESULT_BYTES : 64 * 1024)) throw new Error('PDF response exceeds the size limit');
          writer.enqueue(value);
        } catch (error) {
          clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => undefined); writer.error(error);
        }
      },
      async cancel(reason) { clearTimeout(timeout); controller.abort(); await reader.cancel(reason); },
    });
    return new Response(body, { status: upstream.status, headers: resultHeaders });
  } catch (error) {
    clearTimeout(timeout);
    if (tooLarge) throw new ApiError(413, 'TOO_LARGE', 'PDF imports are limited to 64 MiB.');
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, 'PDF_TIMEOUT', 'PDF conversion timed out. Try a smaller document.');
    throw new ApiError(502, 'PDF_UNAVAILABLE', 'Could not connect to the PDF service. Try again shortly.');
  }
}
