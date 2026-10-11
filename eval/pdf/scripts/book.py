"""A controlled typesetting of a full public-domain novel, with source text gold.

This is not an independently typeset book holdout. It tests much more varied
book-length prose than the deliberately small synthetic layout fixtures.
Run after corpus.py. It appends to the existing manifest.
"""
from pathlib import Path
import hashlib, json, re, textwrap, urllib.request
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT=Path(__file__).resolve().parents[3]
DEST=ROOT/'test-corpus/pdf'
SOURCE='https://www.gutenberg.org/cache/epub/11/pg11.txt'

def main():
    path=DEST/'alice-source.txt'
    if not path.exists():
        with urllib.request.urlopen(SOURCE,timeout=60) as r:path.write_bytes(r.read())
    source=path.read_text(encoding='utf-8-sig')
    source=re.split(r'\*\*\* START OF THE PROJECT GUTENBERG EBOOK .*?\*\*\*',source,maxsplit=1,flags=re.S)[1]
    source=re.split(r'\*\*\* END OF THE PROJECT GUTENBERG EBOOK',source,maxsplit=1)[0].strip()
    fonts=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    font=next(f for f in fonts if Path(f).exists());pdfmetrics.registerFont(TTFont('BookBody',font))
    output=DEST/'alice-book.pdf';c=canvas.Canvas(str(output),pagesize=(612,792),invariant=1,pageCompression=1)
    c.setTitle("Alice's Adventures in Wonderland");c.setAuthor('Lewis Carroll');c.setSubject('Controlled typesetting of Project Gutenberg ebook 11 for PDF extraction evaluation.')
    expected=[];headings=[];page=1;y=700
    def finish():
        nonlocal page,y
        c.setFont('Helvetica',9);c.drawString(54,765,'Alice | Reading edition benchmark');c.drawCentredString(306,25,str(page));c.showPage();page+=1;y=710
    for para in re.split(r'\n\s*\n',source):
        para=' '.join(para.split());is_heading=bool(re.match(r'^CHAPTER [IVX]+\.',para)) and len(para)<140
        size=16 if is_heading else 11;font='Helvetica-Bold' if is_heading else 'BookBody'
        wrapped=textwrap.wrap(para,55 if is_heading else 88,break_long_words=False,break_on_hyphens=False)
        if is_heading and y<150:finish()
        if is_heading:headings.extend(wrapped)
        for row in wrapped:
            if y<65:finish()
            c.setFont(font,size);c.drawString(54,y,row);expected.append(row);y-=22 if is_heading else 15
        y-=10
    finish();c.save();pages=page-1
    manifest=json.loads((DEST/'manifest.json').read_text());manifest=[r for r in manifest if r['id']!='alice-book']
    manifest.append({'id':'alice-book','file':str(output.relative_to(ROOT)),'pages':pages,'kind':'generated','genre':'public-domain novel with controlled typesetting','sourceUrl':SOURCE,'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'text':'\n'.join(expected),'headings':headings,'tables':[],'codes':[],'images':0})
    (DEST/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
    print(f'Alice: {pages} pages, {len(expected)} lines, {len(" ".join(expected).split())} words')

if __name__=='__main__':main()
