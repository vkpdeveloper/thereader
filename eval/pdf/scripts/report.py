"""Render the shareable report from measurements, with an explicit HTML template.

python report.py --template reader-template.html --output /tmp/report.html
Optional local screenshots become embedded data URLs; proof links stay public.
"""
import argparse, base64, html, json
from pathlib import Path
from summary import summarize

ROOT=Path(__file__).resolve().parents[3]
NAMES={'pdf-extractor':'PDF Extractor','pymupdf':'PyMuPDF','pymupdf4llm':'PyMuPDF4LLM','pypdf':'pypdf','pdfminer':'pdfminer.six','pdfplumber':'pdfplumber','markitdown':'MarkItDown','pdftotext':'Poppler pdftotext'}
def esc(value):return html.escape(str(value),quote=True)

def chart(engines):
    maximum=max(e['pagesPerSecond'] for e in engines)*1.1
    svg=['<div role="img" aria-label="Throughput of eight measured converter configurations; higher is faster">']
    for j,e in enumerate(engines):
        w=e['pagesPerSecond']/maximum*100
        color='#8ab4f8' if e['engine']=='pdf-extractor' else '#70757a'
        svg.append(f'<div style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>{j+1}. {esc(NAMES[e["engine"]])}</strong><span>{e["pagesPerSecond"]:.1f} pages/s · {e["weightedMsPerPage"]:.3f} ms/page</span></div><svg xmlns="http://www.w3.org/2000/svg" width="100%" height="18" aria-hidden="true"><rect width="{w:.3f}%" height="18" fill="{color}"/></svg></div>')
    svg.append(f'<div style="border-top:1px solid #5f6368;display:flex;justify-content:space-between;gap:8px"><span>0</span><span>Pages per second →</span><span>{maximum:.0f}</span></div></div>')
    return ''.join(svg)

def report(args):
    s=summarize();engines=s['engines'];ours=next(e for e in engines if e['engine']=='pdf-extractor')
    environment=json.loads((ROOT/'eval/pdf/results/environment.json').read_text())
    evidence=json.loads((ROOT/'eval/pdf/evidence.json').read_text())
    results=json.loads((ROOT/'eval/pdf/results/pdf-extractor.json').read_text())
    repo='https://github.com/vkpdeveloper/thereader/tree/feat/go-pdf-markdown-extraction'
    q=ours['qualityMacro'];alice=ours['alice'];second=min((e for e in engines if e!=ours),key=lambda e:e['weightedMsPerPage'])
    p4=next(e for e in engines if e['engine']=='pymupdf4llm');mi=next(e for e in engines if e['engine']=='markitdown')
    body=f'''<h1>PDF Extractor: implementation and measured results</h1>
<p class="lede">11 October 2026 · Go library 0.1.0 · {esc(environment['processor'])}, {esc(environment['platform'])} · {esc(environment['go'])}</p>
<p>The standalone Go package converts native PDF content into structured blocks, Markdown with assets and a reflowable EPUB. The Reader can upload a PDF through its backend and open the converted book with its existing navigation, typography and code highlighting.</p>
<p><strong>Measured throughput rank: {ours['speedRank']} of 8 configurations.</strong> {ours['weightedMsPerPage']:.3f} ms/page, or {ours['pagesPerSecond']:.0f} pages/second, across {s['digitalDocuments']} digital documents and {s['digitalPages']} pages. This is amortized conversion throughput, not a per-page latency guarantee.</p>
<p><strong>Controlled text score: {q['characterAccuracy']:.2%}, rank {ours['characterRank']} of 8.</strong> The {s['qualityDocuments']} generated documents contain {s['qualityPages']} pages, including a 60-page, 26,525-word novel. These are development fixtures with known source text, not a blind holdout. They cannot establish 99% accuracy across arbitrary books.</p>
<p>Text accuracy is nearly tied with PyMuPDF4LLM at {p4['qualityMacro']['characterAccuracy']:.2%}. The {(q['characterAccuracy']-p4['qualityMacro']['characterAccuracy'])*100:.2f} percentage-point difference is too small, and this corpus too limited, to claim broad quality superiority.</p>
<h2>Speed and comparison scope</h2>
<figure>{chart(engines)}<figcaption>Warm document conversions, one warm-up and five timed calls per document. Engines run sequentially on a shared development host. Bars start at zero; higher is faster. The image-only scan is excluded.</figcaption></figure>
<p>On this corpus, PDF Extractor throughput was {second['durationDividedByOurs']:.2f}× that of the next measured configuration ({esc(NAMES[second['engine']])}), {mi['durationDividedByOurs']:.1f}× MarkItDown and {p4['durationDividedByOurs']:.1f}× PyMuPDF4LLM. These ratios compare the configurations below, which perform different work. They are not market-wide speed claims.</p>
<div class="table-wrap"><table style="min-width:680px"><caption>Exact versions, output scope and controlled character score</caption><thead><tr><th>Tool / version</th><th>Measured output</th><th class="num">Text score</th></tr></thead><tbody>'''
    for e in engines:
        body+=f'<tr><td>{esc(NAMES[e["engine"]])}<br><code>{esc(e["version"])}</code></td><td>{esc(e["scope"])}</td><td class="num">{e["qualityMacro"]["characterAccuracy"]:.2%}</td></tr>'
    body+='</tbody></table></div>'
    body+=f'''<p>Go includes object parsing, stream decoding, Unicode, layout, block construction, images and Markdown. Input file I/O, process startup, JSON serialization and EPUB ZIP compression are excluded. Python imports and model initialization are excluded. Poppler's CLI timing includes process startup. Text-only baselines do not perform equivalent structural or image extraction.</p>
<h2>Book accuracy and the one-millisecond target</h2>
<p>The controlled Alice reading edition reached {alice['quality']['characterAccuracy']:.2%} normalized character accuracy and {alice['quality']['headingF1']:.2%} heading F1 at {alice['msPerPage']:.3f} ms/page ({alice['medianMs']:.2f} ms for 60 pages). The novel's source words were independently typeset using ReportLab; the extractor did not provide its own ground truth.</p>
<p>On the controlled fixtures, heading, table-cell, exact code-block and image-count F1 were {q['headingF1']:.2%}, {q['tableCellF1']:.2%}, {q['codeBlockF1']:.2%} and {q['imageCountF1']:.2%}. Image count is not visual fidelity. Code scoring preserves indentation and line breaks. Character scoring uses Unicode NFKC and whitespace normalization, so it measures text recovery and order rather than typographic equivalence.</p>
<div class="table-wrap"><table style="min-width:680px"><caption>PDF Extractor on independent public PDFs, without accuracy ground truth</caption><thead><tr><th>Document</th><th class="num">Pages</th><th class="num">ms/page</th><th>Known gaps</th></tr></thead><tbody>'''
    for r in results:
        if r['kind']!='public-unscored':continue
        codes=', '.join(sorted({w['code'] for w in r['warnings']})) or 'No known warning; accuracy unscored'
        body+=f'<tr><td>{esc(r["id"])}</td><td class="num">{r["pages"]}</td><td class="num">{r["msPerPage"]:.3f}</td><td>{esc(codes)}</td></tr>'
    body+='''</tbody></table></div><p>The complex public documents exceed one millisecond per page. A scanned page is preserved as an image and marked as needing OCR; image-only EPUB import returns a clear error. Universal speed and accuracy targets remain unproven.</p>
<h2>How it works</h2>
<pre><code>PDF bytes
  → bounded lexer, cross references and lazy objects
  → stream filters, font maps, positioned text and images
  → line grouping, reading order and content cleanup
  → Document → Pages → Blocks + styled/link runs + assets
                         ├─ Markdown and relative images
                         └─ EPUB with navigation and XHTML

Web / Flutter PDF picker
  → Worker relay → standalone Go HTTP adapter
  → EPUB validation → existing storage, upload and reader</code></pre>
<p>The library lives in <code>packages/pdf_go</code> with its own Go module. It has zero third-party dependencies. The parser, stream filters, Unicode recovery, content interpreter, layout and exporters were implemented here using the standard library. Competitor tools and the ReportLab fixture writer are confined to evaluation.</p>
<p>Blocks retain source-page bounds, semantic kind, heading level, text runs, links, table rows, assets, role and code language. Document metadata includes title, author, subject, keywords, language, creator, date, outlines and source SHA-256. Code fences and EPUB code classes come from code blocks. Markdown is generated from the block representation.</p>
<p>Cleanup removes repeated small headers and footers, page numbers, tagged artifacts and duplicate overprinting. It protects chapter titles, rejoins paragraph lines, normalizes ligatures and removes discretionary soft hyphens. Visible hyphens remain because compound words are ambiguous. Code keeps indentation and blank lines. References, index text, captions and footnotes retain roles.</p>
<p>Limits cover input bytes, decoded data, pages, objects, operators, spans, font expansion and image pixels. The HTTP adapter adds concurrency limits, cancellation, timeouts and optional bearer authentication. The Worker streams only to its configured service. PDF actions, JavaScript and remote resources are never executed.</p>
<h2>Proof in the reader</h2>'''
    body+=f'<p><a href="{esc(evidence["video"])}">Watch the 20-second upload and reading walkthrough</a> · <a href="{esc(evidence["sourcePDF"])}">Download the original demonstration PDF</a></p>'
    for kind,label in [('desktop','Desktop: recognized code, semantic table, extracted image and contents.'),('mobile','Mobile browser viewport: the same blocks reflow at 390 × 844 CSS pixels.')]:
        path=getattr(args,kind)
        if path:
            data=base64.b64encode(Path(path).read_bytes()).decode()
            width=' style="max-width:390px"' if kind=='mobile' else ''
            body+=f'<figure><a href="{esc(evidence[kind])}"><img{width} src="data:image/png;base64,{data}" alt="{esc(label)}"/></a><figcaption>{esc(label)}</figcaption></figure>'
    body+=f'''<p>The local flow returned HTTP 200 for conversion, then saved and verified the EPUB. Initial upload preparation returned 200 and object upload returned 201. Browser inspection confirmed three headings, exact Go indentation, four table rows, a loaded 480-pixel image and no horizontal overflow at the mobile viewport. The video reimports the same original PDF and exercises deduplication. It is not a native simulator recording.</p>
<h2>Validation and remaining coverage</h2>
<ul><li>Go unit, HTTP, race and vet checks pass. The final 20-second fuzz run covered 1,224,256 inputs with minimization disabled, without a failure. CI repeats race, vet and bounded fuzz checks.</li>
<li>Web production build and 58 import/queue tests pass. API type checking and all 114 tests pass. Flutter import analysis and 17 conversion/import/upload tests pass. Native simulator UI was not exercised.</li>
<li>Code review identified a text-matrix heading-scale bug and an inline-image recovery gap; both were fixed and covered by regression tests. Repeated EPUB extraction notes are grouped for readability while JSON retains page-specific warnings.</li></ul>
<p>This release does not include OCR, encrypted-PDF support, full mathematical semantics, arbitrary merged/nested tables, universal font recovery, all masks/color spaces or all PDF image codecs. Interactive form values, attachments, optional layer visibility and non-link annotations are reported as gaps. Clipping is diagnosed rather than fully rendered. Reading order, headings, tables and code-language detection remain heuristics.</p>
<p>Production deployment still requires hosting the native Go service and setting the Worker's <code>PDF_EXTRACTOR_URL</code> and <code>PDF_EXTRACTOR_TOKEN</code>. The PR adds the integration and a Dockerfile; the screenshots use local services. The Cloudflare Worker cannot run the native Go library directly.</p>
<h2>Reproduce and audit</h2>
<p><a href="{repo}/packages/pdf_go">Library, CLI, HTTP adapter and architecture documentation</a> · <a href="{repo}/eval/pdf">Benchmark scripts, pinned dependencies, raw samples, input hashes and methodology</a></p>
<p>Every measured configuration processed the same 14 PDFs, totaling 455 pages. Nine controlled documents supply accuracy ground truth; four independent public documents supply coverage and throughput; one scan demonstrates the OCR gap. Quality uses a macro average across the nine controlled documents. Overall speed uses the sum of digital-document medians divided by 454 pages. No p95 page-latency or upload SLA is inferred.</p>
<p>No Docling, Marker, MinerU, hosted API or OmniDocBench rank is claimed. The benchmark is useful evidence for this implementation, but is not a comprehensive market leaderboard.</p>
<p>Primary references: <a href="https://pdfa.org/resource/iso-32000-1/">PDF specification</a>, <a href="https://pymupdf.readthedocs.io/">PyMuPDF</a>, <a href="https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/">PyMuPDF4LLM</a>, <a href="https://pypdf.readthedocs.io/en/stable/user/extract-text.html">pypdf</a>, <a href="https://pdfminersix.readthedocs.io/">pdfminer.six</a>, <a href="https://github.com/jsvine/pdfplumber">pdfplumber</a>, <a href="https://github.com/microsoft/markitdown">MarkItDown</a>, <a href="https://poppler.freedesktop.org/">Poppler</a>, <a href="https://www.gutenberg.org/ebooks/11">Alice source</a>, <a href="https://github.com/opendatalab/OmniDocBench">OmniDocBench</a>.</p>'''
    template=Path(args.template).read_text().replace('DOCUMENT TITLE','PDF Extractor: implementation and benchmarks')
    start=template.index('<main>')+len('<main>');end=template.index('</main>')
    output=template[:start]+body+template[end:]
    Path(args.output).write_text(output)
    print(args.output)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--template',required=True);p.add_argument('--output',required=True);p.add_argument('--desktop');p.add_argument('--mobile');report(p.parse_args())
