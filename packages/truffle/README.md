# truffle (TypeScript)

The article extraction engine: HTML in, a structured, renderable `Article` out (text, headings,
code with languages, math, tables, figures, media). This is the reference implementation, used
by the web app and the eval; `packages/truffle_dart` is its line-for-line Dart port and produces
the same JSON for the same page tree.

```ts
import { extract, articleText, type Article } from 'truffle';

const article: Article | null = extract(document, { url }); // a parsed DOM Document
const text = article ? articleText(article) : '';
```

## Markdown

Pass `markdown: true` to get the article as Markdown too, for consumers that render it
themselves. The blocks are returned either way, and without the option nothing changes (no
`markdown` key, no extra work).

```ts
const article = extract(document, { url, markdown: true }); // MarkdownArticle | null
article?.markdown; // "# Title\n\nFirst paragraph…\n"
```

`articleMarkdown(article)` and `blocksMarkdown(blocks)` convert an article or blocks you already
have (a stored article, for instance). The output is GitHub Flavored Markdown:

- the title as the one `#` heading, then the body; headings, paragraphs with `\` hard breaks,
  `**bold**`, `*italic*`, `~~strike~~`, code spans, links (`<url>` when the text is the URL);
- `-` and `1.` lists, tight unless an item holds several blocks, `[x]` task items, nested
  content indented under its marker; two lists in a row switch markers (`*`, `)`) so they stay
  apart;
- fenced code with the language (`title="…"` after it when the page named the file), fences
  longer than any backtick run inside;
- pipe tables (row and column spans become empty cells; a table without a header row gets an
  empty one), `$…$` and `$$…$$` math, `[^label]` footnotes (a note nothing calls is written as
  text, since GFM drops it), callouts as GitHub alerts (`> [!NOTE]`), figures as images with
  their caption below, video and audio as links, embeds as quotes with their source.

There is no raw HTML. Text is escaped where it would read as syntax (`*`, `_` outside words,
`[`, a `1.` or `#` starting a line, `$`, `<tag`, `&entity;`), bare URLs are left as written (GFM
links them), and emphasis no parser would see (a delimiter between a letter and punctuation, as in
`x**(y)**`) is written as plain text. Subscript, superscript, underline and highlight have no
Markdown form and are plain text; keyboard keys are code spans. A formula the page gave only as
MathML (no TeX) is written as its text, since Markdown has no MathML form.

Also exported: `extractHtml(html, { url, parse? })` (parses with `DOMParser` unless `parse` is
given), `extractTree(VDocument, options)` and `fromDom(Document)` (the two halves of the
pipeline), `cleanTitle`, `canonicalUrl`, `detectLanguage`, `normalizeLanguage`,
`languageFromClass`, `articleText`, `blocksText`, `inlineText`, `countWords`, `articleMarkdown`,
`blocksMarkdown`, and the model types.

## Using it in this repo

`truffle` is a member of the root Bun workspace (`package.json` at the repository root). A
consumer declares it like any other dependency and imports it by name:

```json
"dependencies": { "truffle": "workspace:*" }
```

`bun install` at the root (or in any workspace member) links `node_modules/truffle` to this
directory. The package ships TypeScript source (`exports` points at `src/index.ts`), which Vite
and Bun compile directly; there is no build step.

## Tests

```sh
bun test           # conformance fixtures (fixtures/), single rules, TeX, serialization order, Markdown
bun run typecheck
```

The Markdown tests compare `fixtures/expected/<name>.md` and `fixtures/markdown/cases.json`
(blocks in, Markdown out; both shared with the Dart port), and parse every output back with
remark (GFM + math, `test/markdown-oracle.ts`) to check that the tree holds exactly what the
blocks hold. `bun scripts/markdown-check.ts` runs the same check on every article of the eval
corpus (after `bun scripts/parity-dump.ts`).

`fixtures/` holds the conformance cases shared with the Dart port (see `fixtures/README.md`).

## Speed and memory

Two scripts compare the working tree with a baseline build of the engine (a checkout of an earlier
commit; `--baseline <its packages/truffle/src>`, by default `../truffle-perf-baseline` next to
this repository) on the eval corpus in `test-corpus/parity/` (`bun scripts/parity-dump.ts`, run
with the baseline, writes it). Chromium runs need Playwright's headless shell (see
`eval/README.md`).

```sh
bun scripts/verify-golden.ts             # Bun + jsdom: every output byte for byte against the golden files and the baseline
bun scripts/verify-golden.ts --browser   # the same against the baseline in Chromium, on DOMParser documents
bun scripts/bench.ts                     # time and memory, baseline → working tree, Chromium and Bun; Markdown tables
bun scripts/bench.ts --runtime chromium --every 8 --runs 5   # a quick look: every 8th page
bun scripts/bench.ts --profile next      # V8 CPU profile of extract over the corpus, top functions by self time
```

`verify-golden.ts` checks, per page: `extractTree(fromDom(doc), { url, markdown: true })`
serialized as the golden files are (`test-corpus/parity/ts/<key>.json`, the baseline's output;
`--golden <dir>` for another copy), `extract` and `extractTree` without Markdown, and, against the
baseline build on fresh trees, the `fromDom` tree, `articleText`, `blocksText`, `blocksMarkdown`
and `articleMarkdown`. It exits 1 at any difference and prints where the outputs first differ.

`bench.ts` runs each build in a runtime of its own (two copies of the engine in one V8 isolate slow
each other down) and alternates them page by page, so machine load reaches both alike. Per page and
phase (`fromDom`, `extractTree`, `articleMarkdown`, and the full `extract(doc, { url, markdown:
true })`) it takes the median of `--runs` runs after a warm-up, on a freshly parsed document each
run in Chromium (the first walk over a document builds its DOM wrappers, as in the app), and reports
median, p95, mean and corpus total, by HTML size and for the slowest pages. Memory comes from V8's
sampling heap profiler in Chromium: bytes allocated per phase, and bytes retained by the tree and
by the final output; the script's header says what each figure means and how precise it is.

On the eval corpus (326 pages; an Apple M-series machine with 4 performance cores, shared with other
work, so the times are indicative), baseline 84a0a8b → this version, `bun scripts/bench.ts --runs 10`.
Time per page in ms (the median of 10 runs per page), Chromium, the web app's runtime:

| phase | median | p95 | mean | corpus total | speedup (total) | per-page speedup (median) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fromDom | 0.37 → 0.28 | 2.53 → 1.84 | 0.82 → 0.60 | 266 → 195 | 1.36× | 1.31× |
| extractTree | 0.64 → 0.51 | 5.63 → 4.70 | 1.54 → 1.23 | 501 → 401 | 1.25× | 1.22× |
| markdown | 0.03 → 0.02 | 0.28 → 0.26 | 0.11 → 0.09 | 36.1 → 31.0 | 1.16× | 1.02× |
| extract | 1.07 → 0.83 | 7.71 → 6.50 | 2.46 → 1.91 | 801 → 623 | 1.29× | 1.26× |

Memory per page in Chromium (allocated: everything the phase allocates, garbage included;
retained: what the tree and the final output hold after a full collection):

| metric | median | p95 | mean | corpus total | change (total) |
| --- | ---: | ---: | ---: | ---: | ---: |
| allocated: fromDom | 274.5 KB → 219.9 KB | 2.14 MB → 1.65 MB | 594.4 KB → 473.5 KB | 193.79 MB → 154.36 MB | -20.3% |
| allocated: extractTree | 818.4 KB → 216.0 KB | 7.35 MB → 2.34 MB | 2.00 MB → 592.4 KB | 652.96 MB → 193.11 MB | -70.4% |
| allocated: markdown | 22.0 KB → 18.2 KB | 359.4 KB → 311.6 KB | 131.8 KB → 115.9 KB | 42.95 MB → 37.78 MB | -12.0% |
| allocated: extract (full) | 1.21 MB → 568.2 KB | 9.20 MB → 4.17 MB | 2.98 MB → 1.32 MB | 970.40 MB → 429.08 MB | -55.8% |
| retained: tree | 207.2 KB → 165.6 KB | 1.47 MB → 1.26 MB | 413.8 KB → 332.5 KB | 134.91 MB → 108.39 MB | -19.7% |
| retained: output | 32.6 KB → 25.2 KB | 339.0 KB → 343.5 KB | 117.1 KB → 99.3 KB | 38.19 MB → 32.39 MB | -15.2% |

Time per page in ms under Bun (JavaScriptCore) on jsdom documents, as the tests parse:

| phase | median | p95 | mean | corpus total | speedup (total) | per-page speedup (median) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fromDom | 1.97 → 1.23 | 11.9 → 6.85 | 3.98 → 2.36 | 1296 → 768 | 1.69× | 1.65× |
| extractTree | 0.78 → 0.64 | 5.84 → 4.78 | 1.90 → 1.47 | 619 → 481 | 1.29× | 1.23× |
| markdown | 0.03 → 0.03 | 0.27 → 0.26 | 0.11 → 0.10 | 34.9 → 31.7 | 1.10× | 1.07× |
| extract | 2.92 → 1.92 | 17.7 → 11.5 | 6.00 → 3.95 | 1956 → 1288 | 1.52× | 1.49× |
