import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuditService } from '../src/service.js';
import { parseProfile } from '../src/profiles.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const service = await new AuditService({ dataDir: path.join(root, '.audit-data'), allowedRoots: [path.join(root, 'examples')] }).init();
const project = await service.createProject({ name: '[演示] 化学论文正文与SI核对' });
await service.addDocument({ projectId: project.id, filePath: path.join(root, 'examples/manuscript.txt'), role: 'main' });
await service.addDocument({ projectId: project.id, filePath: path.join(root, 'examples/supplementary.txt'), role: 'si' });
await service.setProfile({ projectId: project.id, profile: parseProfile(await readFile(path.join(root, 'profiles/custom-demo.yaml'), 'utf8')) });
const run = await service.runAudit({ projectId: project.id });
await mkdir(path.join(root, 'outputs'), { recursive: true });
for (const format of ['md', 'json', 'csv']) { const report = await service.exportReport({ projectId: project.id, runId: run.id, format }); await writeFile(path.join(root, `outputs/demo-report.${format}`), report.content); }
console.log(JSON.stringify({ projectId: project.id, runId: run.id, extractedFacts: run.facts.length, issues: run.issues.map(i => ({ type: i.type, title: i.title, evidenceStatus: i.evidenceStatus })), report: path.join(root, 'outputs/demo-report.md') }, null, 2));
