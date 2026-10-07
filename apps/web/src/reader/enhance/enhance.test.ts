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
import { findDelimited, scrubMathml, texOfImage } from './math';
import { isPdfConversion } from './pdf';
import { MAX_TEX, texToMathml } from './tex';

// Run with `cd apps/web && bun test src/reader/enhance`.

const { describe, test } = bunTest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

const window = new JSDOM('').window;
const g = globalThis as Record<string, unknown>;
for (const name of ['Node', 'NodeFilter', 'DOMParser']) g[name] ??= (window as unknown as Record<string, unknown>)[name];

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
