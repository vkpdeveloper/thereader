"""Author-HTML table gold: visible cell text and exact (row, col, rowspan, colspan).

This check is deliberately stricter than a bag of cell strings. Hidden LaTeXML
phantom padding is removed. Old and new predictions use the same corrected gold.
It is a scoped regression metric, not an OmniDocBench score or market ranking.
"""
import argparse, collections, hashlib, json, re, unicodedata
from pathlib import Path
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parents[3]
PAGES=[4,5,7,8,11,13,14,28,29,30,39,40,40]

def normalized(s):
    # Keep signs, decimal points, units and punctuation. Ignore typography and
    # whitespace only; unlike the old alphanumeric metric, 1.2 != 12.
    return ''.join(unicodedata.normalize('NFKC',s).split()).replace('\u00ad','').replace('−','-')

def html_cells(table):
    occupied=set();cells=[];width=0
    rows=table.find_all('tr',recursive=False)
    if not rows: rows=table.select('tr')
    for r,tr in enumerate(rows):
        col=0
        for td in tr.find_all(['td','th'],recursive=False):
            while (r,col) in occupied: col+=1
            rs,cs=int(td.get('rowspan',1)),int(td.get('colspan',1))
            cells.append({'row':r,'column':col,'rowSpan':rs,'colSpan':cs,'text':td.get_text(' ',strip=True)})
            for y in range(r,r+rs):
                for x in range(col,col+cs): occupied.add((y,x))
            col+=cs;width=max(width,col)
    return {'rows':len(rows),'columns':width,'cells':cells}

def gold():
    raw=(ROOT/'test-corpus/pdf/real-world/harness.html').read_bytes()
    expected=json.loads((ROOT/'eval/pdf/real-world/corpus.json').read_text())[0]['referenceHtmlSha256']
    if hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('Author HTML hash mismatch')
    soup=BeautifulSoup(raw,'html.parser')
    hidden=0
    for node in list(soup.select('.ltx_phantom,[style]')):
        if node.parent is None: continue
        if 'ltx_phantom' in node.get('class',[]) or re.search(r'(?:visibility\s*:\s*hidden|display\s*:\s*none)',node.get('style','')):
            hidden+=1;node.decompose()
    # MathML annotations contain a second TeX encoding, not visible text.
    for node in soup.select('annotation,annotation-xml'): node.decompose()
    tables=[]
    for n,f in enumerate(soup.select('figure.ltx_table')):
        tables.append({'id':f['id'],'page':PAGES[n],**html_cells(f.select_one('table'))})
    return tables,hidden,hashlib.sha256(raw).hexdigest()

def counter(t,structure=False):
    return collections.Counter(((c['row'],c['column'],c['rowSpan'],c['colSpan'],normalized(c['text'])) if structure else normalized(c['text'])) for c in t['cells'] if normalized(c['text']))

def score(g,p):
    n=sum(g.values());m=sum(p.values());match=sum((g&p).values())
    return {'matched':match,'reference':n,'predicted':m,'precision':match/m if m else 0,'recall':match/n if n else 0,'f1':2*match/(n+m) if n+m else 1}

def normalized_prediction(doc):
    """Read native JSON formats without repairing or stitching predictions."""
    if doc.get('schema_name')=='DoclingDocument':
        pages={}
        for b in doc['tables']:
            v=b['data'];table={'rows':v['num_rows'],'columns':v['num_cols'],'cells':[{'row':c['start_row_offset_idx'],'column':c['start_col_offset_idx'],'rowSpan':c['row_span'],'colSpan':c['col_span'],'text':c['text']} for c in v['table_cells']]}
            pages.setdefault(b['prov'][0]['page_no'],[]).append({'kind':'table','box':{},'table':table})
        return {'version':'docling-standard-cpu-no-ocr','pages':[{'number':p,'blocks':b} for p,b in pages.items()]}
    if 'children' in doc and 'pages' not in doc:
        pages={}
        def walk(b,p):
            if b.get('block_type')=='Table':
                table=BeautifulSoup(b.get('html',''),'html.parser').select_one('table')
                if table:pages.setdefault(p,[]).append({'kind':'table','box':{},'table':html_cells(table)})
            for c in b.get('children') or []:walk(c,p)
        for p,b in enumerate(doc['children'],1):walk(b,p)
        return {'version':'marker-fast-no-ocr','pages':[{'number':p,'blocks':b} for p,b in pages.items()]}
    return doc

def evaluate(path):
    doc=normalized_prediction(json.loads(path.read_text()));ref,hidden,sha=gold()
    pred=[]
    for page in doc['pages']:
        for b in page['blocks']:
            if b['kind']!='table':continue
            table=b.get('table') or {'rows':len(b['rows']),'columns':max(map(len,b['rows'])),'cells':[{'row':r,'column':c,'rowSpan':1,'colSpan':1,'text':s} for r,row in enumerate(b['rows']) for c,s in enumerate(row)]}
            pred.append({'page':page['number'],'box':b['box'],**table})
    # Match each ground-truth table to at most one predicted table on its page.
    # A fragmented table therefore loses structural recall rather than getting
    # artificially stitched using the reference before scoring.
    candidates=[]
    for i,g in enumerate(ref):
        for j,p in enumerate(pred):
            if p['page']==g['page']: candidates.append((score(counter(g),counter(p))['f1'],i,j))
    assigned={};used=set()
    for sim,i,j in sorted(candidates,reverse=True):
        if i not in assigned and j not in used:assigned[i]=j;used.add(j)
    rows=[];totals=[collections.Counter(),collections.Counter(),collections.Counter(),collections.Counter()]
    for i,g in enumerate(ref):
        p=pred[assigned[i]] if i in assigned else {'rows':0,'columns':0,'cells':[]}
        a,b,c,d=counter(g),counter(p),counter(g,True),counter(p,True)
        for k,v in enumerate((a,b,c,d)):totals[k].update({(i,key):value for key,value in v.items()})
        rows.append({'id':g['id'],'page':g['page'],'referenceGrid':[g['rows'],g['columns']],'predictedGrid':[p['rows'],p['columns']],'cellText':score(a,b),'cellPositionAndSpan':score(c,d),'missingText':list((a-b).elements()),'unexpectedText':list((b-a).elements()),'wrongOrMissingCells':list((c-d).elements())})
    # Unmatched false tables count against precision.
    for j,p in enumerate(pred):
        if j not in used:
            totals[1].update({('extra',j,key):v for key,v in counter(p).items()});totals[3].update({('extra',j,key):v for key,v in counter(p,True).items()})
    return {'version':doc['version'],'htmlSHA256':sha,'hiddenNodesRemoved':hidden,'referenceTables':len(ref),'predictedTables':len(pred),'matchedTables':len(assigned),'exactNonemptyCellTables':sum(r['cellPositionAndSpan']['f1']==1 for r in rows),'cellText':score(totals[0],totals[1]),'cellPositionAndSpan':score(totals[2],totals[3]),'tables':rows}

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('prediction',type=Path);ap.add_argument('--out',type=Path);args=ap.parse_args();result=evaluate(args.prediction)
    if args.out:args.out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='tables'},indent=2))
    for t in result['tables']:
        print(t['id'],t['referenceGrid'],t['predictedGrid'],round(t['cellPositionAndSpan']['f1'],5), 'missing',t['missingText'][:12], 'extra',t['unexpectedText'][:12])
