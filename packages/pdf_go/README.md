# PDF Extractor

A standalone, server-side Go library for converting PDF bytes into a structured
reading document, Markdown with assets, or a reflowable EPUB. The module is
independent of The Reader backend. Its library, CLI and HTTP adapter use **only
the Go standard library**. No existing PDF parser/extractor, OCR engine, model,
subprocess or network service is used by the extraction engine.

This is a first release, not a claim of universal 99% accuracy or sub-millisecond
latency. The measured results, corpus, versions and limitations live in
[the PDF evaluation](../../eval/pdf/README.md). Particularly complex, scanned,
encrypted or badly encoded files do not have the same coverage as digital books.

## Use as a library

```go
import (
    "context"
    "os"
    "time"

    pdf "github.com/vkpdeveloper/thereader/packages/pdf_go"
)

data, err := os.ReadFile("book.pdf") // handle err
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
doc, err := pdf.Extract(data, pdf.Options{Context: ctx}) // handle err
// doc.Pages[n].Blocks is the primary representation, not a Markdown parse.
markdown := doc.Markdown
epub, err := pdf.EPUB(doc) // handle err
_ = markdown
_ = epub
```

Use `Options.Limits` to lower input, object, page, stream, operation, span or image
limits. `KeepArtifacts` retains marked artifacts and repeated margin text.
Independent calls are safe to run concurrently. A call does not retain the input
after its returned document is released. JPEG assets may reference the input
buffer, so treat the input as immutable while using the document.

`Document` contains title, author, subject, keywords, language, creator, creation
date, source SHA-256, outlines, pages, blocks, assets, warnings and measured
extraction duration. PDF Info metadata takes precedence over XMP fallbacks.
Dates remain in source form. Language defaults to `en` when absent; it is not
inferred from the words.

Blocks include headings with levels, paragraphs with styled/link runs, list
items, code with language hints, table rows/cells, images and tagged formulas.
Reference, index, caption and footnote roles remain on blocks. Each block has a
top-left bounding box in PDF points and belongs to a numbered source page.
Image bytes have deterministic relative names in `Assets` (`[]byte`, base64 when
marshaled as JSON). `WriteAssets` accepts a caller-supplied storage function.
The reading representation is intentionally not a facsimile of the original PDF.

`Complete` means no *known* unsupported feature was encountered. It does **not**
mean the layout, reading order or text is 100% accurate. `Warnings` identify the
page and feature needing review. Malformed object graphs, encryption,
cancellation and exhausted limits fail the call. Unsupported content streams
can produce partial output with explicit warnings. Scan images are retained in
JSON/Markdown and flagged `NeedsOCR`; no text is invented for them.

## Command line

```sh
cd packages/pdf_go
go build -o /tmp/pdf ./cmd/pdf
/tmp/pdf -format json book.pdf
/tmp/pdf -out output/book.md book.pdf    # writes output/assets/* too
/tmp/pdf -format epub -out book.epub book.pdf
/tmp/pdf -format text book.pdf
/tmp/pdf -repeat 6 -format json -out book.json book.pdf
```

Repeat timings include parse, stream decoding, Unicode recovery, layout,
images and Markdown. Input file I/O, CLI startup, JSON serialization and EPUB
compression are outside that timer. They are not upload latency measurements.
Markdown sent to stdout still references relative assets; use `-out` to save them.

## How extraction works

1. **Objects.** A bounded lexer reads PDF names, escaped and hex strings,
   numbers, arrays, dictionaries and references. The final cross-reference
   table/stream is followed through incremental revisions, newest entries first.
   Objects and object streams are resolved lazily, with cycle and depth checks.
   Stream lengths come from PDF objects, never a regex over binary image data.
2. **Streams and fonts.** Flate, LZW (both EarlyChange variants), ASCII85,
   ASCIIHex and RunLength filters are decoded with a cumulative byte budget.
   PNG predictors and 8-bit TIFF prediction are handled. ToUnicode bfchar and
   bfrange maps recover simple/CID font glyphs; Standard, WinAnsi, MacRoman and
   Encoding Differences provide simple-font fallbacks. ActualText overrides
   visual glyph sequences. A missing CID Unicode map is reported, not guessed.
3. **Positioned content.** The interpreter applies graphics/text matrices,
   page rotation, spacing, kerning arrays, nested Form XObjects, marked content,
   artifact tags and link annotations. MCID structure roles and figure alt text
   inform the block classifier. Raster images and supported inline images are
   extracted; supported vector paths become SVG assets.
4. **Reading cleanup.** Overprinted duplicate text is removed; repeated small
   margin text and page numbers are filtered across pages. Prominent chapter
   titles are protected. Baselines group spans into lines; repeated gutters
   infer two-column order around full-width headings. Aligned short cells and
   rulings identify simple tables. Paragraphs rejoin, ligatures normalize and
   discretionary soft hyphens disappear. Visible hyphens remain because their
   role in compound words is ambiguous. Monospaced/tagged code retains blank
   lines and indentation; recognizable syntax supplies a language hint.
5. **Export.** Markdown and escaped XHTML are emitted from those same blocks.
   EPUB includes metadata, a navigation document, source-page anchors, code
   classes, tables and local images. ZIP bytes are deterministic; `mimetype`
   is the first, uncompressed entry. Partial reading editions start with
   extraction notes. The original PDF is not stored by the converter.

## Coverage boundaries

- **Supported:** classic and stream xrefs, object streams, incremental updates,
  inherited page resources, nested forms, common text operators/encodings,
  Unicode CMaps, UTF-16 metadata, links, tagged roles/ActualText, headings,
  paragraphs, simple ruled/aligned tables, lists, code, references/index text,
  JPEG, raw gray/RGB/CMYK/indexed images with supported bit depths, PNG export,
  8-bit soft masks (including resampling), JPEG Decode arrays, basic vector
  paths and supported inline images. Plain JPEGs keep their original bytes;
  masks or Decode mappings cause conversion to PNG.
- **Heuristics:** reading order, paragraph breaks, heading levels, untagged
  tables, captions/footnotes and code languages. Formula tags are preserved as
  linear text; mathematical semantics/LaTeX are not reconstructed.
- **Reported gaps:** OCR, encrypted PDFs, missing/unusual font maps, vertical
  writing, complex merged/nested tables, non-Identity CID encodings, JPEG 2000,
  JBIG2/CCITT images, uncommon inline-image filters, some masks/color spaces,
  clipping and shading, optional layers, form values, non-link annotations
  and embedded attachments. Named/internal destinations are not all resolved.
  A small test corpus cannot establish accuracy across arbitrary books.

The engine never executes JavaScript, launch actions or embedded files. It does
not access external resources referenced by a PDF. EPUB text/metadata are XML
escaped and only HTTP(S)/mailto links are retained.

Default limits: 64 MiB input, 256 MiB decoded data, 200,000 objects, 10,000 pages,
5,000,000 content operators, 2,000,000 spans and 20,000,000 pixels per image.
Limits are resource guards, not a proof that every malformed PDF is harmless.
Run the HTTP service in an isolated process/container with a memory/CPU limit.

## HTTP service and The Reader

```sh
go run ./cmd/pdfserver                       # 127.0.0.1:8091
curl --data-binary @book.pdf -H 'Content-Type: application/pdf' \
  'http://127.0.0.1:8091/v1/pdf/extract?format=epub' -o book.epub
```

`format=json` (default), `markdown` and `epub` are supported. The service bounds
request size, concurrency (2 by default), read/write timeouts and extraction
duration. It returns `X-PDF-Pages`, `X-PDF-Warnings` and `Server-Timing`.
An image-only document returns `422 PDF_NEEDS_OCR` when EPUB is requested.

For production, build the provided Dockerfile. Set `PDF_LISTEN=0.0.0.0:8091`, a
strong `PDF_EXTRACTOR_TOKEN` and optionally `PDF_CONCURRENCY`. Binding beyond
loopback without a token is refused. Put TLS and rate/access controls in front
of the service. Set the Worker variable `PDF_EXTRACTOR_URL` to that HTTPS
origin and the Worker secret `PDF_EXTRACTOR_TOKEN` to the same token. Neither
value is shipped in the browser. The Worker only relays to its configured
service and refuses redirects; an unconfigured Worker returns an actionable 503.

For local development, place `PDF_EXTRACTOR_URL=http://127.0.0.1:8091` in
`apps/api/.dev.vars` and run the normal Worker and Vite dev servers. The web and
Flutter file pickers accept PDF, submit it to `/v1/pdf/extract`, validate the
returned EPUB, and reuse the existing checksum, upload, sync, offline storage,
navigation, typography, highlighting and code-rendering paths. Conversion needs
a network connection; reading the saved result does not.

## Tests

```sh
go test ./...
go test -race ./...
go test -fuzz=FuzzExtract -fuzztime=30s -parallel=2
go test -run '^$' -bench BenchmarkExtract -benchmem
```

Tests cover byte-level syntax, Unicode/ActualText, filter prediction,
cross-reference and object streams, incremental updates, bounds/cancellation,
chapter preservation, inline images, code/asset/table output, deterministic EPUB,
unsafe markup and the HTTP contract. `testdata/reading.pdf` is original material
generated by `eval/pdf/scripts/corpus.py` using a separate PDF writer.
