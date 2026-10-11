"""Pixel check of hand-selected display-formula regions, not book-wide accuracy.

Each original PDF crop is compared with ONE output math block, so splitting a
formula into separate blocks is penalized. MuPDF is evaluation-only. The
regions were chosen from original PDF pages and include known difficult cases.
"""
from pathlib import Path
import base64, hashlib, json, re
import numpy as np
from PIL import Image, ImageFilter
import pymupdf

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT/'eval/pdf/real-world'
LOCAL = ROOT/'test-corpus/pdf/real-world'
REGIONS = json.loads((DEST/'math-regions.json').read_text())
SCALE = 3


def ink(image):
    rgb = np.asarray(image.convert('RGB')).astype(np.int16)
    return (rgb.max(axis=2) < 160) & ((rgb.max(axis=2)-rgb.min(axis=2)) < 60)


def dilate(mask):
    return np.asarray(Image.fromarray(mask.astype(np.uint8)*255).filter(ImageFilter.MaxFilter(3))) > 0


def compare(a, b):
    # One raster pixel tolerance at 216 dpi, i.e. one third of a PDF point.
    if not a.any():
        raise ValueError('Reference region contains no ink')
    recall = np.count_nonzero(a & dilate(b))/np.count_nonzero(a)
    precision = np.count_nonzero(b & dilate(a))/max(1,np.count_nonzero(b))
    return {'inkRecall':float(recall), 'inkPrecision':float(precision), 'inkF1':float(2*recall*precision/max(1e-12,recall+precision)),
            'referenceInkPixels':int(a.sum()), 'outputInkPixels':int(b.sum())}


def svg_page(asset, width, height):
    svg = asset.decode()
    body = svg[svg.index('>')+1:svg.rfind('</svg>')]
    body = re.sub(r'<title>.*?</title>', '', body, flags=re.S)
    body = re.sub(r'<rect[^>]*fill="white"[^>]*/>', '', body)
    # MuPDF's SVG importer expects the SVG 1.1 xlink spelling; the browser uses SVG 2.
    body = body.replace('href="#', 'xlink:href="#')
    return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}" viewBox="0 0 {width} {height}">{body}</svg>'.encode()


def render_svg(asset, page, clip):
    with pymupdf.open(stream=svg_page(asset,page['width'],page['height']),filetype='svg') as svg:
        pdf = svg.convert_to_pdf()
    with pymupdf.open(stream=pdf,filetype='pdf') as doc:
        pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(SCALE,SCALE),clip=clip,alpha=False)
    return Image.frombytes('RGB',(pix.width,pix.height),pix.samples)


def intersection(b, region):
    box = b['box']
    return pymupdf.Rect(box['x'],box['y'],box['x']+box['width'],box['y']+box['height']) & region


def main():
    out = LOCAL/'visual'
    out.mkdir(exist_ok=True)
    rows = []
    docs = {}
    for r in REGIONS:
        id = r['document']
        if id not in docs:
            data = json.loads((LOCAL/'after'/f'{id}.json').read_text())
            docs[id] = data, {a['name']:base64.b64decode(a['data']) for a in data['assets']}
        data, assets = docs[id]
        page = data['pages'][r['page']-1]
        clip = pymupdf.Rect(r['box'])
        with pymupdf.open(LOCAL/f'{id}.pdf') as original:
            pix = original[r['page']-1].get_pixmap(matrix=pymupdf.Matrix(SCALE,SCALE),clip=clip,alpha=False)
            source = Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
        # Geometrically largest overlap, not the best scoring image.
        candidates = [b for b in page['blocks'] if b['kind']=='math' and b.get('asset') in assets and not intersection(b,clip).is_empty]
        best = max(candidates,key=lambda b:intersection(b,clip).get_area(),default=None)
        extracted = render_svg(assets[best['asset']],page,clip) if best else Image.new('RGB',source.size,'white')
        if extracted.size != source.size:
            raise ValueError(f"Pixel grid mismatch: {r['id']}")
        a,b = ink(source),ink(extracted)
        score = compare(a,b)
        source.save(out/(r['id']+'-source.png'))
        extracted.save(out/(r['id']+'-extracted.png'))
        row = {**r, **score, 'candidateMathBlocks':len(candidates), 'selectedAsset':best['asset'] if best else None,
               'selectedBlockTextSha256': hashlib.sha256(best.get('text','').encode()).hexdigest() if best else None}
        rows.append(row)
        print(r['id'], f"F1={score['inkF1']:.4%}", f"recall={score['inkRecall']:.4%}",len(candidates))
    report = {'method':'14 manually selected display-formula crops from three books. Largest-overlap single math block; original-PDF vs extracted-glyph raster at 216 dpi, grayscale ink <160 with chroma spread <60; 1-pixel dilation tolerance. Mean over regions, not whole-book accuracy; does not measure semantic math or prose reading order.',
              'meanInkF1':sum(r['inkF1'] for r in rows)/len(rows), 'regionsAt99PercentF1':sum(r['inkF1']>=.99 for r in rows), 'regions':rows}
    (DEST/'math-visual.json').write_text(json.dumps(report,indent=2))

if __name__=='__main__':main()
