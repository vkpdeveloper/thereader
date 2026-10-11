"""Build the shareable real-PDF report from checked-in results and verified media.

Pass the HTML Communication template with --template. Media is embedded so the
output is one portable document; only its optional font stylesheet is external.
"""
import argparse
import base64
import hashlib
from html import escape
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'eval/pdf/real-world'
REPO = 'https://github.com/vkpdeveloper/thereader/tree/fix/pdf-real-world-math'
NAMES = {'after': 'PDF Extractor', 'pdftotext': 'Poppler pdftotext',
         'pymupdf': 'PyMuPDF', 'pypdf': 'pypdf', 'pdfplumber': 'pdfplumber',
         'pymupdf4llm': 'PyMuPDF4LLM'}


def read(name):
    return json.loads((DATA / (name + '.json')).read_text())


def link(url, label):
    return f'<a href="{escape(url, quote=True)}">{escape(label)}</a>'


def raw(name, label=None):
    return link(f'{REPO}/eval/pdf/real-world/{name}', label or name)


def pct(value):
    return f'{100 * value:.2f}%'


def table(headers, rows, numeric=()):
    def cell(tag, value, index):
        cls = ' class="num"' if index in numeric else ''
        return f'<{tag}{cls}>{value}</{tag}>'
    head = ''.join(cell('th', escape(h), i) for i, h in enumerate(headers))
    body = ''.join('<tr>' + ''.join(cell('td', v, i) for i, v in enumerate(row)) + '</tr>' for row in rows)
    return f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def speed_chart(rates):
    rows = []
    maximum = max(100, max(rates.values()))
    for rank, (engine, rate) in enumerate(sorted(rates.items(), key=lambda x: x[1]), 1):
        grid = ''.join(f'<line x1="{x}" x2="{x}" y1="0" y2="22" stroke="#5f6368"/>' for x in [0,250,500,750,1000])
        color = '#81c995' if engine == 'after' else '#8ab4f8'
        rows.append(f'<div class="bar-row"><div class="bar-label"><span>{rank}. {NAMES[engine]}</span><strong>{rate:.3f} ms/page</strong></div>'
                    f'<svg viewBox="0 0 1000 22" preserveAspectRatio="none" aria-hidden="true">{grid}'
                    f'<rect x="0" y="3" width="{rate/maximum*1000:.4f}" height="16" fill="{color}"/></svg></div>')
    ticks = ''.join(f'<span>{maximum*x/4:g}</span>' for x in range(5))
    return '<figure aria-label="Warm conversion time per page, lower is faster">' + ''.join(rows) + f'<div class="axis">{ticks}</div><figcaption>Warm milliseconds per page; lower is faster. Zero baseline, shared scale. Scope: this 1,508-page corpus and these six configured engines.</figcaption></figure>'


def embed_media(record, cache):
    path = cache / Path(record['url']).name
    if not path.exists():
        with urllib.request.urlopen(record['url'], timeout=60) as response:
            data = response.read()
    else:
        data = path.read_bytes()
    if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        raise ValueError(f"Evidence hash mismatch: {record['id']}")
    if not path.exists():
        path.write_bytes(data)
    mime = 'video/mp4' if record['id'] == 'video' else 'image/png'
    uri = 'data:' + mime + ';base64,' + base64.b64encode(data).decode()
    if record['id'] == 'video':
        media = f'<video controls playsinline preload="none" src="{uri}"></video>'
    else:
        style = ' style="max-width:390px"' if record['id'] == 'mobile' else ''
        media = f'<img loading="lazy"{style} src="{uri}" alt="{escape(record["caption"], quote=True)}">'
    return '<figure>' + media + f'<figcaption>{escape(record["caption"])} {link(record["url"], "Open original evidence")}</figcaption></figure>'


def report(template, cache):
    corpus, evidence, env = read('corpus'), read('evidence'), read('environment')
    after, before, quality, math = read('after'), read('before'), read('quality'), read('math-visual')
    rate = lambda rows: sum(r['medianMs'] for r in rows) / sum(r['pages'] for r in rows)
    rates = {name: rate(read(name)) for name in NAMES}
    a, b = quality['paper']['after'], quality['paper']['before']
    ours = {r['id']: r for r in after}
    media = {r['id']: embed_media(r, cache) for r in evidence['media']}
    sources = {r['id']: r for r in corpus}
    source_link = lambda id, title=None: link(sources[id]['source'], title or sources[id]['title'])
    pages = sum(r['pages'] for r in corpus)
    duration = sum(r['medianMs'] for r in after)
    next_engine = sorted(rates, key=rates.get)[1]
    paper_rows = [
        ['Heading labels recovered', f'{b["headings"]["matched"]} / 41', f'<strong>{a["headings"]["matched"]} / 41</strong>'],
        ['Heading F1, including extra labels', pct(b['headings']['f1']), pct(a['headings']['f1'])],
        ['Exact table cells recovered', f'{b["tableCells"]["matched"]:,} / 1,448', f'<strong>{a["tableCells"]["matched"]:,} / 1,448</strong>'],
        ['Table-cell F1', pct(b['tableCells']['f1']), pct(a['tableCells']['f1'])],
        ['Prose-window character agreement', pct(b['weightedCharacterAgreement']), pct(a['weightedCharacterAgreement'])],
        ['Selected paragraphs at ≥99%', f'{b["paragraphsAt99Percent"]} / 73', f'{a["paragraphsAt99Percent"]} / 73'],
        ['Exact selected paragraphs', f'{b["paragraphsExact"]} / 73', f'{a["paragraphsExact"]} / 73'],
        ['Exact 32-character fragments found', f'{b["fragment32"]["matched"]:,} / 1,419', f'{a["fragment32"]["matched"]:,} / 1,419'],
    ]
    book_rows = []
    for id in ['axler', 'hefferon', 'thinkpython', 'calculus']:
        r = ours[id]
        book_rows.append([source_link(id), str(r['pages']), f'{r["msPerPage"]:.3f}', f'{r["stats"]["math"]:,}', str(r['unknownCharacters'])])
    math_rows = [[escape(r['id']), str(r['page']), pct(r['inkF1'])] for r in math['regions']]
    engine_docs = [('https://pymupdf.readthedocs.io/', 'PyMuPDF'),
                   ('https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/', 'PyMuPDF4LLM'),
                   ('https://pypdf.readthedocs.io/en/stable/user/extract-text.html', 'pypdf'),
                   ('https://github.com/jsvine/pdfplumber', 'pdfplumber'),
                   ('https://poppler.freedesktop.org/', 'Poppler')]
    content = f'''
<h1>PDF Extractor: real-paper and textbook results</h1>
<p class="lede">11 October 2026 · Go library 0.2.0 · {pages:,} pages · five comparison engines · local platform reader proof</p>
<p>The requested paper and four complete books now pass through the standalone Go library and the platform reader. The changes recover small section headings, more table cells, legacy font text and positioned equations. <strong>The evidence does not establish 99% whole-book accuracy or under 1 ms for every page.</strong></p>
<p>The requested input is {source_link('harness')}. The books are Sheldon Axler’s {source_link('axler')}, Jim Hefferon’s {source_link('hefferon')}, Allen Downey’s {source_link('thinkpython')} and Silvanus P. Thompson’s {source_link('calculus')}. These publisher PDFs became development cases during the fixes, so they are not a blind holdout.</p>

<h2>Speed: first of six on this corpus</h2>
<p>PDF Extractor averages <strong>{rates['after']:.3f} ms/page</strong>, or {duration/1000:.3f} seconds summed across the five document medians. That is <strong>{rates[next_engine]/rates['after']:.3f}×</strong> the warm throughput of the next measured engine, {NAMES[next_engine]}, and {rates['pymupdf4llm']/rates['after']:.2f}× PyMuPDF4LLM in its measured configuration.</p>
{speed_chart(rates)}
<p>These engines produce different outputs. PDF Extractor builds blocks, text, image assets, positioned mathematics and Markdown. PyMuPDF and pypdf return text. pdfplumber returns text and default tables. PyMuPDF4LLM uses its layout model with embedded images, OCR off and header/footer cleanup on. Poppler returns text and includes CLI startup. This comparison does not establish superiority over untested products or a quality rank.</p>
<p>The previous 0.1.0 implementation averaged {rate(before):.3f} ms/page. The new font geometry and structure recovery cost time. Only Think Python and Calculus average below 1 ms/page. The requested paper takes <strong>{ours['harness']['msPerPage']:.3f} ms/page</strong>; Poppler takes 4.487 ms/page on that same file.</p>
<p>Hardware: {escape(env['processor'])}, {escape(env['platform'])}, {escape(env['go'])}. One warm-up, three timed fresh parses per document, sequentially on a shared development host. Weighted rate = sum of document medians ÷ total pages. This measures amortized conversion throughput, not individual-page tail latency or upload-to-reader time. Go excludes source-file I/O, JSON and EPUB compression. Python excludes imports/model initialization. Versions and raw samples: {raw('environment.json', 'environment')} and {raw('README.md', 'reproduction notes')}.</p>

<h2>The requested paper: what was recovered</h2>
<p>All 43 pages were processed. Output contains 135,275 block-text characters, 42 headings, 313 paragraphs, 31 image/figure blocks, 25 code blocks, six list blocks and 19 table blocks. Zero replacement characters were observed. These counts do not prove completeness; the source HTML has 13 tables, so some are still fragmented.</p>
{table(['Check against author HTML', 'Before 0.1.0', 'After 0.2.0'], paper_rows, (1,2))}
<p>All <strong>41 reference headings</strong> are recovered; the extra heading is the PDF-only “Appendix” label. Table-cell recall is {pct(a['tableCells']['recall'])}, precision {pct(a['tableCells']['precision'])}; exact normalized cell F1 improves by {100*(a['tableCells']['f1']-b['tableCells']['f1']):.2f} percentage points. This metric ignores merged-cell geometry and row/column relationships.</p>
<p>The prose test uses 73 long body/prompt paragraphs, 46,405 normalized alphanumeric characters, matched to their best contiguous output windows. It excludes short paragraphs, author metadata, tables, figures, whitespace and punctuation. Floating content can interrupt an otherwise recovered paragraph. Exact 32-character fragment coverage is {pct(a['fragment32']['matched']/a['fragment32']['total'])}; it does not measure global reading order. PDF Extractor is <strong>second of six on this prose check</strong>, behind pypdf at 95.56%. PyMuPDF4LLM scores 94.03% here and 87.30% table-cell F1, while recovering more reference table cells (1,254) with lower precision. Text-only engines’ structured counts are not treated as quality failures.</p>
<p>Reference: {link(sources['harness']['referenceHtmlUrl'], 'versioned author HTML')}. Method, paragraph-level values and all competitors: {raw('quality.json')}.</p>
{media['paper']}

<h2>Books: coverage and equation fidelity</h2>
{table(['Book', 'Pages', 'ms/page', 'Display math blocks', 'Replacement characters'], book_rows, (1,2,3,4))}
<p>Hefferon’s replacement characters drop from 10,685 to 68; that is a 99.36% reduction in undecoded glyph markers, <strong>not 99.36% book accuracy</strong>. Think Python recovers 596 code blocks versus zero previously; language detection is still heuristic. Calculus retains 346 replacement characters, compared with 348 before. Block counts are coverage diagnostics, not semantic correctness scores.</p>
<p>For mathematical appearance, <strong>{math['regionsAt99PercentF1']} of {len(math['regions'])} selected regions reach at least 99% ink F1</strong>, with a mean of {pct(math['meanInkF1'])}. All six Axler and four Hefferon regions reach 100% within the specified raster tolerance. They include matrices, subscripts, superscripts, accents, vector arithmetic and multi-line summations.</p>
{media['comparison']}
<p>Fourteen manually selected crops are rendered from the original PDF and the largest-overlapping single output math block at 216 dpi. Grayscale ink uses a one-pixel (⅓ pt) tolerance. Split formulas are penalized. MuPDF rasterizes both sides for evaluation only; production uses our Go font readers. This checks visual geometry, not LaTeX/MathML semantics, accessibility, every inline expression or whole-book accuracy. Selection during development and shared rasterization also limit the claim.</p>
{table(['Formula region', 'Physical page', 'Ink F1'], math_rows, (1,2))}
<p><strong>Two retained failures:</strong> Calculus’s fractional-power example scores 79.54%; the integral example scores 95.65%. Parts of those expressions remain mixed with prose instead of one complete math block. The substitution example reaches 99.52%. Reproduction: {raw('math-regions.json', 'crop coordinates')} and {raw('math-visual.json', 'raw visual scores')}.</p>

<h2>How the standalone library works</h2>
<p>The dependency-free {link(REPO+'/packages/pdf_go', 'Go module')} parses PDF objects and content streams itself. New bounded CFF/Type 2, Type 1, TrueType and restricted Type 3 readers recover embedded glyph outlines. Glyph paths and original transforms become SVG assets, preserving mathematical placement, fraction rules and accents. Embedded encodings and licensed Adobe Glyph List reference data improve Unicode recovery. No existing extraction engine, OCR service, model or subprocess is used in production.</p>
<p>Layout retains true baselines and script runs, removes repeated margins as lines, joins wrapped headings, detects small numbered headings, groups ruled tables with empty cells and keeps vector chart labels inside figures. CropBox is intersected with MediaBox. Structured blocks retain source geometry, text and assets; Markdown and EPUB are generated from those blocks.</p>
<p>Math blocks explicitly declare <code>representation: "positioned"</code>. Searchable linear text remains available, but it is not guaranteed to encode mathematical meaning. The shared reader preserves those SVGs instead of trying to parse alt text as TeX. Dimensions scale with the reading font, and monochrome formulas follow dark mode. Mobile reader assets were rebuilt at enhancement version 5.</p>
<p>Format references: {link('https://adobe-type-tools.github.io/font-tech-notes/pdfs/5176.CFF.pdf','Adobe CFF')}, {link('https://adobe-type-tools.github.io/font-tech-notes/pdfs/5177.Type2.pdf','Type 2')}, {link('https://learn.microsoft.com/en-us/typography/opentype/spec/glyf','OpenType glyf')}, and {link('https://github.com/adobe-type-tools/agl-aglfn','Adobe Glyph List with its retained license')}.</p>

<h2>Actual upload and reader proof</h2>
<p>The unedited 32-second video uploads Axler’s PDF through the local platform, verifies the saved book, opens the reader and navigates from extraction notes to mathematical content. It demonstrates the workflow; its duration is not an extraction benchmark.</p>
{media['video']}
{media['desktop']}
{media['mobile']}
<p>Assertions confirm loaded, visible formula assets and no horizontal page overflow at desktop and 390px widths. The narrow view is a Chromium browser viewport, not a native mobile-device run. The video preceded two minor font/layout review corrections; final benchmark source and binary hashes are separately pinned in {raw('environment.json')}. Media hashes and browser assertions: {raw('evidence.json')}.</p>

<h2>What still needs work</h2>
<p>The requested paper still fragments merged table headings and grouped row labels. Cell text can be recovered while the table’s relationships are wrong. Wide tables scroll within the reader, as shown below.</p>
{media['table']}
<p>Other reported gaps include 13 unsupported JPEG2000 photo reports in Axler, bitmap Type 3 glyphs, legacy symbol mappings, 20 font-outline warnings in Think Python, some clipping/color-space approximation, reading order around floats, and mixed prose/math segmentation. The outputs remain <code>complete: false</code> with explicit warnings. There is no OCR, semantic equation reconstruction, JPEG2000/JBIG2/CCITT decoder or exhaustive support for every PDF feature.</p>
<p>These results cannot substantiate a universal 99% book claim or a sub-millisecond guarantee. Docling, Marker, MinerU, hosted APIs and OmniDocBench were not evaluated in this follow-up. Tool documentation for the five configured comparisons: {', '.join(link(url,name) for url,name in engine_docs)}.</p>

<h2>Validation and audit trail</h2>
<p>Go race tests and vet pass. Reader tests pass: 89 tests and 3,300 assertions. The web production build and mobile enhancement bundle build pass; the existing build still reports unresolved Libron font URLs with runtime fallback. The native mobile app itself was not run.</p>
<p>Fuzzing found a CFF INDEX offset that could panic before validation. The bound is fixed and a minimized regression is committed. After that fix, font-program fuzzing completed 541,985 executions in 21 seconds, and extractor fuzzing 293,920 in 16 seconds without failure. Three CodeRabbit CLI review rounds led to fixes for stale benchmark output, unsupported implicit CFF encoding, indirect Type 1 lengths, math reclassification and processor detection. Invalid font matrices deliberately retain a resource-limit error.</p>
<p>Reproduce using {raw('README.md', 'the checked-in instructions')}. The corpus hashes, raw timings, warning counts, per-paragraph scores, crop definitions and media hashes are committed beside the implementation. Full source PDFs and extracted books are not redistributed. Evidence shows limited excerpts with attribution to the authors; publisher links above identify the original books and their license terms.</p>
'''
    title = 'PDF Extractor: real-paper and textbook results'
    css = '''<style>
.bar-row { margin: 0 0 0.65em; }
.bar-label { display:flex; flex-wrap:wrap; justify-content:space-between; gap:0.15em 1em; font-size:0.88em; }
.bar-row svg { display:block; width:100%; height:22px; }
.axis { display:flex; justify-content:space-between; color:var(--fg-dim); font-size:0.75em; }
figcaption { color:var(--fg-dim); font-size:0.82em; line-height:1.65; margin-top:0.6em; }
figure img, figure video { display:block; width:100%; }
</style>'''
    if '<main>' not in template or '</main>' not in template:
        raise ValueError('Template must contain a main element')
    head, rest = template.split('<main>', 1)
    _, tail = rest.split('</main>', 1)
    return head.replace('DOCUMENT TITLE', title).replace('</head>', css+'</head>') + '<main>' + content + '</main>' + tail


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--template', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--media-cache', type=Path, default=ROOT/'test-corpus/pdf/real-world/proof-media')
    args = parser.parse_args()
    args.media_cache.mkdir(parents=True, exist_ok=True)
    html = report(args.template.read_text(), args.media_cache)
    args.output.write_text(html)
    print(f'Wrote {args.output.name}: {len(html.encode()):,} bytes')


if __name__ == '__main__':
    main()
