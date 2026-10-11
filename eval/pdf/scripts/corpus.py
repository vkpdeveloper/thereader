"""Independent, deterministic PDF fixtures and source-level ground truth.

ReportLab is an evaluation-only PDF *writer*. It is never used by the Go engine.
Public PDFs are downloaded, checksummed, and kept outside git.
"""
from pathlib import Path
import argparse, hashlib, io, json, textwrap, urllib.request
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'test-corpus/pdf'
DEST.mkdir(parents=True, exist_ok=True)
records = []


def build(name, pages=1, mode='prose'):
    path = DEST / f'{name}.pdf'
    c = canvas.Canvas(str(path), pagesize=(612, 792), invariant=1, pageCompression=1)
    c.setTitle('The Art of Reading' if name == 'reading-demo' else name.replace('-', ' ').title())
    c.setAuthor('The Reader benchmark authors')
    c.setSubject('Original evaluation material: text, headings, tables, images, code and references.')
    expected, headings, tables, codes, images = [], [], [], [], 0

    def line(text, x, y, font='Helvetica', size=11):
        c.setFont(font, size); c.drawString(x, y, text); expected.append(text)

    for page in range(pages):
        if pages > 1:
            c.setFont('Helvetica', 9); c.drawString(54, 769, 'The Reader | Field Notes')
            c.drawCentredString(306, 25, f'Page {page+1}')
        title = 'The Art of Reading' if name == 'reading-demo' and page == 0 else f'Chapter {page+1}: A quieter page'
        line(title, 54, 725, 'Helvetica-Bold', 24); headings.append(title)
        c.bookmarkPage(f'p{page}'); c.addOutlineEntry(title, f'p{page}', level=0)
        if mode == 'columns':
            for col, x in enumerate((54, 324)):
                for k in range(12):
                    text = f'Column {col+1}, sentence {k+1}: read in order.'
                    line(text, x, 675-k*18, size=10)
        elif mode == 'unicode':
            for k, text in enumerate(['Café, naïve, résumé: a readable edition.', 'Ελληνικά: άλφα βήτα γάμμα.', 'Русский: книга, глава, слова.', 'Typography: “quotes”, an en–dash, and €42.']):
                line(text, 54, 660-k*24, 'Unicode', 12)
        elif mode == 'scan':
            # No hidden text or title text: exercise honest OCR-gap reporting.
            c.showPage() if False else None
        else:
            paragraphs = [
                'A book should invite attention. Clear headings, comfortable paragraphs and useful illustrations make complex ideas easier to follow.',
                'The reading edition preserves the author\'s words while removing repeated page furniture. Tables remain tables, and source code keeps its indentation.',
                'This is original benchmark material with independently recorded ground truth. The score measures what was recovered, including order and structure.',
            ]
            y = 677
            for text in paragraphs:
                for row in textwrap.wrap(text, 84): line(row, 54, y); y -= 16
                y -= 12
            if mode in ('mixed', 'code'):
                line('A small, complete program', 54, y-8, 'Helvetica-Bold', 16); headings.append('A small, complete program'); y -= 38
                code = 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Read with care.")\n}'
                for row in code.splitlines():
                    if row: line(row, 54, y, 'Courier', 10)
                    y -= 14
                codes.append(code)
            if mode in ('mixed', 'table'):
                y = min(y-30, 430)
                line('Keep the structure', 54, y, 'Helvetica-Bold', 16); headings.append('Keep the structure'); y -= 32
                rows = [['Content', 'Treatment', 'Result'], ['Headings', 'Semantic levels', 'Navigation'], ['Tables', 'Rows and cells', 'Readable data'], ['Code', 'Indentation', 'Meaning']]
                tables.append(rows)
                for r, row in enumerate(rows):
                    for x, text in zip((62, 224, 410), row): line(text, x, y-r*24, 'Helvetica-Bold' if r == 0 else 'Helvetica', 10)
                    c.line(54, y-r*24-9, 558, y-r*24-9)
                c.line(54, y+15, 558, y+15)
                y -= 120
            if mode in ('mixed', 'image'):
                im = Image.new('RGB', (480, 120), '#e6e0d4'); dr = ImageDraw.Draw(im)
                for j, h in enumerate([25, 50, 90, 65, 105]): dr.rectangle((30+j*85, 112-h, 85+j*85, 112), fill=['#54674b','#a36e46'][j%2])
                c.drawImage(ImageReader(im), 54, max(70,y-95), width=360,height=90); images += 1
                line('Figure 1. A rhythm of longer and shorter reading sessions.',54,max(55,y-110),size=9)
            if mode == 'references':
                line('References',54,400,'Helvetica-Bold',18);headings.append('References')
                line('[1] Reader, A. Notes on careful reading. 2026.',54,370)
                line('Index',54,320,'Helvetica-Bold',18);headings.append('Index')
                line('attention, 1; code, 2; structure, 3',54,290)
                c.linkURL('https://example.org/reading', (54,365,320,382), relative=0)
        c.showPage()
    c.save()
    records.append({'id': name, 'file': str(path.relative_to(ROOT)), 'pages': pages, 'kind':'generated', 'text':'\n'.join(expected), 'headings':headings,'tables':tables,'codes':codes,'images':images, 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--public',action='store_true');args=parser.parse_args()
    candidates = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    font = next((p for p in candidates if Path(p).exists()), None)
    if font: pdfmetrics.registerFont(TTFont('Unicode',font))
    build('reading-demo', 1, 'mixed')
    build('book-120',120,'prose')
    for mode in ('columns','table','code','image','references'):
        build(mode,3,mode)
    if font: build('unicode',2,'unicode')
    # A real image-only scan fixture, with no font resources or text operators.
    path=DEST/'scanned.pdf';c=canvas.Canvas(str(path),invariant=1,pageCompression=1)
    im=Image.new('RGB',(600,180),'white');ImageDraw.Draw(im).text((35,55),'A page without a text layer. OCR is required.',fill='black',font_size=24)
    c.drawImage(ImageReader(im),30,450,width=540,height=162);c.save()
    records.append({'id':'scanned','file':str(path.relative_to(ROOT)),'pages':1,'kind':'capability-gap','sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    if args.public:
        for name,url in {
            'attention':'https://arxiv.org/pdf/1706.03762',
            'nist-aes':'https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.197-upd1.pdf',
            'rfc9110':'https://www.rfc-editor.org/rfc/rfc9110.pdf',
            'w3c':'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
        }.items():
            path=DEST/f'{name}.pdf'
            if not path.exists():
                with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'TheReaderPDFBenchmark/0.1'}),timeout=60) as r: path.write_bytes(r.read(64*1024*1024))
            from pypdf import PdfReader
            pages=len(PdfReader(path).pages)
            records.append({'id':name,'file':str(path.relative_to(ROOT)),'pages':pages,'kind':'public-unscored','url':url,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    (DEST/'manifest.json').write_text(json.dumps(records,indent=2,ensure_ascii=False))
    print(json.dumps([{'id':r['id'],'pages':r['pages']} for r in records]))

if __name__=='__main__': main()
