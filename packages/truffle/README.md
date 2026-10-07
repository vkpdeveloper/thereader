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
| fromDom | 0.37 → 0.28 | 2.35 → 1.75 | 0.80 → 0.58 | 260 → 190 | 1.36× | 1.32× |
| extractTree | 0.63 → 0.49 | 5.50 → 4.62 | 1.51 → 1.18 | 491 → 384 | 1.28× | 1.25× |
| markdown | 0.03 → 0.02 | 0.28 → 0.25 | 0.11 → 0.09 | 35.0 → 30.3 | 1.16× | 1.05× |
| extract | 1.07 → 0.83 | 7.68 → 6.30 | 2.41 → 1.85 | 786 → 602 | 1.30× | 1.27× |

Memory per page in Chromium (allocated: everything the phase allocates, garbage included;
retained: what the tree and the final output hold after a full collection):

| metric | median | p95 | mean | corpus total | change (total) |
| --- | ---: | ---: | ---: | ---: | ---: |
| allocated: fromDom | 275.5 KB → 221.9 KB | 2.07 MB → 1.64 MB | 593.6 KB → 474.2 KB | 193.52 MB → 154.57 MB | -20.1% |
| allocated: extractTree | 819.7 KB → 222.0 KB | 7.37 MB → 2.29 MB | 1.99 MB → 604.6 KB | 649.60 MB → 197.09 MB | -69.7% |
| allocated: markdown | 21.1 KB → 19.9 KB | 383.4 KB → 298.0 KB | 131.1 KB → 115.1 KB | 42.72 MB → 37.52 MB | -12.2% |
| allocated: extract (full) | 1.22 MB → 572.5 KB | 9.26 MB → 4.18 MB | 2.94 MB → 1.33 MB | 959.81 MB → 433.85 MB | -54.8% |
| retained: tree | 202.7 KB → 168.1 KB | 1.45 MB → 1.29 MB | 409.0 KB → 333.9 KB | 133.34 MB → 108.86 MB | -18.4% |
| retained: output | 33.3 KB → 24.5 KB | 331.0 KB → 347.5 KB | 116.5 KB → 99.3 KB | 37.97 MB → 32.36 MB | -14.8% |

Time per page in ms under Bun (JavaScriptCore) on jsdom documents, as the tests parse:

| phase | median | p95 | mean | corpus total | speedup (total) | per-page speedup (median) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fromDom | 2.01 → 1.22 | 12.3 → 6.45 | 4.00 → 2.42 | 1305 → 788 | 1.66× | 1.62× |
| extractTree | 0.77 → 0.60 | 5.61 → 4.47 | 1.89 → 1.43 | 617 → 466 | 1.32× | 1.26× |
| markdown | 0.03 → 0.03 | 0.27 → 0.27 | 0.11 → 0.10 | 34.7 → 32.0 | 1.08× | 1.06× |
| extract | 2.91 → 1.89 | 16.8 → 10.9 | 6.06 → 3.98 | 1976 → 1297 | 1.52× | 1.49× |
