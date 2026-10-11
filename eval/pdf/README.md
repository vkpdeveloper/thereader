# PDF Extractor evaluation

The [real-paper and textbook follow-up](real-world/README.md) tests the requested
arXiv 2609.20804 PDF plus Axler, Hefferon, Think Python and Calculus Made Easy:
1,508 pages, five comparison engines, font/mathematical geometry checks and
reader proof. Its scores are separate from the original controlled fixtures below.

[Implementation, measured ranks and reader proof report](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/doc/thereader/pdf-extractor-report-ebf0e378.html)
includes screenshots and a video. [Evidence metadata](evidence.json) records the
exact original PDF, converted EPUB hash and browser assertions.

This harness compares the standalone Go PDF Extractor with seven established
tools: **PyMuPDF, PyMuPDF4LLM, pypdf, pdfminer.six, pdfplumber, Microsoft
MarkItDown and Poppler pdftotext**. Their output scopes differ. Text-only tools
are included as speed/text baselines, not represented as full Markdown engines.
PyMuPDF4LLM uses its current layout model with images embedded, OCR disabled,
and its documented `header=False, footer=False` cleanup enabled.
No competing extraction code is used in the production package.

## Reproduce

```sh
uv venv /tmp/thereader-pdf-bench
uv pip install --python /tmp/thereader-pdf-bench/bin/python -r eval/pdf/requirements.lock.txt
# Install Poppler using your platform's package manager for pdftotext.
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/corpus.py --public
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/book.py
(cd packages/pdf_go && go build -o /tmp/thereader-pdf ./cmd/pdf)
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/bench.py --repeats 5
/tmp/thereader-pdf-bench/bin/python eval/pdf/scripts/summary.py
```

ReportLab is only an independent evaluation PDF **writer**. It supplies source
text and structure ground truth without calling the extractor. Generated source
and output PDFs, downloaded PDFs, model logs and extracted text stay in the
gitignored `test-corpus/pdf`. Engine versions, per-run times, output hashes,
scores and input checksums are in `results/`. `requirements.lock.txt` pins the
evaluation-only Python environment, including transitive dependencies.
The generated Unicode fixtures use the platform's Arial or DejaVu font; PDF
bytes can differ across platforms. Input hashes identify the actual measured
files. The environment record includes the Go source and benchmark binary hashes.

## What the numbers mean

- Each converter receives the same PDF bytes. Every timed call opens a fresh
  document; cached parsed PDFs are not reused. One warm-up precedes five timed
  calls. Engines run sequentially. Library imports, model initialization and
  reading the source file into memory are outside the warm-call timer.
- The Go timer includes parsing, decompression, fonts, layout, blocks, images
  and Markdown. It excludes JSON serialization and EPUB compression. The
  Python timers include their configured output construction. Poppler exposes
  a CLI here, so **its timing includes process startup**; the scope column
  records that asymmetry. The benchmark is on a shared development host.
- `msPerPage` is a **document's median conversion duration divided by its page
  count**. It is amortized throughput, not individually measured page latency.
  The overall weighted rate is the sum of document medians divided by total
  pages. A per-document p95 is not a per-page tail latency or an upload SLA.
- Character accuracy is `1 - LevenshteinDistance / max(reference length,
  output length)`, clamped to zero, after Unicode NFKC and whitespace
  normalization. Reading order, missing content and unwanted repeated text
  affect this score. Token F1 compares normalized token multisets.
- Heading and table-cell F1 compare exact normalized labels/cells, ignoring
  Markdown emphasis/link markup around their text. Code-block
  F1 requires exact indentation and line breaks (trailing spaces ignored).
  Image-count F1 measures count only, **not visual fidelity or placement**.
  These deliberately simple measures are not a comprehensive semantic score.
- Quality scores apply to the controlled generated PDFs only. These are
  development fixtures, not a blind held-out corpus. The real public PDFs are
  throughput/coverage checks with **no accuracy score**. The scan is a separate
  OCR capability-gap case and is excluded from digital-text speed rankings.
- Ranks are confined to these measured engines, this corpus, these versions and
  this machine. They are not a market-wide ranking. There is no defensible
  universal 99% book-accuracy claim, speedup on arbitrary documents, or ranking
  above untested Docling, Marker, MinerU or hosted APIs.

The small generated booklet repeats original short prose; its page rate should
not be mistaken for a scanned textbook's rate. A separate 60-page, 26,525-word
controlled typesetting of [Alice's Adventures in Wonderland](https://www.gutenberg.org/ebooks/11)
adds a full novel with source-text ground truth. It is still a generated layout,
not an independently typeset book holdout. Public coverage includes
[Attention Is All You Need](https://arxiv.org/abs/1706.03762),
[NIST FIPS 197](https://doi.org/10.6028/NIST.FIPS.197-upd1),
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html), and
[W3C's test PDF](https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf).
Downloads are not redistributed. Their hashes make the measured input auditable.

## Why no OmniDocBench rank

[OmniDocBench](https://github.com/opendatalab/OmniDocBench) evaluates rich page
images and document-parsing tasks, including OCR, tables, formulas and reading
order. A native-text parser without its own OCR engine cannot claim a result on
that benchmark from these fixtures. Running its evaluation is a separate gate
before making broad accuracy or market-leadership claims.

Primary tool documentation:
[PyMuPDF](https://pymupdf.readthedocs.io/),
[PyMuPDF4LLM](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/),
[pypdf](https://pypdf.readthedocs.io/en/stable/user/extract-text.html),
[pdfminer.six](https://pdfminersix.readthedocs.io/),
[pdfplumber](https://github.com/jsvine/pdfplumber),
[MarkItDown](https://github.com/microsoft/markitdown),
[Poppler](https://poppler.freedesktop.org/).
The parser was written against PDF syntax concepts in
[ISO 32000-1](https://pdfa.org/resource/iso-32000-1/), not by wrapping these tools.
