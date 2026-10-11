# PDF Extractor: independent browser engines

[Published report with screenshot and video proof](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/doc/thereader/pdf-browser-engines-c5c810a4.html).

The TypeScript and Dart libraries independently implement the Go 0.3 extraction
pipeline. Neither uses Go/WASM, PDF.js, a hosted extractor, or the other language's
engine. The web reader now converts PDFs in the TypeScript worker before its
existing EPUB import/upload flow. The Dart library includes its own browser
worker and public client; it is separately reusable and is not wired into the
TypeScript reader.

## Exact score, with an exact scope

All five configurations (Go, Bun TypeScript, Dart VM, browser TypeScript, and
Dart compiled to browser JavaScript) score **0.3033110936410476**, or
**30.33110936410476%**, on the pinned olmOCR-bench reference corpus.
The ports have **zero changed pass/fail outcomes across all 8,413 checks**.
There are 1,403 PDFs; the same 12 oversized-image files hit resource limits.
Their empty outputs remain in scoring. No tests are discarded or rewritten.

This is the macro-average of category pass rates, including the official
baseline checks. It is not a character accuracy or book completeness percentage.
The seeded bootstrap 95% interval is [0.29454142651994575, 0.31145846649013537].
The reference corpus includes scanned and semantic-math content unsupported by
all three engines; matching Go does not mean market-leading extraction accuracy.

| Category | Passed / total (every engine) |
| --- | ---: |
| arxiv_math | 16 / 2,927 |
| baseline | 1,382 / 1,394 |
| headers_footers | 458 / 760 |
| long_tiny_text | 71 / 442 |
| multi_column | 314 / 884 |
| old_scans | 70 / 526 |
| old_scans_math | 0 / 458 |
| table_tests | 182 / 1,022 |

Dataset revision: `54a96a6fb6a2bd3b297e59869491db4d3625b711`.
Evaluator revision: `f7cfe4c22098b154c76b6ec950d1c0a464eecf8d`.
Go baseline: `625d6b202da5759e13dc67c743022a22c2e07175`.
Individual outcomes and their hashes are in `olmocr-*-tests.jsonl` and
`olmocr-*-scores.json`. See `parity.json` for the direct outcome comparison.
The independent reference corpus has also been used during development; it is
not an untouched holdout. Prior competitor evaluations and their limitations
remain in [the Go report](../coverage-v03/README.md); this change measures port
parity, not a new market leaderboard.

## Performance

`timing-go.json` and `timing-browser-*.json` retain every measured sample.
On the same Apple M5, Chrome 154, the final run's page-weighted warm medians are:

| Engine | ms/page | Time relative to Go |
| --- | ---: | ---: |
| Go | 1.3124130742705569 | 1.00× |
| TypeScript browser | 2.62559681698008 | 2.00× |
| Dart browser | 4.6710875331564985 | 3.56× |

Five documents, 1,508 pages: the requested arXiv paper (43), Axler (404), Hefferon
(525), Think Python (244), and Calculus Made Easy (292). Each document has one
cold call and three warm calls. We sum the per-document warm medians, then divide
by total pages. Input is already in memory; extraction includes parsing, stream
and font decoding, layout, images, and Markdown. File reads, EPUB compression,
network/upload and reader rendering are excluded. Worker wall times are also
recorded. These are document throughput measurements, not individual-page
latency guarantees. Similar speed to Go and universal sub-millisecond pages
have **not** been achieved. No Safari, Firefox, mobile, or low-memory-device
performance claims are made.

Hot-path changes avoid quadratic SVG byte counting, add a bounded Dart Huffman
lookup table, remove repeated number-format regular expressions, and use direct
RGB pixel paths. Both engines run off the UI thread. Resource limits and worker
termination bound failures; unsupported features remain explicit warnings.

## What matches and what differs

- Nineteen small Go-generated PDF fixtures compare structured extraction,
  geometry (1e-8 tolerance), warning categories and assets. Separate regression
  fixtures cover named RGB/ICC inline images and text after binary image data.
- All five real PDFs match block kinds, text, order, table anchor coordinates,
  row/column spans and header scopes. Markdown matches after asset filename
  normalization. Asset names can differ when generic codecs compress differently.
- The requested paper retains 13 tables. Its cell relationships match the Go
  version that recovered all 1,473 nonempty author-HTML cells. The paper was a
  development example, so its perfect table score cannot represent all PDFs.
- All 14 selected math crops exceed 99% ink F1; mean **99.96026317503747%** for
  both ports, identical to Go under the stated pixel tolerance. This evaluates
  positioned glyph appearance, not semantic equation reconstruction or LaTeX.
- Fifteen of 16 PNG assets have identical decoded RGBA pixels. One masked JPEG
  becomes PNG after decoding: generic JPEG decoders differ by at most 3/255 in
  RGB channels, with identical alpha. `parity.json` retains the changed-pixel
  counts and mean channel differences. Raster images are **not all bit-exact**.
- OCR, JPEG2000, JBIG2, full color management, and semantic math remain
  unsupported. `complete: false` and warnings are preserved where appropriate.

## Reproduce

Use Bun 1.4.0, Dart 3.13.4 and the lockfiles. Core dependencies are generic
codecs; installed versions are recorded in the lockfiles. From the repo root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/pdf_ts typecheck
bun test packages/pdf_ts/test apps/web/src/lib/import/pdf.test.ts
(cd packages/pdf_dart && dart analyze && dart test)
bun run --cwd apps/web build
```

For standalone Dart use, copy `packages/pdf_dart` and remove `resolution:
workspace` from its pubspec. CI demonstrates testing it without Flutter.
Fixtures remain at the same relative `eval/pdf/native` path for the tests.

Fetch the pinned evaluation inputs and Python environment using the commands
in [coverage-v03/README.md](../coverage-v03/README.md#reproduce). No corpus or
reference text is embedded in the engine. Then:

```sh
bun run eval/pdf/native/extract-ts.ts
dart run packages/pdf_dart/tool/olmocr.dart
bun run eval/pdf/native/real-world-ts.ts
dart run packages/pdf_dart/tool/real_world.dart

mkdir -p test-corpus/pdf/native/browser
bun build packages/pdf_ts/src/worker.ts --target browser --minify \
  --outfile test-corpus/pdf/native/browser/ts-worker.js
dart compile js -O2 packages/pdf_dart/web/worker.dart \
  -o test-corpus/pdf/native/browser/dart-worker.js
bun run eval/pdf/native/serve-browser.ts
```

Open `http://127.0.0.1:5199/`. Run `await runCorpus('ts')`, then
`await runCorpus('dart')` in the browser console. The local evaluation server
saves output Markdown and diagnostic records. Run `await benchmark('ts')` and
`await benchmark('dart')` sequentially and save the returned objects as the
corresponding timing JSON. Avoid concurrent CPU work during timing runs.
The harness heartbeat shows that extraction does not block UI execution.

```sh
# Use the pinned evaluation virtualenv Python here.
PYTHONPATH=/tmp/olmocr-evaluator python eval/pdf/scripts/olmocr_score.py \
  native-ts native-dart browser-ts browser-dart --output-dir eval/pdf/native
(cd packages/pdf_go && go build -o /tmp/pdf-native-go-benchmark ./cmd/pdf)
python eval/pdf/native/timing-go.py
python eval/pdf/native/compare.py
python eval/pdf/scripts/math_visual.py --predictions test-corpus/pdf/native/ts \
  --results eval/pdf/native/math-ts.json --images test-corpus/pdf/native/math-ts
python eval/pdf/scripts/math_visual.py --predictions test-corpus/pdf/native/dart \
  --results eval/pdf/native/math-dart.json --images test-corpus/pdf/native/math-dart
```

`compare.py` also needs the saved Go real-world JSON predictions from the Go
reproduction commands. The CI workflow runs package tests/builds; it does not
silently download the full benchmark or claim to reproduce these timings.

## Reader proof

The production-built reader successfully imported and opened the requested PDF
with `/v1/pdf/extract` blocked. Conversion occurs locally; the resulting EPUB
still uses the existing upload/storage/sync flow. The recording shows the actual
upload, extraction notes, paper title, and merged tables. Wide tables retain
horizontal scrolling in the reader.

- [Merged table screenshot](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/pr-assets/thereader/pdf-browser-table-305433fd.png)
- [Upload and reader recording](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/pr-assets/thereader/pdf-browser-upload-29647d4b.mp4)

CodeRabbit review identified asset-buffer ownership and inline named-color
length calculation bugs. Both were fixed with regression tests. Public worker
APIs were additionally exercised in Chrome, including Dart EPUB transfer and
cancellation and TypeScript structured-document transfer with multiple images.

Two inherited Go graphics/layout issues remain: path stroke widths do not scale
with the CTM (zero-width hairlines can disappear), and discarded/clipping paths
can influence ruling-based table detection. See [review dispositions](review.md).
The port does not claim a clean review or full visual parity for every PDF.
