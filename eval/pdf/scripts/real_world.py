"""Real PDFs: sequential warm-call timings and reproducible, explicitly scoped checks.

No reference extraction code is used by the Go library. Outputs/PDFs stay ignored.
Run in the evaluation venv; see ../real-world/README.md for metric definitions.
"""
import argparse, collections, contextlib, hashlib, importlib.metadata, json, platform
from pathlib import Path
import re, statistics, subprocess, sys, time, unicodedata
from bs4 import BeautifulSoup
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
from bench import load_engine

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'eval/pdf/real-world'
LOCAL = ROOT / 'test-corpus/pdf/real-world'
CORPUS = json.loads((DEST / 'corpus.json').read_text())
ENGINES = ['pymupdf', 'pdftotext', 'pypdf', 'pdfplumber', 'pymupdf4llm']


def canonical(text):
    text = re.sub(r'(\w)-\s*\n\s*(\w)', r'\1\2', text)
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def block_text(b):
    return '\n'.join(' '.join(row) for row in b.get('rows', [])) if b['kind'] == 'table' else b.get('text', '')


def go_result(d):
    blocks = [b for p in d['pages'] for b in p['blocks']]
    return {'text': '\n'.join(block_text(b) for b in blocks),
            'headings': [b['text'] for b in blocks if b['kind'] == 'heading'],
            'cells': [c for b in blocks if b['kind'] == 'table' for row in b['rows'] for c in row],
            'codes': [b['text'] for b in blocks if b['kind'] == 'code'],
            'images': sum(b['kind'] == 'image' for b in blocks)}


def fetch():
    import concurrent.futures
    import requests
    LOCAL.mkdir(parents=True, exist_ok=True)
    for r in CORPUS:
        path = ROOT/r['file']
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==r['sha256']:
            continue
        if r['id']=='hefferon':
            # This public host throttles long responses; verified 128 KiB ranges.
            def part(start):
                end=min(r['bytes'],start+131072)-1
                response=requests.get(r['url'],headers={'Range':f'bytes={start}-{end}'},timeout=45)
                response.raise_for_status()
                if response.status_code!=206 or response.headers.get('Content-Range')!=f"bytes {start}-{end}/{r['bytes']}" or len(response.content)!=end-start+1:
                    raise ValueError('Invalid range response')
                return response.content
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                data=b''.join(pool.map(part,range(0,r['bytes'],131072)))
        else:
            response=requests.get(r['url'],timeout=90)
            response.raise_for_status()
            data=response.content
        if len(data)!=r['bytes'] or hashlib.sha256(data).hexdigest()!=r['sha256']:
            raise ValueError(f"Source changed: {r['id']}; do not compare different revisions silently")
        temp=path.with_suffix('.download')
        temp.write_bytes(data)
        temp.replace(path)
    html_path=LOCAL/'harness.html'
    if not html_path.exists():
        response=requests.get(CORPUS[0]['referenceHtmlUrl'],timeout=90)
        response.raise_for_status()
        html_path.write_bytes(response.content)


def validate():
    for r in CORPUS:
        data = (ROOT / r['file']).read_bytes()
        if len(data) != r['bytes'] or hashlib.sha256(data).hexdigest() != r['sha256']:
            raise ValueError(f"Corpus hash mismatch: {r['id']}")
    html = (LOCAL/'harness.html').read_bytes()
    if hashlib.sha256(html).hexdigest() != CORPUS[0]['referenceHtmlSha256']:
        raise ValueError('Author HTML hash mismatch; review changed reference before scoring')


def benchmark(engine, args):
    rows = []
    outdir = LOCAL / engine
    outdir.mkdir(exist_ok=True)
    ours = engine in ('before', 'after')
    if not ours:
        with contextlib.redirect_stdout(sys.stderr):
            convert, version, scope = load_engine(engine)
    for record in CORPUS:
        path = ROOT / record['file']
        output = outdir / (record['id'] + '.json')
        output.unlink(missing_ok=True)
        try:
            if ours:
                binary = args.before if engine == 'before' else args.after
                proc = subprocess.run([binary, '-format', 'json', '-repeat', str(args.repeats+1), '-out', str(output), str(path)], capture_output=True, text=True, check=True, timeout=300)
                doc = json.loads(output.read_text())
                timing = json.loads(proc.stderr.splitlines()[-1])
                times = timing['samplesMs'][1:]
                version, scope = doc['version'], timing['scope']
                result = go_result(doc)
            else:
                data = path.read_bytes()
                times = []
                for n in range(args.repeats+1):
                    with contextlib.redirect_stdout(sys.stderr):
                        started = time.perf_counter()
                        result = convert(data)
                        elapsed = (time.perf_counter()-started)*1000
                    if n:
                        times.append(elapsed)
                output.write_text(json.dumps(result, ensure_ascii=False))
            row = {'engine': engine, 'version': version, 'id': record['id'], 'pages': record['pages'], 'scope': scope,
                   'samplesMs': times, 'medianMs': statistics.median(times), 'msPerPage': statistics.median(times)/record['pages'],
                   'characters': len(result['text']), 'outputSha256': hashlib.sha256(output.read_bytes()).hexdigest()}
            if ours:
                row.update(stats=doc['stats'], complete=doc['complete'], warnings=dict(collections.Counter(w['code'] for w in doc['warnings'])),
                           unknownCharacters=result['text'].count('\ufffd'), assetBytes=sum(len(__import__('base64').b64decode(a['data'])) for a in doc['assets']),
                           blockCounts=dict(collections.Counter(b['kind'] for p in doc['pages'] for b in p['blocks'])))
        except Exception as error:
            output.unlink(missing_ok=True)
            (DEST/(engine+'.json')).unlink(missing_ok=True)
            raise RuntimeError(f"{engine}/{record['id']} failed; stale results removed") from error
        rows.append(row)
        (DEST / (engine + '.json')).write_text(json.dumps(rows, indent=2))
        print(engine, record['id'], row.get('msPerPage', row.get('error')), flush=True)
    return rows


def reference_html():
    source = LOCAL / 'harness.html'
    soup = BeautifulSoup(source.read_text(), 'html.parser')
    for e in soup.select('annotation,annotation-xml'):
        e.decompose()
    # Body prose and prompt paragraphs, excluding the malformed author metadata.
    paragraphs = [(p.get('id', f'p{j}'), canonical(p.get_text(' ', strip=True)))
                  for j, p in enumerate(soup.select('.ltx_p'))
                  if j > 0 and not p.find_parent(class_=['ltx_table', 'ltx_figure'])]
    paragraphs = [(i, s) for i, s in paragraphs if len(s) >= 100]
    headings = []
    for h in soup.select('.ltx_title_document,.ltx_title_section,.ltx_title_subsection,.ltx_title_subsubsection,.ltx_title_bibliography'):
        for tag in h.select('.ltx_tag'):
            tag.decompose()
        headings.append(canonical(h.get_text(' ', strip=True)))
    cells = [canonical(c.get_text(' ', strip=True)) for t in soup.select('.ltx_table table') for c in t.select('td,th')]
    return paragraphs, headings, [c for c in cells if c]


def exact_counts(expected, actual):
    a, b = collections.Counter(expected), collections.Counter(actual)
    shared = sum((a & b).values())
    return {'matched': shared, 'expected': sum(a.values()), 'actual': sum(b.values()),
            'recall': shared/max(1, sum(a.values())), 'precision': shared/max(1, sum(b.values())),
            'f1': 2*shared/max(1, sum(a.values())+sum(b.values()))}


def score():
    paragraphs, headings, cells = reference_html()
    scores = {}
    for engine in ['before', 'after'] + ENGINES:
        path = LOCAL / engine / 'harness.json'
        if not path.exists():
            continue
        d = json.loads(path.read_text())
        result = go_result(d) if engine in ('before', 'after') else d
        actual = canonical(result['text'])
        samples = []
        for id, expected in paragraphs:
            if expected in actual:
                similarity = 1.0
            else:
                match = fuzz.partial_ratio_alignment(expected, actual)
                observed = actual[match.dest_start:match.dest_end] if match else ''
                similarity = max(0, 1-Levenshtein.distance(expected, observed)/max(len(expected), len(observed), 1))
            samples.append({'id': id, 'characters': len(expected), 'agreement': similarity})
        # Strip printed section prefixes from PDF headings; HTML tags were removed above.
        actual_heads = [canonical(re.sub(r'^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.?\s+', '', h)) for h in result['headings']]
        scores[engine] = {'proseCharacters': sum(s['characters'] for s in samples), 'paragraphs': len(samples),
                          'weightedCharacterAgreement': sum(s['characters']*s['agreement'] for s in samples)/sum(s['characters'] for s in samples),
                          'paragraphsAt99Percent': sum(s['agreement'] >= .99 for s in samples),
                          'paragraphsExact': sum(s['agreement'] == 1 for s in samples),
                          'fragment32': {'matched': sum(expected[j:j+32] in actual for _,expected in paragraphs for j in range(0,len(expected)-31,32)), 'total': sum(len(expected)//32 for _,expected in paragraphs)},
                          'headings': exact_counts(headings, actual_heads), 'tableCells': exact_counts(cells, [canonical(c) for c in result['cells'] if canonical(c)]),
                          'paragraphScores': samples}
        print('HTML score', engine, scores[engine]['weightedCharacterAgreement'], flush=True)
    # Diagnostic only: unordered alphanumeric glyph agreement with another extractor.
    import pymupdf
    books = {}
    for record in CORPUS:
        with pymupdf.open(ROOT / record['file']) as doc:
            reference = [canonical(p.get_text()) for p in doc]
        books[record['id']] = {}
        for engine in ['before', 'after']:
            d = json.loads((LOCAL / engine / (record['id']+'.json')).read_text())
            a, b, common = 0, 0, 0
            for expected, page in zip(reference, d['pages'], strict=True):
                observed = canonical('\n'.join(block_text(x) for x in page['blocks']))
                ec, oc = collections.Counter(expected), collections.Counter(observed)
                a += len(expected); b += len(observed); common += sum((ec & oc).values())
            books[record['id']][engine] = {'referenceCharacters': a, 'outputCharacters': b, 'matchedPerPageCharacters': common, 'recall': common/max(1,a), 'precision': common/max(1,b), 'f1': 2*common/max(1,a+b)}
    summary = {'paperHtmlSha256': hashlib.sha256((LOCAL/'harness.html').read_bytes()).hexdigest(),
               'paperMethod': 'Author HTML body/prompt paragraphs >=100 normalized alphanumeric characters; each compared with its best contiguous output window using edit distance. Omits whitespace/punctuation, short paragraphs, tables, figures, author metadata. Not a whole-document accuracy metric.',
               'paper': scores, 'bookDiagnosticMethod': 'Per-page unordered alphanumeric character multiset agreement with PyMuPDF. Headers/footers included in reference. Not ground truth, not reading-order/structure/math accuracy.', 'bookDiagnostic': books}
    (DEST/'quality.json').write_text(json.dumps(summary, indent=2))


def environment(args):
    files = sorted(p for p in (ROOT/'packages/pdf_go').rglob('*') if p.is_file() and (p.suffix == '.go' and not p.name.endswith('_test.go') or p.name in ['go.mod','glyphlist.txt']))
    digest = hashlib.sha256()
    for p in files:
        digest.update(str(p.relative_to(ROOT)).encode()+b'\0'+p.read_bytes())
    env = {'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'platform': platform.platform(), 'processor': processor(),
           'python':sys.version, 'go':subprocess.check_output(['go','version'],text=True).strip(), 'repeats':args.repeats,'warmups':1,
           'extractorSourceSha256':digest.hexdigest(), 'binaries':{v:hashlib.sha256(Path(getattr(args,v)).read_bytes()).hexdigest() for v in ['before','after']},
           'hostNote':'Shared development host; medians of three calls, not an isolated hardware or upload-latency SLA.',
           'fonttools':importlib.metadata.version('fonttools'),
           'rankScope':'This 1508-page corpus, warm conversion only, five local competitors. Different output scopes; no OCR/cloud services; no market-wide or quality rank.'}
    (DEST/'environment.json').write_text(json.dumps(env,indent=2))


def processor():
    try:
        return subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return platform.processor() or platform.machine()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['before','after']+ENGINES)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--score', action='store_true')
    parser.add_argument('--finalize', action='store_true', help='write current environment and scores after individual engine reruns')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--before', default='/tmp/pdf-extractor-before')
    parser.add_argument('--after', default='/tmp/pdf-extractor-after')
    args = parser.parse_args()
    if args.fetch:
        fetch()
        return validate()
    validate()
    if args.finalize:
        environment(args)
        return score()
    if args.score:
        return score()
    if args.engine:
        return benchmark(args.engine, args)
    for engine in ['before','after'] + ENGINES:
        # One process/engine, strictly sequential; no competing conversions.
        subprocess.run([sys.executable, __file__, '--engine', engine, '--repeats', str(args.repeats), '--before', args.before, '--after', args.after], check=True)

    environment(args)
    score()

if __name__ == '__main__':
    main()
