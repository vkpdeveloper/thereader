"""Fetch only the pinned official evaluator files, verifying Git and SHA256 hashes."""
import argparse,hashlib,json
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[3]
ap=argparse.ArgumentParser();ap.add_argument('--destination',type=Path,default=Path('/tmp/olmocr-evaluator'));args=ap.parse_args()
manifest=json.loads((ROOT/'eval/pdf/coverage-v03/olmocr-evaluator.json').read_text())
for row in manifest['files']:
    path=args.destination/row['path']
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256']:continue
    r=requests.get(f"https://raw.githubusercontent.com/allenai/olmocr/{manifest['revision']}/{row['path']}",timeout=60);r.raise_for_status();b=r.content
    if hashlib.sha256(b).hexdigest()!=row['sha256'] or hashlib.sha1(f'blob {len(b)}\0'.encode()+b).hexdigest()!=row['gitBlobSHA1']:raise ValueError('Upstream hash mismatch: '+row['path'])
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b)
print('Verified',len(manifest['files']),'upstream evaluator files at',args.destination)
