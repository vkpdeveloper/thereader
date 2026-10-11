"""Create the self-contained public report from recorded measurements.

Pass local screenshots/video explicitly. The template is the HTML Communication
template, with its original CSS and hex-swatch script retained.
"""
import argparse,base64,html,json,mimetypes
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];DEST=ROOT/'eval/pdf/coverage-v03'
def read(name):return json.loads((DEST/(name+'.json')).read_text())
def esc(value):return html.escape(str(value))
def pct(v):return f'{v*100:.2f}%'
NAMES={'pdf-extractor':'PDF Extractor 0.3','pymupdf':'PyMuPDF','pymupdf-tables':'PyMuPDF tables','pymupdf4llm':'PyMuPDF4LLM','pdfplumber':'pdfplumber','pdftotext':'Poppler pdftotext','pypdf':'pypdf','docling':'Docling CPU','marker':'Marker fast CPU'}
NAMES.update({'pymupdf-text-tables':'PyMuPDF (text)','pdfplumber-text':'pdfplumber (text)'})
def asset(path):
    p=Path(path);return 'data:'+mimetypes.guess_type(p.name)[0]+';base64,'+base64.b64encode(p.read_bytes()).decode()
def bars(rows,key,title,unit,maximum):
    parts=['<figure><div role="img" aria-label="'+esc(title)+'" style="font:18px/1.5 system-ui,sans-serif">']
    for r in rows:
        value=r[key];color='#8ab4f8' if r['engine']=='pdf-extractor' else '#9aa0a6'
        parts.append(f'<div style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><span>{esc(NAMES[r["engine"]])}</span><strong>{value:.2f}{unit}</strong></div><div style="height:12px;background:#3d3e41"><div style="height:12px;width:{value/maximum*100:.3f}%;background:{color}"></div></div></div>')
    parts.append(f'<div style="display:flex;justify-content:space-between;color:#b8b8b8"><span>0</span><span>{maximum:g}{unit}</span></div></div><figcaption>{esc(title)}</figcaption></figure>')
    return ''.join(parts)
def table(headers,rows):
    return '<div class="table-wrap"><table><thead><tr>'+''.join(f'<th class="{"num" if i else ""}">'+esc(h)+'</th>' for i,h in enumerate(headers))+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td class="{"num" if i else ""}">'+esc(v)+'</td>' for i,v in enumerate(row))+'</tr>' for row in rows)+'</tbody></table></div>'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--desktop',required=True);ap.add_argument('--mobile',required=True);ap.add_argument('--video',required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    s=read('summary');q=read('quality');e=read('evidence');a=read('tables-after');b=read('tables-before')
    before=s['independent']['0.2'];after=s['independent']['0.3'];ours=next(r for r in s['bulkTiming'] if r['engine']=='pdf-extractor');pop=next(r for r in s['bulkTiming'] if r['engine']=='pdftotext');paper=next(r for r in s['paperTiming'] if r['engine']=='pdf-extractor')
    assert a['referenceTables']==a['exactNonemptyCellTables']==a['predictedTables']==13
    assert a['cellPositionAndSpan']['matched']==a['cellPositionAndSpan']['reference']==a['cellPositionAndSpan']['predicted']==1473
    source='<a href="https://arxiv.org/pdf/2609.20804">arXiv 2609.20804</a>'
    content=f'''<h1>PDF Extractor 0.3: repaired tables, measured limits</h1>
<p class="lede">Go library and reader integration · 11 October 2026 · <a href="https://github.com/vkpdeveloper/thereader/pull/34">PR #34</a></p>
<p>The fragmented tables in {source} are repaired. All <strong>13 tables and 1,473 nonempty cells</strong> now match the author's HTML in text, row, column, rowspan and colspan. Group labels stay attached to their rows in the reader.</p>
<p><strong>Best-in-market accuracy has not been achieved.</strong> On the full olmOCR-bench reference corpus of 1,403 page PDFs, the score is {pct(after['overallMacroPassRate'])}, versus {pct(before['overallMacroPassRate'])} before. The confidence intervals overlap. This work does not substantiate 99% whole-book accuracy or a universal sub-millisecond page time.</p>
<h2>The reported table defect</h2>
<p>The old output split 13 source tables into 19 fragments. Model headings now span their two metric columns; the 32K, 64K and 96K labels span five rows, and 128K spans seven. Superscripts remain with their numeric cells. Wrapped headings are rejoined, and numbered algorithms remain pseudocode.</p>'''
    content+=table(['Requested-paper check','0.2','0.3'],[
        ['Output tables',b['predictedTables'],a['predictedTables']],
        ['Exact complete nonempty-cell tables',b['exactNonemptyCellTables'],a['exactNonemptyCellTables']],
        ['Cell text F1',pct(b['cellText']['f1']),pct(a['cellText']['f1'])],
        ['Cell text + position + spans F1',pct(b['cellPositionAndSpan']['f1']),pct(a['cellPositionAndSpan']['f1'])],
        ['Selected prose agreement',pct(q['paper']['0.2']['weightedCharacterAgreement']),pct(q['paper']['0.3']['weightedCharacterAgreement'])],
        ['Heading label F1',pct(q['paper']['0.2']['headings']['f1']),pct(q['paper']['0.3']['headings']['f1'])]])
    content+=f'''<p>This paper was used during development. Its perfect table score is a regression result, not a blind accuracy estimate. The corrected reference includes visible punctuation and 1,473 cells; the previous report's 1,448-cell alphanumeric score is not directly comparable.</p>
<figure><img src="{asset(args.desktop)}" alt="Actual reader showing merged model headings and grouped context-window rows"><figcaption>Actual PDF upload → Go server → EPUB → reader. <a href="{e['screenshot']}">Open desktop screenshot</a>.</figcaption></figure>
<figure><video controls preload="metadata" src="{asset(args.video)}"></video><figcaption>Recorded reader interaction, including horizontal table scrolling. <a href="{e['video']}">Open video</a>.</figcaption></figure>
<figure><img style="width:390px;max-width:100%" src="{asset(args.mobile)}" alt="Repaired table within a phone-sized reader"><figcaption>390 × 844 viewport emulation. The table scrolls within the reader; page horizontal overflow is zero. This is not a physical-device test. <a href="{e['mobileScreenshot']}">Open mobile screenshot</a>.</figcaption></figure>
<h2>Table comparison: eight local configurations</h2>
<p>PDF Extractor ranks <strong>1 of {len(s['paperTables'])} on this development paper's exact cell-structure F1</strong>. This rank includes five competitor engines, with two strategies each for PyMuPDF and pdfplumber, and applies only to these settings and this paper.</p>'''
    content+=bars([{**r,'percent':100*r['cellPositionAndSpanF1']} for r in s['paperTables']],'percent','Exact cell text, position and spans F1 on the requested paper. Higher is better.','%',100)
    content+='''<p>Docling uses accurate table inference on CPU. Marker uses its fast CPU mode with OCR and LLM processing disabled, not its strongest GPU or hosted configuration. PyMuPDF and pdfplumber each run default line and documented text strategies over full pages, retaining merged spans from native cell rectangles. Their default line strategies miss almost all cells on this paper, which lacks vertical cell borders; the text strategies can over-detect prose as tables. PyMuPDF4LLM uses Markdown page chunks with OCR off. No competitor is repaired or cropped using the gold tables. These are configuration comparisons, not overall product rankings.</p>
<h2>Selected prose and heading checks</h2>
<p>The same 73 author-HTML body and prompt paragraphs are compared against each output's best contiguous text window. This omits punctuation, whitespace, short paragraphs, tables, figures and author metadata. It is not whole-document accuracy. Text-only configurations do not expose heading labels.</p>'''
    prose=[]
    for engine in ['0.3','pymupdf','pdftotext','pypdf','pdfplumber','pymupdf4llm','docling','marker']:
        r=q['paper'][engine]
        prose.append([NAMES.get(engine,'PDF Extractor 0.3'),pct(r['weightedCharacterAgreement']),f"{r['paragraphsAt99Percent']}/{r['paragraphs']}",pct(r['headings']['f1']) if engine in ('0.3','pymupdf4llm','docling','marker') else 'not exported'])
    content+=table(['Configuration','Prose agreement','Paragraphs ≥99%','Heading F1'],prose)
    prose_rank=next(r['rank'] for r in s['paperProse'] if r['engine']=='pdf-extractor')
    content+=f'<p>PDF Extractor ranks {prose_rank} of {len(s["paperProse"])} on this selected prose metric. Its table improvement does not imply better prose extraction than every competitor.</p>'
    content+='<h2>Speed on 1,508 pages</h2>'
    content+=f'<p>Across the paper and four books, PDF Extractor ranks <strong>{ours["rank"]} of 6</strong> at <strong>{ours["msPerPage"]:.3f} ms/page</strong>, using total median document time divided by total pages. It is {pop["msPerPage"]/ours["msPerPage"]:.2f}× as fast as Poppler in this run. On the complex 43-page paper alone, it takes {paper["msPerPage"]:.3f} ms/page and ranks {paper["rank"]} of 8.</p>'
    maximum=max(r['msPerPage'] for r in s['bulkTiming']);maximum=__import__('math').ceil(maximum/20)*20
    content+=bars(s['bulkTiming'],'msPerPage','Warm conversion time, 1,508 pages across five PDFs. Lower is faster.',' ms/page',maximum)
    content+=table(['Document','Pages','PDF Extractor ms/page'],[(r['id'],r['pages'],f"{r['msPerPage']:.3f}") for r in read('timing-pdf-extractor')['rows']])
    content+=table(['Paper-only configuration','Version','ms/page'],[(NAMES[r['engine']],r['version'],f"{r['msPerPage']:.3f}") for r in s['paperTiming']])
    content+=f'''<p>{esc(s['cpu'])}, {esc(s['platform'])}, {esc(s['go'])}. Each engine ran sequentially: one warm-up discarded, median of three measured conversions. This was a shared development host, not an isolated hardware test or upload-latency SLA. Imports and model loading are excluded.</p>
<p>Go includes parsing, fonts, images, layout and Markdown, excluding input I/O and JSON/EPUB serialization. PyMuPDF, pypdf and Poppler extract text only; Poppler includes CLI startup. pdfplumber adds default table extraction. PyMuPDF4LLM and Docling export Markdown with embedded images. Marker exports Markdown and image objects, includes file reads and uses four CPU threads. Different output scopes limit direct speed comparisons. Exact samples and settings are committed.</p>
<h2>The independent corpus exposes the remaining gap</h2>
<p>All 1,403 page PDFs and 8,413 tests from the pinned <a href="https://huggingface.co/datasets/allenai/olmOCR-bench">olmOCR-bench</a> revision were evaluated using the unmodified official evaluator. The overall score is a category macro-average. The release's 95% bootstrap interval is {pct(after['bootstrap95CI'][0])}–{pct(after['bootstrap95CI'][1])}. Twelve oversized-image PDFs hit the default resource limit in both versions; their empty outputs remain in scoring.</p>'''
    content+=table(['Category','0.2 passes','0.3 passes','0.3 rate'],[(k.replace('_',' '),f"{before['categories'][k]['passed']}/{v['total']}",f"{v['passed']}/{v['total']}",pct(v['passRate'])) for k,v in after['categories'].items()])
    content+='''<p>Baseline checks only detect gross output problems; their 99% pass rate is not 99% content accuracy. Semantic math and scanned text remain major failures. The corpus is independently authored but now also informed a fix for false tables around two-column articles, so it is no longer an untouched holdout. No competitor was run on the full corpus in this iteration; there is no market accuracy rank.</p>
<h2>More text, glyphs and images recovered</h2>
<p>The package adds original CFF charset/encoding parsing, partial Unicode fallback, monochrome bitmap Type 3 glyphs, T.4/T.6 fax decoding, indexed grayscale/CMYK/ICC palettes, and packed or JPEG soft masks. Visible line-end hyphens are removed only when the solid spelling appears elsewhere on the page without a conflicting compound spelling.</p>
<p>On the independent corpus, image-failure reports fall from 166 to 64, and font-outline warnings from 2,435 to 166. These are diagnostic counts, not a completeness metric. All 76 testable fax image objects match independent MuPDF RGB pixels exactly; 16 stencil masks are excluded because their color depends on page drawing state. Think Python's 20 CFF outline warnings disappear. Calculus replacement characters fall from 346 to 78; unresolved mappings remain explicit.</p>
<p>All 14 deliberately selected equation crops exceed 99% ink F1; 13 score exactly 100% under a one-pixel tolerance at 216 dpi. Three selected bitmap-glyph crops also match. The following examples preserve layout as SVG, not semantic LaTeX or MathML.</p>'''
    visual=ROOT/'test-corpus/pdf/coverage-v03/visual'
    for id,label in [('hefferon-matrix','Hefferon matrix equation'),('calculus-substitution','Calculus substitution'),('calculus-bitmap-pound','Bitmap Type 3 glyph')]:
        if not (visual/(id+'-source.png')).exists():continue
        content+=f'<figure><p>{esc(label)}: original PDF</p><img src="{asset(visual/(id+"-source.png"))}" alt="Original PDF crop"><p>Extracted block</p><img src="{asset(visual/(id+"-extracted.png"))}" alt="Extracted SVG raster crop"><figcaption>Selected appearance check, not whole-book accuracy.</figcaption></figure>'
    content+='''<h2>How the library and reader work</h2>
<p>The standalone <code>packages/pdf_go</code> module has no dependencies beyond the Go standard library. PDF objects, streams, fonts, glyphs, graphics, images and geometry are parsed directly. Existing extraction systems are used only in evaluation.</p>
<p><code>Block.Table</code> is the canonical grid: anchor row/column, rowspan/colspan, styled runs, header role and source rectangle. Long rules locate table regions; repeated body alignments infer columns; partial underlines recover grouped headings. Wrapped header bands and vertically centered labels recover spans. Rejected table guesses leave text available to ordinary reading order.</p>
<p>The same blocks generate JSON, Markdown and EPUB. Complex tables use HTML in Markdown; EPUB retains table sections, headers, spans, scope and explicit header associations. The existing backend calls the Go HTTP service, stores the resulting EPUB and opens it in the existing reader. Desktop and mobile proof use this actual upload path.</p>
<h2>Validation and reproduction</h2>
<p>Unit and regression tests, race detection and Go vet pass. Fax and font parsers have bounded fuzz checks. The final source review has no unresolved findings. Pixel checks use an independent decoder; paper tables use author HTML. Dataset and evaluator revisions, source hashes, per-test results, timing samples and reproduction scripts are included in <a href="https://github.com/vkpdeveloper/thereader/tree/fix/pdf-real-world-math/eval/pdf/coverage-v03">the evidence directory</a>.</p>
<p>Use <code>coverage_bench.py</code> for sequential timings, <code>table_structure.py</code> and <code>paper_competitors.py</code> for tables, <code>coverage_quality.py</code> for selected prose, <code>math_visual.py</code> and <code>bitmap_visual.py</code> for crops, and <code>fax_pixels.py</code> for decoded image bytes. The README gives pinned environments and full corpus commands.</p>
<h2>What still prevents the requested accuracy</h2>
<p>OCR, semantic equation reconstruction, JPEG 2000 and JBIG2 decoding, unresolved symbol mappings, complex/nested tables, some clipping, color-space and opacity behavior, and reading order around floats remain incomplete. Axler still has 13 unsupported JPEG 2000 reports. Known partial outputs retain <code>complete: false</code> and warnings. Hosted APIs, strongest GPU/model configurations and OmniDocBench were not evaluated.</p>
<p>The table defect is fixed and content coverage improved. A best-in-market or universal 99% book claim would require substantial further implementation and a new untouched evaluation corpus.</p>'''
    template=(DEST/'report-template.html').read_text();start=template.index('<main>');end=template.index('</main>',start)
    result=(template[:start]+'<main>\n'+content+'\n'+template[end:]).replace('DOCUMENT TITLE','PDF Extractor 0.3: repaired tables and measured limits')
    args.out.write_text(result);print(args.out)

if __name__=='__main__':main()
