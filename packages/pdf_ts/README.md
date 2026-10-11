# PDF Extractor · TypeScript

Independent in-memory PDF → structured blocks → Markdown/EPUB. The parser,
font readers, content interpreter and layout reconstruction are TypeScript.
There is no PDF.js, extraction service, Go binary or WebAssembly dependency.
Generic compression, JPEG and XML codecs are the only runtime dependencies.

```ts
import { extract, epub } from '@thereader/pdf-extractor';
const document = extract(pdfBytes, { timeoutMs: 60_000 });
console.log(document.pages, document.markdown, document.warnings);
const readingEdition = epub(document);
```

For a browser, run the synchronous engine in a worker. With Vite:

```ts
// pdf.worker.ts
import '@thereader/pdf-extractor/worker';

// application.ts
import { extractInWorker } from '@thereader/pdf-extractor/browser';
const job = await extractInWorker(pdfBytes, 'epub', {
  workerFactory: () => new Worker(new URL('./pdf.worker.ts', import.meta.url), {
    type: 'module',
  }),
  timeoutMs: 65_000,
  signal: abortController.signal,
});
```

Formats: `document` (typed blocks and Uint8Array assets), `markdown`, `epub`.
The wrapper preserves the caller's input buffer and terminates the worker on
completion, timeout, cancellation, or an error. A worker may also be reused by
sending `{ id, bytes: ArrayBuffer, format, options }` directly to the worker;
responses echo the ID. A reused worker processes messages sequentially.

`extract` is synchronous: its deadline is checked cooperatively. A browser
AbortSignal cannot interrupt a blocked thread; the worker wrapper terminates
that thread and enforces the outer deadline. Limits cover input, objects,
pages, decoded data, operations, spans, image pixels and output assets.

Blocks preserve heading levels, inline styles and links, code language hints,
lists, references/index roles, images, tables with merged cells and positioned
math. Complex tables render as semantic HTML inside Markdown. Math preserves
PDF glyph outlines and placement; it is **not semantic LaTeX/MathML**. There is
no OCR, JPEG2000 or JBIG2 decoder. Inspect `warnings` and `complete`; matching
Go's output does not establish universal book accuracy.

See [measured parity and timing](../../eval/pdf/native/README.md). `bun test`
and `bun run typecheck` validate the package. Asset compression is allowed to
vary between languages; text, cell relationships and benchmark outcomes are
compared separately from decoded image pixels.

Known shared graphics/layout limitations are listed in the [review dispositions](../../eval/pdf/native/review.md).
