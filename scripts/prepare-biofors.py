"""Freeze a deterministic external-paper subset BEFORE inference. No detector import.
Run once with Python 3; image bytes stay under ignored outputs/. Never extracts tar paths.
"""
import json, hashlib, urllib.request, urllib.parse, re, tarfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
if (ROOT/'benchmarks/biofors-external.json').exists():
    raise RuntimeError('Frozen manifest exists; use fetch-biofors.py to reproduce, not reselection')
OUT = ROOT / 'outputs' / 'biofors-source'
OUT.mkdir(parents=True, exist_ok=True)
repo = 'https://api.github.com/repos/vimal-isi-edu/BioFors'
sha = json.load(urllib.request.urlopen(repo + '/commits/main', timeout=30))['sha']
base = 'https://raw.githubusercontent.com/vimal-isi-edu/BioFors/' + sha + '/'
def fetch(name):
    b = urllib.request.urlopen(base + name, timeout=60).read()
    p = OUT / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
    return b
raw = {n: fetch('annotation_files/' + n) for n in ['edd_gt.json', 'classification.json', 'edd_test_pairs.json']}
gt, classes, pairs = [json.loads(raw[n]) for n in ['edd_gt.json', 'classification.json', 'edd_test_pairs.json']]
license_bytes = fetch('LICENSE')
# Labels belong to the upstream test split, not the plugin development fixtures.
selection = {}; assets = {}; tar_offsets = {}; selected_order = []
url = 'https://drive.usercontent.google.com/download?id=1UVSJ6h7r8pmOWYZkqWeAZ_YvwbFr1wV3&export=download'
s = urllib.request.urlopen(url, timeout=30).read().decode()
params = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', s))
action = re.search(r'<form[^>]+action="([^"]+)"', s).group(1)
url = action + '?' + urllib.parse.urlencode(params)
request = urllib.request.Request(url, headers={'Range': 'bytes=0-268435455'})
response = urllib.request.urlopen(request, timeout=60)
if response.status != 206 or not response.headers.get('Content-Range','').startswith('bytes 0-'):
    raise RuntimeError('Expected bounded archive range response')
archive_identity = {'url': 'https://drive.google.com/file/d/1UVSJ6h7r8pmOWYZkqWeAZ_YvwbFr1wV3/view', 'contentRange': response.headers['Content-Range'], 'lastModified': response.headers.get('Last-Modified')}
previous = None
try:
  with tarfile.open(fileobj=response, mode='r|') as archive:
    for member in archive:
      match = re.fullmatch(r'biofors_images/(\d+)/(\d+\.png)', member.name)
      if not match: continue
      paper, name = match.groups()
      if paper != previous and len(selected_order) >= 10 and paper not in selection: break
      previous = paper
      if paper not in pairs: continue
      if paper not in selection:
        rows = []
        for category, entries in sorted(pairs[paper].items()):
          for pair in sorted(entries):
            rev = ' '.join(reversed(pair.split()))
            coords = gt.get(paper, {}).get(pair) or gt.get(paper, {}).get(rev)
            rows.append({'paperId': paper, 'category': category, 'pair': pair, 'expected': 'positive' if coords else 'negative', 'annotationPair': pair if pair in gt.get(paper,{}) else rev if coords else None, 'annotationBoxes': coords})
        # Fixed class-stratified sample: up to 5 positives and 15 negatives per paper.
        chosen = [r for r in rows if r['expected']=='positive'][:5] + [r for r in rows if r['expected']=='negative'][:15]
        selection[paper] = chosen; selected_order.append(paper)
        print('Selected external test paper', paper, 'cases', len(chosen), flush=True)
      needed = {n for row in selection[paper] for n in row['pair'].split()}
      if name not in needed: continue
      if member.size > 32*1024*1024: raise RuntimeError('Oversize image')
      b = archive.extractfile(member).read(); rel = paper + '/' + name
      target = OUT/'images'/rel; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(b)
      assets[rel] = {'path': rel, 'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'category': classes[paper][name], 'tarOffset': member.offset_data}
finally: response.close()
rows=[]
for paper in selected_order:
  for row in selection[paper]:
    row['id'] = 'biofors-' + paper + '-' + row['pair'].replace('.png','').replace(' ','-')
    row['assets'] = [paper+'/'+n for n in row['pair'].split()]
    if any(a not in assets for a in row['assets']): raise RuntimeError('Archive range incomplete; do not freeze partial manifest')
    rows.append(row)
if len(selected_order) < 10: raise RuntimeError('Need ten complete papers')
manifest = {'schemaVersion': 1, 'dataset': 'biofors-external-test-subset-v1', 'upstreamRepository': 'https://github.com/vimal-isi-edu/BioFors', 'upstreamCommit': sha, 'paperUrl': 'https://openaccess.thecvf.com/content/ICCV2021/html/Sabir_BioFors_A_Large_Biomedical_Image_Forensics_Dataset_ICCV_2021_paper.html', 'labelLicense': 'CC0-1.0 (upstream repository LICENSE; not a blanket image redistribution license)', 'annotationHashes': {n: hashlib.sha256(b).hexdigest() for n,b in raw.items()}, 'licenseSha256': hashlib.sha256(license_bytes).hexdigest(), 'archive': archive_identity, 'selection': 'First 10 upstream EDD test paper IDs encountered in original archive order; sorted categories and pairs; up to first 5 labelled positives and 15 labelled negatives per paper. Frozen before inference. Case-control convenience subset; not prevalence representative.', 'paperIds': selected_order, 'labelProvenance': 'External published BioFors EDD ground truth; missing pair annotations interpreted as negative only within upstream enumerated EDD test pairs, matching upstream evaluator.', 'independentOfPluginLabels': True, 'newIndependentExpertReview': False, 'scope': 'Extracted real-paper image pair screening only; no chemical or whole-paper accuracy claim. IDs are upstream paper identifiers, not DOI verification. No synthetic edits.', 'assets': list(assets.values()), 'cases': rows}
(ROOT/'benchmarks/biofors-external.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'papers':len(selected_order),'cases':len(rows),'assets':len(assets),'positive':sum(r['expected']=='positive' for r in rows)}))
