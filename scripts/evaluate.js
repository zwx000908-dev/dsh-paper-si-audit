import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { checkNmr } from '../src/nmr.js';
import { calculateExperiment } from '../src/experimental-math.js';
import { checkImageDuplicates } from '../src/image-duplicates.js';
import { extractPanels } from '../src/panels.js';
import { evaluatePredictions } from '../src/evaluation.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [], add = (id, detector, expected, observed, extra = {}) => cases.push({ id, detector, expected, observed, ...extra });
for (const [hydrogens, reported, expected] of [[6, 6, 'negative'], [6, 5, 'positive'], [6, 7, 'positive'], [10, 10, 'negative'], [10, 12, 'positive'], [8, 8, 'negative']]) {
  const r = checkNmr([{ id: 'd', blocks: [{ id: 'b', text: `Compound 3a: formula: C6H${hydrogens}O; 1H NMR δ 3.0 (s, ${reported}H).` }] }]);
  add(`h-${hydrogens}-${reported}`, 'nmr_formula', expected, r.records[0]?.status === 'needs_review' ? 'positive' : r.records[0]?.status === 'compatible_count_only' ? 'negative' : 'abstain');
}
for (const [mass, yieldValue, expected] of [[48, 80, 'negative'], [48, 90, 'positive'], [30, 50, 'negative'], [30, 70, 'positive']]) {
  const r = calculateExperiment({ kind: 'yield', productMassMg: mass, limitingAmountMmol: 0.2, molarMassGmol: 300, stoichiometricFactor: 1, reportedYieldPercent: yieldValue });
  add(`yield-${mass}-${yieldValue}`, 'experimental_math', expected, r.status === 'needs_review' ? 'positive' : 'negative');
}
const canvas = createCanvas(256, 256), ctx = canvas.getContext('2d'); let seed = 617;
for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; ctx.fillStyle = `rgb(${seed % 256},${(seed >>> 8) % 256},${(seed >>> 16) % 256})`; ctx.fillRect(x, y, 8, 8); }
const base = canvas.toBuffer('image/png'), cropped = (await extractPanels(base, [{ x: 64, y: 64, width: 128, height: 128 }])).panels[0].bytes;
const other = createCanvas(256, 256), oc = other.getContext('2d'); oc.fillStyle = 'white'; oc.fillRect(0, 0, 256, 256); oc.fillStyle = 'black'; oc.fillRect(20, 30, 80, 110);
const rotated = createCanvas(256, 256), rc = rotated.getContext('2d'); rc.translate(256, 0); rc.rotate(Math.PI / 2); rc.drawImage(canvas, 0, 0);
for (const [name, bytes, expected] of [['exact', base, 'positive'], ['crop', cropped, 'positive'], ['rotation', rotated.toBuffer('image/png'), 'positive'], ['different', other.toBuffer('image/png'), 'negative']]) {
  const pair = [base, bytes], r = await checkImageDuplicates([{ id: 'a0', status: 'ready' }, { id: 'a1', status: 'ready' }], a => pair[Number(a.id.slice(1))], { localImages: true });
  add(name, 'image_duplicate', expected, r.issues.some(i => i.imageEvidence.length === 2 && i.imageEvidence[0].assetId !== i.imageEvidence[1].assetId) ? 'positive' : 'negative');
}
const output = path.join(root, 'test-output', 'evaluation'); await mkdir(output, { recursive: true });
const grouped = rows => Object.fromEntries([...new Set(rows.map(c => c.detector))].map(detector => [detector, evaluatePredictions(rows.filter(c => c.detector === detector))]));
const synthetic = { dataset: 'controlled-synthetic-v1', source: 'Generated mathematical and raster fixtures; not natural-paper accuracy', cases, metrics: evaluatePredictions(cases), byDetector: grouped(cases) };
await writeFile(path.join(output, 'synthetic.json'), JSON.stringify(synthetic, null, 2));
console.log(JSON.stringify({ dataset: synthetic.dataset, metrics: synthetic.metrics, output: path.join(output, 'synthetic.json') }, null, 2));
if (cases.some(c => c.expected !== c.observed)) process.exitCode = 1;
if (process.argv[2]) {
  if (!path.isAbsolute(process.argv[2])) throw new Error('Supply absolute report.json from private real-source replay');
  const run = JSON.parse(await readFile(process.argv[2], 'utf8')), manifest = JSON.parse(await readFile(path.join(root, 'benchmarks/real-reference.json'), 'utf8'));
  for (const [role, sha] of Object.entries(manifest.sourceHashes)) if (!run.documents.some(d => d.role === role && d.sha256 === sha)) throw new Error('Real-source hash mismatch; reference labels do not apply');
  const realCases = manifest.cases.map(c => {
    let observed = 'abstain', extractionMatches;
    if (c.detector === 'stoichiometry') observed = run.issues.some(i => i.category === 'stoichiometry' && i.evidenceIds.includes(c.blockId)) ? 'positive' : 'negative';
    if (c.detector === 'entity_attribution') { const facts = run.facts.filter(f => f.blockId === c.blockId && f.field === 'yield.percent' && f.value === c.value); if (facts.length) observed = facts.some(f => f.entity === c.forbiddenEntity) ? 'positive' : 'negative'; }
    if (c.detector === 'nmr_formula') { const r = run.nmrRecords.find(r => r.entity === c.entity && r.nucleus === c.nucleus); extractionMatches = r?.count === c.expectedCount; if (r) observed = r.status === 'ambiguous' || r.status === 'insufficient' ? 'abstain' : r.status === 'needs_review' ? 'positive' : 'negative'; }
    if (c.detector === 'spectrum_label') {
      const comparisons = run.spectrumComparisons ?? [];
      if (comparisons.length) observed = comparisons.some(r => r.fieldOrigins?.[c.field] === 'document_caption' && r.differences.some(d => d.field === c.field && d.text === c.textValue && d.image === c.captionValue)) ? 'positive' : 'negative';
    }
    return { ...c, observed, ...(extractionMatches !== undefined ? { extractionMatches } : {}) };
  });
  const result = { dataset: manifest.dataset, labelProvenance: manifest.labelProvenance, independentExpertReviewed: false, paperCount: 1, metrics: evaluatePredictions(realCases), byDetector: grouped(realCases), cases: realCases, excluded: 'Unlabelled parts of this paper and all natural-image duplicate accuracy; selected examples are not a held-out multi-paper benchmark.' };
  await writeFile(path.join(output, 'real-reference.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ dataset: result.dataset, metrics: result.metrics, extractionAssertions: realCases.filter(c => c.extractionMatches !== undefined).map(c => ({ id: c.id, matched: c.extractionMatches })), output: path.join(output, 'real-reference.json') }, null, 2));
}
