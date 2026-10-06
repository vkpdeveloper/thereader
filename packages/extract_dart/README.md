# thereader_extract (Dart)

The article extraction engine the mobile app runs: HTML in, a structured `Article` out. It is a
line-for-line port of the TypeScript engine in `packages/extract` (the reference, used by the
web app), and produces the same JSON for the same page tree.

```dart
import 'package:thereader_extract/thereader_extract.dart';

final Article? article = extractArticle(html, Uri.parse(url)); // package:html parse + extraction
final json = article?.toJson();                                // TypeScript key order
```

Also exported: `extractHtml(html, url)` (URL string as given), `extractTree(VDocument, url)` and
`fromDocument(Document)` (the two halves of the pipeline), `VDocument.fromJson`/`toJson`,
`cleanTitle`, `canonicalUrl`, `detectLanguage`, `normalizeLanguage`, `languageFromClass`,
`articleText`, `blocksText`, `inlineText`, `countWords`, and the model.

## Layout

One file per TypeScript file in `lib/src/` (`tree`, `url`, `metadata`, `content`, `blocks`,
`media`, `languages`, `extract`, `text`, `model`), plus:

- `dom.dart`: `fromDocument`, the package:html counterpart of `fromDom` (the only
  platform-specific stage).
- `js.dart`: JavaScript semantics where Dart differs: `trim` and `\s` (U+0085 is not
  whitespace), `toLowerCase` special casing, `split('')`, `Number()`, `parseInt`, number
  formatting, `decodeURIComponent`, object key order.
- `match.dart`: `ClassPattern`. Class/id patterns that are alternations of literal words match
  by string search (the Dart VM interprets regular expressions in AOT builds, far slower than
  V8); the words are derived from the same pattern source, and with assertions enabled every
  call is checked against the `RegExp`.
- `url.dart` ports the WHATWG URL parser so `new URL(href, base).href` resolves identically,
  with a concatenation fast path for plain http(s) references (also asserted against the
  parser).

Dart regular expressions are ECMAScript's (irregexp), so the patterns are the TypeScript ones
verbatim, with the same flags.

## Tests: `dart test`

- `conformance_test.dart`: the shared fixtures in `packages/extract/fixtures`. Each page is
  parsed with package:html and extracted with its manifest URL; the JSON must equal
  `expected/<name>.json`, and `JsonEncoder.withIndent('  ')` must reproduce the file byte for
  byte.
- `parser_test.dart`: `fromDocument` against the tree jsdom gives the TypeScript engine for
  small pages (`test/fixtures/parser_cases.json`, regenerate with
  `bun scripts/parser-cases.ts` in `packages/extract`). Cases marked `known` are the parser
  differences below.
- `match_test.dart`, `model_test.dart`: `ClassPattern` against `RegExp`; model round trips.

## Parity with the TypeScript engine (eval corpus)

```sh
cd packages/extract && bun scripts/parity-dump.ts      # writes test-corpus/parity/ (jsdom trees, TS outputs, HTML)
cd ../extract_dart
dart run tool/parity.dart engine    # Dart extractTree on the jsdom VDocuments vs TS: parser excluded
dart run tool/parity.dart pipeline  # Dart extractHtml on the raw HTML (package:html) vs TS on jsdom
dart run tool/parity.dart tree      # the trees themselves: package:html + fromDocument vs jsdom + fromDom
dart --enable-asserts tool/parity.dart engine   # also checks every ClassPattern and URL fast path
```

`--ids key,key` selects pages, `--out dir` writes the Dart outputs for diffing.

Results on the 326 corpus pages (145 curated, 181 Zyte): **engine 326/326 byte-identical,
pipeline 326/326 byte-identical**.

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

Per page: parse (package:html), `fromDocument` and `extractTree` timed separately, median of the
timed runs; summaries over pages and by HTML size, next to the TypeScript timings for the same
pages (Chromium from the last eval run, Bun `extractTree` from the parity dump).

On an Apple M5 (load average ~7 from other work, so absolute numbers are somewhat inflated),
326 corpus pages, 5 timed runs per page, ms per page (median / p95 / mean):

| | AOT | JIT |
| --- | ---: | ---: |
| parse (package:html) | 4.85 / 36.8 / 10.3 | 3.82 / 34.7 / 9.63 |
| `fromDocument` | 0.71 / 5.24 / 1.49 | 0.63 / 5.70 / 1.45 |
| `extractTree` | 1.14 / 29.1 / 4.97 | 1.06 / 25.7 / 4.83 |
| extract (`fromDocument` + `extractTree`) | 1.95 / 32.8 / 6.46 | 1.87 / 28.4 / 6.27 |
| total | 7.49 / 57.8 / 16.8 | 6.28 / 61.0 / 15.9 |

The TypeScript engine on the same pages: Chromium parse 1.57 / 14.3 / 3.22, extract 2.04 / 16.5
/ 4.70, total 3.94 / 24.1 / 7.92; Bun `extractTree` 0.90 / 11.3 / 2.47. Per page, Dart AOT
extraction is 0.98x Chromium's at the median (2.3x at p95), `extractTree` 1.4x Bun's (4.1x at
p95); the gap in the total is package:html, a pure-Dart parser against Chromium's native one
(3x at the median). Pages over 1 MB (Wikipedia articles) are the slowest: 129 ms median total
(69 ms parse, 59 ms extract), against 51 ms in Chromium.

The eval harness runs the AOT build as the `ours-dart` engine
(`cd eval && bun run eval --engines ours,ours-dart`); see `eval/README.md`.
