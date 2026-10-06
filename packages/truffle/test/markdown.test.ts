import { describe, expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, writeFileSync } from 'node:fs';
import { articleMarkdown, blocksMarkdown, extract, type Block } from '../src/index';
import { compareShapes, expectedShape, parseMarkdown, parsedShape } from './markdown-oracle';

// Markdown export. `fixtures/expected/<name>.md` and `fixtures/markdown/cases.json` are shared with
// the Dart port (packages/truffle_dart/test/markdown_test.dart); `UPDATE=1 bun test test/markdown.test.ts`
// rewrites both from this reference.
const root = new URL('../fixtures/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8')) as Record<string, string>;

/** Blocks whose emphasis CommonMark cannot express (an italic `[` glued to a citation number). */
const MARK_DROPS: Record<string, number> = { 'latexml-lists': 1 };

/** Parses the Markdown back (remark, GFM + math) and fails on any difference from the blocks except dropped emphasis. */
function expectRoundTrip(blocks: readonly Block[], markdown: string, allowedMarkDrops = 0): void {
  const mismatches = compareShapes(expectedShape(blocks), parsedShape(parseMarkdown(markdown)));
  expect(mismatches.filter((m) => !m.marksOnly)).toEqual([]);
  expect(mismatches.length).toBeLessThanOrEqual(allowedMarkDrops);
}

function page(name: string): Document {
  return new JSDOM(readFileSync(`${root}pages/${name}.html`, 'utf8'), { virtualConsole: new VirtualConsole() }).window.document;
}

describe('markdown of the conformance fixtures', () => {
  for (const [name, url] of Object.entries(manifest)) {
    test(name, () => {
      const article = extract(page(name), { url, markdown: true });
      const plain = extract(page(name), { url });
      if (article === null || plain === null) {
        expect(article).toBeNull();
        return;
      }
      // The option adds the field and changes nothing else.
      const { markdown, ...rest } = article;
      expect(rest).toEqual(plain);
      expect(plain.markdown).toBeUndefined();
      expect(markdown).toBe(articleMarkdown(plain));
      const path = `${root}expected/${name}.md`;
      if (process.env.UPDATE) writeFileSync(path, markdown);
      expect(markdown).toBe(readFileSync(path, 'utf8'));
      expect(markdown.startsWith(`# ${plain.title}\n\n`) || plain.title.length === 0).toBe(true);
      expectRoundTrip(plain.blocks, blocksMarkdown(plain.blocks), MARK_DROPS[name] ?? 0);
    });
  }
});

interface Case {
  name: string;
  blocks: Block[];
  markdown: string;
}

const casesPath = `${root}markdown/cases.json`;
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Case[];

describe('markdown cases', () => {
  for (const c of cases) {
    test(c.name, () => {
      const markdown = blocksMarkdown(c.blocks);
      if (process.env.UPDATE) c.markdown = markdown;
      expect(markdown).toBe(c.markdown);
      // Emphasis CommonMark cannot express there (`cite*[*`) is the one allowed difference.
      expectRoundTrip(c.blocks, markdown, c.name.startsWith('emphasis a parser') ? 1 : 0);
    });
  }
  test.if(Boolean(process.env.UPDATE))('write cases', () => writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n'));
});

test('no markdown unless asked for', () => {
  const article = extract(page('blog-basic'), { url: manifest['blog-basic']! })!;
  expect('markdown' in article).toBe(false);
  expect(JSON.stringify(article).endsWith(']}')).toBe(true);
});

test('markdown is the last key when asked for', () => {
  const article = extract(page('blog-basic'), { url: manifest['blog-basic']!, markdown: true })!;
  expect(Object.keys(article).pop()).toBe('markdown');
  expect(article.markdown.endsWith('\n')).toBe(true);
});

test('an article with no title starts with its body', () => {
  expect(articleMarkdown({ title: '', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body.' }] }] } as never)).toBe('Body.\n');
  expect(blocksMarkdown([])).toBe('');
});
