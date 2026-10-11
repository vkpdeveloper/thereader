"""Recompute the same selected author-prose checks without changing 0.2 evidence.

Not a whole-document accuracy metric. Table relationships are scored separately
by table_structure.py. No reference content is passed to the Go extractor.
"""
import collections,hashlib,json,re
from pathlib import Path
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
from markdown_it import MarkdownIt
from bs4 import BeautifulSoup
from real_world import ROOT,LOCAL,CORPUS,canonical,go_result,reference_html,exact_counts,validate

DEST=ROOT/'eval/pdf/coverage-v03';PRED=ROOT/'test-corpus/pdf/coverage-v03'

def markdown_content(raw):
    # Parse actual Markdown. A broad <...> regex can swallow paragraphs between
    # mathematical less-than and greater-than signs and unfairly lower scores.
    soup=BeautifulSoup(MarkdownIt('commonmark',{'html':True}).enable('table').render(raw),'html.parser')
    for node in soup.select('img,script,style'):node.decompose()
    return {'text':soup.get_text(' ',strip=True),'headings':[h.get_text(' ',strip=True) for h in soup.select('h1,h2,h3,h4,h5,h6')]}

def paper(result,paragraphs,headings):
    actual=canonical(result['text']);samples=[]
    for id,expected in paragraphs:
        if expected in actual:similarity=1.0
        else:
            match=fuzz.partial_ratio_alignment(expected,actual)
            observed=actual[match.dest_start:match.dest_end] if match else ''
            similarity=max(0,1-Levenshtein.distance(expected,observed)/max(len(expected),len(observed),1))
        samples.append({'id':id,'characters':len(expected),'agreement':similarity})
    actual_heads=[canonical(re.sub(r'^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.?\s+','',h)) for h in result['headings']]
    return {'paragraphs':len(samples),'proseCharacters':sum(s['characters'] for s in samples),
            'weightedCharacterAgreement':sum(s['characters']*s['agreement'] for s in samples)/sum(s['characters'] for s in samples),
            'paragraphsAt99Percent':sum(s['agreement']>=.99 for s in samples),
            'paragraphsExact':sum(s['agreement']==1 for s in samples),
            'fragment32':{'matched':sum(expected[j:j+32] in actual for _,expected in paragraphs for j in range(0,len(expected)-31,32)),
                          'total':sum(len(expected)//32 for _,expected in paragraphs)},
            'headings':exact_counts(headings,actual_heads),'paragraphScores':samples}

def main():
    validate();paragraphs,headings,_=reference_html();scores={};coverage={}
    paths={'0.2':LOCAL/'after/harness.json','0.3':PRED/'harness.json'}
    for engine in ['pymupdf','pdftotext','pypdf','pdfplumber','pymupdf4llm','docling','marker']:
        paths[engine]=PRED/'bench'/engine/('harness.md' if engine in ('docling','marker') else 'harness.json')
    paths['pymupdf4llm']=PRED/'pymupdf4llm-raw.md'
    for engine,path in paths.items():
        if engine in ('docling','marker','pymupdf4llm'):result=markdown_content(path.read_text())
        else:
            d=json.loads(path.read_text());result=go_result(d) if engine.startswith('0.') else d
        scores[engine]=paper(result,paragraphs,headings)
        scores[engine]['outputSHA256']=hashlib.sha256(path.read_bytes()).hexdigest()
    for r in CORPUS:
        coverage[r['id']]={}
        for version,path in [('0.2',LOCAL/'after'/(r['id']+'.json')),('0.3',PRED/(r['id']+'.json'))]:
            d=json.loads(path.read_text());blocks=[b for p in d['pages'] for b in p['blocks']];result=go_result(d)
            coverage[r['id']][version]={'pages':len(d['pages']),'complete':d['complete'],
                'blockCharacters':len(result['text']),'replacementCharacters':result['text'].count('\ufffd'),
                'blockCounts':dict(collections.Counter(b['kind'] for b in blocks)),
                'warningCounts':dict(collections.Counter(w['code'] for w in d['warnings']))}
    report={'paperHtmlSHA256':hashlib.sha256((LOCAL/'harness.html').read_bytes()).hexdigest(),
            'method':'Same 73 author HTML body/prompt paragraphs >=100 normalized alphanumeric characters as v0.2. Best contiguous window edit-distance agreement; omits punctuation, whitespace, short paragraphs, tables, figures and author metadata. Not whole-document accuracy. Heading labels scored separately. Classic text-only engines do not expose headings in this configuration.',
            'paper':scores,'coverage':coverage}
    (DEST/'quality.json').write_text(json.dumps(report,indent=2)+'\n')
    for engine,s in scores.items():print(engine,s['weightedCharacterAgreement'],s['headings']['f1'])

if __name__=='__main__':main()
