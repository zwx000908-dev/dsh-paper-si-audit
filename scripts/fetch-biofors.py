"""Retrieve only frozen image byte ranges; verify each SHA-256. No archive extraction.
Python 3 standard library. Original image rights are not changed by the plugin's MIT license.
"""
import json, hashlib, urllib.request, urllib.parse, re, concurrent.futures
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
m = json.loads((ROOT/'benchmarks/biofors-external.json').read_text(encoding='utf-8'))
# Independently verify frozen labels and test membership against pinned upstream files.
base = 'https://raw.githubusercontent.com/vimal-isi-edu/BioFors/' + m['upstreamCommit'] + '/annotation_files/'
annotations = {}
for name, expected_hash in m['annotationHashes'].items():
    data = urllib.request.urlopen(base+name,timeout=60).read()
    if hashlib.sha256(data).hexdigest()!=expected_hash: raise RuntimeError('Upstream annotation drift')
    annotations[name] = json.loads(data)
for c in m['cases']:
    paper, pair = c['paperId'], c['pair']; rev=' '.join(reversed(pair.split()))
    if pair not in annotations['edd_test_pairs.json'][paper][c['category']]: raise RuntimeError('Case not in upstream test split')
    g=annotations['edd_gt.json'].get(paper,{})
    expected='positive' if pair in g or rev in g else 'negative'
    if c['expected']!=expected: raise RuntimeError('Frozen label differs from external annotation')
    if expected=='positive' and c['annotationBoxes']!=g[c['annotationPair']]: raise RuntimeError('Annotation coordinate mismatch')
for a in m['assets']:
    paper,name=a['path'].split('/')
    if a['category']!=annotations['classification.json'][paper][name]: raise RuntimeError('Image class mismatch')
print(json.dumps({'externalLabelsVerified':len(m['cases']),'upstreamCommit':m['upstreamCommit']}),flush=True)
out = ROOT/'outputs/biofors-source/images'
url = 'https://drive.usercontent.google.com/download?id=1UVSJ6h7r8pmOWYZkqWeAZ_YvwbFr1wV3&export=download'
s = urllib.request.urlopen(url,timeout=30).read().decode()
params = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"',s))
action = re.search(r'<form[^>]+action="([^"]+)"',s)
if not action: raise RuntimeError('Upstream download form changed; inspect official source')
url = action.group(1)+'?'+urllib.parse.urlencode(params)
def fetch(a):
    if not re.fullmatch(r'\d+/\d+\.png',a['path']): raise ValueError('Invalid frozen asset path')
    p=out/a['path']
    if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==a['sha256']: return 'cached'
    start=a['tarOffset'];end=start+a['bytes']-1
    req=urllib.request.Request(url,headers={'Range':f'bytes={start}-{end}'})
    with urllib.request.urlopen(req,timeout=60) as r:
        if r.status!=206 or not r.headers.get('Content-Range','').startswith(f'bytes {start}-{end}/'): raise RuntimeError('Archive no longer supports exact frozen byte ranges')
        b=r.read(a['bytes']+1)
    if len(b)!=a['bytes'] or hashlib.sha256(b).hexdigest()!=a['sha256']: raise RuntimeError('Image content drift; refuse to relabel or overwrite manifest')
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);return 'downloaded'
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results=list(pool.map(fetch,m['assets']))
print(json.dumps({'verified':len(results),'downloaded':results.count('downloaded'),'cached':results.count('cached')}))
