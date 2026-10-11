"""Reproducible PDF conversion benchmark. Run engines sequentially, never race them.

Quality is measured only against the independent generated source, not against
another extractor's output. Public PDFs measure throughput/coverage only.
"""
import argparse, collections, contextlib, hashlib, importlib.metadata, io, json, os
from pathlib import Path
import platform, re, statistics, subprocess, sys, time, unicodedata
from rapidfuzz.distance import Levenshtein

ROOT=Path(__file__).resolve().parents[3]
CORPUS=ROOT/'test-corpus/pdf'
RESULTS=ROOT/'eval/pdf/results'
ENGINES=['pdf-extractor','pymupdf','pymupdf4llm','pypdf','pdfminer','pdfplumber','markitdown','pdftotext']


def normal(s): return ' '.join(unicodedata.normalize('NFKC',s).split())

def inline_text(s):
    s=re.sub(r'\[([^\]]*)\]\([^\n)]*\)',r'\1',s)
    return s.replace('**','').replace('__','').replace('`','').strip()

def markdown_content(md):
    code=re.findall(r'^```[^\n]*\n(.*?)^```\s*$',md,re.M|re.S)
    headings=[inline_text(s) for s in re.findall(r'^#{1,6}\s+(.+?)\s*#*$',md,re.M)]
    rows=[]
    for line in md.splitlines():
        if line.strip().startswith('|') and line.strip().endswith('|'):
            cells=[s.strip() for s in line.strip()[1:-1].split('|')]
            if all(re.fullmatch(r'[:\- ]+',s) for s in cells):continue
            rows.extend(inline_text(c) for c in cells)
    image_count=len(re.findall(r'!\[[^\]]*\]\([^\n]*\)',md))
    text=re.sub(r'!\[[^\]]*\]\([^\n]*\)','',md)
    text=re.sub(r'\[([^\]]*)\]\([^\n)]*\)',r'\1',text)
    text=re.sub(r'<[^>]+>','',text)
    text=re.sub(r'^```[^\n]*$', '',text,flags=re.M)
    text=re.sub(r'^\s*\|(?:\s*:?-+:?\s*\|)+\s*$','',text,flags=re.M)
    text=re.sub(r'^#{1,6}\s*','',text,flags=re.M)
    text=re.sub(r'\\([`*_\[\]|])',r'\1',text)
    text=text.replace('**','').replace('`','').replace('|',' ')
    return {'text':text,'headings':headings,'cells':rows,'codes':code,'images':image_count}


def counter_f1(expected,actual):
    a,b=collections.Counter(map(normal,expected)),collections.Counter(map(normal,actual))
    if not a and not b:return None
    match=sum((a&b).values());return 2*match/(sum(a.values())+sum(b.values())) if a or b else 1


def quality(record,result):
    if record['kind']!='generated':return None
    a,b=normal(record['text']),normal(result['text'])
    score={'characterAccuracy':max(0,1-Levenshtein.distance(a,b)/max(1,len(a),len(b))),
           'tokenF1':counter_f1(a.split(),b.split()),'headingF1':counter_f1(record['headings'],result['headings'])}
    if record['tables']:
        score['tableCellF1']=counter_f1([c for table in record['tables'] for row in table for c in row],result['cells'])
    if record['codes']:
        # Exact indentation and line breaks matter for code; only trailing spaces differ.
        canonical=lambda s:'\n'.join(x.rstrip() for x in s.strip().splitlines())
        a,b=collections.Counter(map(canonical,record['codes'])),collections.Counter(map(canonical,result['codes']))
        score['codeBlockF1']=2*sum((a&b).values())/(sum(a.values())+sum(b.values()))
    if record['images']:
        a,b=record['images'],result['images'];score['imageCountF1']=2*min(a,b)/(a+b) if a+b else 0
    return score


def load_engine(engine):
    if engine.startswith('pymupdf'):
        import pymupdf
        if engine=='pymupdf4llm':
            import pymupdf4llm
            def convert(data):
                with pymupdf.open(stream=data,filetype='pdf') as doc:
                    md=pymupdf4llm.to_markdown(doc,use_ocr=False,embed_images=True,header=False,footer=False,show_progress=False)
                return markdown_content(md)
            return convert,importlib.metadata.version('pymupdf4llm'),'Markdown with layout model; OCR off; images embedded; header/footer cleanup on'
        def convert(data):
            with pymupdf.open(stream=data,filetype='pdf') as doc:text='\n'.join(p.get_text(sort=True) for p in doc)
            return {'text':text,'headings':[],'cells':[],'codes':[],'images':0}
        return convert,importlib.metadata.version('pymupdf'),'text only, sort=True'
    if engine=='pypdf':
        from pypdf import PdfReader
        convert=lambda data:{'text':'\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(data)).pages),'headings':[],'cells':[],'codes':[],'images':0}
        return convert,importlib.metadata.version('pypdf'),'text only, default extraction'
    if engine=='pdfminer':
        from pdfminer.high_level import extract_text
        convert=lambda data:{'text':extract_text(io.BytesIO(data)),'headings':[],'cells':[],'codes':[],'images':0}
        return convert,importlib.metadata.version('pdfminer.six'),'text only, default layout analysis'
    if engine=='pdfplumber':
        import pdfplumber
        def convert(data):
            with pdfplumber.open(io.BytesIO(data)) as doc:
                text=[];cells=[]
                for page in doc.pages:
                    text.append(page.extract_text() or '')
                    for table in page.extract_tables():cells.extend(c or '' for row in table for c in row)
                return {'text':'\n'.join(text),'headings':[],'cells':cells,'codes':[],'images':0}
        return convert,importlib.metadata.version('pdfplumber'),'text plus default extract_tables; no Markdown/image export'
    if engine=='markitdown':
        from markitdown import MarkItDown
        converter=MarkItDown(enable_plugins=False)
        convert=lambda data:markdown_content(converter.convert_stream(io.BytesIO(data),file_extension='.pdf').text_content)
        return convert,importlib.metadata.version('markitdown'),'default PDF Markdown conversion; no LLM/OCR'
    if engine=='pdftotext':
        def convert(data):
            p=subprocess.run(['pdftotext','-','-'],input=data,capture_output=True,check=True)
            return {'text':p.stdout.decode('utf-8'),'headings':[],'cells':[],'codes':[],'images':0}
        v=subprocess.run(['pdftotext','-v'],capture_output=True,text=True).stderr.splitlines()[0]
        return convert,v,'text only; CLI startup included (no in-process API)'


def worker(args):
    manifest=json.loads((CORPUS/'manifest.json').read_text())
    if args.ids:manifest=[r for r in manifest if r['id'] in args.ids.split(',')]
    # Imports, model loading and initialization are outside the warm-call timer.
    with contextlib.redirect_stdout(sys.stderr):convert,version,scope=load_engine(args.worker)
    for record in manifest:
        data=(ROOT/record['file']).read_bytes();times=[]
        try:
            for n in range(args.repeats+1):
                with contextlib.redirect_stdout(sys.stderr):
                    start=time.perf_counter();result=convert(data);elapsed=(time.perf_counter()-start)*1000
                if n:times.append(elapsed)
            row={'engine':args.worker,'version':version,'scope':scope,'id':record['id'],'pages':record['pages'],'kind':record['kind'],'samplesMs':times,'medianMs':statistics.median(times),'msPerPage':statistics.median(times)/record['pages'],'quality':quality(record,result),'characters':len(result['text']),'outputSha256':hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()}
            (CORPUS/f"{args.worker}-{record['id']}.json").write_text(json.dumps(result,ensure_ascii=False))
        except Exception as e:row={'engine':args.worker,'id':record['id'],'pages':record['pages'],'error':f'{type(e).__name__}: {e}'}
        print(json.dumps(row),flush=True)


def ours(args,manifest):
    rows=[]
    for record in manifest:
        output=CORPUS/f"pdf-extractor-{record['id']}.json"
        command=[args.binary,'-format','json','-repeat',str(args.repeats+1),'-out',str(output),str(ROOT/record['file'])]
        proc=subprocess.run(command,capture_output=True,text=True,timeout=120)
        if proc.returncode:
            rows.append({'engine':'pdf-extractor','id':record['id'],'pages':record['pages'],'error':proc.stderr});continue
        d=json.loads(output.read_text());timing=json.loads(proc.stderr.strip().splitlines()[-1]);blocks=[b for p in d['pages'] for b in p['blocks']]
        result={'text':'\n'.join(b.get('text','') if b['kind']!='table' else '\n'.join(' '.join(row) for row in b['rows']) for b in blocks), 'headings':[b['text'] for b in blocks if b['kind']=='heading'],'cells':[c for b in blocks if b['kind']=='table' for row in b['rows'] for c in row],'codes':[b['text'] for b in blocks if b['kind']=='code'],'images':sum(b['kind']=='image' for b in blocks)}
        times=timing['samplesMs'][1:]
        rows.append({'engine':'pdf-extractor','version':d['version'],'scope':timing['scope'],'id':record['id'],'pages':record['pages'],'kind':record['kind'],'samplesMs':times,'medianMs':statistics.median(times),'msPerPage':statistics.median(times)/record['pages'],'quality':quality(record,result),'characters':len(result['text']),'warnings':d['warnings'],'complete':d['complete'],'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest()})
        print(f"pdf-extractor {record['id']}: {rows[-1]['msPerPage']:.3f} ms/page",flush=True)
    return rows


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--worker');parser.add_argument('--repeats',type=int,default=5);parser.add_argument('--engines',default=','.join(ENGINES));parser.add_argument('--ids',default='');parser.add_argument('--binary',default='/tmp/thereader-pdf');args=parser.parse_args()
    if args.worker:return worker(args)
    RESULTS.mkdir(exist_ok=True);corpus=json.loads((CORPUS/'manifest.json').read_text());manifest=corpus
    if args.ids:manifest=[r for r in manifest if r['id'] in args.ids.split(',')]
    for engine in args.engines.split(','):
        if engine=='pdf-extractor':rows=ours(args,manifest)
        else:
            path=CORPUS/f'{engine}.jsonl';log=CORPUS/f'{engine}.log'
            command=[sys.executable,__file__,'--worker',engine,'--repeats',str(args.repeats),'--ids',args.ids]
            print('Running '+engine,flush=True)
            with path.open('w') as out,log.open('w') as err:
                try:subprocess.run(command,stdout=out,stderr=err,timeout=2400,check=True)
                except Exception as e:print(f'{engine}: {e}',flush=True)
            rows=[json.loads(line) for line in path.read_text().splitlines()]
        print(f'{engine}: {len(rows)}/{len(manifest)} documents recorded',flush=True)
        destination=RESULTS/f'{engine}.json'
        if args.ids and destination.exists():
            updated={r['id']:r for r in json.loads(destination.read_text())}
            updated.update({r['id']:r for r in rows})
            rows=[updated[r['id']] for r in corpus if r['id'] in updated]
        destination.write_text(json.dumps(rows,indent=2))
    metadata={'timestamp':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'platform':platform.platform(),'machine':platform.machine(),'processor':subprocess.run(['sysctl','-n','machdep.cpu.brand_string'],capture_output=True,text=True).stdout.strip() if sys.platform=='darwin' else platform.processor(),'python':sys.version,'go':subprocess.run(['go','version'],capture_output=True,text=True).stdout.strip(),'repeats':args.repeats,'warmups':1,'qualityScope':'Original generated documents only; public PDF quality is unscored. No OCR. Not an OmniDocBench evaluation or a market-wide rank.','corpus':[{k:v for k,v in r.items() if k not in ('text','headings','tables','codes')} for r in manifest]}
    metadata['corpus']=[{k:v for k,v in r.items() if k not in ('text','headings','tables','codes')} for r in corpus]
    metadata['lastRunEngines']=args.engines.split(',');metadata['lastRunIds']=[r['id'] for r in manifest]
    source=hashlib.sha256()
    for path in sorted((ROOT/'packages/pdf_go').rglob('*.go')):
        if not path.name.endswith('_test.go'):source.update(str(path.relative_to(ROOT)).encode()+b'\0'+path.read_bytes())
    source.update((ROOT/'packages/pdf_go/go.mod').read_bytes())
    metadata['extractorSourceSha256']=source.hexdigest()
    if Path(args.binary).exists():metadata['extractorBinarySha256']=hashlib.sha256(Path(args.binary).read_bytes()).hexdigest()
    (RESULTS/'environment.json').write_text(json.dumps(metadata,indent=2))

if __name__=='__main__':main()
