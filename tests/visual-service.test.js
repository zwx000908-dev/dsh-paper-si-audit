import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { AuditService } from '../src/service.js';

const OUTPUT = fileURLToPath(new URL('../test-output/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const TRANSCRIPTION = [
  ['compound', 'experiment', 'batch', 'method', 'yield', 'ee'],
  ['3a', 'E1', 'B1', 'isolated', '80', '96'],
];

function tableImage(values = TRANSCRIPTION) {
  const canvas = createCanvas(1820, 340), c = canvas.getContext('2d');
  c.fillStyle = 'white'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = 'black'; c.fillStyle = 'black'; c.lineWidth = 3;
  const xs = [20, 320, 660, 900, 1250, 1530, 1800], ys = [20, 170, 320];
  for (const x of xs) { c.beginPath(); c.moveTo(x, 20); c.lineTo(x, 320); c.stroke(); }
  for (const y of ys) { c.beginPath(); c.moveTo(20, y); c.lineTo(1800, y); c.stroke(); }
  values.forEach((row, y) => row.forEach((text, x) => {
    c.font = `${y === 0 ? 34 : 42}px Arial`; c.fillText(text, xs[x] + 26, ys[y] + 95);
  }));
  return canvas.toBuffer('image/png');
}

async function setup(t, values = TRANSCRIPTION) {
  await mkdir(OUTPUT, { recursive: true });
  const directory = await mkdtemp(path.join(OUTPUT, 'visual-service-'));
  const sources = path.join(directory, 'sources'), dataDir = path.join(directory, 'state');
  await mkdir(sources);
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(OUTPUT));
    assert.ok(path.basename(directory).startsWith('visual-service-'));
    await rm(directory, { recursive: true, force: true });
  });
  const service = await new AuditService({ dataDir, allowedRoots: [sources] }).init();
  const project = await service.createProject({ name: 'Visual evidence integration' });
  const source = path.join(sources, 'si.png'), original = tableImage(values);
  await writeFile(source, original);
  await service.addDocument({ projectId: project.id, filePath: source, role: 'si' });
  const descriptor = (await service.getProject(project.id)).documents[0];
  const prepared = await service.prepareVisuals({ projectId: project.id, documentKey: descriptor.key });
  assert.equal(prepared.assets.length, 1);
  return { directory, dataDir, sources, service, project, source, original, descriptor, asset: prepared.assets[0] };
}

test('real six-column OCR keeps source/cell evidence, explicit corrections and immutable audit snapshots', { timeout: 120000 }, async t => {
  const ctx = await setup(t), { service, project, asset } = ctx;
  const main = path.join(ctx.sources, 'main.csv');
  await writeFile(main, 'compound,experiment,batch,method,yield,ee\n3a,E1,B1,isolated,92,98\n');
  await service.addDocument({ projectId: project.id, filePath: main, role: 'main' });
  const result = await service.readImageTable({ projectId: project.id, assetId: asset.id });
  assert.equal(result.status, 'needs_review', JSON.stringify(result.notes));
  assert.equal(result.review.status, 'needs_review');
  assert.equal(result.provider.route, 'local_wasm');
  assert.equal(result.provider.networkRequestsRequired, false);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.cells.length === 6));
  assert.equal(result.source.sourceSha256, sha(ctx.original));
  assert.equal(result.source.rasterSha256, asset.sha256);
  assert.equal(result.sourceSha256, asset.sha256);
  const originalRows = structuredClone(result.rows);
  const firstPage = await service.getImageTable({ projectId: project.id, tableId: result.id, limit: 1 });
  assert.equal(firstPage.rowCount, 2); assert.equal(firstPage.nextOffset, 1);
  const secondPage = await service.getImageTable({ projectId: project.id, tableId: result.id, offset: 1, limit: 1 });
  assert.deepEqual(secondPage.items[0], result.rows[1]); assert.equal(secondPage.nextOffset, null);
  const otherProject = await service.createProject({ name: 'Other table owner' });
  await assert.rejects(() => service.getImageTable({ projectId: otherProject.id, tableId: result.id }), /not found/);
  await assert.rejects(() => service.getImageTable({ projectId: project.id, tableId: result.id, limit: 101 }), /page/);
  for (const row of result.rows) for (const cell of row.cells) {
    assert.ok(cell.bbox.x >= 0 && cell.bbox.y >= 0 && cell.bbox.width > 0 && cell.bbox.height > 0);
    assert.ok(cell.bbox.x + cell.bbox.width <= asset.imageWidth);
    assert.ok(cell.bbox.y + cell.bbox.height <= asset.imageHeight);
  }

  const provisional = await service.runAudit({ projectId: project.id });
  assert.equal(provisional.coverage.imageTables.provisionalTables, 1);
  assert.equal(provisional.coverage.imageTables.acceptedTables, 0);
  const ocrFacts = provisional.facts.filter(f => f.evidenceOrigin === 'image_table_ocr');
  assert.ok(ocrFacts.length >= 2, 'real OCR should expose yield and ee facts');
  assert.ok(ocrFacts.every(f => f.unverifiedVisual && f.visualReviewStatus === 'needs_review'));
  const ocrFactIds = new Set(ocrFacts.map(f => f.id));
  assert.ok(provisional.issues.filter(i => i.evidenceIds.some(id => ocrFactIds.has(id))).every(i => i.evidenceStatus !== 'confirmed_difference'));
  const originalRunBytes = await readFile(path.join(service.dir(project.id), 'runs', `${provisional.id}.json`));

  // This fixture acts as an explicit human transcription from the known source,
  // including any headers or entity labels OCR may have misread. It is not an
  // OCR stub or an automatic acceptance path in production.
  const corrections = TRANSCRIPTION.flatMap((row, ri) => row.map((text, ci) => ({ row: ri + 1, column: ci + 1, text })));
  const review = await service.reviewImageTable({ projectId: project.id, tableId: result.id, status: 'accepted', reason: 'Fixture human compared every cell with its original image.', corrections });
  assert.equal(review.corrections.length, 12);
  const accepted = await service.runAudit({ projectId: project.id });
  assert.equal(accepted.coverage.imageTables.acceptedTables, 1);
  assert.equal(accepted.coverage.imageTables.provisionalTables, 0);
  const acceptedTable = accepted.imageTables.find(table => table.id === result.id);
  assert.equal(acceptedTable.review.status, 'accepted');
  assert.equal(acceptedTable.reviewHistory.length, 1);
  for (let ri = 0; ri < 2; ri++) for (let ci = 0; ci < 6; ci++) {
    const cell = acceptedTable.rows[ri].cells[ci];
    assert.equal(cell.text, TRANSCRIPTION[ri][ci]);
    assert.equal(cell.originalOCRText, originalRows[ri].cells[ci].text);
    assert.deepEqual(cell.bbox, originalRows[ri].cells[ci].bbox);
  }
  const dataDifferences = accepted.issues.filter(i => i.type === 'data' && i.evidenceStatus === 'confirmed_difference');
  assert.ok(dataDifferences.some(i => i.title.includes('yield.percent')), JSON.stringify(accepted.issues));
  assert.ok(dataDifferences.some(i => i.title.includes('stereo.ee')), JSON.stringify(accepted.issues));
  const visualFact = accepted.facts.find(f => f.evidenceOrigin === 'image_table_ocr' && f.field === 'yield.percent');
  const evidence = await service.getEvidence({ projectId: project.id, runId: accepted.id, evidenceId: visualFact.id });
  assert.equal(evidence.block.metadata.originalSourceSha256, sha(ctx.original));
  assert.equal(evidence.block.metadata.rasterSha256, asset.sha256);
  assert.equal(evidence.block.metadata.visualReviewStatus, 'accepted');
  assert.equal(evidence.block.metadata.cells[4].originalOCRText, originalRows[1].cells[4].text);
  assert.deepEqual(evidence.block.metadata.cells[4].bbox, originalRows[1].cells[4].bbox);
  assert.match(evidence.block.locator.label, new RegExp(result.id));

  const oldRun = await service.getRun({ projectId: project.id, runId: provisional.id });
  assert.equal(oldRun.imageTablesChangedSinceRun, true);
  assert.equal(oldRun.imageTables[0].review.status, 'needs_review');
  assert.deepEqual(oldRun.imageTables[0].rows, originalRows);
  assert.deepEqual(await readFile(path.join(service.dir(project.id), 'runs', `${provisional.id}.json`)), originalRunBytes);

  // A later decision must not rewrite the already accepted run, either.
  const acceptedRunBytes = await readFile(path.join(service.dir(project.id), 'runs', `${accepted.id}.json`));
  await service.reviewImageTable({ projectId: project.id, tableId: result.id, status: 'rejected', reason: 'Fixture human withdraws this transcription for further review.' });
  const rejected = await service.runAudit({ projectId: project.id });
  assert.equal(rejected.coverage.imageTables.rejectedTables, 1);
  assert.equal(rejected.documents.filter(d => d.format === 'image_table').length, 0);
  assert.deepEqual(await readFile(path.join(service.dir(project.id), 'runs', `${accepted.id}.json`)), acceptedRunBytes);

  await service.reviewImageTable({ projectId: project.id, tableId: result.id, status: 'accepted', reason: 'Fixture human accepts the unchanged cells after rechecking.' });
  const changed = structuredClone(TRANSCRIPTION); changed[1][4] = '81';
  await writeFile(ctx.source, tableImage(changed));
  const stale = await service.runAudit({ projectId: project.id });
  assert.deepEqual(stale.coverage.imageTables.staleTables, [result.id]);
  assert.equal(stale.coverage.imageTables.acceptedTables, 0);
  assert.equal(stale.documents.filter(d => d.format === 'image_table').length, 0);
  assert.ok(stale.facts.every(f => f.evidenceOrigin !== 'image_table_ocr'));
  const historical = await service.getRun({ projectId: project.id, runId: accepted.id });
  assert.equal(historical.sourcesChangedSinceRun, true);
  assert.equal(historical.imageTables[0].source.sourceSha256, sha(ctx.original));
  assert.equal(historical.imageTables[0].rows[1].cells[4].text, '80');
});

test('visual service rejects unregistered, cross-project and changed raster assets', async t => {
  const { service, project, asset, original, source } = await setup(t);
  const other = await service.createProject({ name: 'Other project' });
  await assert.rejects(service.prepareVisuals({ projectId: other.id, documentKey: asset.documentKey }), /Document key not found/);
  await assert.rejects(service.prepareVisuals({ projectId: project.id, documentKey: '../escape' }), /Document key not found/);
  await assert.rejects(service.getVisualImage({ projectId: other.id, assetId: asset.id }), /registered/);
  await assert.rejects(service.getVisualImage({ projectId: project.id, assetId: asset.path }), /registered/);
  await assert.rejects(service.readImageTable({ projectId: other.id, assetId: asset.id }), /registered/);
  await assert.rejects(service.reviewImageTable({ projectId: other.id, tableId: 'table-other-project', status: 'accepted', reason: 'Wrong project' }), /not found in project/);

  // Even a forged project record cannot point the image reader into a peer project.
  const otherFile = path.join(service.dir(other.id), 'project.json');
  const otherState = JSON.parse(await readFile(otherFile, 'utf8'));
  otherState.visualAssets.push(asset);
  await writeFile(otherFile, JSON.stringify(otherState));
  await mkdir(path.join(service.dir(other.id), 'visuals'));
  await assert.rejects(service.getVisualImage({ projectId: other.id, assetId: asset.id }), /escaped its project/);

  const registered = await service.getVisualImage({ projectId: project.id, assetId: asset.id });
  assert.equal(sha(registered.data), asset.sha256);
  await writeFile(asset.path, Buffer.concat([Buffer.from(registered.data), Buffer.from('tampered')]));
  await assert.rejects(service.getVisualImage({ projectId: project.id, assetId: asset.id }), /changed/);
  await assert.rejects(service.readImageTable({ projectId: project.id, assetId: asset.id }), /changed/);
  assert.deepEqual(await readFile(source), original);
});

test('invalid review corrections cannot mutate an OCR table or review revision', { timeout: 120000 }, async t => {
  const { service, project, asset } = await setup(t);
  const table = await service.readImageTable({ projectId: project.id, assetId: asset.id });
  const tableFile = path.join(service.dir(project.id), 'tables', `${table.id}.json`), before = await readFile(tableFile);
  const revision = (await service.getProject(project.id)).visualRevision;
  for (const corrections of [[{ row: 0, column: 1, text: 'bad' }], [{ row: 2, column: 7, text: 'bad' }], [{ row: 2, column: 5, text: '81', bbox: {} }], [{ row: 2, column: 5, text: 81 }]]) {
    await assert.rejects(service.reviewImageTable({ projectId: project.id, tableId: table.id, status: 'accepted', reason: 'invalid correction', corrections }), /correction|does not exist/i);
    assert.deepEqual(await readFile(tableFile), before);
    assert.equal((await service.getProject(project.id)).visualRevision, revision);
  }
});

test('unaccepted OCR cannot confirm a unit-format difference', { timeout: 120000 }, async t => {
  const values = structuredClone(TRANSCRIPTION); values[0][3] = 'temperature'; values[1][3] = '25 K';
  const { service, project, asset } = await setup(t, values);
  await service.setProfile({ projectId: project.id, profile: {
    schema_version: 1,
    profile: { id: 'fixture-units', name: 'Fixture human preference', version: '1.0.0', source_type: 'user_defined', journal: null },
    rules: [{ id: 'temp-celsius', field: 'reaction.temperature', scope: 'si', expected_unit: '°C' }],
  } });
  const table = await service.readImageTable({ projectId: project.id, assetId: asset.id });
  assert.equal(table.review.status, 'needs_review');
  const run = await service.runAudit({ projectId: project.id });
  assert.ok(run.facts.some(f => f.field === 'reaction.temperature' && f.unit === 'K' && f.unverifiedVisual));
  const unitDifference = run.issues.find(i => i.ruleId === 'temp-celsius');
  assert.ok(unitDifference, 'a provisional unit mismatch should remain visible');
  assert.notEqual(unitDifference.evidenceStatus, 'confirmed_difference');
  await service.reviewImageTable({ projectId: project.id, tableId: table.id, status: 'accepted', reason: 'Fixture human confirms the printed Kelvin unit.' });
  const accepted = await service.runAudit({ projectId: project.id });
  assert.equal(accepted.issues.find(i => i.ruleId === 'temp-celsius').evidenceStatus, 'confirmed_difference');
});
