import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract, type Article, type Block, type Image } from '../src/index';

// Hostile frame, image and TeX markup that sent the old patterns into quadratic backtracking (seconds
// to minutes for one page); the same cases as packages/truffle_dart/test/security_media_test.dart.
// Each page is parsed outside the timing and must extract in well under a second, where the old
// code took several, and ordinary markup keeps its result.

const PROSE = 'Some long prose sentence here to pass thresholds. '.repeat(15);
const LIMIT_MS = 1000;

function parse(body: string, head = ''): Document {
  const html = `<html><head><title>Security test page</title>${head}</head><body><article><h1>Security test page</h1><p>${PROSE}</p>${body}<p>${PROSE}</p></article></body></html>`;
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

function article(body: string, head = ''): Article {
  return extract(parse(body, head), { url: 'https://example.com/a' })!;
}

/** The article, extracted within LIMIT_MS (parsing not counted). */
function quick(body: string, head = ''): Article {
  const doc = parse(body, head);
  const start = performance.now();
  const result = extract(doc, { url: 'https://example.com/a' })!;
  expect(performance.now() - start).toBeLessThan(LIMIT_MS);
  return result;
}

/** The blocks between the two prose paragraphs. */
function middle(a: Article): Block[] {
  return a.blocks.slice(1, -1);
}

const frame = (src: string) => `<iframe src="${src.replace(/&/g, '&amp;')}"></iframe>`;

/** Pages the old patterns took seconds on, in V8 or JavaScriptCore or both. */
const HOSTILE: [string, string, string?][] = [
  ['a YouTube frame URL repeating its prefix', frame('https://www.' + 'youtube.com/watch?'.repeat(20000))],
  ['a Twitch frame URL repeating its prefix', frame('https://' + 'player.twitch.tv/?'.repeat(20000))],
  ['a SoundCloud frame URL repeating its prefix', frame('https://' + 'w.soundcloud.com/player/?'.repeat(20000))],
  ['a Bilibili frame URL repeating its prefix', frame('https://' + 'player.bilibili.com/player.html?'.repeat(15000))],
  ['a tweet frame URL repeating its prefix', frame('https://' + 'platform.twitter.com/embed/Tweet.html?'.repeat(12000))],
  ['a video source repeating the YouTube prefix', `<video src="https://www.${'youtube.com/watch?'.repeat(20000)}"></video>`],
  // A parameter on another line than the prefixes cannot be reached from them.
  ['a video source with the parameter on its own line', `<video src="https://www.${'youtube.com/watch?'.repeat(20000)}\n&amp;v=dQw4w9WgXcQ"></video>`],
  ['an image name repeating a placeholder word', `<p><img src="https://example.com/${'blank'.repeat(60000)}"></p>`],
  ['a srcset with long numbers', `<p><img src="https://example.com/a.jpg" srcset="https://example.com/b.jpg ${'1'.repeat(40000)}, https://example.com/c.jpg ${'2'.repeat(80000)}y"></p>`],
  ['a srcset URL with a long run of commas', `<p><img srcset="https://example.com/a${','.repeat(100000)}b, https://example.com/c.jpg 2x"></p>`],
  ['an image width padded with spaces', `<p><img src="https://example.com/a.jpg" width="1${' '.repeat(50000)}x"></p>`],
  ['icon sizes with a long number', '', `<link rel="icon" href="/f.png" sizes="${'1'.repeat(80000)}">`],
  ['unclosed \\[ delimiters', `<p>${'\\['.repeat(100000)}</p>`],
  ['unclosed \\( delimiters', `<p>${'\\('.repeat(100000)}</p>`],
  ['unclosed \\[ delimiters on a TeX page', `<p>\\(x\\) ${'\\[ '.repeat(50000)}</p>`],
  ['formulas inside one long \\[ formula', `<p>${'\\(x\\[x\\)'.repeat(12000)}\\]</p>`],
  ['code with a long run of spaces', `<pre>a${' '.repeat(100000)}b</pre>`],
  ['table code with a long run of spaces', `<table class="highlight"><tr><td class="blob-num">1</td><td class="blob-code">a${' '.repeat(100000)}b</td></tr><tr><td class="blob-num">2</td><td class="blob-code">c</td></tr></table>`],
];

for (const [name, body, head] of HOSTILE) {
  test(`${name} extracts quickly`, () => {
    quick(body, head);
  });
}

test('player frames still become videos and audio', () => {
  expect(middle(article(frame('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ')))).toEqual([
    { type: 'video', provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', poster: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
  ]);
  // The last `&v=` on the line wins, as with the regex.
  expect(middle(article(frame('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=x&v=BBBBBBBBBBB')))[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB' });
  // The leftmost match wins across the alternatives.
  expect(middle(article(frame('https://example.com/?a=youtube.com/watch?x=1&v=CCCCCCCCCCC&b=youtu.be/DDDDDDDDDDD')))[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC' });
  expect(middle(article(frame('https://player.twitch.tv/?parent=example.com&channel=somechannel')))[0]).toMatchObject({ provider: 'twitch', url: 'https://www.twitch.tv/somechannel' });
  expect(middle(article(frame('https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123&auto_play=false')))[0]).toMatchObject({ provider: 'soundcloud', url: 'https://api.soundcloud.com/tracks/123' });
  expect(middle(article(frame('https://player.bilibili.com/player.html?aid=1&bvid=BV1xx411c7mD&page=1')))[0]).toMatchObject({ provider: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
  expect(middle(article(frame('https://platform.twitter.com/embed/Tweet.html?dnt=true&id=1234567890')))[0]).toEqual({ type: 'embed', provider: 'twitter', url: 'https://twitter.com/i/status/1234567890' });
});

test('placeholders, srcsets, sizes and favicons read as before', () => {
  // A placeholder src gives way to the lazy source.
  const figure = (image: Image): Block[] => [{ type: 'figure', images: [image] }];
  expect(middle(article('<p><img src="https://example.com/img/lazy-load-blank.gif" data-src="https://example.com/real.jpg" alt="A cat"></p>'))).toEqual(
    figure({ src: 'https://example.com/real.jpg', alt: 'A cat' }),
  );
  expect(middle(article('<p><img src="https://example.com/img/blank.gif?v=2" alt="A cat"></p>'))).toEqual([]);
  // Widths and densities, the largest up to 1600px chosen.
  expect(middle(article('<p><img src="https://example.com/s.jpg" srcset="https://example.com/m.jpg 800w, https://example.com/l.jpg 1200w" alt="A cat"></p>'))).toEqual(
    figure({ src: 'https://example.com/l.jpg', alt: 'A cat', srcset: 'https://example.com/m.jpg 800w, https://example.com/l.jpg 1200w' }),
  );
  expect(middle(article('<p><img srcset="https://example.com/a.jpg 1.5x, https://example.com/b.jpg 2x" alt="A cat"></p>'))).toEqual(
    figure({ src: 'https://example.com/b.jpg', alt: 'A cat', srcset: 'https://example.com/a.jpg 1.5x, https://example.com/b.jpg 2x' }),
  );
  expect(middle(article('<p><img src="https://example.com/a.jpg" width=" 640px " height="480" alt="A cat"></p>'))).toEqual(
    figure({ src: 'https://example.com/a.jpg', alt: 'A cat', width: 640, height: 480 }),
  );
  const icons = '<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/192.png" sizes="any 192x192">';
  expect(article('', icons).favicon).toBe('https://example.com/192.png');
});

test('TeX is still split out of the text', () => {
  // `\\[\\[z\\]` closes at the first `\\]`; `\\(\\)` holds nothing, so it does not close.
  expect(middle(article('<p>Let \\(x^2\\) be $y$ and \\[\\[z\\]\\] end, \\(\\) \\(a\\) b.</p>'))).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: 'Let ' }, { type: 'math', tex: 'x^2', text: 'x^2' }, { type: 'text', text: ' be ' }, { type: 'math', tex: 'y', text: 'y' }, { type: 'text', text: ' and' }] },
    { type: 'math', tex: '\\[z', text: '\\[z' },
    { type: 'paragraph', content: [{ type: 'text', text: '\\] end, ' }, { type: 'math', tex: '\\) \\(a', text: '\\) \\(a' }, { type: 'text', text: ' b.' }] },
  ]);
});

test('code keeps runs of spaces and loses trailing whitespace', () => {
  const spaces = ' '.repeat(1000);
  expect(middle(article(`<pre>a${spaces}b</pre>`))).toEqual([{ type: 'code', code: `a${spaces}b`, language: null }]);
  expect(middle(article(`<pre>\n${spaces}b \n\t</pre>`))).toEqual([{ type: 'code', code: `${spaces}b`, language: null }]);
  const table = `<table class="highlight"><tr><td class="blob-num">1</td><td class="blob-code">a${spaces}b</td></tr><tr><td class="blob-num">2</td><td class="blob-code">c  </td></tr></table>`;
  expect(middle(article(table))).toEqual([{ type: 'code', code: `a${spaces}b\nc`, language: null }]);
});
