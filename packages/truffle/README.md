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

Also exported: `extractHtml(html, { url, parse? })` (parses with `DOMParser` unless `parse` is
given), `extractTree(VDocument, options)` and `fromDom(Document)` (the two halves of the
pipeline), `cleanTitle`, `canonicalUrl`, `detectLanguage`, `normalizeLanguage`,
`languageFromClass`, `articleText`, `blocksText`, `inlineText`, `countWords`, and the model types.

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
bun test           # conformance fixtures (fixtures/), single rules, TeX, serialization order
bun run typecheck
```

`fixtures/` holds the conformance cases shared with the Dart port (see `fixtures/README.md`).
