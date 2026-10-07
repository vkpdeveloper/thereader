# Article extraction eval

Quality and speed of `truffle` (`packages/truffle`), its Dart port
(`packages/truffle_dart`, the engine the mobile app runs) and its Go port (`packages/truffle_go`)
against Mozilla Readability,
Defuddle, Trafilatura and Postlight Parser, on the Zyte article-extraction benchmark and on a
hand-annotated live corpus. Results: [RESULTS.md](RESULTS.md) and `results/latest.json`.

## Setup

```sh
cd eval
bun install
bunx playwright install chromium-headless-shell   # once; skip if ms-playwright already has build 1243
```

Trafilatura runs through `uv` from `eval/python` (`uv run` creates the venv from `uv.lock` on
first use; Python 3.12). Postlight runs under `node` (22+).

## Commands

| command | what it does |
| --- | --- |
| `bun run snapshot [--refresh] [--only id,id]` | Fetches every curated URL with the app's request headers into `test-corpus/live/` (raw bytes + `{finalUrl, status, contentType, fetchedAt}`); skips existing snapshots. |
| `bun run validate [--ids id,id] [--file batch.json]` | Checks every curated annotation: schema, snippet lengths, and that each `mustInclude`/`mustExclude` snippet occurs in the snapshot's page text. Exits 1 on any failure. |
| `bun run eval [--engines ours,ours-md,ours-dart,ours-go,readability,defuddle,trafilatura,postlight] [--dataset zyte\|curated\|all] [--runs 5] [--workers 4] [--ids id,id] [--timeout 60]` | Runs the engines, stores raw outputs in `test-corpus/eval-out/<dataset>/<engine>.json`, re-derives `results/latest.json` and `RESULTS.md`. `--ids` prints per-page results without saving. |
| `bun run report` | Re-derives the results and writes a self-contained dark HTML report to `$TMPDIR/extract-eval-report.html`. |
| `bun run failures [--engine ours] [--dataset zyte\|curated\|all] [--limit 20] [--snippets 4]` | Worst pages for an engine, sorted by the gap to the best other engine, with missed and leaked snippets, failed structure checks, and the text it missed or added. |
| `bun run dump <id>` | Annotation aid: a snapshot's text blocks with DOM paths. |
| `bun run markdown-cost [--dataset zyte\|curated\|all] [--runs 21] [--workers 4] [--ids id,id]` | What `markdown: true` adds to `extract` in Chromium: both variants on every page in the same renderer, alternating which runs first, per-page medians compared. |
| `bun run bench [--runs 11] [--ids key,key] [--skip go,dart,ts] [--keep go,dart,ts]` | The TypeScript, Dart and Go engines on the same pages (the parity dump, `bun scripts/parity-dump.ts` in `packages/truffle`): the whole pipeline (parse, tree, extract, Markdown) timed per phase, and memory per page. `--keep` reuses an engine's last results instead of running it. Writes `results/bench.json` and [results/benchmark.md](results/benchmark.md). |

The engine import is live: every `eval` run re-bundles `src/page.ts` together with
`packages/truffle/src` (about 50 ms), so after editing the engine just run
`bun run eval --engines ours`. Competitor outputs are kept from their last run, and every
score is re-derived from the stored outputs, so annotation fixes need no re-run either.

## Engines

| engine | version | how it runs | settings |
| --- | --- | --- | --- |
| ours | git HEAD of `packages/truffle` (`+dirty` if modified) | Chromium, `DOMParser` | `extract(doc, { url })`, text = `articleText(article)` |
| ours-md | same as ours | Chromium, `DOMParser` | `extract(doc, { url, markdown: true })` (timed); text and stats from `article.markdown` rendered to HTML by remark's parser (GFM + math) and mdast-util-to-hast |
| ours-dart | git HEAD of `packages/truffle_dart` (`+dirty` if modified) | Dart AOT (`dart compile exe`), package:html | `extractTree(fromDocument(parse(html)), url)`, summarized in Chromium exactly like ours |
| ours-go | git HEAD of `packages/truffle_go` (`+dirty` if modified) | Go native binary (`go build`, profile-guided with `cmd/truffle/default.pgo`), its own HTML5 parser | `ExtractTree(Parser.ParseDocument(html), {URL})`, summarized in Chromium exactly like ours |
| Readability | `@mozilla/readability` 0.6.0 | Chromium, `DOMParser` | `new Readability(doc).parse()` defaults |
| Defuddle | `defuddle` 0.19.4 (core bundle) | Chromium, `DOMParser` | `new Defuddle(doc, { url }).parse()` defaults |
| Trafilatura | 2.3.0 | CPython 3.12 + lxml | `extract(tree, url=url, include_comments=False)`, txt output (comments off as in the Zyte runner) |
| Postlight | `@postlight/parser` 2.2.3 | Node | `Parser.parse(url, { html, fetchAllPages: false })` |

Versions are pinned in `package.json`, the root `bun.lock`, `python/pyproject.toml` and `python/uv.lock`.

### Runtime and timing

- The three JS engines run inside headless Chromium (Playwright, one isolated context and
  renderer per worker). Each run parses a fresh document with the native `DOMParser` (engines
  mutate it), adds a `<base href>` with the page URL when the page has none, and times
  `parse` and `extract` separately with `performance.now()`; pages are cross-origin isolated
  for 5 µs timer resolution. Per page and engine: one warm-up run (its output is the one
  scored) and `--runs` timed runs, reported as the median. A warm-up slower than 5 s becomes the
  only timing sample, and a run exceeding `--timeout` is recorded as a failure.
- ours-dart: `packages/truffle_dart/tool/eval_cli.dart`, compiled with `dart compile exe` on
  every run (needs the Dart SDK), runs all pages in one process without workers. It times the
  package:html parse and the extraction separately with a `Stopwatch` (warm-up + `--runs`,
  median), adds the same `<base href>` the Chromium engines get, and returns the articles, which
  are summarized in Chromium with the `ours` code path. On identical page trees the port's
  output equals the TypeScript engine's byte for byte (`packages/truffle_dart/README.md`); here
  the parsers differ (Chromium vs package:html), so small differences are parser differences.
- ours-go: `packages/truffle_go/tools/evalcli`, built with `go build` on every run (needs Go
  1.24+), the same contract as the Dart runner: all pages in one process, parse
  (`ParseDocument`) and extraction (`ExtractTree`) timed separately (warm-up + `--runs`, median),
  the same `<base href>`, articles summarized in Chromium with the `ours` code path. On the jsdom
  trees the port's output equals the TypeScript engine's byte for byte (`packages/truffle_go/README.md`).
- Trafilatura: `load_html` (lxml parse) and `extract` timed separately with
  `time.perf_counter`, warm-up + `--runs`, median. Postlight parses with cheerio internally, so
  only its total is timed (reported as extraction).
- Phases run one after another (Chromium, then ours-dart, ours-go, Trafilatura, Postlight), each with
  `--workers` parallel workers. `latest.json` records the machine and its load average at the
  start and end of the run; timings on a loaded machine are inflated, so use `--workers 2` on a
  busy machine and compare engines within one run.

### The Markdown export (ours-md)

ours-md checks that `article.markdown` carries the article and renders properly. The Markdown is
rendered the way a consumer would render it (`mdast-util-from-markdown` with GFM and math, then
`mdast-util-to-hast`, which is what `remark-rehype` runs; math becomes `<math>` holding its TeX),
then scored like the other HTML outputs. The leading `# title`, GitHub alert markers and
footnote chrome (the "Footnotes" label, back-references) are removed first, as a reader view
shows them. Its text differs from ours by design: Markdown keeps figure captions and code titles
that `articleText` leaves out, and math as TeX. Its timing is `extract` with the option, so the
gap between ours and ours-md is the export's cost. Measured in one run, though, the two are
affected by run order and load; `bun run markdown-cost` measures the cost directly.

### TypeScript, Dart and Go side by side (`bun run bench`)

`bun run eval` times each engine the way it runs in production next to the competitors;
`bun run bench` compares the three Truffle engines on their own, on the same machine and pages,
phase by phase, with the Markdown export included: HTML in, article and Markdown out.

- Pages: every page of the parity dump (`test-corpus/parity/html/`, the decoded HTML the eval
  uses), no `<base>` added. Per page: one warm-up, then `--runs` timed runs (default 11); each
  phase is the median of its runs, and summaries are over pages.
- Phases: parse (Chromium's native `DOMParser` / package:html / the Go port's own HTML5 parser),
  tree (`fromDom` / `fromDocument` / `FromTree`: the compact copy the engine runs on), extract
  (`extractTree` / `ExtractTree`) and Markdown (`articleMarkdown` / `ArticleMarkdown`).
- Runtimes: TypeScript in headless Chromium (one renderer), Dart AOT
  (`packages/truffle_dart/tool/bench.dart --json`), Go native (`packages/truffle_go/tools/bench`,
  built with the CLI's profile for profile-guided optimization; the timed runs reuse one
  `truffle.Parser`, as a batch would). They run one after another, single-threaded.
- Memory per page: Go counts every byte the pipeline allocates for the page, from a fresh parse,
  with the garbage collector paused (`runtime.MemStats.TotalAlloc`): an upper bound on the heap the
  page needs. TypeScript reports how much the V8 heap and Blink's (the DOM) grow across one run
  whose results stay alive, after a full collection (DevTools `Runtime.getHeapUsage`;
  `performance.memory` does not move within a task); what V8 collects during the run is not
  counted. The Dart VM gives programs no heap counter, so Dart (and Go) also report the
  process's peak RSS for the whole run.

### Output normalization

Every engine's output becomes plain text the same way: HTML outputs (Readability, Defuddle,
Postlight `content`) are converted in Chromium with block elements and `<br>` as newlines and
table cells as tabs; ours uses `articleText(article)` (blocks joined by blank lines; figure and
video captions are excluded by design); Trafilatura uses its own txt output. Then all text gets
the same `normalizeText` (horizontal whitespace collapsed, lines trimmed, empty lines dropped).

Structure stats come from each engine's own output: code blocks (`<pre>` not nested / `code`
blocks), code languages (`language-*`/`lang-*`/`data-lang` markup, or ours' `language`),
images (`<img>` / figure images), headings (h2-h6 plus any h1 that is not the title / heading
blocks), tables, lists, math (`<math>`, KaTeX, MathJax / math blocks and inlines), footnotes
(definitions and references) and embeds (iframes, video, audio, social embeds / video, audio,
embed blocks). Trafilatura's stats come from its XML output (its defaults drop images).

## Datasets

### Zyte article-extraction-benchmark

181 real pages with human ground-truth article text,
[scrapinghub/article-extraction-benchmark](https://github.com/scrapinghub/article-extraction-benchmark)
pinned at `4a3bc97` (`src/zyte.ts`), downloaded on first use into `test-corpus/zyte/`.
`src/metric.ts` ports `evaluate.py` line for line: per-page TP/FP/FN over 4-token shingles
(Python `\w+` tokens, normalized to sum to 1), precision and recall averaged over pages, F1
from the averages, accuracy = identical token sequences, ± = bootstrap std over 1000
resamples (seeded), plus a 95% percentile interval for F1. Every eval re-scores the
benchmark's own committed outputs (`readability_js`, `trafilatura`, `html-text`) with the port
and compares them to the README table (the "Metric sanity check" section of RESULTS.md).

### Curated live corpus

`corpus/curated.json`: real article URLs from trivial clean blogs (tier 1) to the hardest pages
(tier 5) across simple blogs, news, technical blogs with code, docs frameworks, reference and
academic pages, interactive articles, non-English and RTL pages, and boilerplate-heavy pages
(recipes, comment walls, galleries, hubs). Each entry has hand-verified annotations taken from
its snapshot (see [corpus/ANNOTATION.md](corpus/ANNOTATION.md)):

- `title`: the headline as a reader view should show it.
- `mustInclude`: 4-6 verbatim snippets (8-20 words) from the start, middle and very last
  paragraph of the article body.
- `mustExclude`: up to 5 verbatim boilerplate snippets that are on the page but not the
  article (nav, footer, related, newsletter, comments, promos). Pages with no boilerplate text
  have fewer.
- Optional structure expectations: `minCodeBlocks`, `codeLanguages`, `minImages`,
  `minHeadings`, `minTables`, `hasMath`, `hasFootnotes`, `hasEmbeds`; plus `jsOnly` (article not
  in the raw HTML) and `annotationConfidence`.

Snippets match on a normalized key (NFKC, lowercase, curly quotes and dashes folded, all
whitespace removed), so whitespace and block-boundary differences never decide a match.
`corpus/blocked.json` lists candidate URLs that refused the app's request headers when the
corpus was built (403/405/402, consent walls); they are not in the corpus.

Curated metrics per engine: mustInclude recall, mustExclude leak rate and share of pages
leaking, title exact and fuzzy match, structure checks passed (per check and overall), code
language recall, and a combined page score = weighted mean of include recall (0.5),
1 − leak rate (0.2, zero for empty output), fuzzy title (0.1) and structure (0.2), with missing
components dropped and the rest renormalized. Reported overall, per tier and per category;
jsOnly pages are scored separately.

## Files

- `src/page.ts`: the Chromium page script (engines, timing, text and stats, annotation aids).
- `src/browser.ts`: Playwright pool and bundling. `src/corpus.ts`: paths, fetch headers,
  browser-style charset decoding, loaders. `src/metric.ts`, `src/zyte.ts`: Zyte metric and
  dataset. `src/score.ts`, `src/results.ts`: scoring, aggregation, `latest.json`, `RESULTS.md`.
- `python/run_trafilatura.py`, `node/run_postlight.mjs`: the out-of-browser runners.
- `test-corpus/` (gitignored): snapshots, the Zyte download, and raw outputs with article text.
