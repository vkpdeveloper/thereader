import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract, inlineText, type Article, type Block } from '../src/index';

// Hostile text that made a pattern backtrack for seconds or minutes, through the public API: each page must extract
// well within the bound (the old patterns took many seconds on these sizes), and the pattern must still do its job.
// The same cases as packages/truffle_dart/test/security_text_test.dart.

const PROSE = 'Some long prose sentence here to pass thresholds. '.repeat(15);
const BOUND_MS = 1000;

function parse(head: string, body: string): Document {
  const html = `<html><head>${head}</head><body><article>${body}<p>${PROSE}</p></article></body></html>`;
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

function page(head: string, body: string, url = 'https://example.com/a'): Article {
  return extract(parse(head, body), { url })!;
}

/** Extracts and checks the time spent (parsing excluded). */
function timed(head: string, body: string): Article {
  const doc = parse(head, body);
  const start = performance.now();
  const article = extract(doc, { url: 'https://example.com/a' })!;
  expect(performance.now() - start).toBeLessThan(BOUND_MS);
  return article;
}

const plain = (b: Block): string => (b.type === 'paragraph' || b.type === 'heading' ? inlineText(b.content) : b.type);

test('a run of capitalised names that is no byline does not backtrack', () => {
  const line = 'By ' + 'AAAAA,'.repeat(8) + 'AAAAA1';
  expect(timed('<title>Rule test page</title>', `<h1>Rule test page</h1><p>${line}</p>`).blocks.map(plain)).toEqual([line, PROSE.trim()]);
  // A byline still goes.
  for (const byline of ['By Jane Doe', 'By JANE DOE and Li Wei | Reuters', "By Jean-Paul O'Brien", 'By J.R.R. Tolkien']) {
    expect(page('<title>Rule test page</title>', `<h1>Rule test page</h1><p>${byline}</p>`).blocks.map(plain)).toEqual([PROSE.trim()]);
  }
});

test('a title with a long run of no-break spaces does not backtrack', () => {
  const spaces = '&nbsp;'.repeat(50000);
  timed(`<title>a${spaces}b</title>`, `<h1>Rule test page</h1><h2>a${spaces}b</h2><p>${PROSE}</p>`);
  timed(`<title>a${spaces}b</title><meta property="og:title" content="a${'\u3000'.repeat(20000)}b">`, `<p>${PROSE}</p>`);
  // The site name still comes off a title separated by no-break spaces, and is still read from it.
  const a = page('<title>A Story About Things&nbsp;|&nbsp;Example</title>', `<p>${PROSE}</p>`);
  expect(a.title).toBe('A Story About Things');
  expect(page('<title>Story&nbsp;-&nbsp;Wikipedia</title>', `<p>${PROSE}</p>`, 'https://en.wikipedia.org/wiki/Story').siteName).toBe('Wikipedia');
});

test('author names with a long run of no-break spaces do not backtrack', () => {
  const a = timed(`<title>Rule test page</title><meta name="author" content="Ann${'&nbsp;'.repeat(50000)}Lee">`, `<p>${PROSE}</p>`);
  expect(a.authors).toEqual([]);
  // Names are still split and trimmed.
  expect(page('<title>Rule test page</title><meta name="author" content="Ann Lee and Bo Chen, ">', `<p>${PROSE}</p>`).authors).toEqual(['Ann Lee', 'Bo Chen']);
});

test('an embed author line with a long run of spaces does not backtrack', () => {
  const embed = (last: string) =>
    `<p>${PROSE}</p><blockquote class="twitter-tweet"><p>Hello world.</p><p>${last} <a href="https://twitter.com/jane/status/123">link</a></p></blockquote>`;
  timed('<title>Rule test page</title>', embed('-' + '\u3000'.repeat(3000) + 'x'));
  // The author is still read from the tweet's last line.
  const a = page('<title>Rule test page</title>', `<p>${PROSE}</p><blockquote class="twitter-tweet"><p>Hello world.</p><p>— Jane Doe (@jane) <a href="https://twitter.com/jane/status/123">March 1, 2020</a></p></blockquote>`);
  expect(a.blocks.find((b) => b.type === 'embed')).toMatchObject({ provider: 'twitter', author: 'Jane Doe (@jane)' });
});

test('code with long runs of blank lines or spaces does not backtrack in language detection', () => {
  const blocks = [
    'x' + '\n'.repeat(4990) + '!',
    'var' + ' '.repeat(4990) + '!',
    'function' + '\n\t'.repeat(2490) + '!',
    'import' + '\t '.repeat(2490) + '!',
    'fragment' + '\n\t'.repeat(2490) + '!',
    '1'.repeat(4990) + '!',
  ];
  timed('<title>Rule test page</title>', blocks.map((code) => `<pre>${code}</pre><p>${PROSE}</p>`).join(''));
  // Detection still works.
  const python = 'import os\n\n\n\ndef main(argv):\n    for name in argv:\n        print(name)\n';
  expect(page('<title>Rule test page</title>', `<p>${PROSE}</p><pre>${python}</pre>`).blocks.find((b) => b.type === 'code')).toMatchObject({ language: 'python' });
});

test('long icon sizes and placeholder-like image names do not backtrack', () => {
  const a = timed(
    `<title>Rule test page</title><link rel="icon" sizes="${'1'.repeat(100000)}" href="/icon.png"><meta property="og:image" content="https://example.com/${'logo'.repeat(25000)}">`,
    `<p>${PROSE}</p>`,
  );
  expect(a.favicon).toBe('https://example.com/icon.png');
  // A placeholder lead image is still skipped; a photo is shown.
  const lead = (src: string) => page(`<title>Rule test page</title><meta property="og:image" content="${src}">`, `<p>${PROSE}</p>`).blocks[0]!.type;
  expect(lead('https://example.com/site-logo.png')).toBe('paragraph');
  expect(lead('https://example.com/photo.jpg')).toBe('figure');
});
