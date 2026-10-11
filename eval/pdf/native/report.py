"""Build the public report from recorded results, never estimated scores."""
import base64,html,json,re,statistics,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent
read=lambda n:json.loads((ROOT/n).read_text())
score=read('olmocr-browser-ts-scores.json');parity=read('parity.json')
for row in parity['officialBenchmark']:
 assert row['overallMacroPassRate']==score['overallMacroPassRate'] and not row['changedPassFail']
go=read('timing-go.json');total=sum(r['pages'] for r in go['rows'])
timings=[('Go',sum(r['medianMs'] for r in go['rows'])/total)]
for e,name in [('ts','TypeScript browser'),('dart','Dart browser')]:
 d=read(f'timing-browser-{e}.json');timings.append((name,sum(statistics.median(s['extractionMs'] for s in r['samples'][1:]) for r in d['rows'])/total))
base='https://github.com/vkpdeveloper/thereader/blob/feat/pdf-browser-engines/eval/pdf/native/'
assets='https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/pr-assets/thereader/'
image_data=base64.b64encode(urllib.request.urlopen(urllib.request.Request(assets+'pdf-browser-table-305433fd.png',headers={'User-Agent':'Mozilla/5.0'}),timeout=30).read()).decode()
chart='<svg viewBox="0 0 860 265" role="img" aria-label="Warm extraction time in milliseconds per page; lower is better" style="width:100%;height:auto;max-height:320px;font-family:system-ui">'
for i,(name,value) in enumerate(timings):
 y=20+i*67;w=value/5*450
 chart+=f'<text x="0" y="{y+26}" fill="#e3e3e3" font-size="21">{name}</text><rect x="240" y="{y}" width="{w}" height="40" fill="#8ab4f8"/><text x="{250+w}" y="{y+26}" fill="#e3e3e3" font-size="21">{value:.3f}</text>'
chart+='<path d="M240 215H690" stroke="#9aa0a6"/>'
for i in range(6):chart+=f'<text x="{240+i*90}" y="240" fill="#9aa0a6" text-anchor="middle" font-size="16">{i}</text>'
chart+='<text x="450" y="263" fill="#9aa0a6" font-size="17">milliseconds / page</text></svg>'
categories=''.join(f'<tr><td>{html.escape(name)}</td><td class="num">{r["passed"]:,} / {r["total"]:,}</td></tr>' for name,r in score['categories'].items())
engineRows=''.join(f'<tr><td>{name}</td><td class="num">{score["overallMacroPassRate"]*100:.14f}%</td><td class="num">0</td></tr>' for name in ['Go baseline','TypeScript browser','Dart browser','TypeScript / Bun','Dart VM'])
body=f'''<h1>PDF Extractor in the browser</h1>
<p class="lede">Independent TypeScript and Dart engines · measured against Go 0.3.0 · 11 October 2026</p>
<p>Both ports preserve the exact reference benchmark score: <strong>{score['overallMacroPassRate']*100:.14f}%</strong>. Every one of the <strong>8,413 individual pass/fail outcomes</strong> agrees with Go. Browser performance is slower: TypeScript takes <strong>{timings[1][1]/timings[0][1]:.2f}×</strong> Go’s time and Dart takes <strong>{timings[2][1]/timings[0][1]:.2f}×</strong> on the measured five-document workload. Performance parity has not been achieved.</p>
<p>The reader now converts uploaded PDFs in a local TypeScript worker and imports the resulting EPUB through its existing storage flow. Both packages can also be used separately. The Dart worker compiles to JavaScript and has its own public browser client.</p>
<h2>The exact score</h2>
<p>Raw macro pass rate: <code>{score['overallMacroPassRate']}</code>. This uses the unmodified pinned olmOCR evaluator, all 1,403 PDFs, original tests, and official baseline checks. It averages category pass rates; it is <strong>not a percentage of book content recovered</strong>. The same 12 resource-limit failures remain in scoring. The seeded bootstrap 95% interval is 29.454142651994575%–31.145846649013537%.</p>
<div class="table-wrap"><table><thead><tr><th>Configuration</th><th class="num">Macro score</th><th class="num">Changed outcomes vs Go</th></tr></thead><tbody>{engineRows}</tbody></table></div>
<p><a href="{base}parity.json">Direct parity results</a> · <a href="{base}olmocr-browser-ts-tests.jsonl">TypeScript’s 8,413 outcomes</a> · <a href="{base}olmocr-browser-dart-tests.jsonl">Dart’s 8,413 outcomes</a></p>
<div class="table-wrap"><table><caption>Identical counts for Go and both ports</caption><thead><tr><th>Category</th><th class="num">Passed / total</th></tr></thead><tbody>{categories}</tbody></table></div>
<p>Scans and semantic math explain major gaps. There is no OCR or semantic LaTeX reconstruction. These results establish score parity, not market-leading accuracy or universal 99% book accuracy. The reference corpus was authored independently but has also been used during development.</p>
<h2>Measured speed</h2><figure><div style="overflow-x:auto"><div style="min-width:620px">{chart}</div></div><figcaption>Page-weighted warm extraction time. Lower is better; bars start at zero.</figcaption></figure>
<p>Same Apple M5, Chrome 154, five PDFs and 1,508 pages. Each document has one cold call and three warm calls. The summary sums warm medians and divides by page count. Parsing, decoding, layout, images and Markdown are included. File reads, EPUB compression, upload, and reader rendering are excluded. Every cold and warm sample is retained; this is document throughput, not a per-page latency guarantee.</p>
<p><a href="{base}timing-go.json">Go timings</a> · <a href="{base}timing-browser-ts.json">TypeScript timings</a> · <a href="{base}timing-browser-dart.json">Dart timings</a>. No universal sub-millisecond claim is supported. Only Chrome desktop was measured.</p>
<h2>What the ports preserve</h2>
<p>The five PDFs are the requested 43-page arXiv paper, Axler’s Linear Algebra Done Right (404 pages), Hefferon’s Linear Algebra (525), Think Python (244), and Calculus Made Easy (292). Their block text, block order, table coordinates and spans, header associations and normalized Markdown match Go. Nineteen synthetic Go fixtures also check structure and geometry.</p>
<p>The requested paper retains all 13 tables, including merged model headings and grouped row labels. Its structures match the Go version that recovered all 1,473 nonempty author-HTML cells. That paper was a development example; this result does not generalize to every table.</p>
<figure><img src="data:image/png;base64,{image_data}" alt="Actual reader with merged model headings and a 32K row header spanning five rows"/><figcaption>Actual browser-converted paper. Merged headings and grouped labels are preserved. Wide tables still scroll horizontally inside the reading column.</figcaption></figure>
<p>Fourteen selected math crops achieve a mean ink F1 of <strong>99.96026317503747%</strong>, with all 14 above 99%, for both ports. The metric compares positioned glyph appearance with a one-pixel tolerance at 216 dpi. It does not evaluate semantic equations, reading order, or whole-book accuracy. <a href="{base}math-ts.json">TypeScript math results</a> · <a href="{base}math-dart.json">Dart math results</a>.</p>
<p>Fifteen of 16 PNG assets match Go’s decoded pixels exactly. One masked JPEG is decoded and re-encoded as PNG; generic decoder rounding changes some RGB values by at most 3/255 while preserving alpha. The report retains changed-pixel counts rather than claiming every raster image is bit-exact.</p>
<h2>How it works</h2>
<pre>PDF bytes
  → bounded PDF syntax, xref and stream parser
  → original content interpreter and font readers
  → positioned spans, glyphs, paths and images
  → reading order, cleanup, headings, code, lists and tables
  → typed blocks, metadata, assets and warnings
  → Markdown, semantic HTML or EPUB</pre>
<p>TypeScript and Dart each implement this pipeline independently. There is no Go runtime, WebAssembly wrapper, PDF.js, hosted extraction service, or call from one engine into the other. Dependencies provide generic compression, JPEG, hashing and XML functionality. Complex tables retain rowspan, colspan, scope and header associations. Math uses positioned glyph SVGs.</p>
<p>Workers keep extraction off the UI thread, copy input before transferring it, enforce deadlines and support cancellation. Limits bound objects, pages, decoded data, operations, spans, images and assets. The reader’s extraction notes preserve warnings and incomplete status. Extraction stays local; the resulting EPUB still uses the existing upload and sync service.</p>
<h2>Reader proof</h2>

<p><a href="{assets}pdf-browser-upload-29647d4b.mp4">Open the original recording</a> · <a href="{assets}pdf-browser-title-f7087bd9.png">Paper title screenshot</a>. The production-built reader was tested with the extraction-service endpoint explicitly blocked. The actual PDF upload opens as an EPUB with notes, title, navigation and merged tables. The independent Dart browser client separately passed EPUB transfer, structured-document and cancellation checks.</p>
<h2>Validation and remaining limits</h2>
<p>56 TypeScript tests and 46 Dart tests passed, along with TypeScript type checking, Dart analysis, browser worker compilation, standalone Dart package validation, the production web build, and Go tests/vet. CI runs the package tests and builds; benchmark reproduction is documented separately.</p>
<p>Review fixed shared image-buffer ownership and named inline-image color-space lengths. Two confirmed limitations inherited from Go remain: scaled/zero-width vector strokes can render incorrectly, and discarded or clipping paths can influence ruling-based table detection. These require shared algorithm changes and new score runs; this port preserves Go’s current behavior. <a href="{base}review.md">Review dispositions</a>.</p>
<p>OCR, JPEG2000, JBIG2, complete color management and semantic math are still unsupported. Some PDFs remain <code>complete: false</code>. The libraries do not claim perfect visual reconstruction, exhaustive PDF support, or a clean review.</p>
<h2>Reproduce and compare</h2>
<p><a href="{base}README.md">Commands, methodology and limitations</a> · <a href="{base}evidence.json">Build and evidence hashes</a>. Dataset revision <code>54a96a6fb6a2bd3b297e59869491db4d3625b711</code>; evaluator revision <code>f7cfe4c22098b154c76b6ec950d1c0a464eecf8d</code>; Go baseline <code>625d6b202da5759e13dc67c743022a22c2e07175</code>.</p>
<p>The <a href="https://github.com/vkpdeveloper/thereader/blob/feat/pdf-browser-engines/eval/pdf/coverage-v03/README.md">prior Go evaluation</a> contains scoped comparisons with PyMuPDF, PyMuPDF4LLM, pypdf, pdfplumber, Poppler, Docling and Marker. It found strong table results on the development paper and weaker prose/reference-corpus results. This browser-port evaluation does not establish a new market-wide rank.</p>'''
template=(ROOT/'report-template.html').read_text().replace('DOCUMENT TITLE','PDF Extractor: independent browser engines')
output=re.sub(r'<main>.*?</main>',lambda _:f'<main>\n{body}\n</main>',template,flags=re.S)
(ROOT/'report.html').write_text(output)
print('Built',ROOT/'report.html')
