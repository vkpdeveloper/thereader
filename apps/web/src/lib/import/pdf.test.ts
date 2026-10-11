import * as bunTest from 'bun:test';
import { convertPdf } from './pdf';
import { inspectFile, sourceKind } from './index';

const { test, afterEach } = bunTest;
// Match the existing import suite's full matcher declaration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (value: unknown) => any;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const pdf = () => new File(['%PDF-1.7\n'], 'reading.pdf', { type: 'application/pdf' });

test('PDF is recognized by bytes, converted at the captured origin and validated as EPUB', async () => {
  const bun = (globalThis as unknown as { Bun: { file(path: string): Blob } }).Bun;
  const sample = await bun.file(new URL('../../../../../apps/api/fixtures/generated/the-quiet-hour-v1.epub', import.meta.url).pathname).arrayBuffer();
  let called = '';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    called = String(url); expect(init?.body).toBeInstanceOf(File); expect(new Headers(init?.headers).get('Content-Type')).toBe('application/pdf');
    return new Response(sample, { headers: { 'Content-Type': 'application/epub+zip' } });
  }) as typeof fetch;
  const result = await inspectFile(pdf(), { origin: 'https://chosen-reader.example.org' });
  expect(called).toBe('https://chosen-reader.example.org/v1/pdf/extract');
  expect(result.converted).toBe(true); expect(result.title).toBe('The Quiet Hour'); expect(result.epub.type).toBe('application/epub+zip');
  expect(sourceKind(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
});

test('scan and encrypted PDF errors are actionable; wrong response types and network failures are refused', async () => {
  const failure = async (promise: Promise<unknown>) => { try { await promise; throw new Error('expected failure'); } catch (error) { return error; } };
  const scan = await failure(convertPdf(pdf(), 'https://reader.example.org', (async () => new Response(JSON.stringify({ error: { code: 'PDF_NEEDS_OCR', message: 'This scan needs OCR.' } }), { status: 422 })) as typeof fetch));
  expect(scan).toMatchObject({ code: 'PDF_NEEDS_OCR', message: 'This scan needs OCR.' });
  const bad = await failure(convertPdf(pdf(), 'https://reader.example.org', (async () => new Response('HTML', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch));
  expect(bad).toMatchObject({ code: 'BAD_RESPONSE' });
  const network = await failure(convertPdf(pdf(), 'https://reader.example.org', (async () => { throw new TypeError('failed'); }) as typeof fetch));
  expect(network).toMatchObject({ code: 'NETWORK', isNetwork: true });
});
