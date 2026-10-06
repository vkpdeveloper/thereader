import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract, type Article, type Block } from '../src/index';

// Hostile markup never reaches the model as a script, file or relative URL, a
// borrowed host, or live MathML; the same cases as
// packages/truffle_dart/test/security_urls_test.dart.

const PROSE = 'Some long prose sentence here to pass thresholds. '.repeat(15);

/** An article of `body` between two long paragraphs. */
function article(body: string, head = '', url = 'https://example.com/a'): Article {
  const html = `<html><head><title>Rule test page</title>${head}</head><body><article><h1>Rule test page</h1><p>${PROSE}</p>${body}<p>${PROSE}</p></article></body></html>`;
  return extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url })!;
}

/** The blocks `body` became, without the surrounding prose. */
function blocks(body: string): Block[] {
  return article(body).blocks.slice(1, -1);
}

const HTTP = /^https?:\/\/[^\s/?#]+/;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/;

/** Every URL-bearing field of the article, with the schemes its field allows. */
function expectSafeUrls(value: unknown, key = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) expectSafeUrls(item, key);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string') {
      expectSafeUrls(v, k);
      continue;
    }
    if (k === 'url' || k === 'embedUrl' || k === 'poster' || k === 'favicon') expect(v).toMatch(HTTP);
    else if (k === 'src') expect(HTTP.test(v) || DATA_IMAGE.test(v)).toBe(true);
    else if (k === 'href') expect(HTTP.test(v) || (record['type'] === 'text' && /^(?:mailto|tel):/.test(v))).toBe(true);
    else if (k === 'srcset') for (const part of v.split(', ')) expect(part).toMatch(HTTP);
  }
}

/** The article is safe and none of `needles` made it into its JSON. */
function expectClean(a: Article, ...needles: string[]): void {
  expectSafeUrls(a);
  const json = JSON.stringify(a);
  for (const needle of needles) expect(json).not.toContain(needle);
}

test('links keep only http(s), mailto and tel, decided after parsing', () => {
  const links = [
    '&#1;javascript:alert(1)', ' &#1;&#31;JavaScript:alert(1)', 'java\tscript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end',
    'data:text/html,hi', '&#1;data:text/html,hi', 'web+evil:x', 'vbscript:x', 'blob:https://example.com/x', 'about:blank',
  ];
  const a = article(`<p>${links.map((href, i) => `<a href="${href}">l${i}</a> `).join('')}<a href="mailto:a@b.c">m</a> <a href="/next">n</a></p>`);
  expectClean(a, 'javascript', 'JavaScript', 'file:', 'intent:', 'data:', 'web+evil', 'vbscript', 'blob:', 'about:');
  const runs = a.blocks[1]!.type === 'paragraph' ? a.blocks[1]!.content : [];
  expect(runs.filter((r) => r.type === 'text' && r.href !== undefined).map((r) => r.type === 'text' && r.href)).toEqual(['mailto:a@b.c', 'https://example.com/next']);
});

test('a figure links only to an http(s) file', () => {
  const figure = (href: string) => blocks(`<div><a href="${href}"><span><span><img src="/big.jpg" width="800" height="600"></span></span></a></div>`);
  expect(figure('mailto:a@b.png')).toEqual([{ type: 'figure', images: [{ src: 'https://example.com/big.jpg', alt: '', width: 800, height: 600 }] }]);
  expect(figure('/full.png')).toEqual([{ type: 'figure', images: [{ src: 'https://example.com/big.jpg', alt: '', width: 800, height: 600, href: 'https://example.com/full.png' }] }]);
});

test('a <base> that is not http(s) does not become the base', () => {
  const a = article('<p>Read the <a href="next">next part</a> of the story.</p>', '<base href="file:///etc/">');
  expectClean(a, 'file:');
  expect(JSON.stringify(a.blocks[1])).toContain('"href":"https://example.com/next"');
});

test('social embeds take only http(s) URLs from their attributes and links', () => {
  const cases = [
    '<blockquote class="twitter-tweet" cite="javascript:alert(document.domain)"><p>hello tweet</p></blockquote>',
    '<blockquote class="reddit-embed"><p>x</p><a href="file:///etc/passwd">l</a></blockquote>',
    '<blockquote class="twitter-tweet"><p>hello</p><a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;//twitter.com/a/status/1">l</a></blockquote>',
    '<blockquote class="instagram-media" data-instgrm-permalink="&#1;javascript:alert(1)"><p>insta</p></blockquote>',
    '<blockquote class="bluesky-embed" data-bluesky-uri="javascript:alert(1)"><p>sky</p></blockquote>',
    '<blockquote class="fb-post" data-href="vbscript:x"><p>post</p></blockquote>',
  ];
  for (const body of cases) {
    const a = article(body);
    expectClean(a, 'javascript', 'file:', 'data:', 'vbscript');
    expect(a.blocks.some((b) => b.type === 'embed')).toBe(false);
  }
  // A bad attribute falls through to the next candidate.
  const reddit = blocks('<blockquote class="reddit-embed" cite="javascript:alert(1)"><p>post</p><a href="/r/x/comments/1">l</a></blockquote>');
  expect(reddit[0]).toMatchObject({ type: 'embed', provider: 'reddit', url: 'https://example.com/r/x/comments/1' });
});

test('a real tweet blockquote is still a twitter embed', () => {
  const body = '<blockquote class="twitter-tweet"><p lang="en">Real tweet text</p>&mdash; Jane (@jane) <a href="https://twitter.com/jane/status/123456?ref_src=twsrc">May 1, 2024</a></blockquote>';
  expect(blocks(body)).toEqual([
    { type: 'embed', provider: 'twitter', url: 'https://twitter.com/jane/status/123456?ref_src=twsrc', author: 'Jane (@jane)', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Real tweet text' }] }] },
  ]);
});

test('<video> and <audio> sources are resolved before provider matching', () => {
  const cases = [
    '<video src="javascript://embed.ted.com/talks/x%0aalert(document.domain)"></video>',
    '<audio src="javascript://bandcamp.com/EmbeddedPlayer%0aalert(1)"></audio>',
    '<audio src="file:///etc/passwd#bandcamp.com/EmbeddedPlayer"></audio>',
    '<video><source src="&#1;javascript://fast.wistia.net/embed/iframe/abc%0aalert(1)"></video>',
  ];
  for (const body of cases) {
    const a = article(body);
    expectClean(a, 'javascript', 'file:');
    expect(a.blocks.some((b) => b.type === 'video' || b.type === 'audio')).toBe(false);
  }
  expect(blocks('<video src="//player.twitch.tv/?channel=abc"></video>')).toEqual([
    { type: 'video', provider: 'twitch', url: 'https://www.twitch.tv/abc', embedUrl: 'https://player.twitch.tv/?channel=abc' },
  ]);
  expect(blocks('<video src="https://cdn.example.com/clip.mp4" poster="javascript:alert(1)"></video>')).toEqual([
    { type: 'video', provider: 'file', url: 'https://cdn.example.com/clip.mp4' },
  ]);
  expect(blocks('<audio src="/a.mp3"></audio>')).toEqual([{ type: 'audio', provider: 'file', url: 'https://example.com/a.mp3' }]);
});

test('a SoundCloud player names an http(s) track page or itself', () => {
  const src = 'https://w.soundcloud.com/player/?url=javascript%3Aalert(document.domain)';
  const a = article(`<iframe src="${src}"></iframe>`);
  expectClean(a, 'javascript:');
  expect(a.blocks[1]).toEqual({ type: 'audio', provider: 'soundcloud', url: src, embedUrl: src });
  const ok = 'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/123&amp;color=ff5500';
  expect(blocks(`<iframe src="${ok}"></iframe>`)[0]).toMatchObject({ type: 'audio', provider: 'soundcloud', url: 'https://api.soundcloud.com/tracks/123' });
});

test('a lite-vimeo id is digits', () => {
  const a = article('<lite-vimeo videoid="1/../../../@evil?&quot;&gt;&lt;x"></lite-vimeo>');
  expectClean(a, '@evil', '<x');
  expect(a.blocks.some((b) => b.type === 'video')).toBe(false);
  expect(blocks('<lite-vimeo videoid="76979871"></lite-vimeo>')).toEqual([
    { type: 'video', provider: 'vimeo', url: 'https://vimeo.com/76979871', embedUrl: 'https://player.vimeo.com/video/76979871' },
  ]);
});

test('userinfo does not borrow a host', () => {
  for (const href of ['https://evil.com:x@www.nytimes.com/story', 'https://www.nytimes.com@evil.com/story']) {
    const a = article('', `<link rel="canonical" href="${href}">`, 'https://evil.com/a');
    expect(a.url).toBe('https://evil.com/a');
  }
  // A canonical URL on the same site still wins.
  expect(article('', '<link rel="canonical" href="https://evil.com/story">', 'https://evil.com/a?utm_source=x').url).toBe('https://evil.com/story');
  // Userinfo does not make a frame a known embed host.
  expect(blocks('<iframe src="https://datawrapper.de:x@evil.com/chart/" width="600" height="400"></iframe>')).toEqual([]);
  expect(blocks('<iframe src="https://datawrapper.dwcdn.net/abc/1/" width="600" height="400"></iframe>')).toEqual([
    { type: 'embed', provider: 'datawrapper', url: 'https://datawrapper.dwcdn.net/abc/1/' },
  ]);
});

test('MathML keeps only MathML elements and attributes', () => {
  const body =
    '<p>f <math href="javascript:alert(1)" onclick="alert(2)"><mtext><img src=x onerror=alert(document.domain)><a href="javascript:alert(3)">c</a><iframe srcdoc="&lt;script&gt;alert(4)&lt;/script&gt;"></iframe><style>*{}</style><script>alert(6)</script></mtext><mi xlink:href="javascript:alert(5)" a"b=1 style="color:red">x</mi></math> g</p>';
  const a = article(body);
  expectClean(a);
  const math = a.blocks[1]!.type === 'paragraph' ? a.blocks[1]!.content[1]! : null;
  expect(math).toMatchObject({ type: 'math', mathml: '<math><mtext>c</mtext><mi>x</mi></math>' });
  const mathml = math !== null && math.type === 'math' ? math.mathml! : '';
  for (const bad of [/\son\w+=/, /href/, /<img/, /<a[\s>]/, /<iframe/, /<style/, /<script/, /javascript/]) expect(mathml).not.toMatch(bad);
});

test('Wikipedia-style MathML still serializes', () => {
  const formula =
    '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle e^{i\\pi }+1=0}" class="mwe-math-element"><semantics><mrow class="MJX-TeXAtom-ORD"><mstyle displaystyle="true" scriptlevel="0"><msup><mi>e</mi><mrow data-mjx-texclass="ORD"><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo stretchy="false">=</mo><mn>0</mn></mstyle></mrow><annotation encoding="application/x-tex">{\\displaystyle e^{i\\pi }+1=0}</annotation></semantics></math>';
  const paragraph = blocks(`<p>Euler: ${formula} holds.</p>`)[0]!;
  const math = paragraph.type === 'paragraph' ? paragraph.content[1] : null;
  expect(math).toEqual({
    type: 'math',
    tex: 'e^{i\\pi }+1=0',
    mathml:
      '<math alttext="{\\displaystyle e^{i\\pi }+1=0}"><semantics><mrow><mstyle displaystyle="true" scriptlevel="0"><msup><mi>e</mi><mrow data-mjx-texclass="ORD"><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo stretchy="false">=</mo><mn>0</mn></mstyle></mrow></semantics></math>',
    text: 'e^{i\\pi }+1=0',
  });
});
