import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync, strToU8 } from 'fflate';
import { AuditService } from '../src/service.js';
import { createToolDefinitions } from '../src/plugin.js';

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-scientific-'));
  t.after(async () => { assert.ok(path.basename(dir).startsWith('paper-scientific-')); await rm(dir, { recursive: true, force: true }); });
  const sources = path.join(dir, 'sources'); await mkdir(sources);
  const service = await new AuditService({ dataDir: path.join(dir, 'data'), allowedRoots: [sources] }).init();
  const project = await service.createProject({ name: 'scientific-screening' });
  const c = createCanvas(100, 100), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 100, 100); x.fillStyle = 'black'; x.fillRect(10, 20, 60, 70);
  return { service, project, sources, png: c.toBuffer('image/png') };
}
test('native image preparation, automatic NMR/duplicate checks, reports, stale assets and snapshots', async t => {
  const { service, project, sources, png } = await setup(t);
  for (const [name, bytes, role] of [['main.txt', 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 8H).', 'main'], ['a.png', png, 'si'], ['b.png', png, 'source']]) {
    const filePath = path.join(sources, name); await writeFile(filePath, bytes); await service.addDocument({ projectId: project.id, filePath, role });
  }
  const first = await service.runAudit({ projectId: project.id }); assert.equal(first.coverage.imageDuplicates.uninventoriedDocuments.length, 2);
  const tool = createToolDefinitions(service).find(t => t.name === 'paper_audit_prepare_image_audit');
  for (const d of (await service.getProject(project.id)).documents.filter(d => d.name.endsWith('.png'))) {
    const result = await tool.execute({ projectId: project.id, documentKey: d.key }); assert.equal(result.nextOffset, null); assert.equal(result.selectedAssets[0].status, 'ready');
  }
  assert.equal((await service.getRun({ projectId: project.id, runId: first.id })).imageTablesChangedSinceRun, true);
  const run = await service.runAudit({ projectId: project.id });
  assert.equal(run.issues.filter(i => i.category === 'nmr_formula').length, 1);
  assert.equal(run.issues.filter(i => i.category === 'image_duplicate').length, 1);
  assert.equal(run.coverage.imageDuplicates.comparedPairs, 1);
  const report = await service.exportReport({ projectId: project.id, format: 'md' }); const text = await readFile(report.path, 'utf8');
  assert.match(text, /氢谱报告积分/); assert.match(text, /打开原图/); assert.match(text, /a.png/); assert.match(text, /b.png/);
  const json = await service.exportReport({ projectId: project.id, format: 'json' });
  assert.equal(JSON.parse(await readFile(json.path, 'utf8')).duplicateImageAssets.length, 2);
  const csv = await service.exportReport({ projectId: project.id, format: 'csv' }); assert.match(csv.content, /image_evidence_json/); assert.match(csv.content, /a.png/); assert.match(csv.content, /nmr_formula/);
  await writeFile(path.join(sources, 'a.png'), 'changed source');
  const changed = await service.runAudit({ projectId: project.id }); assert.equal(changed.coverage.imageDuplicates.staleAssets.length, 1); assert.equal(changed.coverage.imageDuplicates.comparedPairs, 0);
  const old = await service.getRun({ projectId: project.id, runId: run.id }); assert.equal(old.coverage.imageDuplicates.comparedPairs, 1); assert.equal(old.sourcesChangedSinceRun, true);
});
test('paged DOCX inventory preserves previously rendered images and repeated placements', async t => {
  const { service, project, sources, png } = await setup(t);
  const filePath = path.join(sources, 'si.docx');
  await writeFile(filePath, zipSync({
    'word/document.xml': strToU8('<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body><w:p><w:r><w:t>Figures</w:t></w:r><a:blip r:embed="r1"/></w:p><w:p><a:blip r:embed="r1"/></w:p><w:p><a:blip r:embed="r2"/></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="r1" Target="media/a.png"/><Relationship Id="r2" Target="media/b.png"/></Relationships>'),
    'word/media/a.png': png, 'word/media/b.png': png,
  }));
  await service.addDocument({ projectId: project.id, filePath, role: 'si' }); const documentKey = (await service.getProject(project.id)).documents[0].key;
  const page1 = await service.prepareImageAudit({ projectId: project.id, documentKey, limit: 1 }); assert.equal(page1.nextOffset, 1);
  const partial = await service.runAudit({ projectId: project.id }); assert.equal(partial.coverage.imageDuplicates.skipped.length, 1);
  const page2 = await service.prepareImageAudit({ projectId: project.id, documentKey, offset: page1.nextOffset, limit: 1 }); assert.equal(page2.nextOffset, null);
  const full = await service.runAudit({ projectId: project.id }); assert.equal(full.coverage.imageDuplicates.checkedAssets, 2); assert.equal(full.issues.filter(i => i.category === 'image_duplicate').length, 2);
});
