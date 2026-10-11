"""Fetch the pinned, independently authored olmOCR-bench corpus for evaluation.
PDFs and test text stay ignored. Verify object hashes before accepting bytes.
"""
import concurrent.futures, hashlib, json, time
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[3]
REV='54a96a6fb6a2bd3b297e59869491db4d3625b711'
BASE=f'https://huggingface.co/datasets/allenai/olmOCR-bench/resolve/{REV}/'
DEST=ROOT/'test-corpus/pdf/olmocr'
MANIFEST=ROOT/'eval/pdf/coverage-v03/olmocr-corpus.json'

def main():
    if MANIFEST.exists(): records=json.loads(MANIFEST.read_text())['files']
    else:
        url=f'https://huggingface.co/api/datasets/allenai/olmOCR-bench/tree/{REV}/bench_data?recursive=true&limit=1000'
        records=[]
        while url:
            r=requests.get(url,timeout=60);r.raise_for_status()
            records += [x for x in r.json() if x['type']=='file' and x['path'].endswith(('.pdf','.jsonl'))]
            url=r.links.get('next',{}).get('url')
        MANIFEST.write_text(json.dumps({'dataset':'allenai/olmOCR-bench','revision':REV,'license':'ODC-By','source':'https://huggingface.co/datasets/allenai/olmOCR-bench','files':records},indent=2)+'\n')
    def valid(data,r):
        if len(data)!=r['size']: return False
        if r.get('lfs'): return hashlib.sha256(data).hexdigest()==r['lfs']['oid']
        return hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==r['oid']
    def one(r):
        p=DEST/Path(r['path']).relative_to('bench_data')
        if p.exists() and valid(p.read_bytes(),r):return p
        for attempt in range(4):
            try:
                res=requests.get(BASE+r['path'],timeout=(20,90));res.raise_for_status();data=res.content
                if not valid(data,r):raise ValueError('object hash mismatch: '+r['path'])
                p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return p
            except Exception:
                if attempt==3:raise
                time.sleep(1+attempt)
    print(f'Fetching {len(records)} objects, {sum(x["size"] for x in records):,} bytes',flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for n,_ in enumerate(pool.map(one,records),1):
            if n%50==0:print(n,flush=True)
    print('Verified all corpus hashes',flush=True)
if __name__=='__main__':main()
