"""Run from repository root after building the Go CLI; sequential, no competitors."""
import hashlib,json,platform,statistics,subprocess
from pathlib import Path
binary='/tmp/pdf-native-go-benchmark'
rows=[]
for name in ['harness','axler','hefferon','thinkpython','calculus']:
 source=Path(f'test-corpus/pdf/real-world/{name}.pdf');target=Path(f'test-corpus/pdf/native/go-{name}.json')
 result=subprocess.run([binary,'-format','json','-repeat','4','-out',str(target),str(source)],capture_output=True,text=True,check=True)
 timing=json.loads(result.stderr.splitlines()[-1]);doc=json.loads(target.read_text());rows.append({'name':name,'inputSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'pages':doc['stats']['pages'],'samplesMs':timing['samplesMs'],'scope':timing['scope'],'medianMs':statistics.median(timing['samplesMs'][1:])});print(name,rows[-1]['medianMs'],flush=True)
Path('eval/pdf/native/timing-go.json').write_text(json.dumps({'platform':platform.platform(),'cpu':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip(),'binarySHA256':hashlib.sha256(Path(binary).read_bytes()).hexdigest(),'warmups':1,'repeats':3,'rows':rows},indent=2)+'\n')
