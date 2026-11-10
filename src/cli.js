#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { AuditService } from './service.js';
import { parseProfile } from './profiles.js';
import { calculateExactMass } from './hrms.js';
import { calculateExperiment } from './experimental-math.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error('Expected --option value');
  const key = args[i].slice(2); (options[key] ??= []).push(args[i + 1]);
}
const first = (key, fallback) => options[key]?.[0] ?? fallback;
const service = new AuditService({ dataDir: path.resolve(first('data', '.audit-data')), allowedRoots: (options.root ?? [process.cwd()]).map(r => path.resolve(r)), executionPath: 'cli' });
try {
  if (command === 'serve') throw new Error('网页复核面板已在 0.2.0 移除。请在 DeepSeek Harness 中使用 paper_audit_* 工具，或运行 CLI help 查看本地命令。');
  if (command === 'help') console.log('Paper–SI Audit — Harness native tools / local CLI\ncreate --name NAME [--root DIR]\nadd --project ID --file FILE --role main|si|source\nprofile --project ID --file PROFILE.yaml\nrun --project ID\nexport --project ID [--run ID] --format md|json|csv\nvisuals --project ID [--document KEY --pages 1,2 --parts word/media/image1.png]\nprepare-image-audit --project ID --document KEY [--offset 0 --limit 10]\nread-table --project ID --asset ID [--crop JSON]\ntables --project ID\nreview-table --project ID --table ID --status accepted|rejected|needs_review --reason TEXT\nhrms-config --project ID --basis neutral|ion|ambiguous --ppm 5 [--mda NUMBER]\nhrms-calculate --formula FORMULA [--ion ION] [--basis neutral|ion|ambiguous] [--charge INTEGER]\ncompounds --project ID [--run ID]\ncompound --project ID --file DECISION.json\nrequirements --project ID --file CHECKLIST.json\nscientific-config --project ID --file SETTINGS.json\npanels --project ID --asset ID [--rectangles JSON]\nread-spectrum --project ID --record ID --asset ID [--crop JSON]\nspectra --project ID [--reading ID]\nreview-spectrum --project ID --reading ID --status accepted|rejected|needs_review --reason TEXT [--fields JSON]\ncalculate-experiment --input JSON\nAll project commands accept --data DIR. Target Harness: 0.2.2-rc.1. No web server or browser panel is included.');
  else if (command === 'calculate-experiment') console.log(JSON.stringify(calculateExperiment(JSON.parse(first('input'))), null, 2));
  else if (command === 'hrms-calculate') console.log(JSON.stringify(calculateExactMass({ formula: first('formula'), ...(first('ion') ? { ion: first('ion') } : {}), formulaBasis: first('basis', 'ambiguous'), ...(first('charge') ? { charge: Number(first('charge')) } : {}) }), null, 2));
  else {
    await service.init();
    let result;
    if (command === 'create') result = await service.createProject({ name: first('name') });
    else if (command === 'add') result = await service.addDocument({ projectId: first('project'), filePath: path.resolve(first('file')), role: first('role', 'main') });
    else if (command === 'profile') result = await service.setProfile({ projectId: first('project'), profile: parseProfile(await readFile(first('file'), 'utf8')) });
    else if (command === 'run') { const run = await service.runAudit({ projectId: first('project') }); result = { runId: run.id, status: run.status, facts: run.facts.length, issues: run.issues.length, coverage: run.coverage }; }
    else if (command === 'export') { const report = await service.exportReport({ projectId: first('project'), runId: first('run'), format: first('format', 'md') }); result = { path: report.path }; }
    else if (command === 'visuals') {
      const documentKey = first('document');
      result = documentKey ? await service.prepareVisuals({ projectId: first('project'), documentKey, selection: {
        ...(first('pages') ? { pages: first('pages').split(',').map(Number) } : {}), ...(options.parts ? { parts: options.parts } : {}),
      } }) : await service.listVisuals({ projectId: first('project') });
    }
    else if (command === 'prepare-image-audit') result = await service.prepareImageAudit({ projectId: first('project'), documentKey: first('document'), offset: Number(first('offset', 0)), limit: Number(first('limit', 10)) });
    else if (command === 'scientific-config') result = await service.configureScientific({ projectId: first('project'), options: JSON.parse(await readFile(first('file'), 'utf8')) });
    else if (command === 'requirements') result = await service.setRequirements({ projectId: first('project'), requirements: JSON.parse(await readFile(first('file'), 'utf8')) });
    else if (command === 'compounds') result = (await service.getRun({ projectId: first('project'), runId: first('run') })).compoundRegistry;
    else if (command === 'compound') result = await service.setCompound({ projectId: first('project'), runId: first('run'), decision: JSON.parse(await readFile(first('file'), 'utf8')) });
    else if (command === 'panels') result = await service.extractImagePanels({ projectId: first('project'), assetId: first('asset'), rectangles: first('rectangles') ? JSON.parse(first('rectangles')) : undefined });
    else if (command === 'read-spectrum') result = await service.readSpectrumImage({ projectId: first('project'), runId: first('run'), recordId: first('record'), assetId: first('asset'), crop: first('crop') ? JSON.parse(first('crop')) : undefined });
    else if (command === 'spectra') result = await service.getSpectrumReadings({ projectId: first('project'), readingId: first('reading') });
    else if (command === 'review-spectrum') result = await service.reviewSpectrum({ projectId: first('project'), readingId: first('reading'), status: first('status'), reason: first('reason'), fields: first('fields') ? JSON.parse(first('fields')) : undefined });
    else if (command === 'read-table') result = await service.readImageTable({ projectId: first('project'), assetId: first('asset'), ...(first('crop') ? { crop: JSON.parse(first('crop')) } : {}) });
    else if (command === 'tables') result = await service.listImageTables({ projectId: first('project') });
    else if (command === 'review-table') result = await service.reviewImageTable({ projectId: first('project'), tableId: first('table'), status: first('status'), reason: first('reason'), ...(first('corrections') ? { corrections: JSON.parse(first('corrections')) } : {}) });
    else if (command === 'hrms-config') result = await service.configureHrms({ projectId: first('project'), options: { formulaBasis: first('basis', 'ambiguous'), ppmTolerance: Number(first('ppm', 5)), ...(first('mda') ? { mDaTolerance: Number(first('mda')) } : {}) } });
    else throw new Error('Unknown command; use help');
    if (result) console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
