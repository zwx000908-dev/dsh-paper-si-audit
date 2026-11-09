import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { AuditService } from '../src/service.js';
import { exampleProfile } from '../src/profiles.js';
import { VERSION } from '../src/version.js';

const OUTPUT = fileURLToPath(new URL('../test-output/', import.meta.url));
const within = (base, file) => { const relative = path.relative(path.resolve(base), path.resolve(file)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

async function setup(t, { name = 'Service audit test' } = {}) {
  await mkdir(OUTPUT, { recursive: true });
  const directory = await mkdtemp(path.join(OUTPUT, 'service-'));
  const sources = path.join(directory, 'sources');
  const outside = path.join(directory, 'sources-other');
  const dataDir = path.join(directory, 'state');
  await Promise.all([mkdir(sources), mkdir(outside)]);
  t.after(async () => {
    assert.ok(within(OUTPUT, directory));
    assert.notEqual(path.resolve(directory), path.resolve(OUTPUT));
    assert.ok(path.basename(directory).startsWith('service-'));
    await rm(directory, { recursive: true, force: true });
  });
  const service = await new AuditService({ dataDir, allowedRoots: [sources] }).init();
  const project = await service.createProject({ name });
  return { directory, sources, outside, dataDir, service, project };
}

async function pairedRun(t) {
  const context = await setup(t);
  const mainPath = path.join(context.sources, 'main.csv');
  const siPath = path.join(context.sources, 'si.csv');
  const header = 'compound,experiment,batch,conditions,method,yield\n';
  const mainText = header + '3a,exp1,b1,standard,isolated,92\n';
  const siText = header + '3a,exp1,b1,standard,isolated,80\n';
  await Promise.all([writeFile(mainPath, mainText), writeFile(siPath, siText)]);
  await context.service.addDocument({ projectId: context.project.id, filePath: mainPath, role: 'main' });
  await context.service.addDocument({ projectId: context.project.id, filePath: siPath, role: 'si' });
  const run = await context.service.runAudit({ projectId: context.project.id });
  assert.ok(run.issues.some(issue => issue.type === 'data'), 'fixture should produce a real cross-document difference');
  return { ...context, mainPath, siPath, mainText, siText, run };
}

function semanticCandidate(run, overrides = {}) {
  const document = run.documents.find(document => document.role === 'main');
  const block = document.blocks.find(block => block.text.includes('92')) || document.blocks[0];
  return { title: 'Check reporting context', description: 'The source quotation is valid; the scientific interpretation remains for review.', severity: 'medium', evidence: [{ blockId: block.id, quote: block.text }], ...overrides };
}

test('uploaded revisions replace current sources by name or explicit key and keep historical evidence', async t => {
  const { service, project } = await setup(t);
  const upload = (name, text, extra = {}) => service.importDocument({ projectId: project.id, name, role: 'main', contentBase64: Buffer.from(text).toString('base64'), ...extra });
  await upload('paper.txt', 'compound=3a; experiment=E1; ee=98%');
  const first = await service.runAudit({ projectId: project.id });
  await upload('paper.txt', 'compound=3a; experiment=E1; ee=96%');
  let current = await service.getProject(project.id);
  assert.equal(current.documents.length, 1); assert.equal(current.documents[0].name, 'paper.txt');
  assert.equal((await service.getRun({ projectId: project.id, runId: first.id })).sourcesChangedSinceRun, true);
  await upload('paper-revised.txt', 'compound=3a; experiment=E1; ee=95%', { replaceKey: current.documents[0].key });
  current = await service.getProject(project.id); assert.equal(current.documents.length, 1);
  const latest = await service.runAudit({ projectId: project.id });
  assert.equal(latest.documents[0].name, 'paper-revised.txt'); assert.equal(latest.facts[0].value, '95');
  assert.equal((await service.getRun({ projectId: project.id, runId: first.id })).facts[0].value, '98');
});

test('source selection rejects relative paths, traversal, sibling-prefix roots and audit-state imports', async t => {
  const context = await setup(t);
  const insidePath = path.join(context.sources, 'paper.txt');
  const outsidePath = path.join(context.outside, 'paper.txt');
  await Promise.all([writeFile(insidePath, '3a: 98% ee.'), writeFile(outsidePath, 'outside source')]);
  await assert.rejects(context.service.addDocument({ projectId: context.project.id, filePath: 'paper.txt' }), /must be absolute/);
  await assert.rejects(context.service.addDocument({ projectId: context.project.id, filePath: path.join(context.sources, '..', 'sources-other', 'paper.txt') }), /outside project roots/);
  await assert.rejects(context.service.addDocument({ projectId: context.project.id, filePath: outsidePath }), /outside project roots/);
  await assert.rejects(context.service.addDocument({ projectId: context.project.id, filePath: path.join(context.dataDir, 'projects', context.project.id, 'project.json') }), /state files cannot be imported/);
  const document = await context.service.addDocument({ projectId: context.project.id, filePath: insidePath });
  assert.equal(document.blocks[0].text, '3a: 98% ee.');
  await assert.rejects(context.service.createProject({ name: 'invalid roots', roots: [context.outside] }), /exceed configured allowedRoots/);
  await assert.rejects(context.service.getProject('../escape'), /Invalid identifier/);
});

test('realpath validation rejects a directory link that escapes the selected source root', async t => {
  const context = await setup(t);
  const outsidePath = path.join(context.outside, 'outside.txt');
  const link = path.join(context.sources, 'linked');
  await writeFile(outsidePath, 'not inside selected sources');
  try { await symlink(context.outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Host disallows link fixtures: ${error.code}`); return; } throw error; }
  await assert.rejects(context.service.addDocument({ projectId: context.project.id, filePath: path.join(link, 'outside.txt') }), /outside project roots/);
});

test('audit snapshots do not overwrite sources and historical runs survive later source changes', async t => {
  const context = await pairedRun(t);
  assert.equal(await readFile(context.mainPath, 'utf8'), context.mainText);
  assert.equal(await readFile(context.siPath, 'utf8'), context.siText);
  const originalMain = context.run.documents.find(document => document.role === 'main');
  const newMainText = context.mainText.replace(',92\n', ',82\n');
  await writeFile(context.mainPath, newMainText);
  const next = await context.service.runAudit({ projectId: context.project.id });
  const historical = await context.service.getRun({ projectId: context.project.id, runId: context.run.id });
  assert.notEqual(next.id, context.run.id);
  assert.equal(next.previousRunId, context.run.id);
  assert.equal(historical.documents.find(document => document.role === 'main').sha256, originalMain.sha256);
  assert.ok(historical.documents.find(document => document.role === 'main').blocks.some(block => block.text.endsWith('\t92')));
  assert.ok(next.documents.find(document => document.role === 'main').blocks.some(block => block.text.endsWith('\t82')));
  assert.equal(await readFile(context.mainPath, 'utf8'), newMainText);
  assert.ok(next.changes.priorIssuesNotReproduced.every(issue => issue.state === 'needs_revalidation'));
});

test('profile snapshots are frozen by run and profile changes are explicitly visible', async t => {
  const context = await pairedRun(t);
  const template = exampleProfile();
  await context.service.setProfile({ projectId: context.project.id, profile: template });
  template.rules[0].number_format.digits = 11;
  const project = await context.service.getProject(context.project.id);
  assert.equal(project.profile.rules[0].number_format.digits, 3);
  const first = await context.service.runAudit({ projectId: context.project.id });
  const updated = exampleProfile();
  updated.profile.version = '1.1.0';
  updated.rules[0].number_format.digits = 4;
  await context.service.setProfile({ projectId: context.project.id, profile: updated });
  const stored = await context.service.getRun({ projectId: context.project.id, runId: first.id });
  assert.equal(stored.profile.rules[0].number_format.digits, 3);
  assert.equal(stored.profile.profile.version, '1.0.0');
  assert.equal(stored.profileChangedSinceRun, true);
  stored.profile.rules[0].number_format.digits = 10;
  assert.equal((await context.service.getRun({ projectId: context.project.id, runId: first.id })).profile.rules[0].number_format.digits, 3);
  const second = await context.service.runAudit({ projectId: context.project.id });
  assert.equal(second.profile.rules[0].number_format.digits, 4);
  assert.equal(second.profile.profile.version, '1.1.0');
  assert.equal((await context.service.getRun({ projectId: context.project.id, runId: second.id })).profileChangedSinceRun, false);
});

test('core API execution is recorded separately from host-native tool use', async t => {
  const { service, project, run } = await pairedRun(t);
  assert.equal(run.engineVersion, VERSION); assert.equal(run.execution.entryPoint, 'core_api');
  const forged = await service.runAudit({ projectId: project.id, executionEvidence: { toolCallId: 'not-a-host-call' } });
  assert.equal(forged.execution.entryPoint, 'core_api'); assert.equal(forged.execution.toolCallId, undefined);
});

test('persisted project roots do not bypass a later narrowing of configured source permissions', async t => {
  const { service, project, dataDir, mainPath, outside } = await pairedRun(t);
  const narrowed = await new AuditService({ dataDir, allowedRoots: [outside] }).init();
  await assert.rejects(narrowed.addDocument({ projectId: project.id, filePath: mainPath, role: 'main' }), /currently configured allowedRoots/);
  const run = await narrowed.runAudit({ projectId: project.id });
  assert.ok(run.documents.every(d => d.coverage.status === 'failed'));
  assert.equal(run.facts.length, 0);
  assert.ok((await service.getProject(project.id)).runIds.includes(run.id));
});

test('semantic candidates require real exact quotations and invalid batches do not partially commit', async t => {
  const context = await pairedRun(t);
  const request = { projectId: context.project.id, runId: context.run.id };
  const candidate = semanticCandidate(context.run);
  const accepted = await context.service.submitSemantic({ ...request, candidates: [candidate] });
  assert.equal(accepted.accepted, 1);
  assert.equal(accepted.issues[0].evidenceStatus, 'needs_review');
  assert.equal(accepted.issues[0].citations[0].quote, candidate.evidence[0].quote);
  assert.equal((await context.service.getRun(request)).coverage.semanticStatus, 'candidates_submitted_not_exhaustive');
  const originalCount = (await context.service.getRun(request)).issues.length;
  await assert.rejects(context.service.submitSemantic({ ...request, candidates: [{ ...candidate, title: 'fabricated', evidence: [{ blockId: candidate.evidence[0].blockId, quote: 'Invented 100% ee which does not occur in source' }] }] }), /not an exact source substring/);
  await assert.rejects(context.service.submitSemantic({ ...request, candidates: [{ ...candidate, title: 'wrong offset', evidence: [{ ...candidate.evidence[0], start: 1 }] }] }), /not an exact source substring/);
  await assert.rejects(context.service.submitSemantic({ ...request, candidates: [{ ...candidate, title: 'unknown evidence', evidence: [{ blockId: 'nonexistent', quote: candidate.evidence[0].quote }] }] }), /Evidence does not exist/);
  await assert.rejects(context.service.submitSemantic({ ...request, candidates: [{ ...candidate, title: 'would otherwise be valid' }, { ...candidate, title: 'atomic invalid', evidence: [{ blockId: candidate.evidence[0].blockId, quote: 'forged' }] }] }), /not an exact source substring/);
  assert.equal((await context.service.getRun(request)).issues.length, originalCount);
});

test('ambiguous repeated quotations require an explicit matching start offset', async t => {
  const context = await setup(t);
  const filePath = path.join(context.sources, 'quotes.txt');
  await writeFile(filePath, 'same quotation; same quotation');
  await context.service.addDocument({ projectId: context.project.id, filePath, role: 'main' });
  const run = await context.service.runAudit({ projectId: context.project.id });
  const block = run.documents[0].blocks[0];
  const candidate = { title: 'Repeated quotation', description: 'Needs explicit location.', severity: 'low', evidence: [{ blockId: block.id, quote: 'same quotation' }] };
  await assert.rejects(context.service.submitSemantic({ projectId: context.project.id, runId: run.id, candidates: [candidate] }), /Ambiguous quotation/);
  candidate.evidence[0].start = block.text.lastIndexOf('same quotation');
  const accepted = await context.service.submitSemantic({ projectId: context.project.id, runId: run.id, candidates: [candidate] });
  assert.equal(accepted.issues[0].citations[0].start, candidate.evidence[0].start);
});

test('semantic submission deduplicates repeated candidates within a batch and across retries', async t => {
  const context = await pairedRun(t);
  const request = { projectId: context.project.id, runId: context.run.id };
  const candidate = semanticCandidate(context.run);
  const result = await context.service.submitSemantic({ ...request, candidates: [candidate, structuredClone(candidate)] });
  assert.equal(result.accepted, 1, 'accepted count should describe newly added unique candidates');
  await context.service.submitSemantic({ ...request, candidates: [candidate] });
  const semantic = (await context.service.getRun(request)).issues.filter(issue => issue.type === 'semantic');
  assert.equal(semantic.length, 1);
  assert.equal(new Set(semantic.map(issue => issue.id)).size, semantic.length);
});

test('review history is append-only and cannot directly mark an issue closed', async t => {
  const context = await pairedRun(t);
  const issue = context.run.issues.find(issue => issue.type === 'data');
  const request = { projectId: context.project.id, runId: context.run.id, issueId: issue.id };
  await assert.rejects(context.service.reviewIssue({ ...request, status: 'closed', reason: 'already fixed' }), /direct closure/);
  await assert.rejects(context.service.reviewIssue({ ...request, status: 'confirmed', reason: '' }), /nonempty bounded text/);
  await assert.rejects(context.service.reviewIssue({ ...request, issueId: 'missing', status: 'confirmed', reason: 'cannot review missing issue' }), /Issue not found/);
  await context.service.reviewIssue({ ...request, status: 'confirmed', reason: 'Confirmed the paired experiment identity.' });
  await context.service.reviewIssue({ ...request, status: 'fixed_pending_recheck', reason: 'Author changed the source; await a fresh run.' });
  const run = await context.service.getRun({ projectId: context.project.id, runId: context.run.id });
  assert.deepEqual(run.reviews.map(review => review.status), ['confirmed', 'fixed_pending_recheck']);
  assert.equal(run.issues.find(item => item.id === issue.id).status, 'open');
});

test('CSV reports neutralize spreadsheet formula prefixes, including review reasons', async t => {
  const context = await pairedRun(t);
  const candidate = semanticCandidate(context.run, { title: '=HYPERLINK("https://example.invalid","test")', description: '+SUM(1,2)' });
  const accepted = await context.service.submitSemantic({ projectId: context.project.id, runId: context.run.id, candidates: [candidate] });
  await context.service.reviewIssue({ projectId: context.project.id, runId: context.run.id, issueId: accepted.issues[0].id, status: 'confirmed', reason: '\t@SUM(1,2)' });
  const report = await context.service.exportReport({ projectId: context.project.id, runId: context.run.id, format: 'csv' });
  const rows = parseCsv(report.content, { columns: true });
  const row = rows.find(row => row.id === accepted.issues[0].id);
  assert.ok(row.title.startsWith("'="));
  assert.ok(row.description.startsWith("'+"));
  assert.ok(row.reason.startsWith("'@"));
  assert.equal(await readFile(report.path, 'utf8'), report.content);
  assert.ok(within(path.join(context.dataDir, 'projects', context.project.id, 'exports'), report.path));
});

test('upload filenames cannot escape imports and invalid uploads or cross-project runs are rejected', async t => {
  const context = await setup(t);
  const document = await context.service.importDocument({ projectId: context.project.id, name: '../../upload.txt', contentBase64: Buffer.from('3a: 98% ee.').toString('base64'), role: 'si' });
  assert.equal(document.blocks[0].text, '3a: 98% ee.');
  const project = await context.service.getProject(context.project.id);
  assert.ok(within(path.join(context.dataDir, 'projects', context.project.id, 'imports'), project.documents[0].filePath));
  await assert.rejects(context.service.importDocument({ projectId: context.project.id, name: 'upload.txt', contentBase64: 'not base64!' }), /base64 upload/);
  await assert.rejects(context.service.importDocument({ projectId: context.project.id, name: 'upload.exe', contentBase64: '' }), /Unsupported file extension/);
  const firstRun = await context.service.runAudit({ projectId: context.project.id });
  const other = await context.service.createProject({ name: 'Separate project' });
  await assert.rejects(context.service.getRun({ projectId: other.id, runId: firstRun.id }), /Run not found in project/);
});
