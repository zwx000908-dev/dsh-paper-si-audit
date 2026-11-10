import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as plugin from '../src/plugin.js';
import { defaultProfile } from '../src/profiles.js';

const exec = () => ({ signal: new AbortController().signal });
const byName = (service, name) => plugin.createToolDefinitions(service).find(tool => tool.name === name);

test('tool schema rejects invalid role and review state before service invocation', async () => {
  let calls = 0;
  const service = { addDocument() { calls++; }, reviewIssue() { calls++; } };
  await assert.rejects(byName(service, 'paper_audit_add_document').execute({ projectId: 'p', filePath: 'x', role: 'invented' }, exec()));
  await assert.rejects(byName(service, 'paper_audit_review').execute({ projectId: 'p', runId: 'r', issueId: 'i', status: 'closed', reason: 'looks fine' }, exec()));
  assert.equal(calls, 0);
});

test('cancelled tool never begins an operation', async () => {
  let called = false;
  const controller = new AbortController(); controller.abort();
  const tool = byName({ listProjects() { called = true; return []; } }, 'paper_audit_projects');
  await assert.rejects(tool.execute({}, { signal: controller.signal }));
  assert.equal(called, false);
});

test('source-block pagination makes bounds and truncated text explicit', async () => {
  const blocks = [{ id: 'b1', locator: { label: 'p1' }, text: 'a'.repeat(7000) }, { id: 'b2', locator: { label: 'p2' }, text: 'second' }];
  const service = { getRun: async () => ({ id: 'r', documents: [{ id: 'd', name: 'SI', blocks }] }) };
  const tool = byName(service, 'paper_audit_blocks');
  const result = await tool.execute({ projectId: 'p', documentId: 'd', limit: 1 }, exec());
  assert.equal(result.total, 2); assert.equal(result.nextOffset, 1);
  assert.equal(result.items[0].text.length, 6000); assert.equal(result.items[0].totalCharacters, 7000);
  assert.equal(result.items[0].truncated, true);
  await assert.rejects(tool.execute({ projectId: 'p', documentId: 'd', limit: 101 }, exec()));
  await assert.rejects(tool.execute({ projectId: 'p', documentId: 'missing' }, exec()));
});

test('evidence windows preserve exact offsets and original fact metadata', async () => {
  const evidence = { document: { id: 'd' }, block: { id: 'b', text: '1234567890', locator: { label: 'line1' } }, fact: { id: 'f', raw: '456', offset: 3 } };
  const tool = byName({ getEvidence: async () => evidence }, 'paper_audit_evidence');
  const result = await tool.execute({ projectId: 'p', evidenceId: 'f', start: 3, length: 3 }, exec());
  assert.equal(result.block.text, '456'); assert.equal(result.window.nextStart, 6);
  assert.equal(result.fact.offset, 3); assert.equal(evidence.block.text, '1234567890');
  await assert.rejects(tool.execute({ projectId: 'p', evidenceId: 'f', start: -1 }, exec()));
});

test('run returns summary without leaking entire source blocks to model context', async () => {
  const run = { id: 'r', projectId: 'p', profile: defaultProfile(), documents: [{ id: 'd', name: 'main', role: 'main', blocks: [{ text: 'private full text' }], coverage: { status: 'partial' } }], facts: [{ id: 'f' }], issues: [], coverage: { semanticStatus: 'not_run' }, hrmsSettingsChangedSinceRun: true, imageTablesChangedSinceRun: false };
  const summary = await byName({ runAudit: async () => run }, 'paper_audit_run').execute({ projectId: 'p' }, exec());
  assert.equal(summary.factCount, 1); assert.equal(summary.documents[0].blockCount, 1);
  assert.equal(JSON.stringify(summary).includes('private full text'), false);
  assert.equal(summary.coverage.semanticStatus, 'not_run');
  assert.equal(summary.hrmsSettingsChangedSinceRun, true); assert.equal(summary.imageTablesChangedSinceRun, false);
});

test('image table ID selects full row pagination with provenance and bounded defaults', async () => {
  const calls = [];
  const service = {
    listImageTables() { throw new Error('A table-ID query must not use preview listing'); },
    async getImageTable(args) {
      calls.push(args);
      return { id: args.tableId, assetId: 'a', source: { sourceSha256: 'original-hash', rasterSha256: 'raster-hash' }, provider: { route: 'local_wasm' }, status: 'needs_review', review: { status: 'needs_review' }, reviewHistory: [], rowCount: 35, items: [{ index: args.offset + 1, cells: [{ column: 1, text: 'row after preview', bbox: { x: 1, y: 2, width: 3, height: 4 } }] }], offset: args.offset, limit: args.limit, nextOffset: args.offset + args.limit < 35 ? args.offset + args.limit : null };
    },
  };
  const tool = byName(service, 'paper_audit_image_tables');
  const page = await tool.execute({ projectId: 'p', tableId: 't', offset: 30, limit: 5 }, exec());
  assert.deepEqual(calls[0], { projectId: 'p', tableId: 't', offset: 30, limit: 5 });
  assert.equal(page.rowCount, 35); assert.equal(page.items[0].index, 31); assert.equal(page.nextOffset, null);
  assert.equal(page.source.sourceSha256, 'original-hash'); assert.equal(page.source.rasterSha256, 'raster-hash');
  assert.deepEqual(page.items[0].cells[0].bbox, { x: 1, y: 2, width: 3, height: 4 });
  await tool.execute({ projectId: 'p', tableId: 't' }, exec());
  assert.deepEqual(calls[1], { projectId: 'p', tableId: 't', offset: 0, limit: 30 });
  await assert.rejects(tool.execute({ projectId: 'p', tableId: 't', offset: -1 }, exec()));
  await assert.rejects(tool.execute({ projectId: 'p', tableId: 't', limit: 101 }, exec()));
  assert.equal(calls.length, 2);
});

test('semantic candidate schema requires exact-quote evidence shape', async () => {
  let calls = 0;
  const tool = byName({ submitSemantic(args) { calls++; return { accepted: args.candidates.length }; } }, 'paper_audit_submit_semantic');
  const base = { projectId: 'p', runId: 'r', candidates: [{ title: 'Concern', description: 'Candidate only', severity: 'medium', evidence: [{ blockId: 'b', quote: 'actual' }] }] };
  assert.deepEqual(await tool.execute(base, exec()), { accepted: 1 });
  await assert.rejects(tool.execute({ ...base, candidates: [{ ...base.candidates[0], evidence: [{ blockId: 'b' }] }] }, exec()));
  await assert.rejects(tool.execute({ ...base, candidates: [{ ...base.candidates[0], arbitrary_code: 'execute' }] }, exec()));
  assert.equal(calls, 1);
});

test('profile tool validates declaration without assigning a journal', async () => {
  const tool = byName({}, 'paper_audit_profile_validate');
  const result = await tool.execute({ profileText: JSON.stringify(defaultProfile()) }, exec());
  assert.equal(result.valid, true); assert.equal(result.profile.profile.journal ?? null, null);
  await assert.rejects(tool.execute({ profileText: '{bad json' }, exec()));
});

test('DSH 0.2.2-rc.1 real Cordis/Tools registration, operation, and disposal smoke', async t => {
  const require = createRequire(import.meta.url);
  const packageVersion = async name => JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version;
  assert.equal(await packageVersion('@deepseek-ai/dsh-tools'), '0.2.2-rc.1');
  assert.equal(await packageVersion('@deepseek-ai/dsh-system-prompt'), '0.2.2-rc.1');
  assert.equal(await packageVersion('@deepseek-ai/cordis'), '4.1.0');
  assert.equal(await packageVersion('@deepseek-ai/schemastery'), '3.19.0');
  const root = await mkdtemp(path.join(tmpdir(), 'paper-si-native-'));
  const sources = path.join(root, 'sources'); await mkdir(sources);
  await writeFile(path.join(sources, 'main.txt'), 'Compound 3a: experiment=exp1; batch=b1; 98% ee.', 'utf8');
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(ToolsService);
  const native = await ctx.plugin(plugin, { dataDir: path.join(root, 'audit'), allowedRoots: [sources] });
  const names = ctx.tools.schemas().map(tool => tool.name);
  assert.equal(names.length, plugin.createToolDefinitions({}).length); assert.equal(names.length, 39); assert.ok(names.includes('paper_audit_prepare_image_audit')); assert.ok(names.includes('paper_audit_submit_semantic'));
  const project = await ctx.tools.get('paper_audit_create').execute({ name: 'native test' }, exec());
  assert.ok(project.id);
  const imported = await ctx.tools.get('paper_audit_add_document').execute({ projectId: project.id, filePath: path.join(sources, 'main.txt'), role: 'main' }, exec());
  assert.ok(imported);
  const run = await ctx.tools.get('paper_audit_run').execute({ projectId: project.id }, exec());
  assert.equal(run.execution.entryPoint, 'harness_native_tools');
  assert.ok(run.id); assert.equal(run.documents[0].name, 'main.txt');
  assert.equal(run.coverage.semanticStatus, 'not_run');
  await native.dispose();
  assert.equal(ctx.tools.schemas().length, 0);
});

test('visual selection and OCR crop keep exact project, source and pixel coordinates', async () => {
  const calls = [];
  const service = { prepareVisuals: async args => { calls.push(args); return { assets: [], coverage: { status: 'partial' } }; }, readImageTable: async args => { calls.push(args); return { id: 't', review: { status: 'needs_review' } }; } };
  const execution = exec();
  await byName(service, 'paper_audit_prepare_visuals').execute({ projectId: 'p', documentKey: 'k', pages: [2], parts: ['word/media/image1.png'] }, execution);
  assert.deepEqual(calls[0], { projectId: 'p', documentKey: 'k', selection: { pages: [2], parts: ['word/media/image1.png'] }, signal: execution.signal });
  const crop = { x: 10, y: 20, width: 300, height: 200 };
  const table = await byName(service, 'paper_audit_read_image_table').execute({ projectId: 'p', assetId: 'a', crop }, execution);
  assert.deepEqual(calls[1].crop, crop); assert.equal(calls[1].signal, execution.signal); assert.equal(table.review.status, 'needs_review');
  await assert.rejects(byName(service, 'paper_audit_read_image_table').execute({ projectId: 'p', assetId: 'a', crop: { left: 1, right: 2 } }, exec()));
  await assert.rejects(byName(service, 'paper_audit_prepare_visuals').execute({ projectId: 'p', documentKey: 'k', pages: [1.5] }, exec()));
});

test('image-table reviews use explicit finite states and never auto-accept OCR output', async () => {
  let calls = 0;
  const service = { reviewImageTable: async args => { calls++; return args; } };
  const tool = byName(service, 'paper_audit_review_image_table');
  await assert.rejects(tool.execute({ projectId: 'p', tableId: 't', status: 'verified_everything', reason: 'AI thinks so' }, exec()));
  assert.equal(calls, 0);
  assert.deepEqual(await tool.execute({ projectId: 'p', tableId: 't', status: 'accepted', reason: 'Synthetic test: human checked all cells against source image' }, exec()), { projectId: 'p', tableId: 't', status: 'accepted', reason: 'Synthetic test: human checked all cells against source image' });
  const corrected = await tool.execute({ projectId: 'p', tableId: 't', status: 'accepted', reason: 'Synthetic human corrected this source cell', corrections: [{ row: 2, column: 3, text: '0.30' }] }, exec());
  assert.deepEqual(corrected.corrections, [{ row: 2, column: 3, text: '0.30' }]);
  await assert.rejects(tool.execute({ projectId: 'p', tableId: 't', status: 'accepted', reason: 'Invalid geometry correction', corrections: [{ row: 2, column: 3, text: '0.30', bbox: { x: 0 } }] }, exec()));
});

test('visual-image fallback never claims delivery or returns raw image bytes without host attachments', async () => {
  const service = { getVisualImage: async () => ({ asset: { id: 'a', mime: 'image/png', imageWidth: 20, imageHeight: 10, sha256: 'source' }, data: Buffer.from([1, 2, 3]) }) };
  const tool = byName(service, 'paper_audit_visual_image');
  const value = await tool.execute({ projectId: 'p', assetId: 'a' }, exec());
  assert.equal(value.imageDelivered, false); assert.equal(value.data, undefined);
  assert.equal(tool.output.render({}, value).some(block => block.type === 'image'), false);
});

test('only image-capable host routes produce durable image blocks with coordinate metadata', async () => {
  let saves = 0;
  const imageAttachment = { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 3, width: 10, height: 5, originalDimensions: { width: 20, height: 10 } };
  const attachments = { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async args => { saves++; assert.deepEqual([...args.data], [1, 2, 3]); return imageAttachment; } };
  const service = { getVisualImage: async () => ({ asset: { id: 'a', mime: 'image/png', imageWidth: 20, imageHeight: 10, sourceSha256: 'source', path: 'source.png' }, data: new Uint8Array([1, 2, 3]) }) };
  const route = { modelSelection: { provider: 'test', model: 'vision' }, signal: new AbortController().signal };
  const vision = plugin.createToolDefinitions(service, { ctx: { get: key => key === 'attachments' ? attachments : { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } } }).find(t => t.name === 'paper_audit_visual_image');
  const value = await vision.execute({ projectId: 'p', assetId: 'a' }, route);
  assert.equal(value.imageDelivered, true); assert.equal(saves, 1); assert.equal(value.data, undefined);
  assert.deepEqual(vision.output.render({}, value).find(b => b.type === 'image').attachment, imageAttachment);
  const textOnly = plugin.createToolDefinitions(service, { ctx: { get: key => key === 'attachments' ? attachments : { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } } }).find(t => t.name === 'paper_audit_visual_image');
  assert.equal((await textOnly.execute({ projectId: 'p', assetId: 'a' }, route)).imageDelivered, false); assert.equal(saves, 1);
});

test('visual and OCR table pages omit unrequested full inventories from model context', async () => {
  const assets = [{ id: 'a' }, { id: 'b' }], tables = [{ id: 't1' }, { id: 't2' }];
  const service = { listVisuals: async () => ({ assets, coverage: { status: 'partial' } }), listImageTables: async () => ({ tables }) };
  const visual = await byName(service, 'paper_audit_visuals').execute({ projectId: 'p', limit: 1 }, exec());
  assert.equal(visual.total, 2); assert.equal(visual.items.length, 1); assert.equal(visual.assets, undefined); assert.equal(visual.nextOffset, 1);
  const table = await byName(service, 'paper_audit_image_tables').execute({ projectId: 'p', limit: 1 }, exec());
  assert.equal(table.tables, undefined); assert.equal(table.items[0].id, 't1');
});

test('native exact-mass calculator validates charge/basis and returns explicit interpretation candidates', async () => {
  const tool = byName({}, 'paper_audit_hrms_calculate');
  await assert.rejects(tool.execute({ formula: 'C2H6O', formulaBasis: 'guess_from_nearest_number' }, exec()));
  await assert.rejects(tool.execute({ formula: 'C2H6O', charge: 1.5 }, exec()));
  const result = await tool.execute({ formula: 'C2H6O', ion: '[M+H]+', formulaBasis: 'neutral' }, exec());
  assert.ok(Array.isArray(result.candidates) && result.candidates.length === 1);
});

test('removed web command cannot start a server or create audit state', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paper-si-no-web-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('paper-si-no-web-')); await rm(directory, { recursive: true, force: true }); });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const state = path.join(directory, 'never-created');
  const result = spawnSync(process.execPath, [cli, 'serve', '--data', state], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /移除/);
  await assert.rejects(access(state));
  await assert.rejects(access(fileURLToPath(new URL('../src/server.js', import.meta.url))));
  const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /No web server/); assert.match(help.stdout, /read-table/);
});
