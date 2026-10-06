# Conformance fixtures

Each `pages/<name>.html` is extracted with the page URL from `manifest.json`,
and the result must equal `expected/<name>.json` exactly, in both the
TypeScript engine (`bun test`) and the Dart port (`dart test` in
`packages/extract_dart`). Regenerate the expectations from the TypeScript
reference with `UPDATE=1 bun test test/conformance.test.ts` after an
intentional engine change, review the diff, and keep the Dart port passing.

The synthetic pages are written for these tests. The real pages are
snapshots of openly licensed documentation, kept for regression coverage:

- `wikipedia-euler.html`: Wikipedia, "Euler's identity", CC BY-SA 4.0.
- `python-docs-classes.html`: Python documentation, PSF License.
- `rust-book-strings.html`: The Rust Programming Language, MIT / Apache-2.0.
- `mdn-array-map.html`: MDN Web Docs, CC BY-SA 2.5.
