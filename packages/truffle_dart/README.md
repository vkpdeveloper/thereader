# truffle (Dart)

The article extraction engine the mobile app runs: HTML in, a structured `Article` out. It is a
line-for-line port of the TypeScript engine in `packages/truffle` (the reference, used by the
web app), and produces the same JSON for the same page tree.

```dart
import 'package:truffle/truffle.dart';

final Article? article = extractArticle(html, Uri.parse(url)); // package:html parse + extraction
final json = article?.toJson();                                // TypeScript key order
```

Also exported: `extractHtml(html, url)` (URL string as given), `extractTree(VDocument, url)` and
`fromDocument(Document)` (the two halves of the pipeline), `VDocument.fromJson`/`toJson`,
`cleanTitle`, `canonicalUrl`, `detectLanguage`, `normalizeLanguage`, `languageFromClass`,
`articleText`, `blocksText`, `inlineText`, `countWords`, `articleMarkdown`, `blocksMarkdown`, and
the model.

`markdown: true` (on `extractArticle`, `extractHtml` and `extractTree`) also writes the article
as GitHub Flavored Markdown into `article.markdown`, the last key of its JSON, exactly as the
TypeScript engine's `markdown` option does; without it the field is null and the JSON is unchanged.
`articleMarkdown(article)` and `blocksMarkdown(blocks)` convert stored articles.

## Using it in this repo

`truffle` is a member of the root pub workspace (`pubspec.yaml` at the repository root, with
`resolution: workspace` in each member). A consumer declares it by version, and pub resolves
it to this directory:

```yaml
dependencies:
  truffle: ^0.1.0
```

`flutter pub get` or `dart pub get` anywhere in the workspace resolves every member together
into the root `pubspec.lock` and `.dart_tool/package_config.json`.

## Layout

One file per TypeScript file in `lib/src/` (`tree`, `url`, `metadata`, `content`, `blocks`,
`media`, `languages`, `extract`, `text`, `markdown`, `model`), plus:

- `dom.dart`: `fromDocument`, the package:html counterpart of `fromDom` (the only
  platform-specific stage).
- `js.dart`: JavaScript semantics where Dart differs: `trim` and `\s` (U+0085 is not
  whitespace), `toLowerCase` special casing, `split('')`, `Number()`, `parseInt`, number
  formatting, `decodeURIComponent`, object key order; and per-code-point `\p{L}\p{N}` and
  `\p{P}\p{S}` lookups.
- `match.dart`: `ClassPattern`. Class/id patterns that are alternations of literal words match
  by string search (the Dart VM interprets regular expressions in AOT builds, far slower than
  V8); the words are derived from the same pattern source, and with assertions enabled every
  call is checked against the `RegExp`. Also `requiredLiterals`, which derives from a pattern's
  source the strings one of which every match contains, and the two screens built on it:
  `ScreenedPattern` (a `RegExp` run only on subjects holding one of its literals; URLs, image
  sources, frames) and `LiteralScreen` (one subject, many patterns: the code-language rules).
- `url.dart` ports the WHATWG URL parser so `new URL(href, base).href` resolves identically,
  with a concatenation fast path for plain http(s) references, protocol-relative ones and
  non-ASCII paths (also asserted against the parser).

Dart regular expressions are ECMAScript's (irregexp), so the patterns are the TypeScript ones
verbatim, with the same flags. Where the TypeScript engine runs a costly pattern over running text
or over every element (calls to action, author bios, UI and promo lines, hidden styles), the port
first checks a cheap condition every match implies (a required literal, the first word or
character, a prefix) and skips the pattern when it fails; with assertions enabled the pattern is
checked as well.

## Tests: `dart test`

- `conformance_test.dart`: the shared fixtures in `packages/truffle/fixtures`. Each page is
  parsed with package:html and extracted with its manifest URL; the JSON must equal
  `expected/<name>.json`, and `JsonEncoder.withIndent('  ')` must reproduce the file byte for
  byte.
- `parser_test.dart`: `fromDocument` against the tree jsdom gives the TypeScript engine for
  small pages (`test/fixtures/parser_cases.json`, regenerate with
  `bun scripts/parser-cases.ts` in `packages/truffle`). Cases marked `known` are the parser
  differences below.
- `match_test.dart`, `model_test.dart`: `ClassPattern` against `RegExp`; model round trips.
- `markdown_test.dart`: `article.markdown` for every conformance page must equal
  `expected/<name>.md` byte for byte (and be absent without `markdown: true`), and
  `blocksMarkdown` must reproduce every case in `fixtures/markdown/cases.json`; both are written by
  `packages/truffle/test/markdown.test.ts`.
- `tex_test.dart`: TeX split out of text, the same cases as `packages/truffle/test/tex.test.ts`
  (input that once looped forever runs in an isolate killed on timeout).

## Parity with the TypeScript engine (eval corpus)

```sh
cd packages/truffle && bun scripts/parity-dump.ts      # writes test-corpus/parity/ (jsdom trees, TS outputs, HTML)
cd ../truffle_dart
dart run tool/parity.dart engine    # Dart extractTree on the jsdom VDocuments vs TS: parser excluded
dart run tool/parity.dart pipeline  # Dart extractHtml on the raw HTML (package:html) vs TS on jsdom
dart run tool/parity.dart tree      # the trees themselves: package:html + fromDocument vs jsdom + fromDom
dart --enable-asserts tool/parity.dart engine   # also checks every ClassPattern and URL fast path
```

`--ids key,key` selects pages, `--out dir` writes the Dart outputs for diffing. The TypeScript
outputs are written with `markdown: true` and `engine`/`pipeline` extract with it, so the
comparison covers `article.markdown` too.

Results on the 326 corpus pages (145 curated, 181 Zyte): **engine 326/326 byte-identical,
pipeline 326/326 byte-identical**, Markdown included.

### Parser differences (package:html vs parse5/jsdom)

`fromDocument` reproduces what a parser with scripting disabled builds where package:html
differs by design: `<noscript>` content is markup (package:html keeps it as raw text, so it is
re-parsed; in `<head>`, anything but `link`/`meta`/`style` ends the head and opens the body,
as browsers do), and the newline right after `<pre>` inside a table cell is dropped. What
remains is in package:html's tree builder, which predates parts of the HTML standard:

- `<template>` is an ordinary element (no template contents, allowed in `<head>` only as an
  unknown element, so it ends the head early);
- `<main>` is not a special element: `</main>` does not close open elements and `<main>` does
  not close an open `<p>`;
- `<menu>` is not special: an `<li>` inside it closes an enclosing `<li>`;
- adjusted foreign attributes (`xmlns`, `xlink:*`, camelCase SVG names) move to the end of the
  attribute list (only visible on `<svg>`, which the engine drops, and in MathML serialization);
- block content inside a body `<noscript>` does not close an open `<p>` (it is re-parsed in
  isolation).

jsdom itself has one quirk the port does not copy: it appends foster-parented text after the
table instead of before it, as browsers and package:html do.

On the corpus (`tree` mode) the trees are identical for 205 of 326 pages; 116 differ only in
attribute order on `<svg>`, 5 structurally (`<template>` 2, `<main>` 1, `<menu>` 2). None of
them changes the extracted article.

## Speed

```sh
dart compile exe tool/bench.dart -o /tmp/bench && /tmp/bench --runs 5   # AOT, as in the app
dart run tool/bench.dart                                                  # JIT
```

Per page: parse (package:html), `fromDocument`, `extractTree` and `articleMarkdown` timed
separately, then `extractHtml(html, url, markdown: true)` as one call; median of the timed runs;
summaries over pages and by HTML size, next to the TypeScript timings for the same pages
(Chromium from the last eval run, Bun `extractTree` from the parity dump). `--json file` writes
the per-page medians.

### Memory

```sh
dart --enable-vm-service=0 --disable-service-auth-codes tool/bench_memory.dart alloc   # JIT
dart compile exe tool/bench_memory.dart -o /tmp/bench-memory && /tmp/bench-memory rss [--ids key]
```

- `alloc`: bytes allocated per page and phase, and the live size of the trees (package:html's
  `Document`, the `VDocument`, and both at the end of `fromDocument`, the pipeline's peak of live
  data). Read through the VM service (dart:io, no package): a phase's allocation is the growth of
  the heap's used bytes across it from a just-collected heap, plus what every collection during
  the phase freed (the VM timeline's GC events); the service exchange (~160 KB) is measured and
  subtracted. Exact to about 1 KB per collection, checked against allocations of known size.
  Live sizes are the bytes of all instances after a full collection. JIT code after a warm-up
  pass; AOT allocates the same objects. (The VM's allocation profile is no substitute: its
  accumulated sizes only count objects that survive a scavenge.)
- `rss`: peak resident set size (`ProcessInfo.maxRss`) of an AOT process extracting the whole
  corpus, or one page (`--ids`: its peak over the RSS just before parsing). Coarse (the GC's
  growth policy decides when garbage is returned), and dominated by package:html: its input
  stream holds 8 bytes per character of the page while it parses.

### Before and after

```sh
dart run tool/bench_compare.dart --base <baseline checkout>/packages/truffle_dart \
  [--rounds 3] [--runs 5] [--rss-pages 8]
```

Builds `tool/bench.dart` and `tool/bench_memory.dart` from both checkouts (copy the tools into
the baseline's `tool/` if it predates them), alternates the two builds in ABBA order so machine
load weighs on both alike, takes per page the lowest of the round medians, and prints the tables
below. `tool/golden.dart write` in the baseline and `check` here (also AOT-compiled) proves the
outputs identical: engine and pipeline JSON with Markdown, the pipeline without it, `articleText`,
and the `fromDocument` tree.

Profiling: `tool/profile.dart` samples the JIT (`--regexp_optimization_counter_threshold=-1`
keeps regular expressions interpreted, as in AOT; `--callers`, `--within`), and
`tool/profile_aot.dart` is a load for a native sampler on an unstripped AOT snapshot, whose
symbols name the Dart functions (`dart compile aot-snapshot`, `dartaotruntime`, macOS `sample`).

The performance pass against the port before it (84a0a8b), on an Apple M5 at load average ~4
from other work, 326 corpus pages, 3 ABBA rounds × 5 timed runs, AOT, ms per page:

| | median before → after | p95 before → after | mean before → after | corpus total | speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| parse (package:html) | 3.55 → 3.35 | 22.6 → 22.5 | 6.81 → 6.82 | 2221 → 2224 ms | 1.00x |
| `fromDocument` | 0.50 → 0.26 | 3.08 → 1.71 | 0.98 → 0.51 | 319 → 166 ms | 1.92x |
| `extractTree` | 0.77 → 0.71 | 20.4 → 9.85 | 3.56 → 2.25 | 1162 → 735 ms | 1.58x |
| `articleMarkdown` | 0.04 → 0.04 | 0.54 → 0.51 | 0.22 → 0.21 | 72 → 68 ms | 1.06x |
| `extractHtml(markdown: true)` | 5.22 → 4.83 | 42.8 → 26.7 | 11.7 → 9.92 | 3821 → 3235 ms | 1.18x |

Pages over 1 MB: 84.8 → 64.8 ms median for `extractHtml(markdown: true)`. Memory (allocation
JIT, MB per page median / p95 / mean; RSS AOT):

| | before | after |
| --- | ---: | ---: |
| allocated by `fromDocument` | 0.64 / 4.55 / 1.36 | 0.30 / 2.00 / 0.65 |
| allocated by `extractTree` | 0.40 / 5.13 / 1.49 | 0.38 / 4.52 / 1.18 |
| allocated by `extractHtml(markdown: true)` (parse: 3.7 of the 4.4 GB) | 7.40 / 41.4 / 14.5 | 6.99 / 37.1 / 13.4 |
| live `VDocument` | 0.52 / 3.90 / 1.08 | 0.46 / 3.37 / 0.97 |
| live `Document` + `VDocument` (peak of live data) | 1.13 / 6.99 / 2.23 | 0.93 / 5.54 / 1.84 |
| peak RSS, whole corpus in one process | 217 MB | 213 MB |
| peak RSS for one page, frwiki Paris (3 MB) / dewiki Berlin (1.7 MB) | 87.7 / 71.7 MB | 86.9 / 61.5 MB |

Parse is now about 70% of the pipeline and nearly all of its allocation, and package:html offers
no way to do less of it without changing the tree. What the pass changed, in order of effect:
the code-language detector's 283 patterns run only when the code holds a literal they require
(`requiredLiterals`); `fromDocument` reads attributes through package:html's map instead of
copying it, tests hidden elements without patterns, and finds the root without a CSS selector;
URL resolution takes non-ASCII and protocol-relative references by concatenation; patterns run on
every element, link, image, frame, short text and paragraph are screened by a required literal,
first word or prefix; class matching and the per-node passes do less per call; per-node flags and
counts are packed into one field; the article text is built once.

The TypeScript engine on the same pages, before this pass (load ~3.5-4.7): Chromium parse 0.83 /
7.13 / 1.71, extract 1.23 / 9.11 / 2.93, total 2.18 / 13.6 / 4.65; Bun `extractTree` 0.68 /
5.82 / 1.84. The gap in the total is package:html, a pure-Dart parser against Chromium's native
one.

The rules added with the engine's quality pass (footnotes, TeX, frames, galleries, bios, calls to
action) cost Dart `extractTree` 7-11% at the median and about 10% on the mean, measured against the
previous port on the same pages and load; the TypeScript engine slowed by 9-16%.

`articleMarkdown` (what `markdown: true` adds, timed on its own in the bench and not in the totals)
costs 0.03 ms per page at the median, 0.19 at p90 and 0.36 at p95 in AOT (4.8 ms for the largest
article, 630 KB of Markdown, against 60 ms of `extractTree`): 6% of `extractTree` at the median,
12% at p90. Bun writes the same Markdown in 0.01 / 0.10 / 0.21 ms. Its scans are code-unit loops
(one pass per text run finds both the syntax characters and any address), with no regular
expression per character.

The eval harness runs the AOT build as the `ours-dart` engine
(`cd eval && bun run eval --engines ours,ours-dart`); see `eval/README.md`.
