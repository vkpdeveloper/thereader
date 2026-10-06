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
  expect(article(body.replace(/href="#"/g, 'href="#plans"')).blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
});

test('short texts positioned over a figure drawn by script are not paragraphs', () => {
  const caption = 'Momentum lets a larger range of step-sizes be used, and creates its own oscillations.';
  const body = `<figure style="position:relative"><div id="chart"></div><div id="slider" style="position: absolute; left: 20px"><text class="figtext">Step-size α = 0.02</text></div><figcaption style="position:absolute">${caption}</figcaption></figure>`;
  expect(article(body).blocks.slice(1, -1)).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: caption }] }]);
  // Positioned text that is no label (a quote set in a figure) stays.
  const quote = '<figure><blockquote style="position:absolute">Quoted words.</blockquote></figure>';
  expect(article(quote).blocks[1]).toEqual({ type: 'quote', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted words.' }] }] });
});

test('the byline is the first name in an author widget', () => {
  const html = `<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1><div class="author"><span itemprop="name">By Ann Lee</span> <span itemprop="name">MARCH 20, 2019 10:43</span></div><p>${PROSE}</p></article></body></html>`;
  const a = extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: 'https://example.com/a' })!;
  expect(a.byline).toBe('Ann Lee');
});

test('an author block above the text is not a paragraph; author names further down stay', () => {
  const authors =
    '<div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Ann Lee</span></span> ' +
    '<span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bo Chen</span><span class="ltx_author_notes">' +
    '<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>Carla Diaz, Dev Patel, Eve Martin, University of Somewhere, Department of Examples</span>' +
    '<span class="ltx_contact ltx_role_email">bo@example.org</span></span></span></div>';
  const later = '<p>Cited: <span class="authors">Ann Lee and Bo Chen</span>, An example, 2020.</p>';
  const html = `<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1>${authors}<p>${PROSE}</p>${later}</article></body></html>`;
  const a = extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: 'https://example.com/a' })!;
  expect(a.byline).toBe('Ann Lee');
  expect(a.blocks.map((b) => (b.type === 'paragraph' ? b.content.map((i) => ('text' in i ? i.text : '')).join('') : b.type))).toEqual([PROSE.trim(), 'Cited: Ann Lee and Bo Chen, An example, 2020.']);
});
