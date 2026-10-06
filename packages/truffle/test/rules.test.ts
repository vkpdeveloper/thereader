import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract, inlineText, type Article, type Inline, type Video } from '../src/index';

// Single rules on small pages; the same cases as packages/truffle_dart/test/rules_test.dart.

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

test('a canonical URL that only drops https on the same host keeps https', () => {
  const url = (canonical: string, page: string) => {
    const html = `<html><head><title>Rule test page</title><link rel="canonical" href="${canonical}"></head><body><article><h1>Rule test page</h1><p>${PROSE}</p></article></body></html>`;
    return extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: page })!.url;
  };
  expect(url('http://distill.pub/2017/momentum', 'https://distill.pub/2017/momentum/')).toBe('https://distill.pub/2017/momentum');
  expect(url('http://www.example.com/a', 'https://example.com/a')).toBe('http://www.example.com/a');
  expect(url('http://example.com/a', 'http://example.com/b')).toBe('http://example.com/a');
});

test('a credit closing a caption goes to the credit; elements never glue a sentence to the next', () => {
  const figure = (caption: string) => `<figure><img src="https://example.com/${caption.length}.jpg" width="800" height="600"><figcaption>${caption}</figcaption></figure>`;
  const blocks = article(
    figure('The theatre in Perth, Western Australia.<small>Photograph: Gavin M John/The Guardian</small>') +
      figure('The tomb of King Djer, in Abydos. Photograph: Mike P Shepherd/Alamy') +
      figure('Image: Jose Mourinho, left, has replaced Mauricio Pochettino') +
      '<p>Rep. Omar speaks at the Capitol on July 25, 2019.<span>J. Scott Applewhite / AP file</span> In <code>asyncio.</code><code>TaskGroup</code>, see <span>asyncio.</span><span>TaskGroup</span>.</p>',
  ).blocks;
  const text = (t: string): Inline[] => [{ type: 'text', text: t }];
  expect(blocks.slice(1, 4).map((b) => (b.type === 'figure' ? [b.caption, b.credit] : b))).toEqual([
    [text('The theatre in Perth, Western Australia.'), text('Photograph: Gavin M John/The Guardian')],
    [text('The tomb of King Djer, in Abydos.'), text('Photograph: Mike P Shepherd/Alamy')],
    [text('Image: Jose Mourinho, left, has replaced Mauricio Pochettino'), undefined],
  ]);
  expect(blocks[4]).toEqual({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Rep. Omar speaks at the Capitol on July 25, 2019. J. Scott Applewhite / AP file In ' },
      { type: 'text', text: 'asyncio.TaskGroup', marks: ['code'] },
      { type: 'text', text: ', see asyncio.TaskGroup.' },
    ],
  });
});

test('the lead of a topic-tag footer at the end goes; the same words inside the article stay', () => {
  const blocks = (body: string) => {
    const html = `<html><head><title>Rule test page</title></head><body><article><h1>Rule test page</h1><p>${PROSE}</p>${body}</article></body></html>`;
    return extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: 'https://example.com/a' })!.blocks.map((b) => (b.type === 'paragraph' ? inlineText(b.content) : b.type));
  };
  expect(blocks('<p>The play opens on Friday.</p><p>Explore more on these topics</p>')).toEqual([PROSE.trim(), 'The play opens on Friday.']);
  expect(blocks('<p>Related topics:</p><p>The play opens on Friday.</p>')).toEqual([PROSE.trim(), 'Related topics:', 'The play opens on Friday.']);
});

test('a video file and its still image are one video carrying the figure caption', () => {
  const video = (poster: string) =>
    `<video src="/media/clip.mp4" ${poster} aria-label="The sidebar loading" width="1320" height="900"></video>`;
  const still = '<img class="still" src="/media/clip.png" alt="The sidebar loading" width="1320" height="900">';
  const caption = '<figcaption><b>FIG A</b> Sidebar jank</figcaption>';
  const one: Video = {
    type: 'video',
    provider: 'file',
    url: 'https://example.com/media/clip.mp4',
    poster: 'https://example.com/media/clip.png',
    caption: [{ type: 'text', text: 'FIG A', marks: ['bold'] }, { type: 'text', text: ' Sidebar jank' }],
  };
  // The still repeats the poster, after or before the video; without a poster the still becomes it.
  expect(article(`<figure><div>${video('poster="/media/clip.png"')}${still}</div>${caption}</figure>`).blocks.slice(1, -1)).toEqual([one]);
  expect(article(`<figure>${still}${video('poster="/media/clip.png"')}${caption}</figure>`).blocks.slice(1, -1)).toEqual([one]);
  expect(article(`<figure>${video('')}${still}${caption}</figure>`).blocks.slice(1, -1)).toEqual([one]);
  // Outside a figure, a still right after the video (or in its <noscript>) is dropped.
  const { caption: _, ...bare } = one;
  expect(article(`<div>${video('poster="/media/clip.png"')}<noscript>${still}</noscript></div>`).blocks.slice(1, -1)).toEqual([bare]);
  expect(article(`<div>${video('poster="/media/clip.png"')}${still}</div>`).blocks.slice(1, -1)).toEqual([bare]);
  // A different image in the figure stays a figure.
  const other = article(`<figure>${video('poster="/media/clip.png"')}<img src="/media/chart.png" alt="Chart" width="1320" height="900">${caption}</figure>`).blocks;
  expect(other.slice(1, -1).map((b) => b.type)).toEqual(['figure', 'video']);
});
