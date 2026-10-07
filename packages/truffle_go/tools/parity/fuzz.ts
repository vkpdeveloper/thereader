// Differential fuzz pages for the Go port: random articles full of the constructs the engine has
// rules for. Writes the parity-dump layout (manifest.json, html/, vdoc/, ts/) so tools/parity reads it.
//   bun tools/parity/fuzz.ts <outDir> [count] [seed]   (then: go run ./tools/parity -dir <outDir> pipeline)
import { JSDOM, VirtualConsole } from '../../../truffle/node_modules/jsdom/lib/api.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTree, fromDom } from '../../../truffle/src/index.ts';
import { vdocJson } from '../../../truffle/scripts/vdoc-json.ts';

const out = process.argv[2]!;
const count = Number(process.argv[3] ?? 300);
let seed = Number(process.argv[4] ?? 1);
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const maybe = (p: number) => rand() < p;
const times = (n: number, f: () => string) => Array.from({ length: n }, f).join('');

const WORDS = 'the quick brown fox jumps over lazy dog reading article engine extraction heading paragraph sentence ünïcødé 漢字 テスト кириллица עברית العربية naïve café 𝔘𝔫𝔦 😀 emoji, comma; semicolon: colon - dash — em – en "quote" ‘single’ (paren) [bracket] {brace} $5 $10 a*b_c `tick` # ¶ § ~tilde~ <lt> &amp; 1. 2) • ◦'.split(' ');
const word = () => pick(WORDS);
const sentence = (n = 8 + Math.floor(rand() * 20)) => {
  const s = times(n, () => word() + ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1) + pick(['.', '.', '.', '!', '?', '', '…', '."']);
};
const esc = (s: string) => s.replace(/&(?!amp;)/g, '&amp;').replace(/</g, '&lt;');
const hrefs = ['https://example.com/a', '/relative/path', 'other.html', '#sec-2', '#fn1', '#', 'mailto:a@b.co', 'tel:+123', 'javascript:alert(1)', 'https://example.com/a b', '//cdn.example.org/x', 'https://www.example.com/', 'HTTP://EXAMPLE.COM/Up?utm_source=x&id=2#frag', ' https://example.com/space ', 'data:text/html,hi', 'https://ex.com/img.jpg', '?q=1', '../up/one'];
const SPACES = [' ', '  ', '\n', '\t', ' ', '   ', ' ', '​', '', ''];

function inline(depth = 0): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.35 || depth > 2) parts.push(esc(sentence(3 + Math.floor(rand() * 10))));
    else if (r < 0.45) parts.push(`<a href="${pick(hrefs)}"${maybe(0.2) ? ' class="footnote-ref"' : ''}>${inline(depth + 1)}</a>`);
    else if (r < 0.5) parts.push(`<${pick(['em', 'strong', 'b', 'i', 'code', 'kbd', 'sub', 'sup', 'mark', 's', 'u', 'small', 'q', 'del', 'ins', 'cite'])}>${inline(depth + 1)}</${'x'}>`.replace('</x>', ''));
    else if (r < 0.55) parts.push(pick(['\\(x^2\\)', '$$a+b$$', '$x$', '\\[\\int f\\]', '$5 and $10', 'cost $ 3']));
    else if (r < 0.6) parts.push(`<sup><a href="#fn${1 + Math.floor(rand() * 3)}" id="ref${Math.floor(rand() * 9)}">[${1 + Math.floor(rand() * 3)}]</a></sup>`);
    else if (r < 0.64) parts.push('<br>');
    else if (r < 0.68) parts.push(`<img src="${pick(['/i.png', 'https://example.com/emoji.png', 'data:image/gif;base64,R0lGOD', '/spacer.gif'])}" alt="${esc(word())}" width="${pick(['16', '20', '800', '1', 'x'])}" height="${pick(['16', '600', '2'])}">`);
    else if (r < 0.72) parts.push(`<span style="${pick(['font-weight:bold', 'font-style: italic', 'display:none', 'color:red'])}">${inline(depth + 1)}</span>`);
    else if (r < 0.75) parts.push(`<math><mi>x</mi><mo>=</mo><mn>${Math.floor(rand() * 9)}</mn>${maybe(0.5) ? '<annotation encoding="application/x-tex">x=1</annotation>' : ''}</math>`);
    else if (r < 0.78) parts.push(`<span class="${pick(['sr-only', 'caption', 'credit', 'footnote', 'sidenote', 'imperial_word', 'metric_word'])}">${inline(depth + 1)}</span>`);
    else parts.push(pick(SPACES));
  }
  return parts.join(pick(['', ' ', '\n']));
}

const LANG_SNIPPETS = [
  'def foo(x):\n    return x + 1\n',
  'const a = 1;\nconsole.log(a);\n',
  'fn main() {\n    println!("hi");\n}\n',
  'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n',
  '$ npm install truffle\n$ ls -la\n',
  'SELECT * FROM t WHERE a = 1;\n',
  '{"a": 1, "b": [1, 2]}',
  '<div class="x"><p>hi</p></div>',
  '+ added line\n- removed line\n  context\n',
  '#include <stdio.h>\nint main(void) { printf("x"); }\n',
  'interface A { b: string; }\nconst x: number = 1;\n',
  'just some plain text\nwith lines\n',
];

function block(depth = 0): string {
  const r = rand();
  if (r < 0.3 || depth > 2) return `<p>${inline()}</p>`;
  if (r < 0.36) return `<h${2 + Math.floor(rand() * 4)}${maybe(0.4) ? ` id="sec-${Math.floor(rand() * 4)}"` : ''}>${esc(sentence(4))}${maybe(0.3) ? ' <a class="anchor" href="#x">#</a>' : ''}</h${2}>`.replace(/<\/h2>$/, '</h2>');
  if (r < 0.42) {
    const ordered = maybe(0.5);
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}${ordered && maybe(0.3) ? ` start="${Math.floor(rand() * 5)}"` : ''}>${times(1 + Math.floor(rand() * 5), () => `<li${maybe(0.2) ? ` id="fn${1 + Math.floor(rand() * 3)}"` : ''}>${pick(['', '• ', '1. ', '- ', '(2) ', '<input type="checkbox" checked> '])}${maybe(0.2) ? block(depth + 1) : inline()}</li>`)}</${tag}>`;
  }
  if (r < 0.47) return `<pre${maybe(0.3) ? ` class="language-${pick(['js', 'py', 'rust', 'text', 'unknown'])}"` : ''}><code>${esc(pick(LANG_SNIPPETS))}</code></pre>`;
  if (r < 0.52) return `<figure${maybe(0.2) ? ' class="wp-caption"' : ''}><img src="${pick(['/photo.jpg', 'https://cdn.example.com/a-800x600.jpg', '/placeholder.png'])}" ${maybe(0.4) ? 'srcset="/a-400.jpg 400w, /a-800.jpg 800w, /a-2000.jpg 2000w"' : ''} ${maybe(0.3) ? 'data-src="/lazy-real.jpg"' : ''} alt="${esc(sentence(3))}" width="800" height="600">${maybe(0.7) ? `<figcaption>${esc(sentence(6))}${maybe(0.5) ? ' Photograph: Jane Doe/Agency' : ''}</figcaption>` : ''}</figure>`;
  if (r < 0.56) return `<blockquote${maybe(0.2) ? ' class="twitter-tweet"' : ''}><p>${inline()}</p>${maybe(0.4) ? '<footer>— Someone</footer>' : ''}${maybe(0.2) ? '<a href="https://twitter.com/u/status/123">t</a>' : ''}</blockquote>`;
  if (r < 0.6) return `<table${maybe(0.2) ? ' role="presentation"' : ''}>${maybe(0.5) ? '<caption>Cap</caption>' : ''}${maybe(0.5) ? `<thead><tr>${times(3, () => `<th>${esc(word())}</th>`)}</tr></thead>` : ''}<tbody>${times(2 + Math.floor(rand() * 10), () => `<tr>${times(1 + Math.floor(rand() * 5), () => `<td${maybe(0.1) ? ' colspan="2"' : ''}${maybe(0.1) ? ' align="center"' : ''}>${inline(2)}</td>`)}</tr>`)}</tbody></table>`;
  if (r < 0.63) return `<iframe src="${pick(['https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://player.vimeo.com/video/12345', 'https://ads.doubleclick.net/x', 'https://datawrapper.dwcdn.net/abc/1/', 'https://example.com/embed/xyz', 'https://open.spotify.com/embed/track/abc'])}" title="${esc(word())}"${maybe(0.2) ? ' width="1"' : ''}></iframe>`;
  if (r < 0.66) return `<div class="${pick(['note', 'warning admonition', 'callout tip', 'alert-info', 'notice'])}"><p class="admonition-title">${pick(['Note', 'Warning', 'Heads up'])}</p><p>${inline()}</p></div>`;
  if (r < 0.69) return `<details><summary>${esc(sentence(3))}</summary><p>${inline()}</p></details>`;
  if (r < 0.72) return `<dl><dt>${esc(word())}</dt><dd>${inline()}</dd><dt>${esc(word())}</dt><dd>${inline()}</dd></dl>`;
  if (r < 0.75) return `<div class="footnotes"><hr><ol>${times(1 + Math.floor(rand() * 3), () => `<li id="fn${1 + Math.floor(rand() * 3)}"><p>${inline()} <a href="#ref1" class="footnote-backref">↩</a></p></li>`)}</ol></div>`;
  if (r < 0.78) return pick(['<p>Read more: <a href="/other">Another story</a></p>', '<p>Sign up for our newsletter today</p>', '<p>By Jane Doe and John Roe</p>', '<p>Published on March 3, 2024</p>', '<p>Jane Doe is a reporter covering science.</p>', '<p>___</p>', '<p>Follow us on twitter @handle</p>', '<p>Explore more on these topics</p>', '<hr>', '<p>12</p>']);
  if (r < 0.81) return `<aside class="${pick(['sidebar', 'related', 'note', 'footnote'])}"><p>${inline()}</p></aside>`;
  if (r < 0.84) return `<nav><ul><li><a href="/a">Home</a></li><li><a href="/b">About</a></li></ul></nav>`;
  if (r < 0.87) return `<div class="${pick(['share', 'social', 'newsletter', 'related-posts', 'content', 'entry-content', 'comments'])}">${block(depth + 1)}${block(depth + 1)}</div>`;
  if (r < 0.9) return `<video src="/clip.mp4" poster="/clip.png"></video>`;
  if (r < 0.93) return `<section>${block(depth + 1)}${block(depth + 1)}${block(depth + 1)}</section>`;
  if (r < 0.96) return `<div>${inline()}<p>${inline()}</p>${inline()}</div>`;
  return `<script type="math/tex; mode=display">E=mc^2</script>`;
}

function page(i: number): { html: string; url: string } {
  const title = sentence(5).replace(/[.!?…"]+$/, '');
  const site = pick(['Example Times', 'The Daily', 'Blog', '']);
  const head = [
    `<title>${esc(title)}${site ? ` ${pick(['|', '-', '–', '·'])} ${site}` : ''}</title>`,
    maybe(0.5) ? `<meta property="og:title" content="${esc(title)}">` : '',
    maybe(0.4) ? `<meta property="og:site_name" content="${site}">` : '',
    maybe(0.5) ? `<meta name="description" content="${esc(sentence(15))}">` : '',
    maybe(0.4) ? `<meta property="og:image" content="${pick(['/lead.jpg', 'https://cdn.example.com/lead-1200x630.jpg', '/logo.png'])}"><meta property="og:image:width" content="${pick(['1200', '300'])}"><meta property="og:image:height" content="630">` : '',
    maybe(0.3) ? `<link rel="canonical" href="${pick(['/canon', 'https://example.com/canon?utm_source=x', 'https://other.org/x'])}">` : '',
    maybe(0.3) ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': pick(['NewsArticle', 'BlogPosting', 'WebPage']), headline: title, author: pick([{ name: 'Jane Doe' }, [{ name: 'A B' }, { name: 'C D' }], 'Solo Writer']), datePublished: pick(['2024-03-04T10:00:00Z', '2024-03-04', 'March 4, 2024']), ...(maybe(0.3) ? { articleBody: times(30, () => sentence() + ' ') } : {}) })}</script>` : '',
    maybe(0.3) ? `<link rel="icon" href="/fav.png" sizes="${pick(['32x32', '192x192', 'any'])}">` : '',
    maybe(0.2) ? `<base href="${pick(['/sub/', 'https://base.example.net/x/'])}">` : '',
  ].join('');
  const lang = pick(['en', 'en-US', 'ar', 'ja', 'zh-Hant-TW', '', 'pt_br']);
  const dir = pick(['', '', ' dir="rtl"']);
  const body = `<header class="site-header"><a href="/">${site}</a></header><main><article>${maybe(0.8) ? `<h1>${esc(title)}</h1>` : ''}${maybe(0.3) ? `<p class="byline">By <a rel="author" href="/jane">Jane Doe</a></p>` : ''}${times(3 + Math.floor(rand() * 12), () => block())}</article></main><footer>© ${site}</footer>`;
  const html = `<!doctype html><html${lang ? ` lang="${lang}"` : ''}${dir}><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
  return { html, url: pick(['https://example.com/2024/03/story', 'https://www.example.com/post?id=1&utm_source=tw', 'http://news.example.org/a/b.html']) + (i % 7 === 0 ? '#top' : '') };
}

for (const dir of ['html', 'vdoc', 'ts']) mkdirSync(resolve(out, dir), { recursive: true });
const manifest: unknown[] = [];
for (let i = 0; i < count; i++) {
  const { html, url } = page(i);
  const key = `fuzz-${i}`;
  const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
  const vdoc = fromDom(doc);
  writeFileSync(resolve(out, 'html', key + '.html'), html);
  writeFileSync(resolve(out, 'vdoc', key + '.json'), JSON.stringify(vdocJson(vdoc)));
  const article = extractTree(vdoc, { url, markdown: true });
  writeFileSync(resolve(out, 'ts', key + '.json'), JSON.stringify(article, null, 2) + '\n');
  manifest.push({ key, dataset: 'fuzz', id: String(i), url, bytes: html.length, tsMs: 0 });
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`wrote ${count} fuzz pages to ${out}`);
