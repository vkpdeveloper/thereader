# Conformance fixtures

Each `pages/<name>.html` is extracted with the page URL from `manifest.json`,
and the result must equal `expected/<name>.json` exactly, in both the
TypeScript engine (`bun test`, pages parsed with jsdom) and the Dart port
(`dart test` in `packages/truffle_dart`, pages parsed with package:html; the
Dart test also checks that 2-space JSON reproduces the file byte for byte).
Regenerate the expectations from the TypeScript reference with
`UPDATE=1 bun test test/conformance.test.ts` after an intentional engine
change, review the diff, and keep the Dart port passing.

Each page also has `expected/<name>.md`, its `article.markdown` with
`markdown: true`, and `markdown/cases.json` lists blocks with the Markdown
`blocksMarkdown` writes for them (escaping, marks, lists, tables, footnotes,
callouts). Both engines must reproduce them byte for byte;
`UPDATE=1 bun test test/markdown.test.ts` regenerates them.

Beyond these fixtures, the Dart port is checked against the reference on the
whole eval corpus: `bun scripts/parity-dump.ts` here, then
`dart run tool/parity.dart` in `packages/truffle_dart` (see its README).

The synthetic pages are written for these tests. The real pages are
snapshots of openly licensed documentation, kept for regression coverage:

- `wikipedia-euler.html`: Wikipedia, "Euler's identity", CC BY-SA 4.0.
- `python-docs-classes.html`: Python documentation, PSF License.
- `rust-book-strings.html`: The Rust Programming Language, MIT / Apache-2.0.
- `mdn-array-map.html`: MDN Web Docs, CC BY-SA 2.5.
