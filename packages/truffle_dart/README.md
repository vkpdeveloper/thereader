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
`articleText`, `blocksText`, `inlineText`, `countWords`, and the model.

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
verbatim, with the same flags. Where the TypeScript engine runs a costly pattern over running text
(calls to action, author bios), the port first checks a cheap condition every match implies (a
literal word, the first character) and skips the pattern when it fails; with assertions enabled
the pattern is checked as well.

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

On an Apple M5 (load average ~3.5-4.7 from other work), 326 corpus pages, 5 timed runs per page,
ms per page (median / p95 / mean):

| | AOT | JIT |
| --- | ---: | ---: |
| parse (package:html) | 2.39 / 16.6 / 4.94 | 2.53 / 17.4 / 5.41 |
| `fromDocument` | 0.33 / 2.39 / 0.72 | 0.38 / 2.71 / 0.82 |
| `extractTree` | 0.58 / 13.1 / 2.52 | 0.71 / 13.9 / 2.92 |
| extract (`fromDocument` + `extractTree`) | 0.97 / 14.4 / 3.24 | 1.19 / 15.1 / 3.74 |
| total | 3.53 / 27.4 / 8.18 | 3.99 / 32.8 / 9.15 |

The TypeScript engine on the same pages: Chromium parse 0.83 / 7.13 / 1.71, extract 1.23 / 9.11
/ 2.93, total 2.18 / 13.6 / 4.65; Bun `extractTree` 0.68 / 5.82 / 1.84. Per page, Dart AOT
extraction is 0.83x Chromium's at the median (1.7x at p95), `extractTree` 0.95x Bun's (2.2x at
p95); the gap in the total is package:html, a pure-Dart parser against Chromium's native one
(2.9x at the median). Pages over 1 MB (Wikipedia articles) are the slowest: 59 ms median total
(34 ms parse, 29 ms extract), against 31 ms in Chromium.

The rules added with the engine's quality pass (footnotes, TeX, frames, galleries, bios, calls to
action) cost Dart `extractTree` 7-11% at the median and about 10% on the mean, measured against the
previous port on the same pages and load; the TypeScript engine slowed by 9-16%.

The eval harness runs the AOT build as the `ours-dart` engine
(`cd eval && bun run eval --engines ours,ours-dart`); see `eval/README.md`.
