/**
 * Writes `packages/truffle_dart/test/fixtures/parser_cases.json`: small pages
 * and the `VDocument` jsdom produces for each (`fromDom`, as in the
 * conformance test), so the Dart port's `fromDocument` (package:html) can be
 * checked against the reference parser on the cases where the two differ by
 * construction (scripting-disabled `<noscript>`, `<pre>` newlines, entities).
 * `known` marks package:html tree-construction gaps the port documents
 * instead of reproducing.
 *
 *   bun scripts/parser-cases.ts
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { writeFileSync } from 'node:fs';
import { fromDom } from '../src/index';
import { vdocJson } from './vdoc-json';

const cases: { name: string; html: string; known?: string }[] = [
  { name: 'head noscript pixel', html: '<!doctype html><html><head><meta charset="utf-8"><noscript><img height="1" width="1" style="display:none" src="https://px.example/tr"></noscript><meta property="og:title" content="T"><title>T</title><link rel="canonical" href="/a"></head>\n<body class="b"><p>Text</p></body></html>' },
  { name: 'head noscript styles only', html: '<html><head><noscript><link rel="stylesheet" href="/n.css"><style>.x{}</style></noscript><title>T</title></head><body><p>Text</p></body></html>' },
  { name: 'head noscript whitespace comment img', html: '<html><head><title>T</title><noscript>\n\t<!-- pixel -->\n  <img src="https://px.example/p" />\n  </noscript>\n  <!-- after -->\n</head>\n<body><p>Body</p></body></html>' },
  { name: 'head noscript text', html: '<html><head><noscript>  Enable JavaScript <a href="/x">here</a></noscript><meta name="description" content="d"></head><body><p>Body</p></body></html>' },
  { name: 'body noscript image', html: '<body><p>Before</p><img class="lazy" data-src="/a.jpg"><noscript><img src="/a.jpg" alt="A"></noscript><p>After</p></body>' },
  { name: 'pre newlines', html: '<body><pre>\nbody pre</pre><table><tr><td><pre>\ncell pre</pre></td><td><pre>\n\ntwo newlines</pre></td></tr><caption><pre>\ncaption pre</pre></caption></table><pre><code>\nin code</code></pre></body>' },
  { name: 'entities', html: '<body><p title="a&amp;b &copy &notit;">&amp; &nbsp;&#x1F600; &#128512; &notin; &notit; &copy 2024 &lt;tag&gt; &#0; &#x110000;</p></body>' },
  { name: 'line endings and nulls', html: '<body><p>a\r\nb\rc\u0000d</p><pre>x\r\n\r\ny</pre></body>' },
  { name: 'attribute and tag case', html: '<BODY><DIV CLASS="X" Data-Foo="1" ID="Main"><SPAN Title="t">x</SPAN></DIV><svg viewBox="0 0 1 1"><linearGradient gradientUnits="x"/></svg><math definitionURL="u"><mi>x</mi></math></BODY>' },
  { name: 'comments split text', html: '<body><p>a<!--x-->b</p></body>' },
  { name: 'table foster parenting', html: '<body><table><tr><td>x</td></tr><div>div</div></table></body>' },
  { name: 'table foster parenting text', html: '<body><table>stray<tr><td>x</td></tr></table></body>', known: 'jsdom appends foster-parented text after the table; browsers and package:html insert it before' },
  { name: 'implied end tags', html: '<body><p>a<div>b</div><p>c<ul><li>d<li>e</ul><dl><dt>t<dd>d</dl></body>' },
  { name: 'base and scripts', html: '<html><head><base href="/docs/"><base href="/ignored/"><script type="application/ld+json">{"@type":"Article"}</script></head><body><script type="math/tex; mode=display">x^2</script><script id="__NEXT_DATA__" type="application/json">{"a":1}</script><p>p</p></body></html>' },
  { name: 'body metadata', html: '<body><title>Streamed</title><meta property="og:title" content="T"><meta charset="utf-8"><link rel="icon" href="/i.png"><p>p</p></body>' },
  { name: 'hidden and dropped', html: '<body><div hidden>h</div><div hidden id="S:1">suspense</div><p style="display: none">n</p><span class="sr-only">s</span><div aria-hidden="true" class="photo">kept</div><button>b</button><p>p</p></body>' },
  { name: 'object images', html: '<html><head><object data="/head.svg"></object></head><body><p>a</p><object type="image/svg+xml" data="/chart.svg" width="300" height="200" title="Chart">fallback</object><object data="/x.PNG?v=2"></object><object type="application/pdf" data="/a.pdf">pdf</object><object type="IMAGE/png" data=""></object></body></html>' },
  { name: 'template', html: '<body><div><template><div>t</template>\n<p>after</p></div></body>', known: 'package:html has no <template> support: its content is parsed as ordinary children' },
  { name: 'main end tag', html: '<body><main><div><div>a</main><footer>f</footer></body>', known: 'package:html predates <main>: </main> does not close open elements, <main> does not close <p>' },
  { name: 'menu list items', html: '<body><ul><li>a<menu><li>b</li></menu></li></ul></body>', known: 'package:html does not treat <menu> as special: an <li> inside it closes the outer <li>' },
  { name: 'svg attribute order', html: '<body><svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 1 1"></svg></body>', known: 'package:html moves adjusted foreign attributes (xmlns, xlink:*, camelCase SVG names) to the end' },
  { name: 'noscript closes paragraph', html: '<body><p>a<noscript><div>n</div></noscript>b</p></body>', known: 'noscript markup is re-parsed in isolation, so block content in it does not close an open <p>' },
];

const out = cases.map((c) => {
  const doc = new JSDOM(c.html, { virtualConsole: new VirtualConsole() }).window.document;
  return { ...c, vdoc: vdocJson(fromDom(doc)) };
});
const path = new URL('../../truffle_dart/test/fixtures/parser_cases.json', import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${out.length} cases to ${path}`);
