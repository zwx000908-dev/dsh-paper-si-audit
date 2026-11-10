import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImageDuplicates } from '../src/image-duplicates.js';
import { imagePolicy } from '../src/image-rules.js';
import { evaluatePredictions } from '../src/evaluation.js';
import { VERSION } from '../src/version.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const raw = await readFile(path.join(root, 'benchmarks/biofors-external.json'));
const manifest = JSON.parse(raw), sha = b => createHash('sha256').update(b).digest('hex');
const imageDir = path.resolve(process.argv[2] ?? path.join(root, 'outputs/biofors-source/images'));
const mapping = { 'Microscopy': 'microscopy', 'Blot/Gel': 'blot', 'Macroscopy': 'photograph', 'FACS': 'chart' };
const cache = new Map(), assets = new Map(manifest.assets.map(a => [a.path, a]));
const cases = [];
for (const c of manifest.cases) {
  const pair = c.assets.map((name,i) => ({ id: `case${i}`, status: 'ready', name, imageType: { type: mapping[assets.get(name).category] ?? 'unknown', origin: 'external_dataset_annotation' } }));
  const failures = [];
  const result = await checkImageDuplicates(pair, async a => {
    const meta = assets.get(a.name), target = await realpath(path.join(imageDir, a.name)), relative = path.relative(await realpath(imageDir), target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Image path escaped dataset');
    const b = await readFile(target); if (sha(b) !== meta.sha256) throw new Error('External image hash mismatch'); return b;
  }, { localImages: true, cache: { get: key => cache.get(key), set: (key,value) => cache.set(key,value) } });
  failures.push(...result.coverage.skipped);
  const hits = result.issues.filter(i => i.imageEvidence.length === 2 && i.imageEvidence[0].assetId !== i.imageEvidence[1].assetId);
  const policy = imagePolicy(pair[0],pair[1],{localImages:true});
  const observed = failures.length ? 'abstain' : hits.length ? 'positive' : policy.whole || policy.local ? 'negative' : 'abstain';
  cases.push({ id: c.id, paperId: c.paperId, category: c.category, expected: c.expected, observed, failures, matches: hits.map(i => i.calculation), limitedToExact: !policy.whole && !policy.local });
}
const group = key => Object.fromEntries([...new Set(cases.map(c => c[key]))].map(value => [value, evaluatePredictions(cases.filter(c => c[key] === value))]));
const report = { dataset: manifest.dataset, engineVersion: VERSION, manifestSha256: sha(JSON.stringify(manifest)), manifestHashEncoding: 'UTF-8 JSON.stringify(parsed manifest), independent of whitespace and CRLF', upstreamCommit: manifest.upstreamCommit,
  independentOfPluginLabels: true, newIndependentExpertReview: false, paperCount: manifest.paperIds.length,
  papersWithAllImagesAvailable: manifest.paperIds.filter(id => cases.filter(c => c.paperId === id).every(c => !c.failures.length)).length,
  status: cases.some(c => c.failures.length) ? 'incomplete_inputs' : 'evaluated_limited_scope',
  selection: manifest.selection, scope: manifest.scope, metrics: evaluatePredictions(cases), byPaper: group('paperId'), byCategory: group('category'), cases,
  limitations: ['Pair-level suspicion only; no pixel-localization accuracy or misconduct judgment.', 'External labels can contain omissions; no new expert adjudication.', 'Convenience stratified sample, not whole-paper or organic chemistry performance.', 'Exact-only types without a match abstain; unreadable/missing images never become negatives.', 'Do not tune thresholds on these results and continue calling this an untouched holdout.'] };
const out = path.join(root, 'test-output/evaluation/biofors-external.json'); await mkdir(path.dirname(out),{recursive:true}); await writeFile(out, JSON.stringify(report,null,2));
console.log(JSON.stringify({output:out,status:report.status,paperCount:report.paperCount,papersWithAllImagesAvailable:report.papersWithAllImagesAvailable,metrics:report.metrics,byCategory:report.byCategory},null,2));
// Natural misses are measurements, not infrastructure failures. Missing sources are failures.
if (report.status === 'incomplete_inputs') process.exitCode = 2;
