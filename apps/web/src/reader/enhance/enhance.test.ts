import * as bunTest from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { anchorQuote, TextIndex } from '../epub/text';
import { applyHighlight, declaredLanguage, tokensOf, type Highlighter } from './code';
import { enhanceContent, hydrateMath, needs } from './index';
import { inkVerdict } from './ink';
import { texOfImage } from './math';
import { isPdfConversion } from './pdf';
import { texToMathml } from './tex';

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

function xhtml(body: string, head = ''): Document {
  const src = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title>${head}</head><body>${body}</body></html>`;
  return new window.DOMParser().parseFromString(src, 'application/xhtml+xml') as unknown as Document;
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
