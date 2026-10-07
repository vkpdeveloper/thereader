# truffle (TypeScript)

The article extraction engine: HTML in, a structured, renderable `Article` out (text, headings,
code with languages, math, tables, figures, media). This is the reference implementation, used
by the web app and the eval; `packages/truffle_dart` is its line-for-line Dart port and
`packages/truffle_go` its Go port (a library and a CLI), and both produce the same JSON and
Markdown for the same page tree.

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
(blocks in, Markdown out; both shared with the Dart and Go ports), and parse every output back with
remark (GFM + math, `test/markdown-oracle.ts`) to check that the tree holds exactly what the
blocks hold. `bun scripts/markdown-check.ts` runs the same check on every article of the eval
corpus (after `bun scripts/parity-dump.ts`).

`fixtures/` holds the conformance cases shared with the Dart and Go ports (see `fixtures/README.md`).
