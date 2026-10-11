"""Run the standalone Go CLI over the pinned independent corpus.

No ground truth is read by the extractor. Four workers are for throughput;
the per-process times here are diagnostic and must not be used for rankings.
"""
import argparse, concurrent.futures, hashlib, json, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
LOCAL=ROOT/'test-corpus/pdf/olmocr'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--binary',required=True);ap.add_argument('--name',required=True);args=ap.parse_args()
    manifest=json.loads((ROOT/'eval/pdf/coverage-v03/olmocr-corpus.json').read_text())
    pdfs=[x for x in manifest['files'] if x['path'].endswith('.pdf')]
    destination=LOCAL/args.name;destination.mkdir(exist_ok=True)
    def one(r):
        source=LOCAL/Path(r['path']).relative_to('bench_data')
        target=destination/source.relative_to(LOCAL/'pdfs').with_suffix('');target=target.with_name(target.name+'_pg1_repeat1.md');target.parent.mkdir(parents=True,exist_ok=True)
        raw=source.read_bytes();sha=hashlib.sha256(raw).hexdigest()
        valid=len(raw)==r['size'] and (sha==r['lfs']['oid'] if r.get('lfs') else hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()==r['oid'])
        if not valid:raise ValueError('Pinned corpus hash mismatch: '+r['path'])
        summary={'pdf':source.relative_to(LOCAL/'pdfs').as_posix(),'sha256':sha}
        started=time.perf_counter()
        try:
            p=subprocess.run([args.binary,'-format','json',str(source)],capture_output=True,timeout=65)
            if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace')[:1000])
            d=json.loads(p.stdout);target.write_text(d['markdown'])
            summary.update(version=d['version'],complete=d['complete'],stats=d['stats'],warnings=d['warnings'],needsOCR=any(p.get('needsOCR') for p in d['pages']))
        except Exception as e:
            target.write_text('');summary['error']=str(e)
        summary['markdownSHA256']=hashlib.sha256(target.read_bytes()).hexdigest()
        summary['diagnosticWallSeconds']=time.perf_counter()-started
        return summary
    rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row in pool.map(one,pdfs):
            rows.append(row)
            if len(rows)%100==0:print(len(rows),'errors',sum('error' in x for x in rows),flush=True)
    (ROOT/f'eval/pdf/coverage-v03/olmocr-{args.name}-extraction.json').write_text(json.dumps({'datasetRevision':manifest['revision'],'extractorBinarySHA256':hashlib.sha256(Path(args.binary).read_bytes()).hexdigest(),'scope':'Four concurrent CLI processes; timings are diagnostic, not a speed benchmark. Original PDF bytes only. No ground truth used during extraction.','documents':rows},indent=2)+'\n')
    print('Done',len(rows),'errors',sum('error' in r for r in rows),flush=True)
if __name__=='__main__':main()
