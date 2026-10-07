/**
 * Writes fixtures/enhance-sampler.epub: a small original EPUB 3 that
 * exercises every content-enhancer rule (src/reader/enhance) — MathML inline,
 * display, wide and in epub:switch; pandoc/MathJax TeX; equation images with
 * TeX alt text; dark-ink and opaque images; code in several languages with
 * long lines; inline code; a wide table; and a pdftohtml-style chapter.
 * All text and images are generated here. Run from apps/web:
 * `bun scripts/build-sampler-epub.ts`.
 */
import { strToU8, zipSync, zlibSync, type Zippable } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
];

// ---------------------------------------------------------------- package

const MODIFIED = '2026-10-07T00:00:00Z';
const manifestItems = chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"${c.id === 'mathml' || c.id === 'tex' ? ' properties="mathml"' : ''}/>`);
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
};
for (const c of chapters) files[`OEBPS/${c.id}.xhtml`] = strToU8(XHTML(c.title, c.body, c.head));

mkdirSync(dirname(outFile), { recursive: true });
// Fixed timestamps keep the archive byte-for-byte reproducible.
const zipped = zipSync(files, { mtime: new Date('2026-10-07T00:00:00Z') });
writeFileSync(outFile, zipped);
console.log(`${outFile} (${zipped.length} bytes)`);
