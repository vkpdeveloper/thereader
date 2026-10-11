"""Aggregate recorded measurements. Never turn a local rank into a market rank."""
import collections,hashlib,json,platform,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];DEST=ROOT/'eval/pdf/coverage-v03'
def read(name):return json.loads((DEST/(name+'.json')).read_text())

def main():
    engines=['pdf-extractor','pymupdf','pdftotext','pypdf','pdfplumber','pymupdf4llm','docling','marker']
    timings={e:read('timing-'+e) for e in engines};bulk=[];paper=[]
    for engine,d in timings.items():
        rows=d['rows'];r=next(r for r in rows if r['id']=='harness')
        paper.append({'engine':engine,'version':r['version'],'msPerPage':r['msPerPage'],'scope':r['scope']})
        if engine not in ('docling','marker'):
            assert {r['id'] for r in rows}=={'harness','axler','hefferon','thinkpython','calculus'}
            bulk.append({'engine':engine,'version':r['version'],'msPerPage':sum(x['medianMs'] for x in rows)/sum(x['pages'] for x in rows),'pages':sum(x['pages'] for x in rows),'scope':r['scope']})
    for rows in (bulk,paper):
        rows.sort(key=lambda r:r['msPerPage'])
        for i,r in enumerate(rows,1):r['rank']=i
    tables=[]
    for engine,key in [('pdf-extractor','after'),('docling','docling'),('marker','marker'),('pymupdf-tables','pymupdf-tables'),('pymupdf-text-tables','pymupdf-text-tables'),('pymupdf4llm','pymupdf4llm'),('pdfplumber','pdfplumber'),('pdfplumber-text','pdfplumber-text')]:
        d=read('tables-'+key)
        tables.append({'engine':engine,'predictedTables':d['predictedTables'],'exactTables':d['exactNonemptyCellTables'],'cellTextF1':d['cellText']['f1'],'cellPositionAndSpanF1':d['cellPositionAndSpan']['f1']})
    tables.sort(key=lambda r:r['cellPositionAndSpanF1'],reverse=True)
    for i,r in enumerate(tables,1):r['rank']=i
    prose=[{'engine':'pdf-extractor' if e=='0.3' else e,'weightedCharacterAgreement':r['weightedCharacterAgreement']} for e,r in read('quality')['paper'].items() if e!='0.2']
    prose.sort(key=lambda r:r['weightedCharacterAgreement'],reverse=True)
    for i,r in enumerate(prose,1):r['rank']=i
    independent={}
    for version,key in [('0.2','before'),('0.3','release')]:
        d=read('olmocr-'+key+'-scores');docs=read('olmocr-'+key+'-extraction')['documents']
        independent[version]={k:v for k,v in d.items() if k!='results'}
        independent[version].update(errors=sum('error' in r for r in docs),needsOCR=sum(r.get('needsOCR',False) for r in docs),warnings=dict(collections.Counter(w['code'] for r in docs for w in r.get('warnings',[]))))
    files=sorted(p for p in (ROOT/'packages/pdf_go').rglob('*') if p.is_file() and (p.suffix=='.go' and not p.name.endswith('_test.go') or p.name=='go.mod' or 'data' in p.parts))
    digest=hashlib.sha256();sources=[]
    for p in files:
        name=p.relative_to(ROOT).as_posix();data=p.read_bytes();digest.update(name.encode()+b'\0'+data);sources.append({'path':name,'sha256':hashlib.sha256(data).hexdigest()})
    summary={'version':'0.3.0','platform':platform.platform(),'cpu':timings['pdf-extractor']['cpu'],
        'go':subprocess.check_output(['go','version'],text=True).strip(),'sourceSHA256':digest.hexdigest(),'sources':sources,
        'binarySHA256':timings['pdf-extractor']['binarySHA256'],'bulkTiming':bulk,'paperTiming':paper,'paperTables':tables,'paperProse':prose,
        'independent':independent,'mathVisual':{k:v for k,v in read('math-visual').items() if k!='regions'},
        'scope':'Shared development host, sequential warm calls, one warmup and three measured runs. Conversion scopes differ; no market-wide speed or accuracy rank. Paper is a development example. Independent corpus has now also informed a regression fix, not a blind holdout.'}
    (DEST/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps({k:v for k,v in summary.items() if k in ('bulkTiming','paperTiming','paperTables')},indent=2))

if __name__=='__main__':main()
