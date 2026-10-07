# truffle (Go)

Truffle, the article extraction engine, for Go: HTML in, a structured, renderable `Article`
out (text, headings, code with languages, math, tables, figures, media) and, on request, the
article as GitHub Flavored Markdown. It is a port of the TypeScript engine in `packages/truffle`
(the reference) and produces the same JSON and Markdown, byte for byte, for the same page tree.
It has its own HTML5 parser and no dependencies, and ships as a library and a command-line tool.

The apps do not use it; it exists to run Truffle where Go does (servers, pipelines, CLIs) and to
show how fast the engine can go. See [Speed and memory](#speed-and-memory).

## Library

```sh
go get github.com/vkpdeveloper/thereader/packages/truffle_go
```

```go
import truffle "github.com/vkpdeveloper/thereader/packages/truffle_go"

article := truffle.ExtractHTML(html, truffle.Options{URL: pageURL, Markdown: true}) // nil: no article
if article != nil {
	fmt.Println(article.Title, article.WordCount)
	fmt.Print(*article.Markdown)       // "# Title\n\nFirst paragraph…"
	os.Stdout.Write(article.JSON("  ")) // the model of packages/truffle/src/model.ts
}
```

`html` is the decoded page (UTF-8); `URL` is where it was fetched from (after redirects) and
resolves relative links. The pipeline also comes in halves, as in the TypeScript engine:
`ParseDocument(html)` (or `ParseHTML` then `FromTree`) builds the compact tree, and
`ExtractTree(doc, opts)` extracts from it (once per tree: extraction marks it).

For many pages in a row, a `truffle.Parser` parses each page into the memory of the one before
(still in the processor's cache), which saves about a fifth of the parse time; a tree it
returned is invalid after its next parse. `ExtractHTML` does the same internally, through a pool.

The model is `Article` with `Blocks []Block` (`*Heading`, `*Paragraph`, `*List`, `*Quote`,
`*Code`, `*Figure`, `*Video`, `*Audio`, `*Embed`, `*Table`, `*Rule`, `*MathBlock`,
`*DefinitionList`, `*Details`, `*Callout`, `*Footnotes`) and inline content `[]Inline`
(`*TextRun`, `*LineBreak`, `*InlineImage`, `*InlineMath`, `*FootnoteRef`). `Article.JSON(indent)`
writes it exactly as `JSON.stringify(article, null, indent)` does in the TypeScript engine (model
key order, absent optionals omitted), and `ParseArticleJSON` reads what any engine wrote.

Also exported: `ArticleMarkdown`, `BlocksMarkdown`, `ArticleText`, `BlocksText`, `InlineText`,
`CountWords`, `CleanTitle`, `CanonicalURL`, `DetectLanguage`, `NormalizeLanguage`,
`LanguageFromClass`, `ReadDocumentJSON` (a tree dumped by `packages/truffle/scripts/vdoc-json.ts`).

Extraction is safe to run concurrently on different pages.

## Command line

```sh
go install github.com/vkpdeveloper/thereader/packages/truffle_go/cmd/truffle@latest
# or, in this directory: go build -o truffle ./cmd/truffle

truffle https://example.com/post                       # fetch, extract, print the article JSON
truffle -format markdown -url https://example.com/post page.html
curl -s https://example.com/post | truffle -url https://example.com/post -format text -
truffle -timing -compact a.html b.html                  # JSON Lines, parse/extract times on stderr
```

A URL is fetched with the reader app's request headers; files and standard input are decoded
the way a browser picks the encoding (BOM, `Content-Type`, `<meta>` prescan, UTF-8), or with
`-charset`. The output is JSON (`-markdown` adds the Markdown field), `-format markdown` or
`-format text`; a page without an article prints `null` (JSON) and exits with status 3. The CLI
uses `golang.org/x/net/html/charset` for legacy encodings; the library imports nothing outside
the standard library.

## Layout

One file per TypeScript file (`tree`, `url`, `metadata`, `content`, `blocks`, `media`,
`languages`, `extract`, `text`, `markdown`, `model`), plus:

- `html_*.go`: the HTML5 parser, a fork of `golang.org/x/net/html`'s tree construction
  (scripting disabled, as `DOMParser` and jsdom parse) that builds the engine's nodes directly,
  from slabs, with text and attribute values sliced from the source when nothing needs decoding.
- `dom.go`: `FromTree`, the counterpart of `fromDom`: filters the parsed tree in place into the
  Document the engine runs on (no second tree).
- `js.go`: JavaScript semantics where Go differs. Strings are UTF-8 in Go and UTF-16 in
  JavaScript: lengths compared with constants and fixed offsets count UTF-16 code units
  (`u16len`); `trim` and `\s` are JavaScript's whitespace (U+FEFF yes, U+0085 no);
  `toLowerCase` special casing; `Number()`, `parseInt`, number formatting,
  `decodeURIComponent`, object key order.
- `jsre.go`: ECMAScript patterns on Go's RE2: `jsRegexp` rewrites `\s`, `\S` (inside classes
  too), `.` and `\u` escapes so the same source matches the same text. Patterns that need
  lookaround are matched by hand-written code. Class and id patterns that are alternations of
  literal words match by string search, cached per element; costly patterns over running text
  first check a literal every match contains.
- `whatwg.go`: the WHATWG URL parser, so `new URL(href, base).href` resolves identically.
- `cmd/truffle`: the CLI. `tools/parity`, `tools/evalcli`, `tools/bench`: corpus parity, the
  eval engine `ours-go` and the benchmark.

## Tests: `go test ./...`

- `conformance_test.go`: the shared fixtures in `packages/truffle/fixtures`, parsed with this
  package's parser: the JSON must equal `expected/<name>.json` byte for byte (2-space
  indent) and the Markdown `expected/<name>.md`; the model round-trips every expected file.
- `markdown_test.go`: `fixtures/markdown/cases.json`, the expected Markdown of every fixture and
  of every corpus article (when `test-corpus/` is present).
- `url_test.go`, `languages_test.go`, `html_test.go`: URL resolution, language detection and
  the parser against the TypeScript functions and `golang.org/x/net/html` (corpus cases when
  `test-corpus/` is present).

## Parity with the TypeScript engine (eval corpus)

```sh
cd packages/truffle && bun scripts/parity-dump.ts   # writes test-corpus/parity/ (jsdom trees, TS outputs, HTML)
cd ../truffle_go
go run ./tools/parity engine     # Go ExtractTree on the jsdom trees vs TS: parser excluded
go run ./tools/parity pipeline   # Go ExtractHTML on the raw HTML vs TS on jsdom
```

`-ids key,key` selects pages, `-out dir` writes the Go outputs and the first difference of each
page, `-markdown=false` leaves `article.markdown` out of the comparison.

On the eval corpus (325 pages: the Zyte benchmark and the curated set) both modes are
identical to the TypeScript engine on every page, JSON and Markdown: `engine` 325/325 and
`pipeline` 325/325. So are 1,900 generated pages (`bun tools/parity/fuzz.ts <dir> 1500 1234`
and `<dir> 400 7`: random documents mixing every construct the engine has rules for, such as
code, math, tables, figures, footnotes, embeds, callouts, bylines, hidden and boilerplate
markup, odd whitespace and links), compared the same way.
The conformance fixtures pass byte for byte with this package's parser. The HTML parser agrees
with `golang.org/x/net/html` on every corpus page, apart from two x/net bugs where it follows
the standard and parse5 instead (`html_test.go`), and passes the same html5lib
tree-construction tests as x/net plus one.

## Speed and memory

`bun run bench` in `eval/` runs the three engines one after another on the 325 pages of the
parity dump: the whole pipeline (parse, tree, extract, Markdown), 11 timed runs per page after a
warm-up, per-page medians. Full tables in [eval/results/benchmark.md](../../eval/results/benchmark.md);
on a 4-core 2.3 GHz Xeon (Linux):

| ms per page | median | p90 | p95 | mean | pages under 1 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript (Chromium, native DOMParser) | 4.76 | 18.0 | 31.4 | 11.1 | 0/325 |
| Dart (AOT, package:html) | 7.88 | 30.1 | 46.2 | 17.0 | 0/325 |
| Go (this package, PGO) | **0.887** | 3.34 | 6.42 | 2.13 | 181/325 |

Per page, Go is a median 5.1× faster than TypeScript and 8.2× faster than Dart. The median Go
page splits into parse 0.212 ms, tree 0.070, extract 0.571 and Markdown 0.019. Pages under 50 KB of
HTML take a median 0.524 ms, 50 to 200 KB 0.746 ms. Absolute times depend on the machine (an earlier
run on a 2.8 GHz Xeon of an older generation gave Go a median of 1.16 ms, TypeScript 9.05);
compare engines within one run.

Memory: every byte the pipeline allocates for a page, garbage collector paused, is a median
0.63 MB (p95 3.61 MB); 312 of 325 pages stay under 5 MB, the rest are pages of 700 KB to 3 MB
of HTML.

`go test -bench Pipeline` runs `ExtractHTML` (Markdown on) on the same pages: `all` and
`median` (50 to 200 KB). Builds of `cmd/truffle` use the CPU profile in `cmd/truffle/default.pgo`
(profile-guided optimization, about 3%); regenerate it after large changes with
`go test -run XXX -bench Pipeline -benchtime 10x -cpuprofile cmd/truffle/default.pgo .`.
