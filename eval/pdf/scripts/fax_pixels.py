"""Independent image-object pixel checks; competitor code is evaluation-only."""
import base64,hashlib,json,subprocess,io
from pathlib import Path
from PIL import Image
import pymupdf
import argparse
ap=argparse.ArgumentParser();ap.add_argument("--binary",default="/tmp/pdf-extractor-v030");args=ap.parse_args()
root=Path(__file__).resolve().parents[3];meta=json.loads((root/'eval/pdf/coverage-v03/olmocr-before-extraction.json').read_text())['documents'];rows=[]
for record in meta:
 if not any('CCITTFaxDecode' in w['message'] for w in record.get('warnings',[])):continue
 path=root/'test-corpus/pdf/olmocr/pdfs'/record['pdf'];p=subprocess.run([args.binary,'-format','json',str(path)],capture_output=True,check=True);d=json.loads(p.stdout)
 assets={}
 for a in d['assets']:
  if a['mediaType']=='image/png':
   im=Image.open(io.BytesIO(base64.b64decode(a['data']))).convert('RGB');assets[(im.width,im.height,hashlib.sha256(im.tobytes()).hexdigest())]=a['name']
 with pymupdf.open(path) as pdf:
  xrefs={v[0] for page in pdf for v in page.get_images(full=True)}
  for x in xrefs:
   if 'CCITTFaxDecode' not in pdf.xref_object(x):continue
   pix=pymupdf.Pixmap(pdf,x)
   if pix.colorspace is None:
    rows.append({'pdf':record['pdf'],'xref':x,'excluded':'stencil colors depend on page graphics state'});continue
   if pix.colorspace.n!=3:pix=pymupdf.Pixmap(pymupdf.csRGB,pix)
   im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
   key=(im.width,im.height,hashlib.sha256(im.tobytes()).hexdigest())
   rows.append({'pdf':record['pdf'],'xref':x,'width':im.width,'height':im.height,'exactPixels':key in assets,'asset':assets.get(key)})
 print(record['pdf'],sum(r.get('exactPixels',False) for r in rows),len(rows),flush=True)
(root/'eval/pdf/coverage-v03/fax-pixels.json').write_text(json.dumps({'method':'Every CCITTFaxDecode image in documents that reported that encoding as unsupported before this change. Extracted PNG RGB bytes compared exactly against MuPDF 1.28.2 rendering of the original image object; no resampling/tolerance. Extraction does not use MuPDF.','images':rows},indent=2)+'\n')
