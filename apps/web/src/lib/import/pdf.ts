import { extractInWorker } from '@thereader/pdf-extractor/browser';
import { PdfError } from '@thereader/pdf-extractor';
import { ImportError } from './contract';

export const maxPdfBytes = 64 * 1024 * 1024;
const maxResultBytes = 128 * 1024 * 1024;

/** Convert locally; PDF bytes are never sent to an extraction service. */
export async function convertPdf(file: File, options: { signal?: AbortSignal; workerFactory?: () => Worker } = {}): Promise<Blob> {
  if (file.size === 0 || file.size > maxPdfBytes) throw new ImportError('PDF imports are limited to 64 MiB.', 'TOO_LARGE');
  try {
    const { result } = await extractInWorker(new Uint8Array(await file.arrayBuffer()), 'epub', {
      workerFactory: options.workerFactory ?? (() => new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })),
      signal: options.signal,
      timeoutMs: 65_000,
    });
    if (result.byteLength > maxResultBytes) throw new ImportError('The converted PDF is too large.', 'TOO_LARGE');
    return new Blob([result as BlobPart], { type: 'application/epub+zip' });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error instanceof PdfError) {
      if (error.code === 'TIMEOUT' || error.code === 'ABORTED') throw new ImportError('PDF conversion was cancelled or took too long. Try a smaller document.', error.code);
      if (error.code === 'RESOURCE_LIMIT') throw new ImportError('This PDF exceeds the browser extraction limits. Try a smaller document.', error.code);
      if (error.code === 'WORKER_FAILED') throw new ImportError('The PDF worker could not start. Reload the reader and try again.', error.code);
      throw new ImportError(error.message, error.code);
    }
    throw new ImportError('PDF conversion failed in this browser.', 'PDF_FAILED');
  }
}
