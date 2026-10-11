import { ImportError } from './contract';

export const maxPdfBytes = 64 * 1024 * 1024;
const maxResultBytes = 128 * 1024 * 1024;

/** Convert on the configured backend; callers inspect and store the EPUB normally. */
export async function convertPdf(file: File, origin: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  if (file.size === 0 || file.size > maxPdfBytes) throw new ImportError('PDF imports are limited to 64 MiB.', 'TOO_LARGE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  try {
    const response = await fetcher(new URL('/v1/pdf/extract', origin).href, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Accept: 'application/epub+zip' },
      body: file, signal: controller.signal, redirect: 'error',
    });
    if (!response.body) throw new ImportError('The PDF service returned an empty response.', 'BAD_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > (response.ok ? maxResultBytes : 64 * 1024)) throw new ImportError('The converted PDF is too large.', 'TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const blob = new Blob(chunks as BlobPart[], { type: 'application/epub+zip' });
    if (!response.ok) {
      let error: { error?: { code?: unknown; message?: unknown } } = {};
      try { error = JSON.parse(await blob.text()); } catch { /* Use a bounded fallback. */ }
      throw new ImportError(typeof error.error?.message === 'string' ? error.error.message : 'PDF conversion failed. Try again shortly.', typeof error.error?.code === 'string' ? error.error.code : 'PDF_FAILED');
    }
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/epub+zip') throw new ImportError('The PDF service returned an invalid reading edition.', 'BAD_RESPONSE');
    return blob;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (controller.signal.aborted) throw new ImportError('PDF conversion timed out. Try a smaller document.', 'TIMEOUT', true);
    throw new ImportError('PDF imports need a connection to your reading server. Check your connection and try again.', 'NETWORK', true);
  } finally { clearTimeout(timer); }
}
