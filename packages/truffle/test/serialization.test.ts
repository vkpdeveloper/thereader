import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extract } from '../src/index';

// Saved-article sync uploads `JSON.stringify(article)`, and the API checks only
// the document's ends without parsing it (apps/api/src/article-bodies.ts):
// compact JSON that starts with `{"schema":1,` and ends with `}`. The Dart
// model writes the same order (packages/truffle_dart/test/serialization_test.dart).
test('articles serialize with schema first, compactly', () => {
  const root = new URL('../fixtures/', import.meta.url).pathname;
  const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8')) as Record<string, string>;
  for (const [name, url] of Object.entries(manifest)) {
    const html = readFileSync(`${root}pages/${name}.html`, 'utf8');
    const article = extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url });
    if (article === null) continue;
    const json = JSON.stringify(article);
    expect(json.startsWith('{"schema":1,"url":'), name).toBe(true);
    expect(json.endsWith('}'), name).toBe(true);
  }
});
