/**
 * Writes fixtures/enhance-sampler.epub: a small original EPUB 3 that
 * exercises every content-enhancer rule (src/reader/enhance) — MathML inline,
 * display, wide and in epub:switch; pandoc/MathJax TeX; equation images with
 * TeX alt text; dark-ink and opaque images; code in several languages with
 * long lines; inline code; a wide table; a pdftohtml-style chapter; and one
 * chapter per way other toolchains carry maths (KaTeX and MathJax output,
 * SVG equations, black-on-white equation images, formulas in attributes,
 * MathML 2 and prefixed MathML). The text is original; rendered maths comes
 * from sampler-formats.ts. Run from apps/web:
 * `bun scripts/build-sampler-epub.ts`.
 */
import { strToU8, zipSync, zlibSync, type Zippable } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './sampler-formats';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(web, 'fixtures', 'enhance-sampler.epub');

// ---------------------------------------------------------------- PNG

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA pixels → PNG. */
function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill: [number, number, number, number] = [0, 0, 0, 0]) {
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.px.set(fill, i * 4);
  }
  dot(x: number, y: number, c: [number, number, number, number], r = 1.5): void {
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= this.w || py >= this.h || dx * dx + dy * dy > r * r) continue;
        this.px.set(c, (py * this.w + px) * 4);
      }
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number, number], r = 1.5): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) this.dot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, c, r);
  }
  png(): Uint8Array {
    return png(this.w, this.h, this.px);
  }
}

const INK: [number, number, number, number] = [20, 20, 24, 255];

/** A formula-looking stroke drawing: "a + b = c" as glyph-ish strokes, transparent background. */
function equationPng(): Uint8Array {
  const c = new Canvas(180, 40);
  // a
  c.line(10, 28, 10, 18, INK);
  c.line(10, 18, 20, 18, INK);
  c.line(20, 18, 20, 30, INK);
  c.line(10, 24, 20, 24, INK);
  // +
  c.line(36, 23, 52, 23, INK);
  c.line(44, 15, 44, 31, INK);
  // b
  c.line(66, 8, 66, 30, INK);
  c.line(66, 30, 78, 30, INK);
  c.line(78, 30, 78, 18, INK);
  c.line(78, 18, 66, 18, INK);
  // =
  c.line(94, 19, 112, 19, INK);
  c.line(94, 27, 112, 27, INK);
  // c
  c.line(140, 18, 128, 18, INK);
  c.line(128, 18, 128, 30, INK);
  c.line(128, 30, 140, 30, INK);
  return c.png();
}

/** Axes, a circle and a vector, dark ink with a blue accent on transparent background. */
function diagramPng(): Uint8Array {
  const c = new Canvas(320, 220);
  c.line(20, 200, 300, 200, INK, 1.6);
  c.line(40, 210, 40, 10, INK, 1.6);
  for (let t = 0; t < Math.PI * 2; t += 0.01) c.dot(160 + 70 * Math.cos(t), 110 + 70 * Math.sin(t), INK, 1.4);
  c.line(160, 110, 210, 60, [30, 60, 160, 255], 2.2);
  c.line(210, 60, 198, 62, [30, 60, 160, 255], 2.2);
  c.line(210, 60, 208, 72, [30, 60, 160, 255], 2.2);
  return c.png();
}

/** An opaque "photo" (gradient): must never be inverted. */
function photoPng(): Uint8Array {
  const c = new Canvas(240, 140, [0, 0, 0, 255]);
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) c.px.set([30 + (x * 180) / c.w, 60 + (y * 120) / c.h, 120, 255], (y * c.w + x) * 4);
  }
  return c.png();
}

/** A bar chart in colour on white: opaque, coloured, never inverted. */
function chartPng(): Uint8Array {
  const c = new Canvas(240, 140, [255, 255, 255, 255]);
  const bars: [number, [number, number, number, number]][] = [[90, [220, 60, 60, 255]], [50, [60, 110, 220, 255]], [115, [70, 170, 90, 255]]];
  bars.forEach(([h, colour], i) => {
    for (let x = 30 + i * 70; x < 80 + i * 70; x++) c.line(x, 130, x, 130 - h, colour, 0.5);
  });
  c.line(20, 130, 230, 130, INK, 1);
  return c.png();
}

const base64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

// ---------------------------------------------------------------- content

const XHTML = (title: string, body: string, head = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<title>${title}</title>
${head}<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`;

const STYLE = `body { font-family: serif; }
.equation { text-align: center; margin: 1em 0; }
.listing pre { background: #f2f2f2; white-space: pre-wrap; word-break: break-all; }
.calibre1 { display: block; margin: 1em 0; }
.calibre3 { font-style: italic; }
`;

const longSum = Array.from({ length: 18 }, (_, i) => `<msub><mi>a</mi><mn>${i + 1}</mn></msub><msup><mi>x</mi><mn>${i + 1}</mn></msup><mo>+</mo>`).join('');

const chapters: { id: string; title: string; body: string; head?: string }[] = [
  {
    id: 'prose',
    title: 'Plain prose',
    body: `<h1>Plain prose</h1>
<p>This chapter has no formulas and no code. It is here to show that ordinary text is left exactly as it was: the same words, the same paragraphs, the same italics where the author wanted <em>emphasis</em>.</p>
<p>A second paragraph follows, long enough to wrap across several lines in a narrow column, so that line height, margins and hyphenation can be compared before and after.</p>`,
  },
  {
    id: 'mathml',
    title: 'MathML',
    body: `<h1>MathML</h1>
<p>An inline formula: <math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo>=</mo><mn>0</mn></math> sits on the text baseline.</p>
<p>A display formula, centred:</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><msup><mi>x</mi><mn>2</mn></msup><mspace width="0.17em"/><mi>d</mi><mi>x</mi><mo>=</mo><mfrac><mn>1</mn><mn>3</mn></mfrac></mrow></math>
<p>A matrix:</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mi>A</mi><mo>=</mo><mrow><mo>[</mo><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd><mtd><mn>3</mn></mtd></mtr><mtr><mtd><mn>4</mn></mtd><mtd><mn>5</mn></mtd><mtd><mn>6</mn></mtd></mtr></mtable><mo>]</mo></mrow></mrow></math>
<p>A display formula wider than any phone column scrolls sideways instead of overflowing:</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mi>p</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo>${longSum}<mi>…</mi></mrow></math>
<p>An <code>epub:switch</code> with a MathML case and a fallback:
<epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML"><math xmlns="http://www.w3.org/1998/Math/MathML"><msqrt><mn>2</mn></msqrt><mo>≈</mo><mn>1.414</mn></math></epub:case><epub:default><span>[square root of two, about 1.414]</span></epub:default></epub:switch>.</p>`,
  },
  {
    id: 'tex',
    title: 'TeX',
    body: `<h1>TeX left for MathJax</h1>
<p>Pandoc inline math: <span class="math inline">\\(a^2 + b^2 = c^2\\)</span>, and display math:</p>
<p><span class="math display">\\[\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\\]</span></p>
<p>Delimited TeX in running text: $$\\det\\begin{pmatrix} a &amp; b \\\\ c &amp; d \\end{pmatrix} = ad - bc$$ and inline \\(\\lambda \\in \\mathbb{F}\\) too.</p>
<p>MathJax script elements: <script type="math/tex">\\vec{v} \\cdot \\vec{w}</script> inline, and display:</p>
<script type="math/tex; mode=display">\\operatorname{null} T = \\{ v \\in V : Tv = 0 \\}</script>
<h2>Equation images with TeX alt text</h2>
<p>Inline: <span class="inline_math"><img src="images/eq.png" alt="T \\colon \\mathbb{R}^n \\to \\mathbb{R}^m" style="height:1.09em; vertical-align:-0.14em;"/></span> maps vectors to vectors; a short token <span class="inline_math"><img src="images/eq.png" alt="x" style="height:0.8em; vertical-align:-0.05em;"/></span> too.</p>
<div class="equation"><img src="images/eq.png" alt="\\begin{bmatrix} 1 &amp; 0 \\\\ 0 &amp; 1 \\end{bmatrix} \\vec{x} = \\vec{x}" style="height:3.2em;"/></div>
<p>An image whose alt does not parse keeps the image (made visible on dark pages): <span class="inline_math"><img src="images/eq.png" alt="\\undefinedmacro{a} + b = c" style="height:1.2em; vertical-align:-0.2em;"/></span>.</p>`,
  },
  {
    id: 'images',
    title: 'Images',
    body: `<h1>Images</h1>
<p>A line diagram with dark ink on a transparent background (inverted on dark pages):</p>
<p><img src="images/diagram.png" alt="A circle with a vector from its centre" style="width:60%;"/></p>
<p>An opaque picture (never touched):</p>
<p><img src="images/photo.png" alt="A colour gradient" style="width:60%;"/></p>
<p>A figure whose alt is its file name stays a figure: <img src="images/diagram.png" alt="number_line_addition" style="width:30%;"/></p>`,
  },
  {
    id: 'code',
    title: 'Code',
    body: `<h1>Code</h1>
<p>Inline code such as <code>torch.nn.Module</code> and <code>git rebase --onto</code> gets a subtle panel.</p>
<pre><code class="language-python">import torch

class SelfAttention(torch.nn.Module):
    def __init__(self, d_in, d_out):
        super().__init__()
        self.W_query = torch.nn.Parameter(torch.rand(d_in, d_out))

    def forward(self, x):
        queries = x @ self.W_query  # a comment that is long enough to make this line much wider than a phone screen column
        return torch.softmax(queries / queries.shape[-1] ** 0.5, dim=-1)
</code></pre>
<pre data-lang="javascript">const total = items.reduce((sum, { price, qty }) =&gt; sum + price * qty, 0);
console.log(\`Total: \${total.toFixed(2)}\`);</pre>
<pre class="brush: rust">fn main() {
    let words: Vec&lt;&amp;str&gt; = "the quick brown fox".split_whitespace().collect();
    println!("{} words", words.len());
}</pre>
<pre class="language-console">$ ls -la /usr/local/share/very/long/path/that/keeps/going/and/going/until/it/is/far/too/wide/for/any/column
total 0</pre>
<div class="listing"><pre>def tokenize(text):
    # No language declared: detected as Python.
    return [token for token in text.split() if token]
<br/>print(tokenize("Hello, world. This is a test."))</pre></div>
<p>A listing taller than a page wraps at spaces in paginated mode so it can continue on the next page:</p>
<pre class="language-python">${Array.from({ length: 70 }, (_, i) => `step_${i + 1} = compute(step_${i}, rate=0.${(i % 9) + 1})  # iteration ${i + 1} of the long training loop`).join('\n')}</pre>`,
  },
  {
    id: 'table',
    title: 'Table',
    body: `<h1>A wide table</h1>
<p>The table scrolls inside the column:</p>
<table><thead><tr>${Array.from({ length: 12 }, (_, i) => `<th>Column ${i + 1}</th>`).join('')}</tr></thead>
<tbody>${Array.from({ length: 4 }, (_, r) => `<tr>${Array.from({ length: 12 }, (_, i) => `<td>${(r + 1) * (i + 1)}.00</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>Text after the table.</p>`,
  },
  {
    id: 'pdf',
    title: 'Converted from PDF',
    head: '<meta name="generator" content="pdftohtml 0.36"/>\n',
    body: `<i class="calibre3">
<p class="calibre1"><a id="p41"></a>SECTION 2.B</p>
<p class="calibre1">Bases and Spans</p>
<p class="calibre1">27</p>
<p class="calibre1">2.31</p>
<p class="calibre1">Every spanning list contains a basis</p>
<p class="calibre1">Suppose we start with a list of vectors that spans the space. Removing the vectors that</p>
<p class="calibre1">depend on the earlier ones, one at a time, leaves a list that still spans the</p>
<p class="calibre1">space and is linearly independent.</p>
<p class="calibre1">Proof</p>
<p class="calibre1">Work through the list from left to right. At each step, keep the vector if it is not in the span of the</p>
<p class="calibre1"><a id="p42"></a>28</p>
<p class="calibre1">CHAPTER 2</p>
<p class="calibre1">Finite-Dimensional Vector Spaces</p>
<p class="calibre1">vectors kept so far, and discard it otherwise. The kept vectors span the same space.</p>
<p class="calibre1">(a)</p>
<p class="calibre1"> <i class="calibre3">v</i> is kept;</p>
<p class="calibre1">(b)</p>
<p class="calibre1"> <i class="calibre3">w</i> is discarded.</p>
<p class="calibre1"><a id="p43"></a>SECTION 2.B</p>
<p class="calibre1">Bases and Spans</p>
<p class="calibre1">29</p>
<p class="calibre1">This completes the argument, and the next section turns to dimension.</p>
<p class="calibre1"><a id="p44"></a>30</p>
<p class="calibre1">CHAPTER 2</p>
<p class="calibre1">Finite-Dimensional Vector Spaces</p>
<p class="calibre1">The end of the sample chapter.</p>
</i>`,
  },
  {
    id: 'katex',
    title: 'KaTeX',
    body: `<h1>KaTeX output</h1>
<p>KaTeX writes every formula twice: MathML for screen readers and HTML that needs KaTeX's stylesheet and fonts, which this book does not ship. Inline, ${F.KATEX_INLINE} maps a vector to its length.</p>
<p>A display formula:</p>
${F.KATEX_DISPLAY}
<p>The sum of the first squares grows like a cube.</p>`,
  },
  {
    id: 'mathjax3',
    title: 'MathJax 3 (CHTML)',
    head: `<style type="text/css">${F.MJ3_CHTML_CSS}</style>\n`,
    body: `<h1>MathJax 3, HTML output</h1>
<p>A page saved after MathJax typeset it: the glyphs are drawn by MathJax's web fonts, and the MathML beside them is clipped away. Inline, ${F.MJ3_CHTML_INLINE} says the inner product is conjugate symmetric.</p>
${F.MJ3_CHTML_DISPLAY}
<p>A two by two determinant, as above.</p>`,
  },
  {
    id: 'mathjax3svg',
    title: 'MathJax 3 (SVG)',
    head: `<style type="text/css">${F.MJ3_SVG_CSS}</style>\n`,
    body: `<h1>MathJax 3, SVG output</h1>
<p>Each formula is an SVG drawing in the current colour: ${F.MJ3_SVG_INLINE} is a scalar.</p>
${F.MJ3_SVG_DISPLAY}
<p>The Gaussian integral, drawn as paths.</p>`,
  },
  {
    id: 'mathjax2',
    title: 'MathJax 2',
    head: `<style type="text/css">${F.MJ2_CSS}</style>\n`,
    body: `<h1>MathJax 2 output</h1>
<p>${F.MJ2_INLINE}</p>
<div>${F.MJ2_DISPLAY}</div>
<p>An older page keeps only the MathML attribute: ${F.MJ2_DATA_ONLY}, complex n-space.</p>`,
  },
  {
    id: 'svg',
    title: 'SVG equations',
    body: `<h1>SVG equations</h1>
<p>An inline SVG painted black: ${F.SVG_INLINE_BLACK}, and one with no paint at all, which is black too: ${F.SVG_INLINE_UNPAINTED}.</p>
<p>An equation file shown as an image:</p>
<div class="equation"><img src="images/eq-ink.svg" alt="The mean of x" style="height:3.4em;"/></div>
<p>An equation embedded as an object: <object data="images/eq-sqrt.svg" type="image/svg+xml" style="height:1.4em; vertical-align:-0.4em;">the length of (x, y)</object> is the length of a vector.</p>
<p>An illustration in colour stays as drawn:</p>
<p><svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" rx="12" fill="#1f3a5f"/><circle cx="70" cy="60" r="32" fill="#f2a541" stroke="#c0392b" stroke-width="4"/><path d="M120 90 L150 30 L180 90 Z" fill="#62c073"/></svg></p>`,
  },
  {
    id: 'paper',
    title: 'Equation images on white',
    body: `<h1>Equation images on white</h1>
<p>Word, InDesign and Kindle conversions export each equation as a picture with a white background, often with no TeX:</p>
<p class="center"><img src="images/eq-white.png" alt="equation" style="height:2.6em;"/></p>
<p>A GIF, as old Kindle books carry them: <img src="images/eq-white.gif" alt=""/></p>
<p>A chart in colour on white is a picture, not ink, and stays as it is:</p>
<p><img src="images/chart.png" alt="A bar chart" style="width:60%;"/></p>`,
  },
  {
    id: 'attrs',
    title: 'Formulas in attributes',
    body: `<h1>Formulas in attributes</h1>
<p>A span keeps its TeX in <code>data-tex</code>: <span class="math" data-tex="\\frac{a}{b} + \\frac{c}{d} = \\frac{ad + bc}{bd}">a/b + c/d = (ad + bc)/bd</span>.</p>
<p>A geometric series in <code>data-latex</code>: <span data-latex="\\sum_{k=0}^{\\infty} x^k = \\frac{1}{1-x}">sum of x to the k equals 1/(1 &#8722; x)</span>.</p>
<div class="equation" data-equation="\\mathbf{A}\\mathbf{x} = \\mathbf{b}">Ax = b</div>
<p>MathML in <code>data-mathml</code>: <span data-mathml="&lt;math xmlns=&quot;http://www.w3.org/1998/Math/MathML&quot;&gt;&lt;msup&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;mn&gt;2&lt;/mn&gt;&lt;/msup&gt;&lt;mo&gt;&#8805;&lt;/mo&gt;&lt;mn&gt;0&lt;/mn&gt;&lt;/math&gt;">x squared is at least zero</span>.</p>
<p>Pandoc's <code>--webtex</code> keeps the TeX as alt text: <img class="math inline" src="images/eq-sqrt.svg" alt="\\sqrt{x^2+y^2}"/>.</p>
<p>MathJax's MathML input: <script type="math/mml"><![CDATA[<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>f</mi><mo>:</mo><mi>X</mi><mo>&#8594;</mo><mi>Y</mi></math>]]></script> is a function.</p>
<p data-equation="3.1">An equation number in an attribute is not a formula (3.1).</p>`,
  },
  {
    id: 'mathml2',
    title: 'MathML 2 and prefixes',
    body: `<h1>MathML 2 and prefixed MathML</h1>
<p>A prefixed formula: <m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:msub><m:mi>v</m:mi><m:mn>1</m:mn></m:msub><m:mo>+</m:mo><m:msub><m:mi>v</m:mi><m:mn>2</m:mn></m:msub></m:math> is a sum of two vectors.</p>
<p>Fences written with <code>mfenced</code>: <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>f</mi><mfenced><mi>a</mi><mi>b</mi></mfenced><mo>=</mo><mfenced open="{" close="}"><mi>a</mi><mi>b</mi></mfenced></math>.</p>
<p>Letter styles from <code>mathvariant</code>: <math xmlns="http://www.w3.org/1998/Math/MathML"><mi mathvariant="bold">v</mi><mo>∈</mo><msup><mi mathvariant="double-struck">R</mi><mn>3</mn></msup><mo>,</mo><mi mathvariant="fraktur">g</mi><mo>,</mo><mi mathvariant="script">L</mi></math>.</p>
<p>A boxed result:</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><menclose notation="box"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></menclose></math>
<p>With a TeX annotation:</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" alttext="\\lVert v \\rVert"><semantics><mrow><mo>‖</mo><mi>v</mi><mo>‖</mo></mrow><annotation encoding="application/x-tex">\\lVert v \\rVert</annotation></semantics></math>`,
  },
];

// ---------------------------------------------------------------- package

const MODIFIED = '2026-10-07T00:00:00Z';
const MATHML = new Set(['mathml', 'tex', 'katex', 'mathjax3', 'mathjax3svg', 'mathjax2', 'mathml2']);
const SVG = new Set(['mathjax3svg', 'svg']);
const properties = (id: string) => [MATHML.has(id) ? 'mathml' : '', SVG.has(id) ? 'svg' : ''].filter(Boolean).join(' ');
const manifestItems = chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"${properties(c.id) ? ` properties="${properties(c.id)}"` : ''}/>`);
const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:7f6d0b1e-2a4c-4f3e-9d51-enhancesampler</dc:identifier>
<dc:title>Enhancer Sampler</dc:title>
<dc:creator>The Reader</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">${MODIFIED}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="eq" href="images/eq.png" media-type="image/png"/>
<item id="diagram" href="images/diagram.png" media-type="image/png"/>
<item id="photo" href="images/photo.png" media-type="image/png"/>
<item id="chart" href="images/chart.png" media-type="image/png"/>
<item id="eq-ink" href="images/eq-ink.svg" media-type="image/svg+xml"/>
<item id="eq-sqrt" href="images/eq-sqrt.svg" media-type="image/svg+xml"/>
<item id="eq-white-png" href="images/eq-white.png" media-type="image/png"/>
<item id="eq-white-gif" href="images/eq-white.gif" media-type="image/gif"/>
${manifestItems.join('\n')}
</manifest>
<spine>
${chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n')}
</spine>
</package>
`;
const nav = XHTML(
  'Contents',
  `<nav epub:type="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('')}</ol></nav>`,
);
const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

const files: Zippable = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(container),
  'OEBPS/content.opf': strToU8(opf),
  'OEBPS/nav.xhtml': strToU8(nav),
  'OEBPS/style.css': strToU8(STYLE),
  'OEBPS/images/eq.png': equationPng(),
  'OEBPS/images/diagram.png': diagramPng(),
  'OEBPS/images/photo.png': photoPng(),
  'OEBPS/images/chart.png': chartPng(),
  'OEBPS/images/eq-ink.svg': strToU8(F.SVG_FILE_INK),
  'OEBPS/images/eq-sqrt.svg': strToU8(F.SVG_FILE_WEBTEX),
  'OEBPS/images/eq-white.png': base64(F.PNG_WHITE_BASE64),
  'OEBPS/images/eq-white.gif': base64(F.GIF_WHITE_BASE64),
};
for (const c of chapters) files[`OEBPS/${c.id}.xhtml`] = strToU8(XHTML(c.title, c.body, c.head));

mkdirSync(dirname(outFile), { recursive: true });
// Fixed timestamps keep the archive byte-for-byte reproducible.
const zipped = zipSync(files, { mtime: new Date('2026-10-07T00:00:00Z') });
writeFileSync(outFile, zipped);
console.log(`${outFile} (${zipped.length} bytes)`);
