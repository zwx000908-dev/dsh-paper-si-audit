import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AuditService } from '../src/service.js';
async function setup(t, text) {
  const root = await mkdtemp(path.join(tmpdir(), 'experiment-context-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = await new AuditService({ dataDir: path.join(root, 'data'), allowedRoots: [root] }).init(), p = await service.createProject({ name: 'Synthetic interpretations' });
  const file = path.join(root, 'si.txt'); await writeFile(file, text); await service.addDocument({ projectId: p.id, filePath: file, role: 'si' });
  return { service, p, file };
}
test('explicit user method interpretation resolves yield; changed source invalidates it', async t => {
  const text = 'General procedure A\nSubstrate (0.20 mmol, 1.0 equiv.) and reagent (0.30 mmol, 1.5 equiv.) were stirred in solvent for 2 h.\nFollowing general procedure A, product 3a was obtained in 86% yield (51.3 mg, 0.171 mmol).';
  const { service, p, file } = await setup(t, text); const run = await service.runAudit({ projectId: p.id }); const doc = run.documents[0], b = doc.blocks[1];
  const context = { scope: 'method', documentId: doc.id, methodLabel: 'A', limitingAmountMmol: .2, stoichiometricFactor: 1, reason: 'Synthetic explicit user interpretation of the reaction', citations: [{ blockId: b.id, start: 0, end: b.text.length, quote: b.text }] };
  await assert.rejects(service.setExperimentContext({ projectId: p.id, runId: run.id, context: { ...context, citations: [{ ...context.citations[0], quote: 'invented' }] } }), /quote/);
  await service.setExperimentContext({ projectId: p.id, runId: run.id, context }); const next = await service.runAudit({ projectId: p.id });
  const y = next.experimentalProseRecords.find(r => r.kind === 'yield'); assert.equal(y.status, 'compatible_with_tolerance'); assert.equal(y.calculation.calculated, '85.5'); assert.equal(y.fieldSources.stoichiometricFactor.origin, 'explicit_user_method_interpretation');
  await writeFile(file, text.replace('0.20 mmol', '0.40 mmol'));
  await assert.rejects(service.setExperimentContext({ projectId: p.id, runId: next.id, context }), /Source changed/);
  const changed = await service.runAudit({ projectId: p.id }); assert.equal(changed.coverage.experimentalProse.staleContextDecisions, 1); assert.equal(changed.experimentalProseRecords.find(r => r.kind === 'yield').status, 'conditional');
});
test('user-confirmed neutral formula applies to one record, with preserved prior snapshot', async t => {
  const { service, p } = await setup(t, 'The product 3a was obtained in 80% yield (92.14 mg, 2 mmol).');
  const run = await service.runAudit({ projectId: p.id }), record = run.experimentalProseRecords.find(r => r.kind === 'mass_amount');
  await service.setExperimentContext({ projectId: p.id, runId: run.id, context: { scope: 'record', recordId: record.id, neutralFormula: 'C2H6O', reason: 'Synthetic user confirms neutral structure/formula', citations: record.citations } });
  const next = await service.runAudit({ projectId: p.id }); assert.equal(next.experimentalProseRecords.find(r => r.kind === 'mass_amount').status, 'compatible_with_tolerance');
  assert.equal((await service.getRun({ projectId: p.id, runId: run.id })).experimentalProseRecords.find(r => r.kind === 'mass_amount').status, 'insufficient');
  const report = await service.exportReport({ projectId: p.id, format: 'md' }); assert.match(report.content, /明确条件复算 1 组/);
});
