import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parse as parseCsv } from 'csv-parse/sync';

export const PARSER_VERSION = '0.2.0';
export const PARSER_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 * 1024,
  officeFileBytes: 128 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  archiveEntries: 20_000,
  xmlBytes: 16 * 1024 * 1024,
  textCharacters: 8_000_000,
  blocks: 100_000,
  pdfPages: 5_000,
});

/** Limits apply to the original source; no stripped derivative is required. */
export function documentByteLimit(filePath) {
  return /\.(?:docx|xlsx)$/i.test(filePath) ? PARSER_LIMITS.officeFileBytes : PARSER_LIMITS.fileBytes;
}
export const fileByteLimit = documentByteLimit;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

/** Validate the ZIP directory before handing Office containers to any decoder. */
function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw failure('INVALID_ARCHIVE', 'Office file is not a valid ZIP archive.');
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + directorySize;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== entries) throw failure('UNSUPPORTED_ARCHIVE', 'Multi-volume Office archives are unsupported.');
  if (entries === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) throw failure('UNSUPPORTED_ARCHIVE', 'ZIP64 Office archives are unsupported in this MVP.');
  if (entries > PARSER_LIMITS.archiveEntries || directoryEnd > end) throw failure('ARCHIVE_LIMIT', 'Office archive directory exceeds parsing limits.');
  const members = new Map();
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw failure('INVALID_ARCHIVE', 'Invalid Office ZIP central directory.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || localOffset + 30 > bytes.length) throw failure('INVALID_ARCHIVE', 'Invalid Office archive member bounds.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const normalized = name.replaceAll('\\', '/');
    if (normalized !== name || /^(?:\/|[a-z]:)/i.test(normalized) || normalized.split('/').includes('..') || name.includes('\0') || members.has(name)) throw failure('UNSAFE_ARCHIVE', 'Unsafe or duplicate Office archive member.');
    if ((flags & 1) || ![0, 8].includes(method)) throw failure('UNSUPPORTED_ARCHIVE', 'Encrypted or unsupported Office archive compression.');
    if (expanded === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) throw failure('UNSUPPORTED_ARCHIVE', 'ZIP64 members are unsupported.');
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw failure('INVALID_ARCHIVE', 'Invalid Office archive local member.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > offset || view.getUint16(localOffset + 8, true) !== method || view.getUint16(localOffset + 6, true) !== flags) throw failure('INVALID_ARCHIVE', 'Invalid Office archive compressed member bounds or header mismatch.');
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name || method === 0 && compressed !== expanded) throw failure('INVALID_ARCHIVE', 'Office archive local name or stored size does not match directory.');
    members.set(name, { expanded, compressed, dataOffset, method, crc32 });
    offset = next;
  }
  if (offset !== directoryEnd) throw failure('INVALID_ARCHIVE', 'Office ZIP directory length does not match its entries.');
  return members;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32Of(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inflate only a bounded, explicit XML selection; media and OLE payloads are never decoded. */
function readXmlParts(bytes, members, selected) {
  let total = 0;
  for (const name of selected) {
    const member = members.get(name);
    if (!member) throw failure('INVALID_ARCHIVE', 'Selected Office XML part is absent.');
    if (member.expanded > PARSER_LIMITS.xmlBytes) throw failure('ARCHIVE_LIMIT', 'An Office XML part exceeds the 16 MiB parsing limit.');
    total += member.expanded;
    if (total > PARSER_LIMITS.expandedBytes) throw failure('ARCHIVE_LIMIT', 'Selected Office XML parts expand beyond the 128 MiB limit.');
  }
  const parts = Object.create(null);
  for (const name of selected) {
    const member = members.get(name);
    const compressed = bytes.subarray(member.dataOffset, member.dataOffset + member.compressed);
    let decoded;
    try { decoded = member.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, member.expanded) }); }
    catch (error) { throw failure(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'ARCHIVE_LIMIT' : 'INVALID_ARCHIVE', `Cannot safely decode Office XML part ${name}: ${error.message}`); }
    if (decoded.length !== member.expanded || crc32Of(decoded) !== member.crc32) throw failure('INVALID_ARCHIVE', `Office XML part size or CRC mismatch: ${name}`);
    // XML safety validation precedes Word/Excel decoders, including XLSX shared strings.
    decodeXml(decoded);
    parts[name] = decoded;
  }
  return parts;
}

/** Read bounded selected Office payloads without extracting paths or decoding unrelated parts. */
export function readOfficeEntries(bytes, { selectedNames = [], maxEntryBytes = PARSER_LIMITS.fileBytes } = {}) {
  if (bytes.length > PARSER_LIMITS.officeFileBytes) throw failure('FILE_LIMIT', 'Office container exceeds its input limit.');
  if (!Array.isArray(selectedNames) || selectedNames.length > PARSER_LIMITS.archiveEntries || !Number.isInteger(maxEntryBytes) || maxEntryBytes < 1 || maxEntryBytes > PARSER_LIMITS.expandedBytes) throw failure('ARCHIVE_LIMIT', 'Invalid selected Office entry limits.');
  const members = inspectZip(bytes), parts = Object.create(null); let total = 0;
  for (const name of new Set(selectedNames)) {
    const entry = members.get(name);
    if (!entry) throw failure('INVALID_ARCHIVE', 'Requested Office entry does not exist.');
    total += entry.expanded;
    if (entry.expanded > maxEntryBytes || total > PARSER_LIMITS.expandedBytes) throw failure('ARCHIVE_LIMIT', 'Selected Office payload exceeds decoding limits.');
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
    let value;
    try { value = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded) }); }
    catch { throw failure('INVALID_ARCHIVE', 'Cannot safely decode requested Office entry.'); }
    if (value.length !== entry.expanded || crc32Of(value) !== entry.crc32) throw failure('INVALID_ARCHIVE', 'Office entry size or CRC mismatch.');
    parts[name] = value;
  }
  return { members: [...members].map(([name, value]) => ({ name, expanded: value.expanded, compressed: value.compressed })), parts };
}

function archiveCoverage(bytes, members, selected, parts) {
  const names = [...members.keys()];
  const selectedNames = new Set(selected);
  const summarize = list => ({ count: list.length, compressedBytes: list.reduce((sum, name) => sum + members.get(name).compressed, 0), declaredExpandedBytes: list.reduce((sum, name) => sum + members.get(name).expanded, 0) });
  const media = names.filter(name => /^(?:word|xl)\/media\//i.test(name));
  const embeddings = names.filter(name => /^(?:word|xl)\/embeddings\//i.test(name));
  const skipped = names.filter(name => !selectedNames.has(name));
  return {
    extraction: 'selected_xml_only', sourceSha256: sha(bytes), inputBytes: bytes.length,
    originalArchive: summarize(names),
    selectedXml: { ...summarize([...selected]), parts: [...selected].map(name => ({ name, bytes: parts[name].length, sha256: sha(parts[name]) })) },
    unparsedMediaParts: summarize(media), unparsedEmbeddedParts: summarize(embeddings), unparsedOtherParts: summarize(skipped.filter(name => !media.includes(name) && !embeddings.includes(name))),
    sourceModified: false, derivativeFileCreated: false,
  };
}

function noteUnparsedArchive(acc, inventory, format) {
  for (const [key, label] of [['unparsedMediaParts', 'media/figure'], ['unparsedEmbeddedParts', 'embedded/OLE']]) {
    const group = inventory[key];
    if (group.count) acc.warnings.add(`${format}: ${group.count} ${label} part(s), ${group.compressedBytes} compressed bytes / ${group.declaredExpandedBytes} declared expanded bytes, were not decoded or checked; retained unchanged in the original source.`);
  }
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw failure('TEXT_ENCODING', 'Text must be UTF-8. Convert this file to UTF-8 before importing.'); }
}

function decodeXml(bytes) {
  if (bytes.length > PARSER_LIMITS.xmlBytes) throw failure('XML_LIMIT', 'An Office XML part exceeds the 16 MiB parsing limit.');
  const text = decodeUtf8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw failure('UNSAFE_XML', 'DTD and custom XML entities are not accepted.');
  const validation = XMLValidator.validate(text);
  if (validation !== true) throw failure('INVALID_XML', `Invalid Office XML: ${validation.err.msg}`);
  return text;
}

function createAccumulator(document) {
  let characters = 0;
  const warnings = new Set();
  const blocks = [];
  function add(text, locator, metadata = {}) {
    if (typeof text !== 'string' || !text.trim()) return;
    characters += text.length;
    if (characters > PARSER_LIMITS.textCharacters || blocks.length >= PARSER_LIMITS.blocks) throw failure('TEXT_LIMIT', 'Extracted text exceeds MVP parsing limits.');
    blocks.push({ id: `${document.id}:b${blocks.length + 1}`, text, locator, metadata });
  }
  return { blocks, warnings, add };
}

function stringValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function tableRow(acc, values, headers, locator, metadata = {}) {
  if (!values.some(value => String(value).trim())) return;
  const { cellDetails, ...rowMetadata } = metadata;
  acc.add(values.join('\t'), locator, {
    ...rowMetadata,
    headers,
    cells: values.map((text, index) => ({ column: index + 1, header: headers[index] || '', text, ...(cellDetails?.[index] || {}) })),
  });
}

function parseText(text, acc) {
  const lines = text.split(/\r\n|\n|\r/);
  let headers = null, table = 0, row = 0;
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
  lines.forEach((line, index) => {
    if (line.includes('|') && index + 1 < lines.length && cells(lines[index + 1]).every(c => /^:?-{3,}:?$/.test(c))) { headers = cells(line); table++; row = 0; }
    if (headers && cells(line).every(c => /^:?-{3,}:?$/.test(c))) return;
    if (headers && line.includes('|') && cells(line).length === headers.length) {
      const before = acc.blocks.length; tableRow(acc, cells(line), headers, { label: `Line ${index + 1}`, line: index + 1, table, row: ++row }, { headerInferred: true, headerRow: row === 1 });
      if (acc.blocks.length > before) acc.blocks.at(-1).text = line; // preserve exact source offsets for quotations
    } else { headers = null; acc.add(line, { label: `Line ${index + 1}`, line: index + 1 }); }
  });
  return { totalUnits: lines.length, parsedUnits: lines.length };
}

function parseCsvText(text, acc) {
  const records = parseCsv(text, { bom: true, info: true, raw: true, relax_column_count: false, skip_empty_lines: true, max_record_size: 2_000_000 });
  const headers = records[0]?.record.map(String) || [];
  records.forEach(({ record, info, raw }, index) => {
    const newlines = (raw.match(/\r\n|\n|\r/g) || []).length;
    const startLine = info.lines - newlines + (/\r\n$|\n$|\r$/.test(raw) ? 1 : 0);
    tableRow(acc, record.map(String), headers, { label: `CSV record ${index + 1} (lines ${startLine}–${info.lines})`, row: index + 1, line: startLine }, { rawRecord: raw, headerInferred: true, headerRow: index === 0 });
  });
  acc.warnings.add('CSV first record is used as candidate column headers; confirm header interpretation for headerless data.');
  return { totalUnits: records.length, parsedUnits: records.length, partial: false };
}

function parseJsonText(text, acc) {
  let data;
  try { data = JSON.parse(text); } catch { throw failure('INVALID_JSON', 'Source JSON is not valid JSON.'); }
  const records = Array.isArray(data) ? data : [data];
  if (records.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      tableRow(acc, headers.map(key => stringValue(row[key])), headers, { label: Array.isArray(data) ? `JSON $[${index}]` : 'JSON $', row: index + 1 }, {
        jsonPath: Array.isArray(data) ? `$[${index}]` : '$', structuredRecord: row,
        cellDetails: headers.map(key => ({ valueKind: typeof row[key], precisionKnown: typeof row[key] === 'string' })),
      });
    }
  } else {
    records.forEach((record, index) => acc.add(stringValue(record), { label: Array.isArray(data) ? `JSON $[${index}]` : 'JSON $', row: index + 1 }));
  }
  acc.warnings.add('JSON values are decoded data values, not original JSON lexical formatting; numeric display precision is unknown.');
  return { totalUnits: records.length, parsedUnits: records.length, partial: false };
}

const wordParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true });

function nodeKey(node) { return Object.keys(node).find(key => key !== ':@' && key !== '#text'); }

function wordText(nodes, warnings) {
  let result = '';
  for (const node of nodes || []) {
    if ('#text' in node) { result += String(node['#text']); continue; }
    const key = nodeKey(node);
    if (!key) continue;
    if (key === 'w:tab') result += '\t';
    else if (key === 'w:br' || key === 'w:cr') result += '\n';
    else if (key === 'w:footnoteReference' || key === 'w:endnoteReference') result += `[${key === 'w:footnoteReference' ? 'footnote' : 'endnote'}:${node[':@']?.['@_w:id'] ?? '?'}]`;
    else if (key === 'w:del' || key === 'w:moveFrom') warnings.add('Tracked deletions/moves are excluded from extracted current-view text; resolve tracked changes before final audit.');
    else if (key === 'w:drawing' || key === 'w:pict' || key.startsWith('m:')) warnings.add('DOCX drawings, chemical structures and Office Math are not interpreted.');
    else if (key === 'w:instrText' || key === 'w:fldChar') warnings.add('DOCX fields use stored display text; field instructions are not executed.');
    else if (key === 'w:sym') warnings.add('DOCX legacy font-symbol runs could not be reliably decoded.');
    else {
      if (key === 'w:ins' || key === 'w:moveTo') warnings.add('Tracked insertions/moves are included in extracted current-view text; resolve tracked changes before final audit.');
      result += wordText(node[key], warnings);
    }
  }
  return result;
}

function containsWordVisual(nodes) {
  return (nodes || []).some(node => {
    const key = nodeKey(node);
    return key && (['w:drawing', 'w:pict', 'w:object'].includes(key) || key.startsWith('m:') || Array.isArray(node[key]) && containsWordVisual(node[key]));
  });
}

function parseDocx(bytes, acc) {
  const members = inspectZip(bytes);
  if (!members.has('word/document.xml')) throw failure('INVALID_DOCX', 'DOCX has no word/document.xml part.');
  const selected = new Set([...members.keys()].filter(name => /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(name) || name === '_rels/.rels' || /^word\/_rels\/[^/]+\.xml\.rels$/.test(name)).sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  const xmlParts = readXmlParts(bytes, members, selected);
  const inventory = archiveCoverage(bytes, members, selected, xmlParts);
  noteUnparsedArchive(acc, inventory, 'DOCX');
  if (members.has('word/comments.xml')) acc.warnings.add('DOCX comments are not included as manuscript evidence.');
  let totalUnits = 0;
  let tableNumber = 0;
  let paragraph = 0;
  let imageOnlyParagraphs = 0;
  let imageOnlyTableRows = 0;
  let imageOnlyTables = 0;
  let precedingReadableText = '';
  const visualLocations = [];
  let visualLocationTotal = 0;
  function noteVisual(kind, locator) {
    visualLocationTotal++;
    if (visualLocations.length < 200) visualLocations.push({ kind, locator, precedingReadableText: precedingReadableText.slice(0, 200) });
  }

  function content(nodes, region, prefix = '') {
    for (const node of nodes || []) {
      const key = nodeKey(node);
      if (key === 'w:p') {
        totalUnits++;
        paragraph++;
        const text = wordText(node[key], acc.warnings);
        if (!text.trim() && containsWordVisual(node[key])) { imageOnlyParagraphs++; noteVisual('paragraph', { label: `${region} paragraph ${paragraph}${prefix}`, paragraph, region }); }
        if (text.trim()) precedingReadableText = text;
        acc.add(text, { label: `${region} paragraph ${paragraph}${prefix}`, paragraph }, { region });
      } else if (key === 'w:tbl') {
        const table = ++tableNumber;
        const rows = node[key].filter(row => nodeKey(row) === 'w:tr');
        let headers = [];
        let hasReadableTableText = false;
        rows.forEach((rowNode, rowIndex) => {
          const cells = rowNode['w:tr'].filter(cell => nodeKey(cell) === 'w:tc');
          const values = cells.map(cell => cell['w:tc'].filter(part => nodeKey(part) !== 'w:tcPr').map(part => wordText([part], acc.warnings)).join('\n'));
          if (values.some(value => value.trim())) { hasReadableTableText = true; precedingReadableText = values.join('\t'); }
          else if (containsWordVisual(rowNode['w:tr'])) { imageOnlyTableRows++; noteVisual('table_row', { label: `${region} table ${table}, row ${rowIndex + 1}`, table, row: rowIndex + 1, region }); }
          if (!rowIndex) headers = values;
          totalUnits++;
          tableRow(acc, values, headers, { label: `${region} table ${table}, row ${rowIndex + 1}`, table, row: rowIndex + 1 }, { region, headerInferred: true, headerRow: rowIndex === 0 });
          if (cells.some(cell => cell['w:tc'].some(part => nodeKey(part) === 'w:tbl'))) acc.warnings.add('Nested DOCX tables are linearized inside their parent cell.');
        });
        if (!hasReadableTableText && containsWordVisual(node[key])) imageOnlyTables++;
      } else if (key === 'w:footnote' || key === 'w:endnote') {
        const id = node[':@']?.['@_w:id'];
        if (Number(id) < 1) continue;
        content(node[key], region, ` (note ${id})`);
      } else if (key && !['w:sectPr', 'w:tblPr', 'w:tblGrid'].includes(key)) content(node[key], region, prefix);
    }
  }

  for (const name of selected) {
    const xml = decodeXml(xmlParts[name]);
    if (name.endsWith('.rels')) {
      if (/TargetMode\s*=\s*["']External["']/i.test(xml)) acc.warnings.add('DOCX external links are not fetched or executed.');
      continue;
    }
    content(wordParser.parse(xml), name);
  }
  if (imageOnlyParagraphs || imageOnlyTableRows || imageOnlyTables) acc.warnings.add(`DOCX has ${imageOnlyParagraphs} visual-only paragraph(s), ${imageOnlyTableRows} visual-only table row(s), including ${imageOnlyTables} table(s) without readable text. Their numeric cells/figures were not checked.`);
  acc.warnings.add('DOCX run formatting is flattened; superscript/subscript styling and visual figure content require source review.');
  return { totalUnits, parsedUnits: totalUnits - imageOnlyParagraphs - imageOnlyTableRows, partial: true, archive: inventory, unreadableVisualUnits: { paragraphs: imageOnlyParagraphs, tableRows: imageOnlyTableRows, tables: imageOnlyTables }, unreadableVisualLocations: { total: visualLocationTotal, items: visualLocations, truncated: visualLocationTotal > visualLocations.length } };
}

async function parsePdf(bytes, acc, signal) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: true, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    if (document.numPages > PARSER_LIMITS.pdfPages) throw failure('PDF_LIMIT', 'PDF exceeds the 5000 page MVP limit.');
    let parsedUnits = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let text = '';
        const items = [];
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          if (text && !text.endsWith('\n') && !text.endsWith(' ') && item.str) text += ' ';
          const start = text.length;
          text += item.str;
          items.push({ start, end: text.length, x: item.transform?.[4], y: item.transform?.[5], width: item.width, height: item.height });
          if (item.hasEOL) text += '\n';
        }
        if (text.trim()) {
          parsedUnits++;
          acc.add(text, { label: `PDF page ${pageNumber}`, page: pageNumber }, { textItems: items, extraction: 'pdf-text-layer' });
        } else acc.warnings.add(`PDF page ${pageNumber}: no readable text layer; OCR/image analysis is not implemented.`);
      } catch (error) {
        if (error.code === 'TEXT_LIMIT') throw error;
        acc.warnings.add(`PDF page ${pageNumber}: text extraction failed (${error.message}).`);
      } finally { page.cleanup(); }
    }
    acc.warnings.add('PDF text is linearized from the text layer; reading order, tables, vector figures and spectra require visual review. OCR is not implemented.');
    return { totalUnits: document.numPages, parsedUnits, partial: true };
  } finally { await loading.destroy(); }
}

async function parseXlsx(bytes, acc) {
  const members = inspectZip(bytes);
  if (!members.has('xl/workbook.xml')) throw failure('INVALID_XLSX', 'XLSX has no xl/workbook.xml part.');
  const selected = new Set([...members.keys()].filter(name => /^(?:\[Content_Types\]\.xml|_rels\/\.rels|xl\/(?:workbook|styles|sharedStrings)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/(?:sheet\d+\.xml|_rels\/sheet\d+\.xml\.rels)|xl\/tables\/table\d+\.xml)$/.test(name)));
  const xmlParts = readXmlParts(bytes, members, selected);
  const inventory = archiveCoverage(bytes, members, selected, xmlParts);
  noteUnparsedArchive(acc, inventory, 'XLSX');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  // ExcelJS otherwise decodes every archive member. Give it only bounded XML,
  // without creating a file or treating this internal view as a new source.
  await workbook.xlsx.load(zipSync(xmlParts, { level: 0 }), { ignoreNodes: ['drawing', 'legacyDrawing', 'picture', 'oleObjects', 'extLst'] });
  let totalUnits = 0;
  let partial = false;
  if ([...members.keys()].some(name => /(?:drawings|media|externalLinks|vbaProject)/i.test(name))) {
    partial = true;
    acc.warnings.add('XLSX drawings, images, macros and external links are not interpreted or executed.');
  }
  for (const worksheet of workbook.worksheets) {
    let headers;
    if (worksheet.state !== 'visible') acc.warnings.add(`Worksheet ${worksheet.name} is ${worksheet.state}; its stored cells are included.`);
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = [];
      const cellDetails = [];
      for (let column = 1; column <= row.cellCount; column++) {
        const cell = row.getCell(column);
        const value = cell.value;
        const detail = { address: cell.address, numberFormat: cell.numFmt || 'General', valueKind: typeof value, precisionKnown: typeof value === 'string' };
        let text = '';
        if (value instanceof Date) {
          text = value.toISOString(); partial = true; detail.valueKind = 'date';
          acc.warnings.add('XLSX date cells are rendered as ISO values; original displayed formatting is not reconstructed.');
        } else if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          text = stringValue(value.result); detail.formula = value.formula || value.sharedFormula; detail.cachedFormula = true; partial = true;
          acc.warnings.add('XLSX formulas are not calculated; only stored cached results are shown and may be stale.');
        } else if (value && typeof value === 'object' && 'richText' in value) text = value.richText.map(run => run.text).join('');
        else if (value && typeof value === 'object' && 'hyperlink' in value) { text = value.text || ''; acc.warnings.add('XLSX hyperlinks are displayed as stored text and are not opened.'); }
        else if (value && typeof value === 'object' && 'error' in value) { text = value.error; partial = true; acc.warnings.add('XLSX contains stored cell errors; affected values require review.'); }
        else text = stringValue(value);
        if (typeof value === 'number') {
          partial = true;
          acc.warnings.add('XLSX numeric cells use stored numbers; displayed trailing zeros and measurement precision cannot be inferred. Check numberFormat metadata before format judgments.');
        }
        values.push(text); cellDetails.push(detail);
      }
      const isHeader = !headers;
      if (!headers) headers = values;
      totalUnits++;
      tableRow(acc, values, headers, { label: `${worksheet.name}, row ${rowNumber}`, sheet: worksheet.name, row: rowNumber }, { cellDetails, headerInferred: true, headerRow: isHeader, worksheetState: worksheet.state });
    });
  }
  return { totalUnits, parsedUnits: totalUnits, partial, archive: inventory };
}

/** Read-only MVP import. Parsing failures throw coded errors; absent content is explicit. */
export async function parseDocument({ filePath, role = 'main', signal } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw failure('INVALID_PATH', 'A non-empty document path is required.');
  if (typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(role)) throw failure('INVALID_ROLE', 'Document role must be a short identifier.');
  const information = await stat(filePath);
  if (!information.isFile()) throw failure('INVALID_PATH', 'Document path must refer to a regular file.');
  const limit = fileByteLimit(filePath);
  if (information.size > limit) throw failure('FILE_LIMIT', `Document exceeds the ${limit / 1024 / 1024} MiB input limit for its format.`);
  const bytes = await readFile(filePath, { signal });
  if (bytes.length > limit) throw failure('FILE_LIMIT', `Document changed or exceeds the ${limit / 1024 / 1024} MiB input limit for its format.`);
  const extension = path.extname(filePath).toLowerCase();
  const sha256 = sha(bytes);
  const document = { id: `doc-${sha(`${sha256}:${role}`).slice(0,20)}`, name: path.basename(filePath), role, sha256, format: extension.slice(1), parserVersion: PARSER_VERSION };
  const acc = createAccumulator(document);
  let coverage;
  switch (extension) {
    case '.txt': case '.md': coverage = parseText(decodeUtf8(bytes), acc); break;
    case '.csv': coverage = parseCsvText(decodeUtf8(bytes), acc); break;
    case '.json': coverage = parseJsonText(decodeUtf8(bytes), acc); break;
    case '.docx': coverage = parseDocx(bytes, acc); break;
    case '.pdf': coverage = await parsePdf(bytes, acc, signal); break;
    case '.xlsx': coverage = await parseXlsx(bytes, acc); break;
    case '.png': case '.jpg': case '.jpeg': case '.tif': case '.tiff': case '.webp': case '.bmp':
      coverage = { totalUnits: 1, parsedUnits: 0, partial: true, visualOnly: true };
      acc.warnings.add('Standalone image retained as source; select and OCR a table before using any numeric reading.');
      break;
    default: throw failure('UNSUPPORTED_FORMAT', `Unsupported document type ${extension || '(none)'}. Supported: TXT, MD, CSV, JSON, DOCX, text-layer PDF, XLSX.`);
  }
  signal?.throwIfAborted();
  if (!acc.blocks.length) acc.warnings.add('No non-empty text evidence was extracted. This document was not successfully audited.');
  return {
    ...document,
    blocks: acc.blocks,
    coverage: {
      ...Object.fromEntries(Object.entries(coverage).filter(([key]) => key !== 'partial')),
      status: coverage.visualOnly ? 'partial' : !acc.blocks.length ? 'failed' : coverage.partial ? 'partial' : 'complete',
      totalUnits: coverage.totalUnits,
      parsedUnits: coverage.parsedUnits,
      warnings: [...acc.warnings],
    },
  };
}
