import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract, type Article } from '../src/index';

// Single rules on small pages; the same cases as packages/extract_dart/test/rules_test.dart.

const PROSE = 'Some long prose sentence here to pass thresholds. '.repeat(15);

/** An article of `body` between two long paragraphs. */
function article(body: string): Article {
  const html = `<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1><p>${PROSE}</p>${body}<p>${PROSE}</p></article></body></html>`;
  return extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: 'https://example.com/a' })!;
}

test('a note marker cleaning removed stays removed when the note is not taken', () => {
  const body = '<p>Claim<span class="sidenote"><sup class="noprint">7</sup><span class="sidenote-content"></span> (see the appendix)</span> rest.</p>';
  expect(article(body).blocks[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Claim (see the appendix) rest.' }] });
});

test('a list of bare href="#" links is not a table of contents', () => {
  const items = ['Basic: 10 GB of storage and email support', 'Plus: 100 GB of storage and chat support', 'Pro: 1 TB of storage and phone support'];
  const body = `<p>The plans:</p><ul>${items.map((t) => `<li><a href="#">${t}</a></li>`).join('')}</ul>`;
  expect(article(body).blocks[2]).toEqual({
    type: 'list',
    ordered: false,
    items: items.map((text) => ({ blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })),
  });
  // Links to places on the page are one.
  expect(article(body.replaceAll('href="#"', 'href="#plans"')).blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
});
