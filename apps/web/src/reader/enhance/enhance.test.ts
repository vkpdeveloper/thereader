import * as bunTest from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { prepareChapter } from '../epub/chapter';
import type { SpineItem } from '../epub/package';
import type { Resources } from '../epub/resources';
import { anchorQuote, TextIndex } from '../epub/text';
import type { ZipArchive } from '../epub/zip';
import { applyHighlight, declaredLanguage, prepareCode, tokensOf, type Highlighter } from './code';
import { enhanceContent, hydrateMath, needs } from './index';
import { inkVerdict } from './ink';
import { parseMarkup } from './formats';
import { findDelimited, scrubMathml, texOfImage } from './math';
import { MAX_MATHML_NODES, needsRebuild, rebuildMathml, styled } from './mathml';
import { paintOf } from './svg';
import { isPdfConversion } from './pdf';
import { MAX_TEX, texToMathml } from './tex';

// Run with `cd apps/web && bun test src/reader/enhance`.

const { describe, test } = bunTest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

const window = new JSDOM('').window;
const g = globalThis as Record<string, unknown>;
for (const name of ['Node', 'NodeFilter', 'DOMParser', 'XMLSerializer']) g[name] ??= (window as unknown as Record<string, unknown>)[name];

hljs.registerLanguage('python', python);
const highlight: Highlighter = (code, language) => {
  if (language && language !== 'python') return null;
  const result = language ? hljs.highlight(code, { language: 'python' }) : hljs.highlightAuto(code, ['python']);
  return result.relevance >= 5 || language ? { html: result.value, language: 'python' } : null;
};

function xhtmlSource(body: string, head = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

function xhtml(body: string, head = ''): Document {
  return new window.DOMParser().parseFromString(xhtmlSource(body, head), 'application/xhtml+xml') as unknown as Document;
}

/** Text as the web TextIndex sees it (the string highlights and Readium quotes index into). */
function bookText(doc: Document): string {
  return new TextIndex(doc.body ?? doc.getElementsByTagNameNS('*', 'body')[0]).text;
}

function bodyOf(doc: Document): HTMLElement {
  return (doc.body ?? doc.getElementsByTagNameNS('*', 'body')[0]) as HTMLElement;
}

async function enhanceAll(doc: Document): Promise<void> {
  const body = bodyOf(doc);
  await enhanceContent(doc, body, { tex: texToMathml, highlight });
  hydrateMath(body, texToMathml);
}

const sampler = unzipSync(new Uint8Array(readFileSync(new URL('../../../fixtures/enhance-sampler.epub', import.meta.url))));
const chapters = Object.keys(sampler).filter((k) => /OEBPS\/(?!nav)\w+\.xhtml$/.test(k));

describe('text invariant', () => {
  for (const name of chapters) {
    test(`${name}: book text and highlight anchors are unchanged`, async () => {
      const source = strFromU8(sampler[name]);
      const doc = new window.DOMParser().parseFromString(source, 'application/xhtml+xml') as unknown as Document;
      const before = bookText(doc);
      const raw = bodyOf(doc).textContent;
      await enhanceAll(doc);
      expect(bookText(doc)).toBe(before);
      expect(bodyOf(doc).textContent).toBe(raw);
      // A quote taken before resolves to the same offsets after.
      const quote = before.replace(/\s+/g, ' ').trim().slice(20, 60).trim();
      if (quote.length > 8) {
        const a = anchorQuote(new TextIndex(bodyOf(doc)), { highlight: quote }, null);
        const fresh = new window.DOMParser().parseFromString(source, 'application/xhtml+xml') as unknown as Document;
        const b = anchorQuote(new TextIndex(bodyOf(fresh)), { highlight: quote }, null);
        expect(a).toEqual(b);
      }
    });
  }

  test('enhancing twice changes nothing more', async () => {
    const doc = new window.DOMParser().parseFromString(strFromU8(sampler['OEBPS/tex.xhtml']), 'application/xhtml+xml') as unknown as Document;
    await enhanceAll(doc);
    const once = bodyOf(doc).innerHTML;
    await enhanceAll(doc);
    expect(bodyOf(doc).innerHTML).toBe(once);
  });

  test('a plain prose chapter is untouched', async () => {
    const doc = new window.DOMParser().parseFromString(strFromU8(sampler['OEBPS/prose.xhtml']), 'application/xhtml+xml') as unknown as Document;
    const before = bodyOf(doc).innerHTML;
    expect(needs(doc, bodyOf(doc))).toEqual({ tex: false, code: false });
    await enhanceAll(doc);
    expect(bodyOf(doc).innerHTML).toBe(before);
  });
});

describe('math', () => {
  test('TeX alt images render into a shadow root and the image stays, hidden', async () => {
    const doc = xhtml(`<p>Map <span class="inline_math"><img src="../Images/a.png" alt="T \\colon \\mathbb{R}^n \\to \\mathbb{R}^m" style="height:1.09em; vertical-align:-0.14em;"/></span>.</p>
<div class="equation"><img src="../Images/b.png" alt="x^2-4=45." style="height:1.38em;"/></div>`);
    await enhanceAll(doc);
    const hosts = Array.from(bodyOf(doc).querySelectorAll('.tr-math'));
    expect(hosts.length).toBe(2);
    expect(hosts[0].hasAttribute('data-tr-ui')).toBe(true);
    expect(hosts[0].shadowRoot?.querySelector('math')).toBeTruthy();
    expect(hosts[0].textContent).toBe('');
    expect(hosts[1].classList.contains('tr-math-display')).toBe(true);
    for (const img of Array.from(bodyOf(doc).querySelectorAll('img'))) expect(img.classList.contains('tr-hidden')).toBe(true);
  });

  test('figures, file-name alts and unparseable TeX keep their image', () => {
    const doc = xhtml(`<div class="figure"><img src="i/number_line.png" alt="number_line" style="width:100%"/></div>
<p><span class="inline_math"><img src="i/x.png" alt="precalculus_for_LA" style="height:1em"/></span></p>
<p><img src="i/c.png" alt="Figure 3: a chart"/></p>
<p><span class="inline_math"><img src="i/y.png" alt="formula" style="height:1em"/></span></p>`);
    for (const img of Array.from(bodyOf(doc).querySelectorAll('img'))) expect(texOfImage(img)).toBe(null);
    expect(texToMathml('\\undefinedmacro{a}', false)).toBe(null);
  });

  test('pandoc spans, MathJax scripts and delimited TeX keep their source text', async () => {
    const doc = xhtml(`<p>A <span class="math inline">\\(a^2\\)</span> and $$\\frac{1}{2}$$ and <script type="math/tex">x_1</script>.</p>`);
    const before = bodyOf(doc).textContent;
    await enhanceAll(doc);
    expect(bodyOf(doc).querySelectorAll('.tr-math').length).toBe(3);
    expect(bodyOf(doc).textContent).toBe(before);
    expect(bodyOf(doc).querySelectorAll('.tr-math-source.tr-hidden').length).toBe(2);
  });

  test('a MathJax preview is hidden while the formula renders and shown again when it cannot', async () => {
    for (const rendered of [false, true]) {
      const output = rendered ? '<span class="MathJax">x</span>' : '';
      const doc = xhtml(`<p>Area <span class="MathJax_Preview">πr²</span>${output}<script type="math/tex">\\pi r^2</script>.</p>`);
      const body = bodyOf(doc);
      await enhanceContent(doc, body, { tex: texToMathml, highlight });
      const preview = body.querySelector('.MathJax_Preview')!;
      expect(preview.classList.contains('tr-hidden')).toBe(true);
      hydrateMath(body, () => null);
      expect(preview.classList.contains('tr-hidden')).toBe(false);
    }
  });

  test('display MathML gets a scroll box and epub:switch shows MathML', async () => {
    const doc = new window.DOMParser().parseFromString(strFromU8(sampler['OEBPS/mathml.xhtml']), 'application/xhtml+xml') as unknown as Document;
    await enhanceAll(doc);
    const body = bodyOf(doc);
    expect(body.querySelectorAll('.tr-math-scroll').length).toBe(3);
    const fallback = Array.from(body.getElementsByTagNameNS('http://www.idpf.org/2007/ops', 'default'))[0];
    expect(fallback.getAttribute('class')).toContain('tr-hidden');
  });
});

describe('other maths formats', () => {
  const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
  /** Shadow MathML of every formula host, serialized. */
  const rendered = (doc: Document) =>
    Array.from(bodyOf(doc).querySelectorAll('.tr-math')).map((h) => h.shadowRoot?.querySelector('math')?.outerHTML ?? null);
  const classes = (doc: Document, selector: string) => Array.from(bodyOf(doc).querySelectorAll(selector)).map((e) => e.getAttribute('class'));

  test('KaTeX shows its MathML and hides its HTML', async () => {
    const doc = xhtml(`<p>A <span class="katex"><span class="katex-mathml"><math ${M}><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord mathnormal">x</span></span></span>.</p>`);
    const before = bookText(doc);
    await enhanceAll(doc);
    expect(classes(doc, '.katex-html')).toEqual(['katex-html tr-hidden']);
    expect(classes(doc, '.katex-mathml')).toEqual(['katex-mathml tr-shown']);
    expect(bookText(doc)).toBe(before);
  });

  test('MathJax 3 shows its assistive MathML instead of CHTML or SVG', async () => {
    const doc = xhtml(`<p><mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true"><mjx-mi><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math><mjx-assistive-mml display="inline"><math ${M}><mi>x</mi></math></mjx-assistive-mml></mjx-container>
<mjx-container class="MathJax" jax="SVG"><svg xmlns="http://www.w3.org/2000/svg" width="1.3ex" height="1ex"><g fill="currentColor"><path d="M0 0h10"/></g></svg><mjx-assistive-mml><math ${M}><mi>y</mi></math></mjx-assistive-mml></mjx-container></p>`);
    await enhanceAll(doc);
    expect(classes(doc, 'mjx-assistive-mml')).toEqual(['tr-shown', 'tr-shown']);
    expect(classes(doc, 'mjx-math')).toEqual(['MJX-TEX tr-hidden']);
    expect(bodyOf(doc).querySelector('svg')!.getAttribute('class')).toContain('tr-hidden');
  });

  test('MathJax 2 frames: assistive MathML, then data-mathml, then the script source', async () => {
    const frame = (id: number, inner: string, attrs = '') => `<span class="MathJax_Preview"></span><span id="MathJax-Element-${id}-Frame" class="mjx-chtml MathJax_CHTML"${attrs}><span class="mjx-math"><span class="mjx-char">v</span></span>${inner}</span><script type="math/tex" id="MathJax-Element-${id}">v_${id}</script>`;
    const doc = xhtml(`<p>${frame(1, `<span class="MJX_Assistive_MathML"><math ${M}><mi>a</mi></math></span>`)}</p>
<p>${frame(2, '', ` data-mathml="&lt;math ${M.replace(/"/g, '&quot;')}&gt;&lt;mi&gt;b&lt;/mi&gt;&lt;/math&gt;"`)}</p>
<p>${frame(3, '')}</p>`);
    const before = bookText(doc);
    await enhanceAll(doc);
    const [p1, p2, p3] = Array.from(bodyOf(doc).querySelectorAll('p'));
    // 1: the assistive MathML shows; the glyph spans and the script do not render.
    expect(p1.querySelector('.MJX_Assistive_MathML')!.getAttribute('class')).toContain('tr-shown');
    expect(p1.querySelector('.mjx-math')!.getAttribute('class')).toContain('tr-hidden');
    expect(p1.querySelectorAll('.tr-math').length).toBe(0);
    // 2: data-mathml renders in a host; the frame hides.
    expect(p2.querySelector('[id$="-Frame"]')!.getAttribute('class')).toContain('tr-hidden');
    expect(p2.querySelector('.tr-math')!.shadowRoot!.querySelector('mi')!.textContent).toBe('b');
    // 3: only TeX: the frame hides and the script renders.
    expect(p3.querySelector('[id$="-Frame"]')!.getAttribute('class')).toContain('tr-hidden');
    expect(p3.querySelector('.tr-math')!.getAttribute('data-tr-tex')).toBe('v_3');
    for (const p of [p1, p2, p3]) expect(p.querySelector('.MathJax_Preview')!.getAttribute('class')).toContain('tr-hidden');
    expect(bookText(doc)).toBe(before);
  });

  test('formulas in data attributes and math/mml scripts render; numbers and native MathML do not', async () => {
    const doc = xhtml(`<p><span class="math" data-tex="\\frac{a}{b}">a/b</span> <span data-latex="x^2">x2</span></p>
<div class="equation" data-equation="\\mathbf{A}\\mathbf{x}">Ax</div>
<p data-equation="3.1">An equation number (3.1).</p>
<p><span data-latex="y"><math ${M}><mi>y</mi></math></span></p>
<p><span data-mathml="&lt;math&gt;&lt;mi&gt;z&lt;/mi&gt;&lt;/math&gt;">z</span>
<script type="math/mml"><![CDATA[<math ${M} display="block"><mi>w</mi></math>]]></script></p>`);
    const before = bookText(doc);
    await enhanceAll(doc);
    const hosts = Array.from(bodyOf(doc).querySelectorAll('.tr-math'));
    expect(hosts.map((h) => h.getAttribute('data-tr-tex') ?? h.shadowRoot?.querySelector('mi')?.textContent)).toEqual(['\\frac{a}{b}', 'x^2', '\\mathbf{A}\\mathbf{x}', 'z', 'w']);
    expect(hosts.map((h) => h.classList.contains('tr-math-display'))).toEqual([false, false, true, false, true]);
    expect(bodyOf(doc).querySelector('p[data-equation]')!.hasAttribute('class')).toBe(false);
    expect(rendered(doc).every(Boolean)).toBe(true);
    expect(bookText(doc)).toBe(before);
    expect(needs(xhtml('<p><span data-latex="x">x</span></p>'), bodyOf(xhtml('<p><span data-latex="x">x</span></p>'))).tex).toBe(true);
  });

  test('an object or embed showing a book image becomes an image the ink rule sees', async () => {
    const doc = xhtml(`<p><object data="eq.svg" type="image/svg+xml" style="height:1em">fallback</object>
<object data="https://example.com/x.svg" type="image/svg+xml">remote</object><object data="movie.mp4">clip</object><embed src="eq2.png"/></p>`);
    const before = bookText(doc);
    await enhanceAll(doc);
    const imgs = Array.from(bodyOf(doc).querySelectorAll('img'));
    expect(imgs.map((i) => [i.getAttribute('src'), i.hasAttribute('data-tr-ui'), i.getAttribute('style')])).toEqual([['eq.svg', true, 'height:1em'], ['eq2.png', true, null]]);
    expect(classes(doc, 'object')).toEqual(['tr-hidden', null, null]);
    expect(bookText(doc)).toBe(before);
  });

  test('black formula SVGs follow the text colour; artwork keeps its paint', async () => {
    const S = 'xmlns="http://www.w3.org/2000/svg"';
    const doc = xhtml(`<p>Inline <svg ${S} width="6ex" height="2ex"><path d="M0 0h1" fill="#000"/><path d="M0 0h1" style="stroke:black;stroke-width:2"/><path d="M0 0h1" fill="none"/></svg>.</p>
<p>Unpainted <svg ${S} width="40" height="16"><path d="M0 0h1"/></svg> in text.</p>
<p><svg ${S} width="200" height="120"><circle r="9" fill="#f2a541"/><path d="M0 0" fill="#000"/></svg></p>
<p><svg ${S} width="300" height="300"><path d="M0 0h1" fill="#000"/></svg></p>
<p>Styled <svg ${S} width="5ex" height="2ex"><style>.a{fill:#000}</style><path class="a" d="M0 0"/></svg>.</p>
<p>Boxed <svg ${S} width="5ex" height="2ex"><rect width="9" height="9" fill="#fff"/><path d="M0 0" fill="#000"/></svg>.</p>`);
    const markup = bodyOf(doc).innerHTML;
    const before = bookText(doc);
    await enhanceAll(doc);
    const svgs = Array.from(bodyOf(doc).getElementsByTagNameNS('http://www.w3.org/2000/svg', 'svg'));
    expect(svgs.map((s) => s.getAttribute('class'))).toEqual(['tr-svg-ink', 'tr-svg-ink', null, null, null, null]);
    const paths = Array.from(svgs[0].children) as SVGElement[];
    expect(paths.map((p) => p.getAttribute('fill'))).toEqual(['currentColor', null, 'none']);
    expect(paths[1].getAttribute('style')!.toLowerCase()).toContain('stroke: currentcolor');
    expect(svgs[1].getAttribute('fill')).toBe('currentColor');
    expect(bodyOf(doc).innerHTML.length).toBeGreaterThan(markup.length);
    expect(bookText(doc)).toBe(before);
    expect(['#000', 'black', 'rgb(20, 20, 20)', '#222f', 'grey'].map(paintOf)).toEqual(['dark', 'dark', 'dark', 'dark', 'colour']);
    expect(['none', 'currentColor', '#fff', '#c0392b', 'url(#g)'].map(paintOf)).toEqual(['none', 'none', 'light', 'colour', 'colour']);
  });
});

describe('MathML for MathML Core browsers', () => {
  const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
  const parse = (markup: string) => new window.DOMParser().parseFromString(markup, 'application/xml').documentElement as unknown as Element;
  const rebuilt = (markup: string) => {
    const doc = xhtml('');
    return rebuildMathml(parse(markup), doc)!;
  };

  test('only formulas that need it are rebuilt', () => {
    expect(needsRebuild(parse(`<math ${M}><mi mathvariant="normal">x</mi><mfrac><mn>1</mn><mn>2</mn></mfrac></math>`))).toBe(false);
    expect(needsRebuild(parse(`<math ${M}><semantics><mi>x</mi><annotation-xml encoding="text/html"><b xmlns="http://www.w3.org/1999/xhtml">x</b></annotation-xml></semantics></math>`))).toBe(false);
    for (const inner of ['<mfenced><mi>a</mi></mfenced>', '<mi mathvariant="bold">v</mi>', '<menclose notation="box"><mi>x</mi></menclose>', '<mtable><mlabeledtr><mtd><mtext>(1)</mtext></mtd><mtd><mi>x</mi></mtd></mlabeledtr></mtable>']) {
      expect(needsRebuild(parse(`<math ${M}>${inner}</math>`))).toBe(true);
    }
    expect(needsRebuild(parse('<math><mi>x</mi></math>'))).toBe(true);
  });

  test('fences, letter styles, enclosures and labels become MathML Core', () => {
    const fenced = rebuilt(`<math ${M}><mfenced open="[" separators=";"><mi>a</mi><mi>b</mi><mi>c</mi></mfenced></math>`);
    expect(Array.from(fenced.getElementsByTagName('mo')).map((m) => m.textContent)).toEqual(['[', ';', ';', ')']);
    expect(rebuilt(`<math ${M}><mstyle mathvariant="double-struck"><mi>R</mi><mn>1</mn></mstyle><mi mathvariant="bold">x</mi><mi mathvariant="script">L</mi></math>`).textContent).toBe('ℝ𝟙𝐱ℒ');
    expect(styled('αβ', 'bold')).toBe('𝛂𝛃');
    expect(styled('h', 'italic', true)).toBe('h');
    expect(styled('h', 'italic')).toBe('ℎ');
    expect(styled('ab', 'italic')).toBe('𝑎𝑏');
    expect(rebuilt(`<math ${M}><menclose notation="box"><mi>x</mi></menclose></math>`).firstElementChild!.getAttribute('style')).toContain('border');
    const row = rebuilt(`<math ${M}><mtable><mlabeledtr><mtd><mtext>(1)</mtext></mtd><mtd><mi>x</mi></mtd></mlabeledtr></mtable></math>`).getElementsByTagName('mtr')[0];
    expect(Array.from(row.children).map((c) => c.textContent)).toEqual(['x', '(1)']);
  });

  test('a rebuilt formula holds only MathML, text and presentation attributes', () => {
    const math = rebuilt(`<math ${M} onload="a()"><mi href="javascript:x" style="color:red" class="c" id="i" mathvariant="normal">x</mi><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script><mo stretchy="false">(</mo></math>`);
    const all = [math, ...Array.from(math.getElementsByTagNameNS('*', '*'))];
    expect(all.every((e) => e.namespaceURI === 'http://www.w3.org/1998/Math/MathML')).toBe(true);
    expect(all.map((e) => e.localName)).toEqual(['math', 'mi', 'mrow', 'mo']);
    expect(all.flatMap((e) => Array.from(e.attributes).map((a) => a.name))).toEqual(['class', 'mathvariant', 'stretchy']);
    expect(scrubMathml(math)).toBe(true);
  });

  test('prefixed MathML read as HTML and MathML without its namespace render from a rebuilt copy', async () => {
    const html = new window.DOMParser().parseFromString('<p>A <m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mfenced><m:mi>x</m:mi></m:mfenced></m:math> and <math><mi>y</mi></math>.</p>', 'text/html') as unknown as Document;
    const kf8 = xhtml('<p>B <math><msup><mi>z</mi><mn>2</mn></msup></math>.</p>');
    for (const doc of [html, kf8]) {
      const before = bookText(doc);
      await enhanceAll(doc);
      expect(bookText(doc)).toBe(before);
      const hosts = Array.from(bodyOf(doc).querySelectorAll('.tr-math'));
      expect(hosts.length).toBeGreaterThan(0);
      for (const h of hosts) expect(h.shadowRoot!.querySelector('math')!.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
    }
    expect(Array.from(bodyOf(html).querySelectorAll('.tr-math'))[0].shadowRoot!.querySelector('math')!.textContent).toBe('(x)');
  });

  test('book MathML strings parse inertly or not at all', () => {
    expect(parseMarkup('<math><mi>x&nbsp;</mi></math>')!.textContent).toBe('x\u00a0');
    expect(parseMarkup('<b>not maths</b>')).toBe(null);
    expect(parseMarkup(`<math>${'<mi>x</mi>'.repeat(10000)}</math>`)).toBe(null);
  });
});

describe('code', () => {
  test('declared languages', () => {
    const pre = (html: string) => xhtml(html).getElementsByTagNameNS('*', 'pre')[0];
    expect(declaredLanguage(pre('<pre><code class="language-python">x</code></pre>'))).toBe('python');
    expect(declaredLanguage(pre('<pre data-lang="js">x</pre>'))).toBe('js');
    expect(declaredLanguage(pre('<pre class="brush: rust">x</pre>'))).toBe('rust');
    expect(declaredLanguage(pre('<pre class="code-area">x</pre>'))).toBe(null);
    expect(declaredLanguage(pre('<pre class="language-text">x</pre>'))).toBe('');
    expect(declaredLanguage(pre('<pre lang="en">x</pre>'))).toBe(null);
  });

  test('highlight markup flattens to runs over the source', () => {
    const { text, runs } = tokensOf('<span class="hljs-keyword">def</span> <span class="hljs-title function_">f</span>(<span class="hljs-params">a &amp; b</span>)');
    expect(text).toBe('def f(a & b)');
    expect(runs.map((r) => text.slice(r.start, r.end))).toEqual(['def', 'f', 'a & b']);
  });

  test('highlighting wraps the original text nodes without changing text', async () => {
    const doc = xhtml('<pre class="code-area">import os\nfor name in os.listdir("."):\n    print(name)  # <b>list</b> files<br/>print("done")</pre>');
    const pre = bodyOf(doc).querySelector('pre')!;
    const before = pre.textContent;
    await enhanceContent(doc, bodyOf(doc), { tex: null, highlight });
    expect(pre.textContent).toBe(before);
    expect(pre.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
    expect(pre.querySelector('b')?.textContent).toBe('list');
    expect(pre.getAttribute('class')).toContain('tr-code');
  });

  test('a mismatched highlight is refused', () => {
    const pre = xhtml('<pre>abc</pre>').getElementsByTagNameNS('*', 'pre')[0];
    expect(applyHighlight(pre, '<span class="hljs-keyword">abd</span>')).toBe(false);
    expect(pre.textContent).toBe('abc');
  });
});

describe('tables', () => {
  test('tables get one scroll box', async () => {
    const doc = xhtml('<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>');
    await enhanceContent(doc, bodyOf(doc), { tex: null, highlight: null });
    expect(bodyOf(doc).querySelectorAll('.tr-table-scroll').length).toBe(1);
  });
});

describe('PDF conversions', () => {
  test('only with strong signals', () => {
    const plain = xhtml('<p>One.</p><p>Two.</p>');
    expect(isPdfConversion(plain, bodyOf(plain))).toBe(false);
    const pdf = xhtml('<p>x</p>', '<meta name="generator" content="pdftohtml 0.36"/>');
    expect(isPdfConversion(pdf, bodyOf(pdf))).toBe(true);
  });

  test('neutralises the italic wrapper, hides page furniture, joins broken lines', async () => {
    const doc = new window.DOMParser().parseFromString(strFromU8(sampler['OEBPS/pdf.xhtml']), 'application/xhtml+xml') as unknown as Document;
    const before = bookText(doc);
    await enhanceAll(doc);
    const body = bodyOf(doc);
    expect(bookText(doc)).toBe(before);
    expect(body.querySelector('i')!.getAttribute('class')).toContain('tr-pdf-neutral');
    const hidden = Array.from(body.querySelectorAll('.tr-pdf-hidden')).map((p) => p.textContent!.trim());
    expect(hidden).toEqual([
      'SECTION 2.B', 'Bases and Spans', '27', '28', 'CHAPTER 2', 'Finite-Dimensional Vector Spaces', 'SECTION 2.B', 'Bases and Spans', '29',
      '30', 'CHAPTER 2', 'Finite-Dimensional Vector Spaces',
    ]);
    expect(body.querySelector('.tr-pdf-label')!.textContent).toBe('2.31');
    expect(body.querySelector('.tr-pdf-title')!.textContent).toBe('Every spanning list contains a basis');
    const paras = Array.from(body.querySelectorAll('.tr-pdf-para')).map((d) => d.textContent!.replace(/\s+/g, ' ').trim());
    expect(paras[0]).toBe(
      'Suppose we start with a list of vectors that spans the space. Removing the vectors that depend on the earlier ones, one at a time, leaves a list that still spans the space and is linearly independent.',
    );
    // A sentence broken by a page break joins across the collapsed header lines.
    expect(paras[1]).toContain('not in the span of the 28 CHAPTER 2 Finite-Dimensional Vector Spaces vectors kept so far');
    expect(paras).toContain('(a) v is kept;');
  });
});

describe('PDF item labels', () => {
  test('a bare "(c)" line joins the item after it whatever it starts with', async () => {
    const doc = xhtml('<p>(c)</p>\n<p>. v + U / \\ . w + U / ¤ ¿.</p>\n<p>Proof</p>', '<meta name="generator" content="pdftohtml 0.36"/>');
    const before = bookText(doc);
    await enhanceContent(doc, bodyOf(doc), { tex: null, highlight: null });
    expect(bookText(doc)).toBe(before);
    const para = bodyOf(doc).querySelector('.tr-pdf-para')!;
    expect(para.textContent!.replace(/\s+/g, ' ').trim()).toBe('(c) . v + U / \\ . w + U / ¤ ¿.');
  });
});

describe('dark ink', () => {
  const pixels = (fn: (i: number) => [number, number, number, number], n = 400) => {
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) data.set(fn(i), i * 4);
    return data;
  };
  test('dark ink on transparency is inverted', () => {
    expect(inkVerdict(pixels((i) => (i % 5 === 0 ? [10, 10, 10, 255] : [0, 0, 0, 0])))).toBe('invert');
  });
  test('opaque images and light ink are kept', () => {
    expect(inkVerdict(pixels(() => [200, 120, 40, 255]))).toBe('keep');
    expect(inkVerdict(pixels((i) => (i % 5 === 0 ? [10, 10, 10, 255] : [255, 255, 255, 255])))).toBe('keep');
    expect(inkVerdict(pixels((i) => (i % 5 === 0 ? [240, 240, 240, 255] : [0, 0, 0, 0])))).toBe('keep');
  });
  /** A 20x20 sample: white border, `ink` inside. */
  const framed = (ink: (i: number) => [number, number, number, number]) =>
    pixels((i) => {
      const x = i % 20;
      const y = Math.floor(i / 20);
      return x === 0 || y === 0 || x === 19 || y === 19 ? [255, 255, 255, 255] : ink(i);
    });
  test('black on opaque white turns light; colour, photos and unknown widths stay', () => {
    const text = framed((i) => (i % 7 === 0 ? [15, 15, 15, 255] : [255, 255, 255, 255]));
    expect(inkVerdict(text, 20)).toBe('paper');
    expect(inkVerdict(text)).toBe('keep');
    expect(inkVerdict(framed((i) => (i % 7 === 0 ? [200, 30, 30, 255] : [255, 255, 255, 255])), 20)).toBe('keep');
    // Greyscale tones over a third of the frame, or mostly mid-grey: a photo.
    expect(inkVerdict(framed((i) => (i % 3 === 0 ? [(i * 37) % 200, (i * 37) % 200, (i * 37) % 200, 255] : [250, 250, 250, 255])), 20)).toBe('keep');
    expect(inkVerdict(framed((i) => (i % 7 === 0 ? [150, 150, 150, 255] : i % 23 === 0 ? [20, 20, 20, 255] : [250, 250, 250, 255])), 20)).toBe('keep');
    // Dark background: not paper.
    expect(inkVerdict(pixels((i) => (i % 7 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 20)).toBe('keep');
  });
});

describe('untrusted books', () => {
  const ms = async (fn: () => unknown) => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };
  /** Every element and attribute in a formula's shadow root. */
  const shadowMarkup = (doc: Document) =>
    Array.from(bodyOf(doc).querySelectorAll('.tr-math'))
      .flatMap((h) => (h.shadowRoot ? [h.shadowRoot, ...Array.from(h.shadowRoot.querySelectorAll('*'))] : []))
      .flatMap((n) => ('attributes' in n ? [(n as Element).localName, ...Array.from((n as Element).attributes).map((a) => a.name)] : []));

  test('temml refuses links, raw HTML, styles and images (trust: false)', () => {
    for (const tex of ['\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\htmlClass{a}{x}', '\\htmlStyle{color:red}{x}',
      '\\htmlData{a=b}{x}', '\\includegraphics{http://e/x.png}', '\\color{red;background:url(http://e)}{x}', '\\textcolor{url(x)}{y}']) {
      expect(texToMathml(tex, false)).toBe(null);
    }
  });

  test('a formula renders text, never markup, and loses \\ref links', async () => {
    const doc = xhtml(`<p>$$\\text{&lt;img src=x onerror=alert(1)&gt;} + \\ref{a} + \\eqref{javascript:x}$$</p>`);
    await enhanceAll(doc);
    const names = shadowMarkup(doc);
    expect(names).toContain('mtext');
    expect(names.filter((n) => n.startsWith('on') || n === 'href' || n === 'img' || n === 'script')).toEqual([]);
  });

  test('scrubbed MathML keeps only MathML elements and no handlers or URLs', () => {
    const parsed = new window.DOMParser().parseFromString(
      `<math xmlns="http://www.w3.org/1998/Math/MathML" xmlns:x="http://www.w3.org/1999/xlink" onload="a()"><mi href="javascript:x" x:href="#a" onclick="b()" mathvariant="bold">x</mi>` +
        `<semantics><annotation-xml encoding="text/html"><b xmlns="http://www.w3.org/1999/xhtml">h</b></annotation-xml></semantics>` +
        `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg><mtext src="x">t</mtext></math>`,
      'application/xml',
    );
    const math = parsed.documentElement as unknown as Element;
    expect(scrubMathml(math)).toBe(true);
    const all = [math, ...Array.from(math.getElementsByTagNameNS('*', '*'))];
    expect(all.map((e) => e.localName)).toEqual(['math', 'mi', 'semantics', 'mtext']);
    expect(all.flatMap((e) => Array.from(e.attributes).map((a) => a.name)).filter((n) => !n.startsWith('xmlns'))).toEqual(['mathvariant']);
    const html = new window.DOMParser().parseFromString('<b xmlns="http://www.w3.org/1999/xhtml">x</b>', 'application/xml');
    expect(scrubMathml(html.documentElement as unknown as Element)).toBe(false);
  });

  test("a book's look-alike formula host keeps its own content", async () => {
    const doc = xhtml(`<p>$$x^2$$ <span class="tr-math" data-tr-ui="" data-tr-tex="y">book text</span></p>`);
    await enhanceAll(doc);
    const fake = Array.from(bodyOf(doc).querySelectorAll('.tr-math')).find((h) => h.textContent === 'book text')!;
    expect(fake.shadowRoot).toBe(null);
    expect(bodyOf(doc).querySelectorAll('.tr-math').length).toBe(2);
  });

  test('rebuilding MathML is capped and linear', async () => {
    const doc = xhtml('');
    const parse = (m: string) => new window.DOMParser().parseFromString(m, 'application/xml').documentElement as unknown as Element;
    const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
    expect(rebuildMathml(parse(`<math ${M}>${'<mi>x</mi>'.repeat(MAX_MATHML_NODES)}</math>`), doc)).toBe(null);
    expect(rebuildMathml(parse(`<math ${M}>${'<mrow>'.repeat(5000)}x${'</mrow>'.repeat(5000)}</math>`), doc)?.textContent ?? '').toBe('');
    // jsdom's live collections make DOM edits cost O(n) here; a browser does 3000 of these in ~100 ms.
    const many = xhtml(Array.from({ length: 400 }, () => `<p><math ${M}><mfenced><mi>a</mi></mfenced></math><object data="a.svg">f</object><span data-latex="\\alpha">a</span></p>`).join(''));
    expect(await ms(() => enhanceContent(many, bodyOf(many), { tex: texToMathml, highlight: null }))).toBeLessThan(3000);
  });

  test('oversized TeX is not rendered', () => {
    expect(texToMathml(`${'x+'.repeat(MAX_TEX)}x`, false)).toBe(null);
    expect(texToMathml('x+y', false)).not.toBe(null);
  });

  test('delimited TeX scanning matches the regex and stays linear', async () => {
    const regex = /\$\$([^$]{1,4000}?)\$\$|\\\[([\s\S]{1,4000}?)\\\]|\\\(([\s\S]{1,4000}?)\\\)/g;
    const alphabet = ['$', '$', '\\[', '\\]', '\\(', '\\)', 'a', ' ', '\\'];
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 3000; round++) {
      const text = Array.from({ length: 1 + rand(24) }, () => alphabet[rand(alphabet.length)]).join('');
      const want = Array.from(text.matchAll(regex)).map((m) => [m.index, m[0]]);
      expect(findDelimited(text).map((d) => [d.index, d.source])).toEqual(want);
    }
    expect(findDelimited(`a \\[${'b'.repeat(4001)}\\] \\(c\\)`).map((d) => d.source)).toEqual(['\\(c\\)']);
    // The regex takes ~1 s here (4000 characters rescanned per opener); the scan, milliseconds.
    expect(await ms(() => findDelimited(`${'\\['.repeat(500000)}x\\]`))).toBeLessThan(300);
  });

  test('alt text and class lists cannot make TeX detection quadratic', async () => {
    const imgs = Array.from({ length: 800 }, () => `<img src="i.png" alt="${'{'.repeat(3990)}" style="height:1em"/>`).join('');
    const doc = xhtml(`<div class="${'x'.repeat(200000)} equation">${imgs}</div>`);
    expect(await ms(() => needs(doc, bodyOf(doc)))).toBeLessThan(800);
  });

  test('a huge generator meta is not rescanned', async () => {
    const doc = xhtml('<p>x</p>', `<meta name="generator" content="${'Adobe InDesign '.repeat(14000)}"/>`);
    expect(await ms(() => isPdfConversion(doc, bodyOf(doc)))).toBeLessThan(100);
  });

  test('a run of page anchors is not rescanned from each anchor', async () => {
    // Counted, not timed: jsdom's own element collections are quadratic and would dominate.
    const doc = xhtml(`${'<a id="p1"></a>'.repeat(1000)}${'<b/>'.repeat(2000)}<p>x</p>`, '<meta name="generator" content="pdftohtml"/>');
    const proto = window.Element.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, 'nextElementSibling')!;
    let hops = 0;
    Object.defineProperty(proto, 'nextElementSibling', { configurable: true, get() { hops++; return real.get!.call(this); } });
    try {
      await enhanceContent(doc, bodyOf(doc), { tex: null, highlight: null });
    } finally {
      Object.defineProperty(proto, 'nextElementSibling', real);
    }
    // Before: every anchor walked the 3000 siblings after it (~3 million hops).
    expect(hops).toBeLessThan(20000);
  });

  test('code blocks over the size caps are styled but not highlighted', async () => {
    const seen: number[] = [];
    const spy: Highlighter = (code) => {
      seen.push(code.length);
      return null;
    };
    const doc = xhtml(`<pre>${'a '.repeat(3500)}</pre><pre class="language-python">${'a '.repeat(7000)}</pre><pre class="language-python">x = 1</pre>`);
    await prepareCode(bodyOf(doc), spy);
    expect(seen).toEqual([5]);
    expect(bodyOf(doc).querySelectorAll('pre.tr-code').length).toBe(3);
  });

  test('highlighting a block made of thousands of text nodes keeps every character', () => {
    const doc = xhtml(`<pre><code class="language-python">${Array.from({ length: 4000 }, (_, i) => `<span>x${i} = "</span>s"\n`).join('')}</code></pre>`);
    const pre = bodyOf(doc).querySelector('pre')!;
    const before = pre.textContent;
    const html = hljs.highlight(before!, { language: 'python' }).value;
    expect(applyHighlight(pre, html)).toBe(true);
    expect(pre.textContent).toBe(before);
    // Each string token spans two of the book's text nodes: two wrapped pieces apiece.
    expect(pre.querySelectorAll('.hljs-string').length).toBe(8000);
  });

  test('the sanitizer drops <img name> so the chapter cannot shadow document properties', async () => {
    const zip = { readText: async () => xhtmlSource('<p><img src="a.png" name="body" id="x"/><a name="keep" id="k">t</a></p>') } as unknown as ZipArchive;
    const res = { url: async () => 'blob:x', rewriteCss: async (css: string) => css, stylesheet: async () => '' } as unknown as Resources;
    const item = { index: 0, href: 'c.xhtml', mediaType: 'application/xhtml+xml' } as unknown as SpineItem;
    const chapter = await prepareChapter(zip, res, item);
    expect(chapter.failed).toBe(false);
    expect(chapter.body.querySelector('img')!.hasAttribute('name')).toBe(false);
    expect(chapter.body.querySelector('a')!.getAttribute('name')).toBe('keep');
  });

  test("setTheme writes its own stylesheet, never a book element's text", async () => {
    await import('./bundle');
    const api = (globalThis as unknown as { TheReaderEnhance: { setTheme: (t: object, d: Document) => void } }).TheReaderEnhance;
    const doc = xhtml('<div id="tr-theme">book text</div>');
    api.setTheme({ panel: '#111111', border: 'red;}body{display:none' }, doc);
    api.setTheme({ panel: '#222222' }, doc);
    expect(bodyOf(doc).querySelector('div')!.textContent).toBe('book text');
    const styles = Array.from(doc.getElementsByTagNameNS('*', 'style'));
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toBe(':root{--tr-panel:#222222;}');
  });
});
