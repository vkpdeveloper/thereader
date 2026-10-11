"""Reproducible selected Type 3 glyph crops, using largest geometric overlap."""
import base64,json,re
from pathlib import Path
import pymupdf
from PIL import Image
from math_visual import ROOT,LOCAL,SCALE,render_svg,ink,compare
DEST=ROOT/'eval/pdf/coverage-v03';PRED=ROOT/'test-corpus/pdf/coverage-v03'
regions=json.loads((DEST/'bitmap-regions.json').read_text());rows=[]
for r in regions:
    d=json.loads((PRED/(r['document']+'.json')).read_text());page=d['pages'][r['page']-1];clip=pymupdf.Rect(r['box'])
    assets={a['name']:base64.b64decode(a['data']) for a in d['assets']}
    candidates=[]
    for b in page['blocks']:
        for run in b.get('runs',[]):
            name=run.get('asset');raw=assets.get(name,b'')
            if not raw:continue
            m=re.search(rb'viewBox="([^"]+)"',raw)
            if m:
                x,y,w,h=map(float,m[1].split());box=pymupdf.Rect(x,y,x+w,y+h);overlap=(box&clip).get_area()
                if overlap>0:candidates.append((overlap,name))
    selected=max(candidates,default=(0,None))[1]
    with pymupdf.open(LOCAL/(r['document']+'.pdf')) as original:
        pix=original[r['page']-1].get_pixmap(matrix=pymupdf.Matrix(SCALE,SCALE),clip=clip,alpha=False);source=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
    actual=render_svg(assets[selected],page,clip) if selected else Image.new('RGB',source.size,'white')
    out=PRED/'visual';out.mkdir(exist_ok=True);source.save(out/(r['id']+'-source.png'));actual.save(out/(r['id']+'-extracted.png'))
    rows.append({**r,'asset':selected,**compare(ink(source),ink(actual))})
(DEST/'bitmap-visual.json').write_text(json.dumps({'method':'Three deliberately selected Type 3 cases. Largest overlap inline SVG, original PDF vs extracted glyph at 216 dpi, one pixel ink tolerance. Visual only, not recovered Unicode.','regions':rows},indent=2)+'\n')
