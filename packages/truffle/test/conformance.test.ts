import { describe, expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extract } from '../src/index';

// The TypeScript engine is the reference; `UPDATE=1 bun test test/conformance.test.ts` rewrites expectations.
const root = new URL('../fixtures/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8')) as Record<string, string>;

function run(name: string): unknown {
  const html = readFileSync(`${root}pages/${name}.html`, 'utf8');
  const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
  return extract(doc, { url: manifest[name]! });
}

describe('conformance fixtures', () => {
  test('every page has a manifest entry', () => {
    const pages = readdirSync(root + 'pages').filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
    expect(pages).toEqual(Object.keys(manifest).sort());
  });

  for (const name of Object.keys(manifest)) {
    test(name, () => {
      const actual = run(name);
      const path = `${root}expected/${name}.json`;
      if (process.env.UPDATE) writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
      expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
    });
  }
});
