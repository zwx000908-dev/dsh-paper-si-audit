import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AuditService } from '../src/service.js';
import { VERSION } from '../src/version.js';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('Usage: node scripts/validate-real-workflow.js ABSOLUTE_PRIOR_CASE_DIRECTORY');
const caseDir = await realpath(process.argv[2]), state = JSON.parse(await readFile(path.join(caseDir, 'state.json'), 'utf8'));
const sourceDir = await realpath(path.resolve(caseDir, '../paper'));
const sources = { main: await realpath(state.inputs.main), si: await realpath(state.inputs.siOriginal) };
for (const file of Object.values(sources)) { const relative = path.relative(sourceDir, file); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Sources must remain in selected paper directory'); }
const hashFile = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const before = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([k, p]) => [k, await hashFile(p)])));
const oldReportPath = path.join(caseDir, 'out/paper-si-audit-report.md'), oldReportHash = await hashFile(oldReportPath);
const output = path.join(root, 'outputs', `real-workflow-${VERSION}`); await mkdir(output, { recursive: true });
const service = await new AuditService({ dataDir: path.join(output, 'data'), allowedRoots: [sourceDir] }).init(), project = await service.createProject({ name: 'Private real-source workflow replay ' + VERSION });
for (const [role, filePath] of Object.entries(sources)) await service.addDocument({ projectId: project.id, role, filePath });
console.log('Imported original manuscript and SI read-only.');
let run = await service.runAudit({ projectId: project.id });
const descriptors = (await service.getProject(project.id)).documents;
const si = descriptors.find(d => d.role === 'si'), main = descriptors.find(d => d.role === 'main');
await service.prepareVisuals({ projectId: project.id, documentKey: si.key, selection: { parts: ['word/media/image58.emf', 'word/media/image59.emf', 'word/media/image60.emf', 'word/media/image61.emf'] } });
await service.prepareVisuals({ projectId: project.id, documentKey: main.key, selection: { pages: [1, 2] } });
console.log('Rendered four explicitly selected SI media and two PDF pages.');
run = await service.runAudit({ projectId: project.id });
const record = run.compoundRegistry.records.find(r => r.label === '3a' && r.kinds.includes('h1_text'));
const asset = (await service.listVisuals({ projectId: project.id })).assets.find(a => a.status === 'ready' && a.locator.part === 'word/media/image58.emf');
if (record && asset) { await service.readSpectrumImage({ projectId: project.id, runId: run.id, recordId: record.id, assetId: asset.id }); console.log('Read selected spectrum labels without human acceptance.'); }
run = await service.runAudit({ projectId: project.id });
for (const format of ['md', 'json', 'csv']) { const report = await service.exportReport({ projectId: project.id, runId: run.id, format }); await writeFile(path.join(output, `report.${format}`), report.content); }
const after = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([k, p]) => [k, await hashFile(p)])));
const summary = { version: VERSION, projectId: project.id, runId: run.id, before, after, originalFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), previousReportUnchanged: oldReportHash === await hashFile(oldReportPath), compoundRegistry: run.coverage.compounds, nmr: run.coverage.nmrFormula, images: run.coverage.imageDuplicates, spectrumComparison: run.coverage.spectrumComparison, spectrumObservedFields: run.spectrumReadings.map(r => ({ fields: r.fields, missingFields: r.missingFields, status: r.status })), experimentalMath: run.coverage.experimentalMath, issueSummary: run.issueSummary, scope: 'One user-provided paper and original SI; only four SI media and two main pages rendered. Unlabelled discoveries are not accuracy metrics. No expert review, no source rewriting, no publication of paper materials.' };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(path.join(output, 'project-reference.json'), JSON.stringify({ projectId: project.id, dataDir: service.dataDir, report: path.join(output, 'report.json') }, null, 2));
console.log(JSON.stringify({ output, originalFilesUnchanged: summary.originalFilesUnchanged, previousReportUnchanged: summary.previousReportUnchanged, compounds: run.compoundRegistry.compounds.length, nmr: summary.nmr, images: { checked: summary.images.checkedAssets, skipped: summary.images.skipped.length, comparedPairs: summary.images.comparedPairs }, spectrum: summary.spectrumObservedFields }, null, 2));
if (!summary.originalFilesUnchanged || !summary.previousReportUnchanged) process.exitCode = 1;
