import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { AuditService } from '../src/service.js';
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-v04-')), sources = path.join(dir, 'sources'); await mkdir(sources);
  t.after(async () => { assert.ok(path.basename(dir).startsWith('paper-v04-')); await rm(dir, { recursive: true, force: true }); });
  const service = await new AuditService({ dataDir: path.join(dir, 'state'), allowedRoots: [sources] }).init(), project = await service.createProject({ name: 'v04 fixture' });
  const source = path.join(sources, 'si.txt'); await writeFile(source, 'Compound 3a: formula: C2H6O; 1H NMR (400 MHz, CDCl3) δ 1.00 (s, 6H).'); await service.addDocument({ projectId: project.id, filePath: source, role: 'si' });
  return { service, project, sources };
}
test('actual spectrum OCR, human corrections, dossiers and immutable reports', async t => {
  const { service, project, sources } = await setup(t);
  const canvas = createCanvas(1500, 400), c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 1500, 400); c.fillStyle = 'black'; c.font = '60px Arial';
  c.fillText('Compound 3a', 40, 85); c.fillText('1H NMR 400 MHz CDCl3', 40, 190); c.fillText('Integral sum: 8 H', 40, 300);
  const filePath = path.join(sources, 'spectrum.png'); const bytes = canvas.toBuffer('image/png'); await writeFile(filePath, bytes); await service.addDocument({ projectId: project.id, filePath, role: 'source' });
  const documentKey = (await service.getProject(project.id)).documents.find(d => d.name === 'spectrum.png').key;
  const prepared = await service.prepareImageAudit({ projectId: project.id, documentKey }), asset = prepared.selectedAssets[0];
  const run = await service.runAudit({ projectId: project.id }), record = run.compoundRegistry.records[0];
  await service.setCompound({ projectId: project.id, runId: run.id, decision: { compoundLabel: '3a', classification: 'new', links: [{ recordId: record.id }, { assetId: asset.id, kind: 'h1_spectrum' }], reason: 'Synthetic explicit user decision fixture only' } });
  await service.setRequirements({ projectId: project.id, requirements: { name: 'lab test', version: '1', source_type: 'user_defined', rules: [{ classification: 'new', allOf: ['h1_text', 'h1_spectrum', 'c13_spectrum'] }] } });
  const reading = await service.readSpectrumImage({ projectId: project.id, runId: run.id, recordId: record.id, assetId: asset.id });
  assert.equal(reading.fields.integralSum, 8); assert.equal(reading.fields.frequencyMHz, 400); assert.ok(reading.words.every(w => w.bbox)); assert.equal(reading.review.status, 'needs_review');
  const compared = await service.runAudit({ projectId: project.id });
  assert.ok(compared.issues.some(i => i.category === 'nmr_image' && i.calculation.differences.some(d => d.field === 'integralSum')));
  assert.ok(compared.issues.some(i => i.category === 'compound_completeness'));
  await service.reviewSpectrum({ projectId: project.id, readingId: reading.id, status: 'accepted', reason: 'Synthetic correction-state test; not human review of research data', fields: { ...reading.fields, integralSum: 6 } });
  const reviewed = await service.runAudit({ projectId: project.id }); assert.equal(reviewed.coverage.spectrumComparison.provisionalReadings, 0);
  assert.equal(reviewed.spectrumReadings[0].originalFields.integralSum, 8); assert.equal(reviewed.spectrumReadings[0].fields.integralSum, 6);
  assert.equal((await service.getRun({ projectId: project.id, runId: compared.id })).spectrumReadings[0].fields.integralSum, 8);
  assert.deepEqual(await readFile(filePath), bytes);
});
test('project image comparisons resume across batches; panel evidence preserves parent coordinates', async t => {
  const { service, project, sources } = await setup(t);
  const c = createCanvas(180, 160), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 180, 160); x.fillStyle = 'black'; x.fillRect(20, 20, 60, 80); x.fillStyle = 'red'; x.fillRect(100, 50, 60, 90);
  for (let i = 0; i < 3; i++) { const filePath = path.join(sources, `${i}.png`); await writeFile(filePath, c.toBuffer('image/png')); await service.addDocument({ projectId: project.id, filePath, role: 'source' }); }
  for (const d of (await service.getProject(project.id)).documents.filter(d => d.name.endsWith('.png'))) await service.prepareImageAudit({ projectId: project.id, documentKey: d.key });
  await service.configureScientific({ projectId: project.id, options: { imagePairBudget: 1, localImages: false } });
  let run; for (let i = 0; i < 3; i++) run = await service.runAudit({ projectId: project.id });
  assert.equal(run.coverage.imageDuplicates.nextPairOffset, null); assert.equal(run.coverage.imageDuplicates.comparedPairs, 3); assert.equal(run.issues.filter(i => i.category === 'image_duplicate').length, 3);
  assert.ok(run.issues.find(i => i.category === 'image_duplicate').previewPath);
  const finished = await service.runAudit({ projectId: project.id }); assert.equal(finished.coverage.imageDuplicates.comparedPairsThisRun, 0); assert.equal(finished.coverage.imageDuplicates.comparedPairs, 3);
  const parent = run.duplicateImageAssets[0]; const panel = await service.extractImagePanels({ projectId: project.id, assetId: parent.assetId, rectangles: [{ x: 10, y: 10, width: 100, height: 100 }] });
  assert.equal(panel.assets[0].parentAssetId, parent.assetId); assert.deepEqual(panel.assets[0].parentCrop, { x: 10, y: 10, width: 100, height: 100 });
  const changed = await service.runAudit({ projectId: project.id }); assert.equal(changed.coverage.imageDuplicates.resumedFromRunId, null);
});
