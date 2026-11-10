import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';
import { AuditService } from '../src/service.js';
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'audit-v05-')); t.after(() => rm(root, { recursive: true, force: true })); const sources = path.join(root, 'sources'); await mkdir(sources);
  const options = { dataDir: path.join(root, 'data'), allowedRoots: [sources] }, service = await new AuditService(options).init(), p = await service.createProject({ name: 'v05' });
  const add = async (name, text, role) => { const file = path.join(sources, name); await writeFile(file, text); await service.addDocument({ projectId: p.id, filePath: file, role }); return file; };
  return { root, sources, options, service, p, add };
}
test('whole project workflow survives service restart, reads OCR and finishes pair batches', async t => {
  const { service, p, options, add } = await setup(t); await add('main.txt', 'Compound 3a: yield: 80%.', 'main'); await add('si.txt', 'Compound 3a: yield: 80%.', 'si');
  const c = createCanvas(900, 220), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 900, 220); x.fillStyle = 'black'; x.font = '36px Arial'; x.fillText('Compound 3a: isolated yield 80%', 30, 100);
  for (let i = 0; i < 3; i++) await add(`image${i}.png`, c.toBuffer('image/png'), 'source');
  await service.configureScientific({ projectId: p.id, options: { imagePairBudget: 1 } });
  let job = await service.workflow({ projectId: p.id, action: 'start', ocr: true, maxSteps: 1 }); assert.equal(job.nextAction, 'resume');
  const next = await new AuditService(options).init();
  for (let i = 0; i < 15 && job.nextAction; i++) job = await next.workflow({ projectId: p.id, action: 'resume', maxSteps: 1 });
  assert.equal(job.status, 'completed'); assert.equal(job.tasks.length, 3); assert.equal(job.counts.ocr_read_provisional, 3); assert.equal(job.coverage.imageDuplicates.comparedPairs, 3);
  assert.equal((await next.getMaterialReadings({ projectId: p.id })).length, 3);
  await writeFile(path.join(options.allowedRoots[0], 'main.txt'), 'Changed');
  assert.equal((await next.workflow({ projectId: p.id, action: 'status' })).status, 'stale');
});
test('failed rendering is recorded and retriable, cancellation never pretends completion', async t => {
  const { service, p, add } = await setup(t); await add('main.txt', 'Main', 'main'); await add('si.txt', 'SI', 'si'); await add('bad.png', 'not an image', 'source');
  let job = await service.workflow({ projectId: p.id, action: 'start', maxSteps: 10 }); assert.equal(job.status, 'completed_with_gaps'); assert.ok(job.failures.length);
  job = await service.workflow({ projectId: p.id, action: 'retry_failed', maxSteps: 1 }); assert.ok(job.failures.length);
  job = await service.workflow({ projectId: p.id, action: 'cancel' }); assert.equal(job.status, 'cancelled');
});
test('revision closure requires new evidence and user decision; deleted data cannot close', async t => {
  const { service, p, add } = await setup(t);
  const file = await add('main.txt', 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 8H).', 'main'); await add('si.txt', 'Supplementary information.', 'si');
  const a = await service.runAudit({ projectId: p.id }), old = a.issues.find(i => i.category === 'nmr_formula'); assert.ok(old);
  await writeFile(file, 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 6H).');
  const b = await service.runAudit({ projectId: p.id }), row = b.revisionLedger.items.find(i => i.originIssueId === old.id); assert.equal(row.state, 'candidate_resolved');
  await assert.rejects(service.revalidateIssue({ projectId: p.id, runId: b.id, trackingId: row.id, status: 'fixed', reason: 'Checked', citations: [{ ...row.currentCitations[0], quote: 'invented' }] }), /quote/);
  await service.revalidateIssue({ projectId: p.id, runId: b.id, trackingId: row.id, status: 'fixed', reason: 'Explicit synthetic user confirmation', citations: row.currentCitations });
  assert.equal((await service.getRun({ projectId: p.id })).revisionLedger.items.find(i => i.id === row.id).state, 'closed_by_user');
  const csv = await service.exportReport({ projectId: p.id, format: 'csv' }); assert.match(csv.content, /revision_state/); assert.ok(csv.content.includes(row.id)); assert.match(csv.content, /closed_by_user/);
  const c = await service.runAudit({ projectId: p.id }); assert.equal(c.revisionLedger.items.find(i => i.id === row.id).state, 'closed_by_user');
  await writeFile(file, 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 8H).');
  const d = await service.runAudit({ projectId: p.id }); assert.equal(d.revisionLedger.items.find(i => i.id === row.id).state, 'reopened');
  await writeFile(file, 'Deleted characterization.'); const e = await service.runAudit({ projectId: p.id }); assert.equal(e.revisionLedger.items.find(i => i.id === row.id).state, 'cannot_revalidate');
});
test('Markdown table parsing preserves exact quotes for cross-reference report', async t => {
  const { service, p, add } = await setup(t);
  await add('main.md', 'An isolated yield of up to 98% yield was obtained (Table S1).', 'main');
  await add('si.md', 'Table S1. Optimization.\n| Entry | Product | isolated yield |\n|---|---|---|\n| 1 | 3a | 92 |', 'si');
  const r = await service.runAudit({ projectId: p.id }); assert.ok(r.crossReferences.records.some(c => c.kind === 'maximum' && c.actual === 92));
  const exported = await service.exportReport({ projectId: p.id }); assert.match(await readFile(exported.path, 'utf8'), /图表/);
});
test('aborted workflow remains resumable; changed settings invalidate checkpoints', async t => {
  const { service, p, add } = await setup(t); await add('main.txt', 'Main', 'main'); await add('si.txt', 'SI', 'si');
  const ac = new AbortController(); ac.abort();
  const job = await service.workflow({ projectId: p.id, action: 'start', signal: ac.signal }); assert.equal(job.status, 'interrupted');
  const resumed = await service.workflow({ projectId: p.id, action: 'resume' }); assert.equal(resumed.status, 'completed');
  await service.configureScientific({ projectId: p.id, options: { yieldTolerancePercent: 2 } });
  assert.equal((await service.workflow({ projectId: p.id, action: 'resume' })).status, 'stale');
});
test('failed source and changed rules cannot be used to close a disappeared issue', async t => {
  const { service, p, add } = await setup(t); const file = await add('main.txt', 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 8H).', 'main'); await add('si.txt', 'SI', 'si');
  const first = await service.runAudit({ projectId: p.id }), tracked = first.revisionLedger.items.find(r => r.title.includes('氢'));
  await writeFile(file, 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 6H).');
  await service.configureScientific({ projectId: p.id, options: { nmrIntegralTolerance: 1 } });
  const second = await service.runAudit({ projectId: p.id }), row = second.revisionLedger.items.find(r => r.id === tracked.id); assert.equal(row.state, 'cannot_revalidate');
  await assert.rejects(service.revalidateIssue({ projectId: p.id, runId: second.id, trackingId: row.id, status: 'fixed', reason: 'test', citations: row.currentCitations }), /closure refused/);
});

test('pre-rendered later DOCX media does not change inventory-task identity or skip earlier media', async t => {
  const { service, p, add } = await setup(t); await add('main.txt', 'Main', 'main');
  const c = createCanvas(100, 100), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 100, 100); x.fillStyle = 'black'; x.fillRect(20, 20, 60, 60); const png = c.toBuffer('image/png');
  const zip = { 'word/document.xml': strToU8('<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body><w:p><w:r><w:t>Images</w:t></w:r><a:blip r:embed="r1"/><a:blip r:embed="r2"/><a:blip r:embed="r3"/></w:p></w:body></w:document>'), 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="r1" Target="media/a.png"/><Relationship Id="r2" Target="media/b.png"/><Relationship Id="r3" Target="media/c.png"/></Relationships>'), 'word/media/a.png': png, 'word/media/b.png': png, 'word/media/c.png': png };
  await add('si.docx', zipSync(zip), 'si'); const doc = (await service.getProject(p.id)).documents.find(d => d.role === 'si');
  await service.prepareImageAudit({ projectId: p.id, documentKey: doc.key, offset: 1, limit: 1 });
  const job = await service.workflow({ projectId: p.id, action: 'start', ocr: false, maxSteps: 10 });
  assert.equal(job.tasks.length, 3); assert.equal(new Set(job.tasks.map(t => t.assetId)).size, 3); assert.equal(job.coverage.imageDuplicates.checkedAssets, 3); assert.equal(job.coverage.imageDuplicates.skipped.length, 0);
});
