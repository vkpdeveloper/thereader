"""Validate matched inputs and derive ranks from the checked-in measurements."""
import json, statistics
from pathlib import Path
from bench import ENGINES, RESULTS

def summarize():
    environment=json.loads((RESULTS/'environment.json').read_text())
    corpus=environment['corpus'];ids={r['id'] for r in corpus}
    engines=[]
    for engine in ENGINES:
        rows=json.loads((RESULTS/f'{engine}.json').read_text())
        assert {r['id'] for r in rows}==ids, f'{engine}: mismatched corpus'
        assert all('error' not in r and len(r['samplesMs'])==5 for r in rows), f'{engine}: incomplete run'
        digital=[r for r in rows if r['id']!='scanned']
        quality=[r['quality'] for r in rows if r.get('quality')]
        rate=sum(r['medianMs'] for r in digital)/sum(r['pages'] for r in digital)
        scores={key:statistics.mean(q[key] for q in quality if q.get(key) is not None)
                for key in ['characterAccuracy','tokenF1','headingF1','tableCellF1','codeBlockF1','imageCountF1']}
        engines.append({'engine':engine,'version':rows[0]['version'],'scope':rows[0]['scope'],
                        'weightedMsPerPage':rate,'pagesPerSecond':1000/rate,'qualityMacro':scores,
                        'alice':next(r for r in rows if r['id']=='alice-book')})
    engines.sort(key=lambda r:r['weightedMsPerPage'])
    for i,e in enumerate(engines):
        e['speedRank']=i+1
        e['characterRank']=1+sum(x['qualityMacro']['characterAccuracy']>e['qualityMacro']['characterAccuracy'] for x in engines)
    ours=next(e for e in engines if e['engine']=='pdf-extractor')
    for e in engines:e['durationDividedByOurs']=e['weightedMsPerPage']/ours['weightedMsPerPage']
    summary={'digitalDocuments':len(corpus)-1,'digitalPages':sum(r['pages'] for r in corpus if r['id']!='scanned'),
             'qualityDocuments':sum(r['kind']=='generated' for r in corpus),'qualityPages':sum(r['pages'] for r in corpus if r['kind']=='generated'),
             'scope':'This corpus only; controlled quality fixtures, no blind holdout; unequal output scopes and Poppler startup explicitly recorded.',
             'engines':engines}
    (RESULTS/'summary.json').write_text(json.dumps(summary,indent=2))
    return summary

if __name__=='__main__':
    for e in summarize()['engines']:
        print(f"{e['speedRank']}. {e['engine']}: {e['weightedMsPerPage']:.3f} ms/page, {e['qualityMacro']['characterAccuracy']:.2%} controlled character accuracy")
