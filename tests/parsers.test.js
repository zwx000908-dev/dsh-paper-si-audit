import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { parseDocument, PARSER_LIMITS, fileByteLimit } from '../src/parsers.js';

async function fixture(t, name, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paper-audit-parser-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('paper-audit-parser-'));
    return rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents);
  return filePath;
}

function docxFixture(body, additional = {}) {
  return zipSync({
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...additional,
  });
}

function centralEntry(bytes, name) {
  for (let offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); offset >= 0; offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4)) {
    const length = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + length).toString() === name) return offset;
  }
  throw new Error('Missing fixture ZIP entry');
}

function pdfFixture() {
  const pageOneText = 'BT /F1 12 Tf 50 750 Td (Compound 3a: 98.0% ee.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${pageOneText.length} >>\nstream\n${pageOneText}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

test('text imports preserve literal decimals and source bytes; IDs depend on content and role, not name', async t => {
  const filePath = await fixture(t, 'main.md', 'Compound 3a: 98.00% ee.\nSI 数据 <0.001 ppm\n');
  const before = await readFile(filePath);
  const document = await parseDocument({ filePath });
  const renamed = path.join(path.dirname(filePath), 'renamed.md');
  await writeFile(renamed, before);
  const again = await parseDocument({ filePath: renamed });
  const si = await parseDocument({ filePath, role: 'si' });
  assert.equal(document.id, again.id);
  assert.notEqual(document.id, si.id);
  assert.equal(document.blocks[0].text, 'Compound 3a: 98.00% ee.');
  assert.equal(document.blocks[1].locator.line, 2);
  assert.equal(document.coverage.status, 'complete');
  assert.deepEqual(await readFile(filePath), before);
});

test('CSV preserves column context, quoted records, trailing zeros and multiline source records', async t => {
  const filePath = await fixture(t, 'data.csv', 'compound,ee,note\r\n3a,98.00,"line one\nline two"\r\n3b,96.0,"=DO_NOT_EXECUTE()"\r\n');
  const document = await parseDocument({ filePath, role: 'si' });
  assert.equal(document.blocks.length, 3);
  assert.equal(document.blocks[1].metadata.cells[1].header, 'ee');
  assert.equal(document.blocks[1].metadata.cells[1].text, '98.00');
  assert.equal(document.blocks[1].metadata.cells[2].text, 'line one\nline two');
  assert.equal(document.blocks[1].locator.line, 2);
  assert.equal(document.blocks[2].locator.line, 4);
  assert.match(document.blocks[1].metadata.rawRecord, /98\.00/);
  assert.equal(document.blocks[2].metadata.cells[2].text, '=DO_NOT_EXECUTE()');
});

test('JSON imports preserve record field context and explain unknown lexical precision', async t => {
  const filePath = await fixture(t, 'data.json', '[{"compound":"3a","ee":98.00,"reported":"98.00"}]');
  const document = await parseDocument({ filePath });
  assert.equal(document.blocks[0].metadata.cells[0].header, 'compound');
  assert.equal(document.blocks[0].metadata.cells[2].text, '98.00');
  assert.equal(document.blocks[0].metadata.cells[1].precisionKnown, false);
  assert.equal(document.blocks[0].metadata.cells[2].precisionKnown, true);
  assert.match(document.coverage.warnings.join(' '), /precision is unknown/i);
});

test('DOCX keeps body order, table row context and note evidence, excluding tracked deletions', async t => {
  const bytes = docxFixture(
    '<w:p><w:r><w:t>First: 3a.</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>compound</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>ee</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>3a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>98.00%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:del><w:r><w:delText>OLD 99%</w:delText></w:r></w:del><w:ins><w:r><w:t>Current 98%</w:t></w:r></w:ins><w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
    { 'word/footnotes.xml': strToU8('<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="-1"><w:p><w:r><w:t>separator</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>NMR yield, not isolated.</w:t></w:r></w:p></w:footnote></w:footnotes>') },
  );
  const filePath = await fixture(t, 'paper.docx', bytes);
  const document = await parseDocument({ filePath });
  assert.equal(document.blocks[0].text, 'First: 3a.');
  assert.equal(document.blocks[2].metadata.cells[1].header, 'ee');
  assert.equal(document.blocks[2].metadata.cells[1].text, '98.00%');
  assert.match(document.blocks[3].text, /Current 98%\[footnote:1\]/);
  assert.ok(!document.blocks.some(block => block.text.includes('OLD')));
  assert.ok(document.blocks.some(block => block.text === 'NMR yield, not isolated.'));
  assert.ok(!document.blocks.some(block => block.text === 'separator'));
  assert.equal(document.coverage.status, 'partial');
  assert.match(document.coverage.warnings.join(' '), /Tracked deletions/);
});

test('DOCX external entities are rejected before XML parsing', async t => {
  const bytes = zipSync({ 'word/document.xml': strToU8('<!DOCTYPE x [<!ENTITY injected SYSTEM "file:///secret">]><w:document xmlns:w="test"><w:body><w:p><w:r><w:t>&injected;</w:t></w:r></w:p></w:body></w:document>') });
  const filePath = await fixture(t, 'unsafe.docx', bytes);
  await assert.rejects(parseDocument({ filePath }), { code: 'UNSAFE_XML' });
});

test('Office archive traversal and declared decompression bombs are rejected without extraction', async t => {
  const traversal = zipSync({ '../outside.xml': strToU8('do not extract'), 'word/document.xml': strToU8('<x/>') });
  const traversalPath = await fixture(t, 'traversal.docx', traversal);
  await assert.rejects(parseDocument({ filePath: traversalPath }), { code: 'UNSAFE_ARCHIVE' });
  const bomb = Buffer.from(docxFixture('<w:p><w:r><w:t>x</w:t></w:r></w:p>'));
  const central = bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bomb.writeUInt32LE(PARSER_LIMITS.expandedBytes + 1, central + 24);
  const bombPath = await fixture(t, 'bomb.docx', bomb);
  await assert.rejects(parseDocument({ filePath: bombPath }), { code: 'ARCHIVE_LIMIT' });
});

test('XLSX reports cached formulas and numeric display limitations without calculating formulas', async t => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Results');
  worksheet.addRow(['compound', 'ee', 'reported', 'formula']);
  worksheet.addRow(['3a', 98, '98.00', { formula: '1+1', result: 2 }]);
  worksheet.getCell('B2').numFmt = '0.00';
  const filePath = await fixture(t, 'data.xlsx', await workbook.xlsx.writeBuffer());
  const document = await parseDocument({ filePath, role: 'source' });
  const row = document.blocks.find(block => block.locator.row === 2);
  assert.equal(row.locator.sheet, 'Results');
  assert.equal(row.metadata.cells[1].text, '98');
  assert.equal(row.metadata.cells[1].numberFormat, '0.00');
  assert.equal(row.metadata.cells[1].precisionKnown, false);
  assert.equal(row.metadata.cells[2].text, '98.00');
  assert.equal(row.metadata.cells[3].text, '2');
  assert.equal(row.metadata.cells[3].cachedFormula, true);
  assert.equal(document.coverage.status, 'partial');
  assert.match(document.coverage.warnings.join(' '), /not calculated/);
});

test('PDF retains page anchors and explicitly records pages without a text layer', async t => {
  const filePath = await fixture(t, 'paper.pdf', pdfFixture());
  const document = await parseDocument({ filePath });
  assert.equal(document.coverage.totalUnits, 2);
  assert.equal(document.coverage.parsedUnits, 1);
  assert.equal(document.coverage.status, 'partial');
  assert.equal(document.blocks[0].locator.page, 1);
  assert.match(document.blocks[0].text, /98\.0% ee/);
  assert.match(document.coverage.warnings.join(' '), /page 2: no readable text layer/);
  assert.ok(document.blocks[0].metadata.textItems[0].x > 0);
});

test('empty sources, unsupported files and invalid UTF-8 never pass silently', async t => {
  const empty = await fixture(t, 'empty.txt', '\n');
  const document = await parseDocument({ filePath: empty });
  assert.equal(document.coverage.status, 'failed');
  const unsupported = await fixture(t, 'macro.docm', 'not supported');
  await assert.rejects(parseDocument({ filePath: unsupported }), { code: 'UNSUPPORTED_FORMAT' });
  const encoding = await fixture(t, 'bad.txt', Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(parseDocument({ filePath: encoding }), { code: 'TEXT_ENCODING' });
});

test('oversized inputs are rejected using file size before reading them', async t => {
  const filePath = await fixture(t, 'large.txt', '');
  const handle = await open(filePath, 'r+');
  try { await handle.truncate(PARSER_LIMITS.fileBytes + 1); } finally { await handle.close(); }
  await assert.rejects(parseDocument({ filePath }), { code: 'FILE_LIMIT' });
});

test('original DOCX larger than 32 MiB is read without media/OLE inflation or a stripped derivative', async t => {
  const xml = strToU8('<w:document xmlns:w="test"><w:body><w:p><w:r><w:t>Compound 3a: 98.00% ee.</w:t></w:r></w:p></w:body></w:document>');
  const media = new Uint8Array(PARSER_LIMITS.fileBytes + 1);
  const original = zipSync({ 'word/document.xml': [xml, { level: 0 }], 'word/media/spectrum.emf': [media, { level: 0 }], 'word/embeddings/oleObject1.bin': strToU8('not executed') });
  assert.ok(original.length > PARSER_LIMITS.fileBytes);
  const filePath = await fixture(t, 'large-original.docx', original);
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const result = await parseDocument({ filePath, role: 'si' });
  assert.equal(result.sha256, sourceHash);
  assert.equal(createHash('sha256').update(await readFile(filePath)).digest('hex'), sourceHash);
  assert.equal(result.blocks[0].text, 'Compound 3a: 98.00% ee.');
  assert.equal(result.coverage.archive.sourceSha256, sourceHash);
  assert.equal(result.coverage.archive.unparsedMediaParts.count, 1);
  assert.equal(result.coverage.archive.unparsedMediaParts.declaredExpandedBytes, media.length);
  assert.equal(result.coverage.archive.unparsedEmbeddedParts.count, 1);
  assert.equal(result.coverage.archive.selectedXml.parts[0].sha256, createHash('sha256').update(xml).digest('hex'));
  assert.equal(result.coverage.archive.derivativeFileCreated, false);
  assert.equal(result.coverage.status, 'partial');
  assert.match(result.coverage.warnings.join(' '), /1 media\/figure part.*1 embedded\/OLE part/);
  assert.equal(fileByteLimit('paper.docx'), PARSER_LIMITS.officeFileBytes);
  assert.equal(fileByteLimit('paper.xlsx'), PARSER_LIMITS.officeFileBytes);
  assert.equal(fileByteLimit('paper.pdf'), PARSER_LIMITS.fileBytes);
});

test('skipped media with enormous declared expansion is inventoried while selected XML bombs and CRC corruption are rejected', async t => {
  const safeXml = '<w:p><w:r><w:t>Source text stays readable.</w:t></w:r></w:p>';
  const mediaName = 'word/media/large.emf';
  const skipped = Buffer.from(docxFixture(safeXml, { [mediaName]: strToU8('opaque skipped binary') }));
  const skippedEntry = centralEntry(skipped, mediaName);
  const declared = PARSER_LIMITS.expandedBytes + 12345;
  skipped.writeUInt32LE(declared, skippedEntry + 24);
  // These bytes are invalid DEFLATE. Successful text import proves they are not decoded.
  const local = skipped.readUInt32LE(skippedEntry + 42);
  const payload = local + 30 + skipped.readUInt16LE(local + 26) + skipped.readUInt16LE(local + 28);
  skipped[ payload ] = 0xff;
  const source = await fixture(t, 'opaque-media.docx', skipped);
  const doc = await parseDocument({ filePath: source });
  assert.equal(doc.coverage.archive.unparsedMediaParts.declaredExpandedBytes, declared);
  assert.equal(doc.coverage.archive.selectedXml.count, 1);
  assert.equal(doc.blocks[0].text, 'Source text stays readable.');
  const bomb = Buffer.from(docxFixture(safeXml));
  bomb.writeUInt32LE(PARSER_LIMITS.xmlBytes + 1, centralEntry(bomb, 'word/document.xml') + 24);
  await assert.rejects(parseDocument({ filePath: await fixture(t, 'xml-bomb.docx', bomb) }), { code: 'ARCHIVE_LIMIT' });
  const crc = Buffer.from(docxFixture(safeXml));
  crc.writeUInt32LE(0, centralEntry(crc, 'word/document.xml') + 16);
  await assert.rejects(parseDocument({ filePath: await fixture(t, 'bad-crc.docx', crc) }), { code: 'INVALID_ARCHIVE' });
});

test('visual-only DOCX table cells are explicitly outside the readable-unit coverage', async t => {
  const filePath = await fixture(t, 'image-table.docx', docxFixture('<w:p><w:r><w:t>Table S1</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:pict/></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing/></w:r></w:p>'));
  const doc = await parseDocument({ filePath });
  assert.deepEqual(doc.coverage.unreadableVisualUnits, { paragraphs: 1, tableRows: 1, tables: 1 });
  assert.equal(doc.coverage.totalUnits, 3);
  assert.equal(doc.coverage.parsedUnits, 1);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.coverage.unreadableVisualLocations.items[0].precedingReadableText, 'Table S1');
  assert.equal(doc.coverage.unreadableVisualLocations.items[0].locator.table, 1);
  assert.match(doc.coverage.warnings.join(' '), /numeric cells\/figures were not checked/);
});

test('XLSX cell evidence is decoded through a bounded XML-only view and does not load embedded payloads', async t => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Results');
  sheet.addRow(['compound', 'yield']); sheet.addRow(['3a', '86.0']);
  const parts = unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  parts['xl/media/image1.png'] = strToU8('skipped media');
  parts['xl/embeddings/oleObject1.bin'] = strToU8('skipped OLE');
  const bytes = Buffer.from(zipSync(parts));
  bytes.writeUInt32LE(PARSER_LIMITS.expandedBytes + 1, centralEntry(bytes, 'xl/media/image1.png') + 24);
  const filePath = await fixture(t, 'with-objects.xlsx', bytes);
  const doc = await parseDocument({ filePath });
  assert.equal(doc.blocks[1].metadata.cells[1].text, '86.0');
  assert.equal(doc.coverage.archive.extraction, 'selected_xml_only');
  assert.equal(doc.coverage.archive.unparsedMediaParts.count, 1);
  assert.equal(doc.coverage.archive.unparsedEmbeddedParts.count, 1);
  assert.equal(doc.coverage.status, 'partial');
  assert.ok(doc.coverage.archive.selectedXml.parts.every(part => !/media|embeddings/.test(part.name)));
});

test('Office file limit is bounded separately from text/PDF limits before reading', async t => {
  const filePath = await fixture(t, 'too-large.docx', '');
  const handle = await open(filePath, 'r+');
  try { await handle.truncate(PARSER_LIMITS.officeFileBytes + 1); } finally { await handle.close(); }
  await assert.rejects(parseDocument({ filePath }), { code: 'FILE_LIMIT' });
});
