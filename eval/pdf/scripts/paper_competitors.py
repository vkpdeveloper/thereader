"""Native table outputs from three additional local tools on the development paper.

This is not a blind holdout: the Go engine was developed with this paper.
No strategy is tuned using gold cells. Run outside the speed timing process.
"""
import argparse,json,re
from pathlib import Path
from bs4 import BeautifulSoup
from table_structure import evaluate,html_cells
ROOT=Path(__file__).resolve().parents[3];LOCAL=ROOT/'test-corpus/pdf/coverage-v03';DEST=ROOT/'eval/pdf/coverage-v03';SOURCE=ROOT/'test-corpus/pdf/real-world/harness.pdf'

def grid(rows):
    return {'rows':len(rows),'columns':max(map(len,rows),default=0),'cells':[{'row':y,'column':x,'rowSpan':1,'colSpan':1,'text':s or ''} for y,row in enumerate(rows) for x,s in enumerate(row)]}
def native_table(table):
    # Both APIs expose native cell rectangles. Retain their merged spans instead
    # of flattening None-covered cells into independent blank cells. No gold is
    # consulted and no missing header/body regions are stitched together.
    rows=table.rows;text=table.extract()
    boxes=[c for row in rows for c in row.cells if c is not None]
    xs=sorted({round(c[i],4) for c in boxes for i in (0,2)})
    ys=sorted({round(c[i],4) for c in boxes for i in (1,3)})
    cells=[]
    for y,row in enumerate(rows):
        for x,c in enumerate(row.cells):
            if c is None:continue
            x0,y0,x1,y1=map(lambda v:round(v,4),c)
            col,r=xs.index(x0),ys.index(y0)
            cells.append({'row':r,'column':col,'rowSpan':ys.index(y1)-r,'colSpan':xs.index(x1)-col,'text':text[y][x] or ''})
    return {'rows':max(0,len(ys)-1),'columns':max(0,len(xs)-1),'cells':cells}
def markdown_tables(md):
    tables=[];current=[]
    def flush():
        nonlocal current
        if len(current)>=2:tables.append(grid(current))
        current=[]
    for line in md.splitlines():
        s=line.strip()
        if s.startswith('|') and s.endswith('|'):
            cells=re.split(r'(?<!\\)\|',s[1:-1])
            if all(re.fullmatch(r'[:\- ]+',c) for c in cells):continue
            cells=[BeautifulSoup(c.replace('**','').replace('`','').replace('\\|','|'),'html.parser').get_text(' ',strip=True) for c in cells]
            current.append(cells)
        else:flush()
    flush()
    for t in BeautifulSoup(md,'html.parser').select('table'):tables.append(html_cells(t))
    return tables

def main():
    ap=argparse.ArgumentParser();ap.add_argument('engine',choices=['pymupdf-tables','pymupdf-text-tables','pymupdf4llm','pdfplumber','pdfplumber-text']);args=ap.parse_args();pages=[]
    if args.engine.startswith('pymupdf-'):
        import pymupdf
        settings={'vertical_strategy':'text','horizontal_strategy':'text'} if args.engine=='pymupdf-text-tables' else {}
        with pymupdf.open(SOURCE) as doc:
            for n,p in enumerate(doc,1):pages.append((n,[native_table(t) for t in p.find_tables(**settings).tables]))
        config=f'PyMuPDF find_tables({settings}); native cell rectangles retain spans; full pages, no gold tuning or reference crops'
    elif args.engine.startswith('pdfplumber'):
        import pdfplumber
        settings={'vertical_strategy':'text','horizontal_strategy':'text'} if args.engine=='pdfplumber-text' else {}
        with pdfplumber.open(SOURCE) as doc:
            for n,p in enumerate(doc.pages,1):pages.append((n,[native_table(t) for t in p.find_tables(settings)]))
        config=f'pdfplumber find_tables({settings}); native cell rectangles retain spans; full pages, no gold tuning or reference crops'
    else:
        import pymupdf,pymupdf4llm
        with pymupdf.open(SOURCE) as doc:
            chunks=pymupdf4llm.to_markdown(doc,page_chunks=True,use_ocr=False,header=False,footer=False,show_progress=False)
            (LOCAL/'pymupdf4llm-raw.md').write_text('\n\n'.join(c['text'] for c in chunks))
            for n,c in enumerate(chunks,1):pages.append((n,markdown_tables(c['text'])))
        config='PyMuPDF4LLM Markdown page chunks; OCR off, header/footer cleanup on'
    result={'version':args.engine,'config':config,'pages':[{'number':n,'blocks':[{'kind':'table','box':{},'table':t} for t in tables]} for n,tables in pages]}
    path=LOCAL/(args.engine+'-tables.json');path.write_text(json.dumps(result,ensure_ascii=False))
    score=evaluate(path);score['configuration']=config;(DEST/('tables-'+args.engine+'.json')).write_text(json.dumps(score,indent=2)+'\n');print(args.engine,score['cellText'],score['cellPositionAndSpan'])
if __name__=='__main__':main()
