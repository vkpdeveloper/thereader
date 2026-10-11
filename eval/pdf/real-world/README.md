# Real-paper and textbook follow-up

[Full report with screenshots and video](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/doc/thereader/pdf-real-world-report-4070e723.html)

PDF Extractor 0.2.0 was tested on the requested [arXiv paper](https://arxiv.org/abs/2609.20804),
Sheldon Axler's [Linear Algebra Done Right](https://linear.axler.net/),
Jim Hefferon's [Linear Algebra](https://jheffero.w3.uvm.edu/linearalgebra/),
Allen Downey's [Think Python](https://greenteapress.com/wp/think-python-2e/),
and Silvanus Thompson's [Calculus Made Easy](https://www.gutenberg.org/ebooks/33283).
These are **1,508 independently typeset, digital-text pages**, not generated fixtures.
They became development cases during this work; this is not a blind holdout.
The downloaded revisions and rights information are pinned in [corpus.json](corpus.json).
Full PDFs, extracted books and reference HTML stay in the ignored `test-corpus/pdf`.

## Measured result

On an Apple M5 / macOS 27.0.1, the page-weighted warm conversion rate is
**1.253 ms/page, rank 1 of six measured engines**. This is 1.234× the throughput
of the next engine, Poppler, and 65.43× PyMuPDF4LLM with its layout model.
Output scopes differ: this is not a market-wide or overall quality ranking.
The previous 0.1.0 implementation was faster at 0.736 ms/page; preserving font
outlines and recovering more structure has a real cost. Only two of these five
documents average under 1 ms/page. The requested paper takes 10.134 ms/page,
versus Poppler's 4.487 ms/page.

| Engine | Version | Weighted ms/page | Configured output |
| --- | --- | ---: | --- |
| PDF Extractor | 0.2.0 | 1.253 | Blocks, text, images, positioned math, Markdown |
| Poppler pdftotext | 26.10.0 | 1.547 | Text, including CLI startup |
| PyMuPDF | 1.28.2 | 5.934 | Sorted text |
| pypdf | 6.20.0 | 6.852 | Default text; optional FontTools installed |
| pdfplumber | 0.11.10 | 20.638 | Text and default table extraction |
| PyMuPDF4LLM | 1.28.2 | 82.012 | Layout-model Markdown, images embedded, OCR off, header/footer cleanup on |

Each document gets one warm-up and three timed fresh parses, sequentially on a
shared development host. The rate is the sum of document medians divided by the
sum of page counts, **not individual-page latency**. Go includes parsing,
decompression, fonts, layout, assets and Markdown. Source-file reads, JSON and
EPUB compression are excluded. Python includes configured conversion but excludes
imports and model initialization; Poppler includes process startup. These are
conversion measurements, not upload or server latency guarantees. Exact samples,
versions, output hashes and scope are in the seven engine JSON files;
[environment.json](environment.json) pins the Go source and binaries.

## Requested paper

The 43-page PDF yields 135,275 block-text characters, 42 heading blocks, 313
paragraphs, 31 image/figure blocks, 25 code blocks, six list blocks and 19 table
blocks. There are zero Unicode replacement characters, which does not imply
zero extraction errors. The author's HTML has 13 tables; 19 output table blocks
reflect some fragmentation, not 19 perfectly recovered source tables.

Against the [versioned author HTML](https://arxiv.org/html/2609.20804v1):

| Check | 0.1.0 | 0.2.0 |
| --- | ---: | ---: |
| Exact normalized heading labels recovered | 11 / 41 | **41 / 41** |
| Heading F1 (including extra labels) | 38.60% | **98.80%** |
| Exact normalized table cells recovered | 883 / 1,448 | **1,223 / 1,448** |
| Table-cell F1 | 74.58% | **89.96%** |
| Weighted prose-window character agreement | 93.50% | **94.31%** |
| Selected paragraphs at ≥99% agreement | 57 / 73 | **60 / 73** |
| Exact selected paragraphs | 54 / 73 | 53 / 73 |
| Exact 32-character fragments found | 1,355 / 1,419 | **1,385 / 1,419 (97.60%)** |

The prose score uses 73 HTML body/prompt paragraphs, 46,405 normalized characters,
with at least 100 alphanumeric characters each. It excludes short paragraphs,
author metadata, figure/table content, whitespace and punctuation. Each paragraph
is compared by edit distance with its best contiguous output window. Floating
tables can interrupt a paragraph even when its words are present. Fragment
coverage ignores order across fragments. Neither score is whole-document accuracy.
Heading and cell F1 compare multisets of exact normalized strings, not table
geometry, merged cells or reading order. The extra heading is the PDF-only
"Appendix" label. HTML appendix numbers also differ from the PDF.

On this prose check, PDF Extractor is **second of six**: pypdf reaches 95.56%.
PyMuPDF4LLM reaches 94.03%, heading F1 80.39% and table-cell F1 87.30%; it recovers
more reference cells (1,254), with more extra/different cells. Text-only engines
do not emit heading/table structure; their zero structured counts are **N/A for
capability comparison**, not proof of zero textual quality. All scores and
per-paragraph details are in [quality.json](quality.json).

## Books and mathematics

| Source | Pages | ms/page | Display math blocks | Other evidence |
| --- | ---: | ---: | ---: | --- |
| Axler | 404 | 1.271 | 1,458 | 208 headings; 0 replacement characters |
| Hefferon | 525 | 1.087 | 1,924 | Replacement characters 10,685 → 68 |
| Think Python | 244 | 0.558 | 8 | Code blocks 0 → 596; language detection remains heuristic |
| Calculus Made Easy | 292 | 0.803 | 887 | 346 replacement characters remain (previously 348) |

Block counts are coverage diagnostics, not accuracy scores. Hefferon's 99.36%
reduction in replacement characters is **not 99.36% book accuracy**.
`quality.json` also includes per-page unordered alphanumeric character agreement
with PyMuPDF. That is disagreement diagnosis against another extractor, not ground
truth, and does not measure reading order, structure or mathematical semantics.

[math-regions.json](math-regions.json) identifies 14 manually selected formula
regions by physical PDF page and crop coordinates. The check renders the original
PDF and the geometrically largest-overlapping **single** output math block at
216 dpi, then compares grayscale ink with one raster pixel (1/3 pt) of tolerance.
It deliberately penalizes formulas split across blocks. MuPDF renders both sides
for this evaluation only; it is not used in production. Antialiasing tolerance,
selection during development, and use of the same evaluation rasterizer limit
what this check establishes. See [math-visual.json](math-visual.json).

**12 of 14 regions exceed 99% ink F1; mean 98.19%.** All six Axler and four
Hefferon selections reach 100% within that tolerance. They cover sets, matrices,
vector arithmetic, accents, summations, derivations and elimination. Calculus's
binomial example reaches 100% and its substitution reaches 99.52%. Its fractional
power example reaches only **79.54%**, and the integral example **95.65%**: parts
of expressions remain mixed with surrounding prose. These failures are retained
in the published results. This is visual geometry, **not LaTeX/MathML accuracy**,
an exhaustive book test or a defensible universal 99% claim.

## What changed

The independent `packages/pdf_go` module still uses only the Go standard library.
New bounded font readers decode CFF/Type 2, Type 1, TrueType outlines and a restricted
Type 3 path vocabulary. They preserve original glyph positions in SVG, including
fraction rules, accents and script placement. Unicode decoding uses embedded font
encodings and the licensed Adobe Glyph List reference data, not another extractor.
No existing parser, renderer, OCR/model or subprocess is linked into production.

Layout now preserves baselines, cleans recurring margins as complete lines,
joins wrapped headings, recognizes small numbered headings, reconstructs ruled
tables including empty cells, and keeps vector-chart labels in their figures.
CropBox is intersected with MediaBox before transforming coordinates. Blocks retain
text, geometry, script runs, assets and a `representation: "positioned"` marker.
Markdown and EPUB are generated from those blocks; math remains searchable via
linear text but its text is not guaranteed to encode its mathematical meaning.

The shared reader respects the positioned-math marker instead of interpreting
its alt text as TeX. Formula dimensions scale with the reader font, and declared
monochrome ink follows dark mode. The generated mobile reader assets are refreshed
to enhancement version 5. Existing PDF upload/server integration remains in use.

Known gaps remain explicit in `warnings` and `complete: false`: JPEG2000 photos
(13 Axler image reports), bitmap Type 3 glyphs, some legacy symbol mappings,
name-keyed CFF outline/encoding fallback, complex clipping and color spaces,
merged tables, reading order around floats, and mixed prose/math segmentation.
Calculus has 346 replacement characters; Think Python has 20 font-outline warnings.
There is no OCR, semantic equation reconstruction, JPEG2000/JBIG2/CCITT decoder,
or full coverage of every PDF feature. Docling, Marker, MinerU and hosted APIs
were not run in this follow-up; no OmniDocBench or market ranking is claimed.

## Validation and reader proof

[evidence.json](evidence.json) links the original-PDF versus exported-math comparison,
the actual desktop reader, a 390px browser view, the requested paper, and an
unedited 32-second upload-to-reading video. The narrow view is a browser test,
not a native simulator test. Display math loads, remains visible and fits the
viewport at both widths. The video predates two minor font/layout review fixes;
the final measured binary and source hashes are recorded separately.

`go test -race ./...` and `go vet ./...` pass. Reader tests pass (89 tests,
3,300 assertions), and the web build and mobile enhancement bundle build pass.
The existing web build still reports unresolved Libron font URLs with runtime
fallback. A font-program fuzz run found a CFF INDEX out-of-bounds panic; the
offset bound is fixed and its minimized input is committed. After that fix,
font fuzzing completed 541,985 executions in 21 seconds, and extractor fuzzing
293,920 in 16 seconds without failure. Three CodeRabbit CLI review rounds produced
fixes for stale benchmark output, implicit CFF warnings, indirect Type 1 lengths,
math reclassification and processor detection. Invalid font matrices deliberately
retain the resource-limit error.

## Reproduce

```sh
uv venv /tmp/thereader-pdf-bench
uv pip install --python /tmp/thereader-pdf-bench/bin/python -r eval/pdf/requirements.lock.txt
# Install Poppler 26.10.0 (pdftotext) separately for the recorded version.
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/real_world.py --fetch

# Build the merged 0.1.0 baseline without changing this checkout.
baseline_dir=$(mktemp -d /tmp/pdf-baseline.XXXXXX)
git archive 0cfdfe3 packages/pdf_go | tar -x -C "$baseline_dir"
(cd "$baseline_dir/packages/pdf_go" && go build -o /tmp/pdf-extractor-before ./cmd/pdf)
(cd packages/pdf_go && go build -o /tmp/pdf-extractor-after ./cmd/pdf)

/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/real_world.py --repeats 3
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/math_visual.py
```

Fetch verifies source PDF and HTML hashes; a changed publisher revision fails
instead of silently substituting content. Hefferon's server is downloaded in
verified byte ranges because it throttles long responses. A failed conversion
deletes its previous output and report. To rerun one engine use `--engine NAME`,
then `--finalize` after all required outputs exist. Reproduction overwrites the
tracked measurements; inspect the diff before publishing new claims.

The report generator accepts the HTML Communication template via `--template`
and writes a standalone HTML artifact with the public evidence embedded. It
verifies media hashes from `evidence.json` before embedding. All evaluation
dependencies stay outside the production Go module.
