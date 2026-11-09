import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AuditService } from '../src/service.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('Usage: node scripts/replay-real-case.js ABSOLUTE_CASE_DIRECTORY');
const caseRoot = await realpath(process.argv[2]);
const selectedRoot = await realpath(path.resolve(caseRoot, '../paper'));
const state = JSON.parse(await readFile(path.join(caseRoot, 'state.json'), 'utf8'));
const sources = { main: await realpath(state.inputs.main), si: await realpath(state.inputs.siOriginal) };
for (const input of Object.values(sources)) { const relative = path.relative(selectedRoot, input); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Case source exceeds its selected sibling paper directory'); }
const oldReportFile = path.join(caseRoot, 'out/paper-si-audit-report.json');
const oldReportBytes = await readFile(oldReportFile);
const baseline = JSON.parse(oldReportBytes.toString('utf8'));
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const before = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([role, file]) => [role, await hashFile(file)])));
const output = path.join(root, `outputs/real-paper-v${VERSION}`);
await mkdir(output, { recursive: true });
const service = await new AuditService({ dataDir: path.join(output, 'data'), allowedRoots: [selectedRoot] }).init();
const project = await service.createProject({ name: `真实案例回归 ${VERSION}（原件只读）` });
for (const [role, filePath] of Object.entries(sources)) await service.addDocument({ projectId: project.id, role, filePath });
await service.setProfile({ projectId: project.id, profile: baseline.profile });
const run = await service.runAudit({ projectId: project.id });
for (const format of ['md', 'json', 'csv']) { const report = await service.exportReport({ projectId: project.id, runId: run.id, format }); await writeFile(path.join(output, `paper-si-audit-report.${format}`), report.content); }
const after = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([role, file]) => [role, await hashFile(file)])));
const mass = run.facts.filter(f => f.field === 'hrms.mass_to_charge');
const bad3a = run.issues.filter(i => ['data', 'alignment'].includes(i.type)).filter(i => i.evidenceIds.map(id => run.facts.find(f => f.id === id)).some(f => f?.entity === '3a' && f.role === 'main' && ['76', '67', '65', '70', '95', '71'].includes(f.raw)));
const summary = { version: VERSION, execution: run.execution, projectId: project.id, runId: run.id, originalSourcePaths: sources, before, after, sourceFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), previousReportUnchanged: Buffer.compare(oldReportBytes, await readFile(oldReportFile)) === 0, usedOriginalSI: run.documents.find(d => d.role === 'si')?.sha256 === before.si, profile: run.profile.profile, previous: { facts: baseline.facts.length, issues: baseline.issues.length, mdLines: (await readFile(path.join(caseRoot, 'out/paper-si-audit-report.md'), 'utf8')).split('\n').length }, current: { facts: run.facts.length, issueSummary: run.issueSummary, massFacts: mass.length, massSourceLabels: [...new Set(mass.map(f => f.sourceLabel))], unmatchedRules: run.coverage.unmatchedRuleIds, stoichiometry: run.issues.filter(i => i.category === 'stoichiometry').map(i => ({ id: i.id, evidenceStatus: i.evidenceStatus, calculation: i.calculation, evidenceIds: i.evidenceIds })), wrong3aIssues: bad3a.length, mdLines: (await readFile(path.join(output, 'paper-si-audit-report.md'), 'utf8')).split('\n').length }, siCoverage: run.documents.find(d => d.role === 'si')?.coverage, note: 'Core API regression on original sources; does not establish native desktop activation, model review, HRMS exact mass, spectra or figure verification.' };
summary.hrms = { ...run.coverage.hrms, records: run.hrmsRecords.map(r => ({ id: r.id, formula: r.formula, ion: r.ion, status: r.status, foundStatus: r.foundStatus, foundCheckStatus: r.foundCheckStatus, reason: r.reason, citations: r.citations })) };
summary.imageTables = run.coverage.imageTables;
summary.note = 'Core API regression on original sources, including conditional exact-mass recalculation. Formula interpretation remains ambiguous where unspecified; EI-MS is not relabelled HRMS. This text run performs no image-table OCR and does not establish native desktop activation, model review, spectra or figure verification.';
await writeFile(path.join(output, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, siCoverage: { status: summary.siCoverage.status, totalUnits: summary.siCoverage.totalUnits, parsedUnits: summary.siCoverage.parsedUnits }, output }, null, 2));
if (!summary.sourceFilesUnchanged || !summary.previousReportUnchanged || !summary.usedOriginalSI || summary.current.wrong3aIssues) process.exitCode = 1;
