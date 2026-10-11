"""Machine-readable results using the unmodified pinned olmOCR-bench evaluator.

Set PYTHONPATH to the verified upstream source checkout. Dataset and evaluator
versions are pinned in coverage-v03/README.md. No test is rewritten or dropped.
"""
import argparse,hashlib,json,random
from pathlib import Path
import numpy as np
from olmocr.bench.tests import load_tests,BaselineTest
from olmocr.bench.benchmark import evaluate_candidate
from olmocr.bench.utils import calculate_bootstrap_ci
ROOT=Path(__file__).resolve().parents[3]
LOCAL=ROOT/'test-corpus/pdf/olmocr'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('candidates',nargs='+');args=ap.parse_args()
    random.seed(0);np.random.seed(0)
    groups={};tests=[]
    for p in sorted(LOCAL.glob('*.jsonl')):
        new=load_tests(str(p));tests.extend(new);groups.update({t.id:p.stem for t in new})
    pdfs=sorted(p.relative_to(LOCAL/'pdfs').as_posix() for p in (LOCAL/'pdfs').rglob('*.pdf'))
    for pdf in pdfs:
        if not any(t.type=='baseline' for t in tests if t.pdf==pdf):
            t=BaselineTest(id=pdf+'_baseline',pdf=pdf,page=1,type='baseline');tests.append(t);groups[t.id]='baseline'
    for candidate in args.candidates:
        _,count,errors,failures,breakdown,scores,results=evaluate_candidate(str(LOCAL/candidate),tests,pdfs)
        if errors:raise RuntimeError(errors[:10])
        categories={};rows=[]
        for pdf,pages in sorted(results.items()):
            for page,items in sorted(pages.items()):
                for t,passed,explanation in sorted(items,key=lambda r:r[0].id):
                    group=groups[t.id];c=categories.setdefault(group,{'passed':0,'total':0});c['total']+=1;c['passed']+=int(passed)
                    rows.append({'pdf':pdf,'page':page,'id':t.id,'type':t.type,'category':group,'passed':passed,'explanationSHA256':hashlib.sha256(explanation.encode()).hexdigest() if not passed else None})
        for c in categories.values():c['passRate']=c['passed']/c['total']
        ordered=sorted(categories);flat=[float(r['passed']) for c in ordered for r in rows if r['category']==c]
        ci=calculate_bootstrap_ci(flat,n_bootstrap=1000,ci_level=.95,splits=[categories[c]['total'] for c in ordered])
        tests_path=ROOT/f'eval/pdf/coverage-v03/olmocr-{candidate}-tests.jsonl'
        tests_path.write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in rows))
        report={'candidate':candidate,'datasetRevision':'54a96a6fb6a2bd3b297e59869491db4d3625b711','evaluatorRevision':'f7cfe4c22098b154c76b6ec950d1c0a464eecf8d','pdfs':len(pdfs),'tests':count,'overallMacroPassRate':sum(c['passRate'] for c in categories.values())/len(categories),'bootstrap95CI':ci,'categories':categories,'testTypes':{k:{'passed':sum(v),'total':len(v),'passRate':sum(v)/len(v)} for k,v in breakdown.items()},'testResults':tests_path.name,'testResultsSHA256':hashlib.sha256(tests_path.read_bytes()).hexdigest()}
        path=ROOT/f'eval/pdf/coverage-v03/olmocr-{candidate}-scores.json';path.write_text(json.dumps(report,indent=2)+'\n');print(candidate,report['overallMacroPassRate'],categories,flush=True)
if __name__=='__main__':main()
