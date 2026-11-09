import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditService } from '../src/service.js';

const output = fileURLToPath(new URL('../test-output/', import.meta.url));
async function setup(t) {
  await mkdir(output, { recursive: true });
  const dir = await mkdtemp(path.join(output, 'hrms-service-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(output));
    assert.ok(path.basename(dir).startsWith('hrms-service-'));
    await rm(dir, { recursive: true, force: true });
  });
  const sources = path.join(dir, 'sources'); await mkdir(sources);
  const service = await new AuditService({ dataDir: path.join(dir, 'state'), allowedRoots: [sources] }).init();
  const project = await service.createProject({ name: 'HRMS snapshot regression' });
  const filePath = path.join(sources, 'si.txt');
  await writeFile(filePath, 'HRMS calcd for C6H12O6 [M+H]+ 181.0707; Found 181.0708.');
  await service.addDocument({ projectId: project.id, filePath, role: 'si' });
  return { service, project, filePath };
}

test('HRMS basis and tolerances are frozen per run; later settings do not rewrite results', async t => {
  const { service, project } = await setup(t), projectId = project.id;
  const first = await service.runAudit({ projectId });
  assert.equal(first.hrmsRecords[0].status, 'ambiguous');
  assert.equal(first.hrmsRecords[0].candidates.length, 2);
  const firstPath = path.join(service.dir(projectId), 'runs', first.id + '.json');
  const frozen = await readFile(firstPath);
  await service.configureHrms({ projectId, options: { formulaBasis: 'neutral', ppmTolerance: 2, mDaTolerance: 1 } });
  const second = await service.runAudit({ projectId });
  assert.equal(second.hrmsRecords[0].status, 'calculated');
  assert.equal(second.hrmsRecords[0].foundCheckStatus, 'checked');
  assert.equal(second.hrmsRecords[0].candidates.length, 1);
  assert.equal(second.hrmsOptions.ppmTolerance, 2);
  assert.equal((await service.getRun({ projectId, runId: first.id })).hrmsSettingsChangedSinceRun, true);
  assert.equal((await service.getRun({ projectId, runId: second.id })).hrmsSettingsChangedSinceRun, false);
  assert.deepEqual(await readFile(firstPath), frozen);
  const record = second.hrmsRecords[0];
  const evidence = await service.getEvidence({ projectId, runId: second.id, evidenceId: record.blockId });
  assert.equal(evidence.block.text.slice(record.citations.formula.start, record.citations.formula.end), 'C6H12O6');
  assert.equal(evidence.block.text.slice(record.citations.found.start, record.citations.found.end), '181.0708');
  const exported = JSON.parse((await service.exportReport({ projectId, runId: second.id, format: 'json' })).content);
  assert.deepEqual(exported.hrmsRecords, second.hrmsRecords);
});

test('invalid HRMS settings cannot be saved and do not leave an unrunnable project', async t => {
  const { service, project } = await setup(t), projectId = project.id;
  const before = await service.getProject(projectId);
  for (const options of [
    { formulaBasis: 'closest' }, { ppmTolerance: 0 }, { ppmTolerance: 10001 },
    { ppmTolerance: Infinity }, { ppmTolerance: '5' }, { mDaTolerance: 1001 },
    { mDaTolerance: -1 }, { extra: true }, [],
  ]) await assert.rejects(() => service.configureHrms({ projectId, options }));
  const after = await service.getProject(projectId);
  assert.deepEqual(after.hrmsOptions, before.hrmsOptions);
  assert.equal(after.hrmsRevision, before.hrmsRevision);
  assert.equal((await service.runAudit({ projectId })).hrmsRecords.length, 1);
});

test('unsupported formula and unreadable found remain incomplete coverage, never a completed mass check', async t => {
  const { service, project, filePath } = await setup(t), projectId = project.id;
  await writeFile(filePath, 'HRMS calcd for XeF2 [M+H]+ 181.0707; Found 181.0708.');
  const unsupported = await service.runAudit({ projectId });
  assert.equal(unsupported.coverage.hrms.unsupportedRecords, 1);
  assert.ok(!unsupported.coverage.completedChecks.includes('hrms_conditional_exact_mass_recalculation'));
  assert.ok(unsupported.coverage.notPerformed.some(s => s.includes('HRMS 分子式精确质量复算')));
  assert.ok(unsupported.coverage.incompleteChecks.includes('hrms_expression_coverage'));
  await writeFile(filePath, 'HRMS calcd for C6H12O6 [M+H]+ 181.0707; Found not detected. 1H NMR 7.26 ppm.');
  await service.configureHrms({ projectId, options: { formulaBasis: 'neutral' } });
  const unreadable = await service.runAudit({ projectId });
  assert.equal(unreadable.hrmsRecords[0].foundReported, null);
  assert.ok(unreadable.coverage.completedChecks.includes('hrms_conditional_exact_mass_recalculation'));
  assert.ok(unreadable.coverage.incompleteChecks.includes('hrms_observed_mass_coverage'));
  assert.equal(unreadable.coverage.hrms.foundCheckedRecords, 0);
});

