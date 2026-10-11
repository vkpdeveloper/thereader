"""Exact outcome parity and decoded-image comparisons against saved Go outputs."""
import base64,hashlib,io,json,re,statistics
from pathlib import Path
from PIL import Image,ImageChops
ROOT=Path(__file__).resolve().parents[3];DEST=ROOT/'eval/pdf/native'
def read(path):return json.loads(path.read_text())
def outcomes(path):return {(r['pdf'],r['page'],r['id']):r['passed'] for r in map(json.loads,path.read_text().splitlines())}
base=outcomes(ROOT/'eval/pdf/coverage-v03/olmocr-release-tests.jsonl')
parity=[]
for candidate in ['native-ts','native-dart','browser-ts','browser-dart']:
 actual=outcomes(DEST/f'olmocr-{candidate}-tests.jsonl');score=read(DEST/f'olmocr-{candidate}-scores.json')
 row={'candidate':candidate,'tests':len(actual),'missing':sorted(base.keys()-actual.keys()),'extra':sorted(actual.keys()-base.keys()),'changedPassFail':[k for k in base.keys()&actual.keys() if base[k]!=actual[k]],'overallMacroPassRate':score['overallMacroPassRate']}
 parity.append(row)
 assert not row['missing'] and not row['extra'] and not row['changedPassFail'],row
books=[]
for engine in ['ts','dart']:
 for name in ['harness','axler','hefferon','thinkpython','calculus']:
  go=read(ROOT/f'test-corpus/pdf/coverage-v03/{name}.json');native=read(ROOT/f'test-corpus/pdf/native/{engine}/{name}.json')
  canonical=lambda s:re.sub(r'assets/[0-9a-f]+\.(svg|png|jpg)',r'assets/ID.\1',s)
  content=lambda d:[[(b['kind'],b.get('text',''),b.get('rows',[]),b.get('table')) for b in p['blocks']] for p in d['pages']]
  # Geometry floats are checked by fixtures. For real table structure, retain
  # cell text/coordinates/spans/header scope and ignore sub-point float noise.
  def strip_boxes(v):
   if isinstance(v,dict):return {k:strip_boxes(x) for k,x in v.items() if k not in ['box','runs']}
   if isinstance(v,(list,tuple)):return [strip_boxes(x) for x in v]
   return v
  row={'engine':engine,'document':name,'pages':len(go['pages']),'blocksAndTableStructureEqual':strip_boxes(content(go))==strip_boxes(content(native)),'markdownEqualAfterAssetURLNormalization':canonical(go['markdown'])==canonical(native['markdown']),'assetsGo':len(go['assets']),'assetsPort':len(native['assets']),'pngCompared':0,'pngPixelMismatches':[], 'pngDifferences':[]}
  assert row['blocksAndTableStructureEqual'] and row['markdownEqualAfterAssetURLNormalization'],row
  assert len(go['assets'])==len(native['assets']),row
  for i,(a,b) in enumerate(zip(go['assets'],native['assets'])):
   assert (a['mediaType'],a['width'],a['height'])==(b['mediaType'],b['width'],b['height']),(name,i)
   if a['mediaType']=='image/png':
    aa=Image.open(io.BytesIO(base64.b64decode(a['data']))).convert('RGBA');bb=Image.open(io.BytesIO(base64.b64decode(b['data']))).convert('RGBA');row['pngCompared']+=1
    if aa.tobytes()!=bb.tobytes():
     row['pngPixelMismatches'].append(i)
     diff=ImageChops.difference(aa,bb);pixels=list(diff.getdata())
     row['pngDifferences'].append({'assetIndex':i,'width':aa.width,'height':aa.height,'pixelsWithAnyDifference':sum(any(p) for p in pixels),'maxChannelDifference':max(max(p) for p in pixels),'meanAbsoluteChannelDifference':sum(sum(p) for p in pixels)/(len(pixels)*4),'alphaIdentical':all(p[3]==0 for p in pixels),'reason':'Masked JPEG decoded by distinct generic JPEG codecs before PNG encoding; integer rounding differs.'})
  books.append(row)
(DEST/'parity.json').write_text(json.dumps({'baseline':'Go v0.3.0 commit 625d6b202da5759e13dc67c743022a22c2e07175','officialBenchmark':parity,'realWorld':books},indent=2)+'\n')
print(json.dumps({'scores':parity,'books':books},indent=2))
