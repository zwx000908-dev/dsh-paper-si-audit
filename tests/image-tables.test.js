import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync, strToU8 } from 'fflate';
import { inspectVisuals, readImageTable, detectGrid } from '../src/image-tables.js';

const out = fileURLToPath(new URL('../test-output/', import.meta.url));
async function fixture(t) { await mkdir(out, { recursive: true }); const dir = await mkdtemp(path.join(out, 'image-tables-')); t.after(async () => { assert.equal(path.dirname(dir), path.resolve(out)); await rm(dir, { recursive: true, force: true }); }); return dir; }
function tableImage() {
  const canvas = createCanvas(1040, 500), c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, canvas.width, canvas.height); c.fillStyle = 'black'; c.strokeStyle = 'black'; c.lineWidth = 3;
  const xs = [20, 270, 520, 770, 1020], ys = [20, 135, 250, 365, 480];
  for (const x of xs) { c.beginPath(); c.moveTo(x, ys[0]); c.lineTo(x, ys.at(-1)); c.stroke(); }
  for (const y of ys) { c.beginPath(); c.moveTo(xs[0], y); c.lineTo(xs.at(-1), y); c.stroke(); }
  c.font = '38px Arial';
  [['Entry', 'Temp', 'Yield', 'ee'], ['1', '25', '92', '98'], ['2', '40', '80', '96'], ['3', '60', '>99', '<0.1']].forEach((row, y) => row.forEach((text, x) => c.fillText(text, xs[x] + 30, ys[y] + 70)));
  return { canvas, c };
}

test('actual offline OCR recovers a raster table into bounded cell candidates', { timeout: 90000 }, async t => {
  const dir = await fixture(t), source = path.join(dir, 'table.png'), { canvas, c } = tableImage(); const bytes = canvas.toBuffer('image/png'); await writeFile(source, bytes);
  const grid = detectGrid(c, canvas.width, canvas.height); assert.equal(grid.horizontalLines.length, 5); assert.equal(grid.verticalLines.length, 5);
  const result = await readImageTable({ imagePath: source, outputDir: path.join(dir, 'ocr') });
  assert.equal(result.status, 'needs_review', JSON.stringify(result.notes)); assert.equal(result.layout, 'detected_grid'); assert.equal(result.rows.length, 4); assert.ok(result.rows.every(r => r.cells.length === 4));
  assert.equal(result.rows[1].cells[2].text, '92'); assert.equal(result.rows[2].cells[3].text, '96'); assert.match(result.rows[0].cells[0].text, /Entry/i);
  assert.equal(result.sourceSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.provider.route, 'local_wasm'); assert.equal(result.provider.networkRequestsRequired, false);
  for (const row of result.rows) for (const cell of row.cells) { assert.ok(cell.bbox.x >= 0 && cell.bbox.y >= 0 && cell.bbox.width > 0 && cell.bbox.height > 0); assert.ok(cell.bbox.x + cell.bbox.width <= canvas.width && cell.bbox.y + cell.bbox.height <= canvas.height); }
  assert.ok(result.notes.some(note => /punctuation/.test(note))); assert.deepEqual(await readFile(source), bytes);
});

test('DOCX image inventory keeps caption/part provenance and only renders explicitly selected raster media', async t => {
  const dir = await fixture(t), source = path.join(dir, 'table.docx'); const image = tableImage().canvas.toBuffer('image/png');
  const document = '<w:document xmlns:w="w" xmlns:r="r"><w:body><w:p><w:r><w:t>Table S1. Optimization</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId1" xmlns:a="a"/></w:drawing></w:r></w:p></w:body></w:document>';
  const rels = '<Relationships><Relationship Id="rId1" Target="media/image1.png" Type="image"/></Relationships>';
  const bytes = zipSync({ 'word/document.xml': strToU8(document), 'word/_rels/document.xml.rels': strToU8(rels), 'word/media/image1.png': image, 'word/embeddings/object.bin': strToU8('not executed') }); await writeFile(source, bytes);
  const inventory = await inspectVisuals({ filePath: source, documentId: 'd', outputDir: path.join(dir, 'assets') });
  assert.equal(inventory.assets.length, 0); assert.equal(inventory.candidates.length, 1); assert.equal(inventory.candidates[0].locator.tableCaptionCandidate, true); assert.equal(inventory.candidates[0].locator.paragraph, 2);
  const selected = await inspectVisuals({ filePath: source, documentId: 'd', outputDir: path.join(dir, 'assets'), selection: { parts: ['word/media/image1.png'] } });
  assert.equal(selected.assets[0].status, 'ready'); assert.equal(selected.assets[0].sourceSha256, createHash('sha256').update(bytes).digest('hex')); assert.ok(selected.assets[0].sourcePartSha256); assert.equal(selected.assets[0].locator.part, 'word/media/image1.png');
  await assert.rejects(inspectVisuals({ filePath: source, outputDir: path.join(dir, 'assets'), selection: { parts: ['word/embeddings/object.bin'] } }), /actual DOCX media/);
  assert.deepEqual(await readFile(source), Buffer.from(bytes));
});

function pdfBytes() {
  const content = 'BT /F1 22 Tf 30 80 Td (Table S1  Yield 92) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; } const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(pdf);
}
test('PDF pages are inventoried without OCR and selected pages really rasterize with page provenance', async t => {
  const dir = await fixture(t), source = path.join(dir, 'table.pdf'); await writeFile(source, pdfBytes());
  const inventory = await inspectVisuals({ filePath: source, outputDir: path.join(dir, 'assets') }); assert.equal(inventory.candidates.length, 1); assert.equal(inventory.assets.length, 0);
  const result = await inspectVisuals({ filePath: source, outputDir: path.join(dir, 'assets'), selection: { pages: [1] } }); assert.equal(result.assets.length, 1); assert.equal(result.assets[0].locator.page, 1); assert.equal(result.assets[0].mime, 'image/png'); assert.ok((await readFile(result.assets[0].path)).length > 100);
  await assert.rejects(inspectVisuals({ filePath: source, outputDir: path.join(dir, 'assets'), selection: { pages: [2] } }), /valid PDF/);
});

test('blank images fail explicitly; invalid crop and path cannot masquerade as readable tables', { timeout: 90000 }, async t => {
  const dir = await fixture(t), source = path.join(dir, 'blank.png'), canvas = createCanvas(300, 120); const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 300, 120); await writeFile(source, canvas.toBuffer('image/png'));
  const result = await readImageTable({ imagePath: source, outputDir: path.join(dir, 'ocr') }); assert.equal(result.status, 'failed'); assert.equal(result.rows.length, 0);
  await assert.rejects(readImageTable({ imagePath: source, outputDir: path.join(dir, 'ocr'), crop: { x: 200, y: 0, width: 200, height: 40 } }), /Crop/);
  await assert.rejects(readImageTable({ imagePath: 'relative.png', outputDir: path.join(dir, 'ocr') }), /absolute/);
  const signal = new AbortController(); signal.abort(); await assert.rejects(readImageTable({ imagePath: source, outputDir: path.join(dir, 'ocr'), signal: signal.signal }));
});

test('borderless aligned table candidates preserve pixel crop offsets and never become verified facts', { timeout: 90000 }, async t => {
  const dir = await fixture(t), source = path.join(dir, 'borderless.jpg'), canvas = createCanvas(1000, 400), c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 1000, 400); c.fillStyle = 'black'; c.font = '40px Arial';
  [['Entry', 'Yield', 'ee'], ['1', '92', '98'], ['2', '80', '96']].forEach((row, y) => row.forEach((text, x) => c.fillText(text, 100 + x * 300, 120 + y * 90)));
  await writeFile(source, canvas.toBuffer('image/jpeg'));
  const r = await readImageTable({ imagePath: source, outputDir: path.join(dir, 'ocr'), crop: { x: 70, y: 50, width: 850, height: 320 } });
  assert.equal(r.status, 'needs_review'); assert.equal(r.layout, 'aligned_columns_candidate'); assert.equal(r.rows.length, 3); assert.ok(r.rows.every(row => row.cells.length === 3), JSON.stringify(r.rows)); assert.equal(r.rows[1].cells[1].text, '92'); assert.ok(r.rows[0].cells[0].bbox.x >= 70 && r.rows[0].cells[0].bbox.y >= 50);
  assert.ok(r.notes.some(note => /column semantics remain unverified/.test(note)));
});

test('single-frame TIFF rasterizes locally with a pixel limit; malformed TIFF directory is refused', async t => {
  const dir = await fixture(t), source = path.join(dir, 'table.tiff'); const { default: UTIF } = await import('utif'); const { canvas, c } = tableImage();
  const rgba = c.getImageData(0, 0, canvas.width, canvas.height).data;
  await writeFile(source, Buffer.from(UTIF.encodeImage(rgba.buffer, canvas.width, canvas.height)));
  const result = await inspectVisuals({ filePath: source, outputDir: path.join(dir, 'images') }); assert.equal(result.assets[0].status, 'ready'); assert.equal(result.assets[0].imageWidth, 1040); assert.equal(result.assets[0].imageHeight, 500);
  const corrupt = path.join(dir, 'corrupt.tiff'); await writeFile(corrupt, Buffer.from([73, 73, 42, 0, 255, 255, 255, 127])); await assert.rejects(inspectVisuals({ filePath: corrupt, outputDir: path.join(dir, 'images') }), /TIFF directory/);
});

test('oversized raster headers are refused before native pixel decoding', async t => {
  const dir = await fixture(t), file = path.join(dir, 'oversized.png'); const bytes = Buffer.alloc(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.writeUInt32BE(13000, 16); bytes.writeUInt32BE(1000, 20); await writeFile(file, bytes);
  await assert.rejects(inspectVisuals({ filePath: file, outputDir: path.join(dir, 'images') }), /pixel budget/);
  const lossless = Buffer.alloc(26); lossless.write('RIFF'); lossless.writeUInt32LE(18, 4); lossless.write('WEBP', 8); lossless.write('VP8L', 12); lossless.writeUInt32LE(5, 16); lossless[20] = 0x2f;
  lossless.writeUInt32LE((12999 | (999 << 14)) >>> 0, 21);
  const webp = path.join(dir, 'oversized-lossless.webp'); await writeFile(webp, lossless);
  await assert.rejects(inspectVisuals({ filePath: webp, outputDir: path.join(dir, 'images') }), /pixel budget/);
});
