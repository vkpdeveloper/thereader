# PDF Extractor 0.3: tables and wider content recovery

[Published report with screenshots and video](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/doc/thereader/pdf-extractor-v03-report-c16a0557.html).

This report evaluates the standalone Go library, not a model-assisted service.
No competitor, OCR library or reference HTML is used by the extractor. The
production module still has no dependencies beyond the Go standard library.

## Findings and limits

- The requested arXiv paper's **13 tables and 1,473 nonempty cells** match the
  author HTML in text, row, column, rowspan and colspan. Previous output split
  them into 19 fragments. This paper was used during development; its perfect
  table result is **not** a held-out or market-wide accuracy result.
- Named CFF charset/encoding and partial Unicode fallback recover additional
  text and outlines. Think Python's 20 CFF outline warnings disappear. Bitmap
  Type 3 glyphs preserve their appearance even where Unicode remains unknown.
- All **14 deliberately selected display-equation crops exceed 99% ink F1**;
  13 are exactly 100% under the stated pixel tolerance. Three selected Type 3
  crops also match visually. This does **not** measure semantic math accuracy.
- Original T.4/T.6 fax decoding, indexed grayscale/CMYK/ICC palettes, and packed
  or JPEG soft masks remove 102 previously reported image failures from the
  independent corpus. All 76 testable fax image objects match MuPDF RGB pixels
  exactly. Sixteen stencil masks are excluded because color depends on page
  drawing state; the extractor explicitly reports its grayscale approximation.
- The full olmOCR-bench corpus of **1,403 page PDFs** remains difficult: the release scores
  about **30.3%**, versus 30.0% for 0.2. Confidence intervals overlap. Table checks
  improve from 149/1,022 to 182/1,022. The corpus contains scans and semantic math
  tests the library cannot solve. This is not market-leading accuracy.

The independent corpus has 8,413 evaluated tests, including 1,394 additional
baseline checks; existing baseline tests remain in their original categories.
Twelve oversized-image PDFs hit the default resource limit in both versions.
Their empty outputs are scored as failures where appropriate, never dropped.
A baseline pass is only a sanity check, not a content-completeness score.

The first broad run exposed false tables spanning two-column article bodies.
The final version rejects prose-heavy regions bounded only by page rules.
The corpus was authored independently but is now also used for development;
call it an independent **reference**, not an untouched holdout.

## How the change works

`Block.Table` is the canonical table model: zero-based anchor row/column,
rowSpan/colSpan, styled runs, header role and source rectangle. `Rows` remains
for existing callers. Long rules find regions; repeated body alignments infer
columns; shorter underlines recover grouped headings. Header bands rejoin
wrapped labels, and vertical centering plus rule boundaries recover row groups.
Rejected guesses leave text available to ordinary reading order. Numbered
algorithms become indented pseudocode blocks rather than false tables.

Complex tables use HTML in Markdown. EPUB preserves `thead`, `tbody`, `th`,
`rowspan`, `colspan`, `scope` and explicit `headers` associations. Reader tables
scroll horizontally inside the text column on desktop and mobile.

CFF tables are standardized reference data with their license retained. The
CFF reader, Type 3 monochrome mask interpreter and CCITT decoder are original
bounded Go code. Decoder limits cover both output and working buffers;
malformed codes, dimensions and unsupported extension modes fail explicitly.
Ordinary line-end hyphens are removed only when a solid spelling is witnessed
elsewhere on the same page, with no conflicting explicit compound spelling.

## Metrics

Final warm conversion: **1.393 ms/page** across 1,508 pages, rank **1/6**
configurations, 1.16× as fast as Poppler. The requested paper is **11.494 ms/page**,
rank **2/8** including Docling and Marker. Two of five documents average below
1 ms/page. This is not an individual-page latency guarantee.

On the development paper, exact cell-structure F1 is **100%**, rank **1/8**
configurations covering five competitor engines. PyMuPDF4LLM is next at **89.43%**,
then Docling at **60.08%**. PyMuPDF and pdfplumber each include both default line
and text strategies over full pages; no reference crops are supplied. Their
default line strategies miss almost all cells because the paper lacks vertical
cell borders; text strategies also mistake prose for tables. These settings
do not establish those tools' best achievable results.

Selected prose agreement is **94.31%**, rank **4/8** behind Docling (**96.47%**),
Marker (**95.63%**) and pypdf (**95.56%**). All 41 reference headings are recovered,
with one extra label (98.80% F1). The paper has 137,196 block-text characters,
42 headings, 269 paragraphs, 31 image/figure blocks, 26 code blocks, six lists
and 13 tables. These counts do not prove completeness.

`quality.json` and `summary.json` contain the exact values. Markdown prose is
parsed with markdown-it-py, not a broad HTML-tag regex that could accidentally
remove text between mathematical comparison signs. PyMuPDF4LLM uses its raw
page-chunk Markdown for quality; its timed configuration embeds images.

`table_structure.py` removes six invisible LaTeXML phantom nodes and duplicate
MathML annotations from the original HTML. NFKC, whitespace, soft hyphens and
equivalent minus signs are normalized; case, decimal points, units and other
punctuation are retained. A reference table matches at most one output table
on its physical source page. Unmatched output tables count against precision.
Exact cell structure requires `(row, column, rowspan, colspan, text)` equality.
It is stricter than cell-text F1 and is not TEDS. The old 1,448-cell alphanumeric
metric is not directly comparable with this corrected 1,473-cell reference.

`math_visual.py` compares one geometrically selected output block against the
original PDF crop at 216 dpi. Ink uses grayscale <160, chroma spread <60, and
one raster-pixel dilation tolerance. It penalizes fragmented equations, but
selected crops cannot estimate whole-book accuracy. `bitmap_visual.py` uses
the same rule for three Type 3 crops. MuPDF is evaluation-only.

`olmocr_score.py` imports the **unmodified official evaluator**, with all tests
and baseline checks. One Markdown output per source page is scored. The overall
score is the official macro-average across JSONL categories and the added
baseline category, with a seeded 1,000-resample 95% bootstrap interval. SVG
formulas do not become LaTeX merely to improve the score. Reference render or
prediction parse failures remain upstream evaluator behavior.
Individual outcomes are retained in `olmocr-*-tests.jsonl`; score summaries
include their SHA256 hashes. Failure explanations are hashed rather than copying
the corpus's reference text into the repository.

## Pinned sources

- Requested paper and four books: [original manifest](../real-world/corpus.json).
- [olmOCR-bench dataset](https://huggingface.co/datasets/allenai/olmOCR-bench),
  revision `54a96a6fb6a2bd3b297e59869491db4d3625b711`, ODC-By. Every downloaded
  PDF/JSONL is verified against the pinned Git/LFS hash in `olmocr-corpus.json`.
- [Official olmOCR evaluator](https://github.com/allenai/olmocr/tree/f7cfe4c22098b154c76b6ec950d1c0a464eecf8d/olmocr/bench),
  revision `f7cfe4c22098b154c76b6ec950d1c0a464eecf8d`. Nineteen required source
  files are independently hash-verified in `olmocr-evaluator.json`.
- CCITT: [ITU T.4](https://www.itu.int/rec/T-REC-T.4),
  [ITU T.6](https://www.itu.int/rec/T-REC-T.6), and the run codeword tables in
  [RFC 804](https://www.rfc-editor.org/rfc/rfc804.html).
- Competitors: [Docling](https://docling-project.github.io/docling/),
  [Marker](https://github.com/datalab-to/marker),
  [PyMuPDF](https://pymupdf.readthedocs.io/en/latest/),
  [PyMuPDF4LLM](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/),
  [pypdf](https://pypdf.readthedocs.io/en/stable/),
  [pdfplumber](https://github.com/jsvine/pdfplumber),
  [Poppler](https://poppler.freedesktop.org/).

## Reproduce

Download documents into ignored `test-corpus/pdf`, never into the library.
Install evaluation dependencies in a separate virtual environment:

```sh
uv venv /tmp/pdf-eval
uv pip install --python /tmp/pdf-eval/bin/python -r eval/pdf/coverage-v03/requirements-eval.txt
/tmp/pdf-eval/bin/python -m playwright install chromium
/tmp/pdf-eval/bin/python eval/pdf/scripts/real_world.py --fetch
/tmp/pdf-eval/bin/python eval/pdf/scripts/fetch_olmocr.py
/tmp/pdf-eval/bin/python eval/pdf/scripts/fetch_olmocr_evaluator.py
(cd packages/pdf_go && go build -o /tmp/pdf-extractor-v030 ./cmd/pdf)
/tmp/pdf-eval/bin/python eval/pdf/scripts/olmocr_extract.py --binary /tmp/pdf-extractor-v030 --name release
PYTHONPATH=/tmp/olmocr-evaluator /tmp/pdf-eval/bin/python eval/pdf/scripts/olmocr_score.py release
```

Build the 0.2 baseline at commit `de1d13f13f4e21b8b30c5b0e7e87237599875687`
in a separate checkout, then use `--name before`. Do not overwrite its outputs
with the release binary. Run warm speed benchmarks **sequentially** on an idle
host; `coverage_bench.py` accepts `pdf-extractor`, `pymupdf`, `pdftotext`, `pypdf`,
`pdfplumber`, `pymupdf4llm`, `docling`, or `marker`. Docling and Marker use separate
venvs with `docling==2.137.0` and `marker-pdf==2.0.0`; use `--ids harness` for their
paper-only runs. No paid API or LLM is used.
The `environment-*.txt` files record all installed packages in the three Python
3.12 environments. Marker timing includes Markdown rendering; structured JSON
is exported afterward from that same processed document for quality scoring.

Additional checks, after generating the five Go JSON files into
`test-corpus/pdf/coverage-v03`:

```sh
for engine in pymupdf-tables pymupdf-text-tables pdfplumber pdfplumber-text pymupdf4llm; do
  /tmp/pdf-eval/bin/python eval/pdf/scripts/paper_competitors.py "$engine"
done
/tmp/pdf-eval/bin/python eval/pdf/scripts/coverage_quality.py
/tmp/pdf-eval/bin/python eval/pdf/scripts/math_visual.py --predictions test-corpus/pdf/coverage-v03 --results eval/pdf/coverage-v03/math-visual.json --images test-corpus/pdf/coverage-v03/visual
/tmp/pdf-eval/bin/python eval/pdf/scripts/bitmap_visual.py
/tmp/pdf-eval/bin/python eval/pdf/scripts/fax_pixels.py
/tmp/pdf-eval/bin/python eval/pdf/scripts/coverage_summary.py
```

Library validation: `go test ./...`, `go test -race ./...`, `go vet ./...`,
10 seconds of `FuzzFaxDecode` (304,748 executions) and 15 seconds of `FuzzExtract`
(162,548 executions) passed. A separate 10-second font parser fuzz check also
passed. CodeRabbit findings were checked and corrected, including Type 3 point
transforms, inline unknown glyphs and annotation continuations. The final review
reported only a portability suggestion for benchmark CPU metadata, now fixed.

One warm-up is discarded; the next three conversion times are retained.
Imports and model loading are excluded. Go includes parse, fonts, images,
layout and Markdown, excluding input I/O and JSON/EPUB serialization. Each
competitor's actual export/device/thread/OCR configuration is recorded with
its timing. Text-only engines perform less work. Marker reads its input file
inside its timer. Four-worker extraction times in corpus manifests are
**diagnostic only** and never used in speed rankings.

## Still unsupported

OCR, semantic LaTeX/MathML reconstruction, JPEG 2000/JBIG2, some symbol mappings,
complex/nested tables, some clipping/color-space/opacity behavior, reading order
around floats and several other PDF features remain incomplete. Axler's 13
JPEG 2000 reports persist. `Complete` remains false for known partial outputs.
Neither a universal 99% book claim, a sub-millisecond guarantee, nor best-in-market
accuracy is supported by these measurements.
