import { test, expect as bunExpect, afterEach } from 'bun:test';
import { extract, epub, PdfError } from '@thereader/pdf-extractor';
import { convertPdf } from './pdf';
import { inspectFile, sourceKind } from './index';

const expect = bunExpect as unknown as (value: unknown) => any;
const originalWorker = globalThis.Worker;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.Worker = originalWorker; globalThis.fetch = originalFetch; });

// Exercises the import contract with the real engine; browser tests exercise
// the actual worker boundary, transferred buffers and UI responsiveness.
class TestWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminated = false;
  postMessage(data: { id: number; bytes: ArrayBuffer }) {
    queueMicrotask(() => {
      try {
        const doc = extract(new Uint8Array(data.bytes));
        this.onmessage?.({ data: { id: data.id, result: epub(doc), stats: doc.stats, complete: doc.complete, warnings: doc.warnings } });
      } catch (error) {
        this.onmessage?.({ data: { id: data.id, error: { code: error instanceof PdfError ? error.code : 'EXTRACTION_FAILED', message: String(error) } } });
      }
    });
  }
  terminate() { this.terminated = true; }
}
const workerFactory = () => new TestWorker() as unknown as Worker;

test('PDF import produces a validated reading edition without an extraction network request', async () => {
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  globalThis.fetch = (async () => { throw new Error('PDF extraction must not use the network'); }) as typeof fetch;
  const input = await (globalThis as unknown as { Bun: { file(path: string): Blob } }).Bun.file(new URL('../../../../../eval/pdf/native/fixtures/cc720d5a85e5f3edd331f47999cf24120e88a65b7e71b59eab409cf4d048da53.pdf', import.meta.url).pathname).arrayBuffer();
  const result = await inspectFile(new File([input], 'reading.pdf'));
  expect(result.converted).toBe(true);
  expect(result.epub.type).toBe('application/epub+zip');
  expect(result.title.length).toBeGreaterThan(0);
  expect(sourceKind(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
});

test('invalid PDF and cancellation errors survive the worker boundary', async () => {
  const file = new File(['%PDF-1.7\n'], 'bad.pdf');
  await expect(convertPdf(file, { workerFactory })).rejects.toMatchObject({ code: 'INVALID_PDF' });
  const controller = new AbortController(); controller.abort();
  await expect(convertPdf(file, { workerFactory, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
});

test('empty input is rejected before a worker is created', async () => {
  let created = false;
  await expect(convertPdf(new File([], 'empty.pdf'), { workerFactory: () => { created = true; return workerFactory(); } })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(created).toBe(false);
});
