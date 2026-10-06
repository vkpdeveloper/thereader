# Article extraction eval

Quality and speed of `truffle` (`packages/truffle`) and its Dart port
(`packages/truffle_dart`, the engine the mobile app runs) against Mozilla Readability,
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
| `bun run eval [--engines ours,ours-dart,readability,defuddle,trafilatura,postlight] [--dataset zyte\|curated\|all] [--runs 5] [--workers 4] [--ids id,id] [--timeout 60]` | Runs the engines, stores raw outputs in `test-corpus/eval-out/<dataset>/<engine>.json`, re-derives `results/latest.json` and `RESULTS.md`. `--ids` prints per-page results without saving. |
| `bun run report` | Re-derives the results and writes a self-contained dark HTML report to `$TMPDIR/extract-eval-report.html`. |
| `bun run failures [--engine ours] [--dataset zyte\|curated\|all] [--limit 20] [--snippets 4]` | Worst pages for an engine, sorted by the gap to the best other engine, with missed and leaked snippets, failed structure checks, and the text it missed or added. |
| `bun run dump <id>` | Annotation aid: a snapshot's text blocks with DOM paths. |

The engine import is live: every `eval` run re-bundles `src/page.ts` together with
`packages/truffle/src` (about 50 ms), so after editing the engine just run
`bun run eval --engines ours`. Competitor outputs are kept from their last run, and every
score is re-derived from the stored outputs, so annotation fixes need no re-run either.

## Engines

| engine | version | how it runs | settings |
| --- | --- | --- | --- |
| ours | git HEAD of `packages/truffle` (`+dirty` if modified) | Chromium, `DOMParser` | `extract(doc, { url })`, text = `articleText(article)` |
| ours-dart | git HEAD of `packages/truffle_dart` (`+dirty` if modified) | Dart AOT (`dart compile exe`), package:html | `extractTree(fromDocument(parse(html)), url)`, summarized in Chromium exactly like ours |
| Readability | `@mozilla/readability` 0.6.0 | Chromium, `DOMParser` | `new Readability(doc).parse()` defaults |
| Defuddle | `defuddle` 0.19.4 (core bundle) | Chromium, `DOMParser` | `new Defuddle(doc, { url }).parse()` defaults |
| Trafilatura | 2.3.0 | CPython 3.12 + lxml | `extract(tree, url=url, include_comments=False)`, txt output (comments off as in the Zyte runner) |
| Postlight | `@postlight/parser` 2.2.3 | Node | `Parser.parse(url, { html, fetchAllPages: false })` |

Versions are pinned in `package.json`, `bun.lock`, `python/pyproject.toml` and `python/uv.lock`.

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
- Trafilatura: `load_html` (lxml parse) and `extract` timed separately with
  `time.perf_counter`, warm-up + `--runs`, median. Postlight parses with cheerio internally, so
  only its total is timed (reported as extraction).
- Phases run one after another (Chromium, then ours-dart, Trafilatura, Postlight), each with
  `--workers` parallel workers. `latest.json` records the machine and its load average at the
  start and end of the run; timings on a loaded machine are inflated, so use `--workers 2` on a
  busy machine and compare engines within one run.

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
