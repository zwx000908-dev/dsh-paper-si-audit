import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { readOfficeEntries } from './parsers.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export const IMAGE_TABLE_LIMITS = Object.freeze({ officeBytes: 128 * 1024 * 1024, otherBytes: 32 * 1024 * 1024, decodedPartBytes: 32 * 1024 * 1024, xmlBytes: 16 * 1024 * 1024, pixels: 20_000_000, dimension: 12000, selectedPages: 10, selectedParts: 20, ocrTimeoutMs: 90000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const makeID = (...parts) => 'visual_' + hash(JSON.stringify(parts)).slice(0, 24);
const fail = message => { throw new Error(message); };
function bounds(width, height) { if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= IMAGE_TABLE_LIMITS.dimension) || width * height > IMAGE_TABLE_LIMITS.pixels) fail('Image dimensions exceed the bounded OCR pixel budget'); }
function preflightRaster(bytes) {
  if (!bytes || bytes.length < 12) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && bytes.subarray(1, 4).toString() === 'PNG') bounds(view.getUint32(16), view.getUint32(20));
  else if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) bounds(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
  else if (bytes[0] === 255 && bytes[1] === 216) {
    let p = 2, steps = 0;
    while (p + 3 < bytes.length && steps++ < 10000) {
      if (bytes[p++] !== 255) continue; while (bytes[p] === 255) p++; const marker = bytes[p++];
      if ([216, 217, 218].includes(marker)) break; if (marker >= 208 && marker <= 215) continue;
      if (p + 2 > bytes.length) break; const length = view.getUint16(p);
      if (length < 2 || p + length > bytes.length) fail('JPEG header exceeds source bounds');
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) { if (length < 7) fail('Malformed JPEG frame'); bounds(view.getUint16(p + 5), view.getUint16(p + 3)); return; }
      p += length;
    }
    fail('JPEG has no bounded readable frame header');
  } else if (bytes.length >= 16 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    const type = bytes.subarray(12, 16).toString();
    if (type === 'VP8X') {
      if (bytes.length < 30) fail('Malformed WebP extended header');
      bounds(1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536, 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536);
    } else if (type === 'VP8L') {
      if (bytes.length < 25 || bytes[20] !== 0x2f) fail('Malformed WebP lossless header');
      // VP8L: signature followed by little-endian 14-bit (width-1),
      // 14-bit (height-1), alpha hint and a zero 3-bit version.
      const dimensions = view.getUint32(21, true);
      if (dimensions >>> 29) fail('Unsupported WebP lossless version');
      bounds(1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff));
    } else if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) bounds(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
  }
}
async function inputBytes(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail('An absolute source path is required');
  const info = await stat(filePath);
  const limit = /\.docx$/i.test(filePath) ? IMAGE_TABLE_LIMITS.officeBytes : IMAGE_TABLE_LIMITS.otherBytes;
  if (!info.isFile() || info.size > limit) fail('Source exceeds image-table file limit');
  const bytes = await readFile(filePath); if (bytes.length > limit) fail('Source changed beyond the bounded file limit'); return bytes;
}
function zipIndex(bytes) {
  return new Map(readOfficeEntries(bytes).members.map(member => [member.name, member]));
}
function zipPart(bytes, member, limit = IMAGE_TABLE_LIMITS.decodedPartBytes) {
  if (!member || member.expanded > limit) fail('Selected DOCX part exceeds decode limit');
  return readOfficeEntries(bytes, { selectedNames: [member.name], maxEntryBytes: limit }).parts[member.name];
}
function docxMediaLocations(bytes, members) {
  const locations = new Map(); if (!members.has('word/document.xml')) fail('DOCX document.xml missing');
  const xml = zipPart(bytes, members.get('word/document.xml'), IMAGE_TABLE_LIMITS.xmlBytes).toString('utf8');
  const relMember = members.get('word/_rels/document.xml.rels');
  const rels = relMember ? zipPart(bytes, relMember, IMAGE_TABLE_LIMITS.xmlBytes).toString('utf8') : '';
  if (/<!DOCTYPE|<!ENTITY/i.test(xml + rels)) fail('External entities are not permitted');
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false });
  const relationships = parser.parse(rels)?.Relationships?.Relationship ?? [];
  const byID = new Map((Array.isArray(relationships) ? relationships : [relationships]).filter(r => r && r['@_TargetMode'] !== 'External').map(r => [r['@_Id'], path.posix.normalize(path.posix.join('word', r['@_Target'] ?? ''))]));
  let paragraph = 0, preceding = '';
  for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    paragraph++; const fragment = match[0];
    const texts = [...fragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')).join('');
    for (const image of fragment.matchAll(/(?:r:embed|r:id)\s*=\s*["']([^"']+)["']/g)) {
      const part = byID.get(image[1]); if (!part || !/^word\/media\//.test(part)) continue;
      const list = locations.get(part) ?? [];
      list.push({ kind: 'docx_media', paragraph, paragraphIndexBasis: 'XML w:p occurrence including nested graphics; not a rendered Word page or parser block index', xmlOffset: match.index, relationshipId: image[1], part, precedingText: preceding.slice(-300), currentText: texts.slice(0, 200), tableCaptionCandidate: /\bTable\s+S?\d|表\s*\d/i.test(preceding.slice(-200) + ' ' + texts) }); locations.set(part, list);
    }
    if (texts.trim()) preceding = texts;
  }
  return locations;
}
async function rasterizeMetafile(input, output, signal) {
  if (process.platform !== 'win32') fail('EMF/WMF conversion needs Windows GDI; use an exported PNG or PDF page on this platform');
  const b64 = text => Buffer.from(text, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(input)}')); $dst=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(output)}')); $img=[Drawing.Image]::FromFile($src); try { if($img.Width -le 0 -or $img.Height -le 0 -or $img.Width -gt 12000 -or $img.Height -gt 12000){ throw 'Metafile dimensions exceed limit' }; $scale=[Math]::Min(3.0,[Math]::Sqrt(20000000.0/($img.Width*$img.Height))); $w=[Math]::Max(1,[int]($img.Width*$scale)); $h=[Math]::Max(1,[int]($img.Height*$scale)); $bmp=New-Object Drawing.Bitmap($w,$h); try { $g=[Drawing.Graphics]::FromImage($bmp); try { $g.Clear([Drawing.Color]::White); $g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::HighQuality; $g.DrawImage($img,0,0,$w,$h) } finally { $g.Dispose() }; $bmp.Save($dst,[Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() } } finally { $img.Dispose() }`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 65536, signal });
}
async function normalizedImage(bytesOrPath) {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const bytes = typeof bytesOrPath === 'string' ? await readFile(bytesOrPath) : bytesOrPath;
  preflightRaster(bytes);
  if (bytes?.length >= 8 && ((bytes[0] === 73 && bytes[1] === 73) || (bytes[0] === 77 && bytes[1] === 77))) {
    const little = bytes[0] === 73, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(2, little) !== 42) fail('BigTIFF or an unsupported TIFF header cannot be decoded');
    let pointer = view.getUint32(4, little); const visited = new Set();
    while (pointer) {
      if (visited.has(pointer) || visited.size >= 20 || pointer + 2 > bytes.length) fail('Cyclic or oversized TIFF directory'); visited.add(pointer);
      const count = view.getUint16(pointer, little), end = pointer + 2 + count * 12;
      if (count > 4096 || end + 4 > bytes.length) fail('TIFF directory exceeds source bounds');
      for (let i = 0; i < count; i++) { const tag = view.getUint16(pointer + 2 + i * 12, little); if ([330, 34665, 34853, 40965].includes(tag)) fail('Nested TIFF/EXIF directories are unsupported by the bounded table-image decoder'); }
      pointer = view.getUint32(end, little);
    }
    const { default: UTIF } = await import('utif'); const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ifds = UTIF.decode(buffer).filter(ifd => ifd.t256?.[0] && ifd.t257?.[0]);
    if (ifds.length !== 1) fail('Select or export one TIFF image frame; multi-frame TIFF is not silently reduced to one page');
    const ifd = ifds[0], width = Number(ifd.t256[0]), height = Number(ifd.t257[0]); bounds(width, height);
    const channels = Number(ifd.t277?.[0] ?? 1), bits = Math.max(...(ifd.t258 ?? [1]));
    if (channels > 4 || bits > 16 || width * height * channels * bits / 8 > 128 * 1024 * 1024) fail('TIFF channel depth exceeds decode budget');
    UTIF.decodeImage(buffer, ifd); const rgba = UTIF.toRGBA8(ifd);
    if (rgba.length !== width * height * 4) fail('TIFF decoded dimensions mismatch');
    const canvas = createCanvas(width, height), context = canvas.getContext('2d'), data = context.createImageData(width, height); data.data.set(rgba); context.putImageData(data, 0, 0);
    return { canvas, context, width, height };
  }
  const image = await loadImage(bytesOrPath); bounds(image.width, image.height);
  const canvas = createCanvas(image.width, image.height); const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, image.width, image.height); context.drawImage(image, 0, 0);
  return { canvas, context, width: image.width, height: image.height };
}

/** Inventory does not OCR spectra or select all embedded images. Explicit selection produces bounded assets. */
export async function inspectVisuals({ filePath, documentId, outputDir, selection = {}, signal } = {}) {
  const bytes = await inputBytes(filePath), sourceSha256 = hash(bytes), extension = path.extname(filePath).toLowerCase();
  if (!outputDir || !path.isAbsolute(outputDir)) fail('An absolute project-owned outputDir is required');
  await mkdir(outputDir, { recursive: true }); const assets = [], candidates = [];
  if (selection.crop) fail('Crop is applied by readImageTable after selecting/rendering an asset, not during visual inventory');
  if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const directory = name => path.join(pdfRoot, name).replaceAll('\\', '/') + '/';
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0, standardFontDataUrl: directory('standard_fonts'), cMapUrl: directory('cmaps'), cMapPacked: true, wasmUrl: directory('wasm') });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 5000) fail('PDF page limit exceeded');
      for (let page = 1; page <= pdf.numPages; page++) candidates.push({ id: makeID(sourceSha256, page), locator: { kind: 'pdf_page', page }, status: 'unread', note: 'Page image candidate; not necessarily a table.' });
      const pages = selection.pages ?? []; if (!Array.isArray(pages) || pages.length > IMAGE_TABLE_LIMITS.selectedPages || pages.some(n => !Number.isInteger(n) || n < 1 || n > pdf.numPages)) fail('Select at most 10 valid PDF page numbers');
      for (const pageNumber of [...new Set(pages)]) {
        signal?.throwIfAborted(); const page = await pdf.getPage(pageNumber);
        try {
          const base = page.getViewport({ scale: 1 }); const scale = Math.min(3, Math.sqrt(IMAGE_TABLE_LIMITS.pixels / (base.width * base.height)), IMAGE_TABLE_LIMITS.dimension / Math.max(base.width, base.height));
          const viewport = page.getViewport({ scale }); const factory = pdf.canvasFactory; const pair = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: pair.context, viewport }).promise;
          const png = pair.canvas.toBuffer('image/png'); const sha256 = hash(png), id = makeID(sourceSha256, pageNumber); const target = path.join(outputDir, `${id}.png`); await writeFile(target, png);
          assets.push({ id, path: target, mime: 'image/png', imageWidth: Math.ceil(viewport.width), imageHeight: Math.ceil(viewport.height), sourceSha256, sha256, documentId, locator: { kind: 'pdf_page', page: pageNumber, scale }, status: 'ready', notes: ['Rendered page; table content has not yet been OCR-verified.'] }); factory.destroy(pair);
        } finally { page.cleanup(); }
      }
    } finally { await loading.destroy(); }
  } else if (extension === '.docx') {
    const members = zipIndex(bytes), locations = docxMediaLocations(bytes, members);
    for (const [part, member] of members) if (/^word\/media\//i.test(part)) candidates.push({ id: makeID(sourceSha256, part), locator: locations.get(part)?.[0] ?? { kind: 'docx_media', part }, locations: locations.get(part) ?? [], part, compressedBytes: member.compressed, declaredExpandedBytes: member.expanded, status: 'unread', note: 'Embedded media candidate; spectra/structures are not automatically read as tables.' });
    const parts = selection.parts ?? []; if (!Array.isArray(parts) || parts.length > IMAGE_TABLE_LIMITS.selectedParts || parts.some(name => typeof name !== 'string' || !/^word\/media\//.test(name) || !members.has(name))) fail('Select at most 20 actual DOCX media parts');
    for (const part of [...new Set(parts)]) {
      signal?.throwIfAborted(); const id = makeID(sourceSha256, part), locator = locations.get(part)?.[0] ?? { kind: 'docx_media', part };
      try {
        const payload = zipPart(bytes, members.get(part)); const sourcePartSha256 = hash(payload); const ext = path.extname(part).toLowerCase(); const target = path.join(outputDir, `${id}.png`);
        if (['.emf', '.wmf'].includes(ext)) { const original = path.join(outputDir, `${id}${ext}`); await writeFile(original, payload); await rasterizeMetafile(original, target, signal); }
        else if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(ext)) { const { canvas } = await normalizedImage(payload); await writeFile(target, canvas.toBuffer('image/png')); }
        else fail(`Unsupported embedded image type ${ext}; export an image or PDF page`);
        const raster = await inputBytes(target), normalized = await normalizedImage(raster);
        assets.push({ id, path: target, mime: 'image/png', imageWidth: normalized.width, imageHeight: normalized.height, sourceSha256, sourcePartSha256, sha256: hash(raster), documentId, locator, status: 'ready', notes: ['Only selected media converted; original DOCX and embeddings remain unchanged.'] });
      } catch (error) { assets.push({ id, documentId, sourceSha256, locator, status: 'failed', notes: [String(error.message)] }); }
    }
  } else if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(extension)) {
    const image = await normalizedImage(bytes), id = makeID(sourceSha256), target = path.join(outputDir, `${id}.png`); const png = image.canvas.toBuffer('image/png'); await writeFile(target, png);
    assets.push({ id, path: target, mime: 'image/png', imageWidth: image.width, imageHeight: image.height, sourceSha256, sha256: hash(png), documentId, locator: { kind: 'standalone_image' }, status: 'ready', notes: ['Standalone image; interpretation requires OCR and review.'] }); candidates.push({ id, locator: { kind: 'standalone_image' }, status: 'selected' });
  } else fail('Visual inspection supports PDF, DOCX and raster image files');
  return { sourceSha256, documentId, assets, candidates, coverage: { candidateCount: candidates.length, selectedCount: assets.length, readyCount: assets.filter(a => a.status === 'ready').length, failedCount: assets.filter(a => a.status === 'failed').length, unselectedCount: Math.max(0, candidates.length - assets.length), status: 'partial', notes: ['Inventory and rendering are not table recognition. Unselected images, spectra, structures and OLE are not checked.'] } };
}

function clusteredLines(counts, minimum, extent) {
  const bands = []; let start = -1;
  for (let p = 0; p <= counts.length; p++) {
    if (p < counts.length && counts[p] >= minimum * extent) { if (start < 0) start = p; }
    else if (start >= 0) { bands.push(Math.round((start + p - 1) / 2)); start = -1; }
  }
  return bands;
}
export function detectGrid(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data; const horizontal = new Uint32Array(height), vertical = new Uint32Array(width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 4; if (pixels[at + 3] > 80 && (pixels[at] + pixels[at + 1] + pixels[at + 2]) < 450) { horizontal[y]++; vertical[x]++; } }
  return { horizontalLines: clusteredLines(horizontal, 0.45, width), verticalLines: clusteredLines(vertical, 0.45, height) };
}
function wordsFromTsv(tsv) {
  const lines = String(tsv ?? '').trim().split(/\r?\n/); const words = [];
  for (const line of lines.slice(1)) { const fields = line.split('\t'); if (fields[0] !== '5' || fields.length < 12) continue; const text = fields.slice(11).join('\t').trim(); if (!text) continue; const [x, y, width, height, confidence] = fields.slice(6, 11).map(Number); if (![x, y, width, height, confidence].every(Number.isFinite)) continue; words.push({ text, bbox: { x, y, width, height }, confidence }); }
  return words;
}
function rowsFromWords(words, grid, crop) {
  const { horizontalLines: ys, verticalLines: xs } = grid;
  if (ys.length >= 3 && xs.length >= 3 && ys.length <= 202 && xs.length <= 102) {
    const rows = [];
    for (let row = 0; row < ys.length - 1; row++) { const cells = [];
      for (let col = 0; col < xs.length - 1; col++) {
        const inside = words.filter(w => { const x = w.bbox.x + w.bbox.width / 2, y = w.bbox.y + w.bbox.height / 2; return x > xs[col] && x < xs[col + 1] && y > ys[row] && y < ys[row + 1]; }).sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
        cells.push({ column: col + 1, text: inside.map(w => w.text).join(' '), bbox: { x: xs[col] + crop.x, y: ys[row] + crop.y, width: xs[col + 1] - xs[col], height: ys[row + 1] - ys[row] }, confidence: inside.length ? Math.min(...inside.map(w => w.confidence)) : null, isHeaderCandidate: row === 0, wordCount: inside.length });
      }
      rows.push({ index: row + 1, cells });
    }
    return { rows, layout: 'detected_grid' };
  }
  // Borderless fallback keeps an explicit uncertain word-alignment structure, not an invented schema.
  const groups = [];
  for (const word of [...words].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const center = word.bbox.y + word.bbox.height / 2; let group = groups.find(g => Math.abs(g.center - center) < Math.max(8, word.bbox.height * 0.6));
    if (!group) { group = { center, words: [] }; groups.push(group); } group.words.push(word);
  }
  const groupedRows = groups.sort((a, b) => a.center - b.center).map(group => {
    const chunks = [];
    for (const word of group.words.sort((a, b) => a.bbox.x - b.bbox.x)) {
      const prior = chunks.at(-1); const gap = prior ? word.bbox.x - prior.right : Infinity;
      if (prior && gap < Math.max(20, word.bbox.height * 0.9)) { prior.words.push(word); prior.right = word.bbox.x + word.bbox.width; }
      else chunks.push({ left: word.bbox.x, right: word.bbox.x + word.bbox.width, words: [word] });
    }
    return chunks;
  });
  const starts = groupedRows.flatMap((chunks, row) => chunks.map(chunk => ({ x: chunk.left, row }))).sort((a, b) => a.x - b.x); const anchors = [];
  for (const start of starts) { let anchor = anchors.find(a => Math.abs(a.x - start.x) <= 25); if (!anchor) { anchor = { x: start.x, rows: new Set() }; anchors.push(anchor); } anchor.rows.add(start.row); }
  const columns = anchors.filter(a => a.rows.size >= Math.max(2, Math.ceil(groupedRows.length * 0.3))).map(a => a.x).sort((a, b) => a - b);
  if (columns.length >= 2 && columns.length <= 50) {
    return { layout: 'aligned_columns_candidate', rows: groupedRows.map((chunks, index) => ({ index: index + 1, cells: columns.map((anchor, col) => {
      const inside = chunks.filter(chunk => columns.reduce((best, current, i) => Math.abs(current - chunk.left) < Math.abs(columns[best] - chunk.left) ? i : best, 0) === col).flatMap(chunk => chunk.words);
      const left = inside.length ? Math.min(...inside.map(w => w.bbox.x)) : anchor, top = inside.length ? Math.min(...inside.map(w => w.bbox.y)) : groups[index].center;
      const right = inside.length ? Math.max(...inside.map(w => w.bbox.x + w.bbox.width)) : Math.min(crop.width, anchor + 1), bottom = inside.length ? Math.max(...inside.map(w => w.bbox.y + w.bbox.height)) : top + 1;
      return { column: col + 1, text: inside.map(w => w.text).join(' '), bbox: { x: left + crop.x, y: top + crop.y, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }, confidence: inside.length ? Math.min(...inside.map(w => w.confidence)) : null, isHeaderCandidate: index === 0, wordCount: inside.length };
    }) })) };
  }
  return { layout: 'word_rows_unverified_columns', rows: groups.map((group, index) => ({ index: index + 1, cells: group.words.sort((a, b) => a.bbox.x - b.bbox.x).map((word, column) => ({ column: column + 1, text: word.text, bbox: { ...word.bbox, x: word.bbox.x + crop.x, y: word.bbox.y + crop.y }, confidence: word.confidence, isHeaderCandidate: index === 0, wordCount: 1 })) })) };
}

/** Actual local OCR. Recognized cells are candidates, never automatically verified measurements. */
export async function readImageTable({ imagePath, outputDir, tableId, crop: requestedCrop, signal } = {}) {
  if (tableId !== undefined && (typeof tableId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tableId))) fail('tableId must be a bounded safe identifier');
  const bytes = await inputBytes(imagePath), sourceSha256 = hash(bytes), image = await normalizedImage(bytes);
  if (!outputDir || !path.isAbsolute(outputDir)) fail('An absolute project-owned outputDir is required');
  await mkdir(outputDir, { recursive: true }); signal?.throwIfAborted();
  const crop = requestedCrop ?? { x: 0, y: 0, width: image.width, height: image.height };
  if (!['x', 'y', 'width', 'height'].every(k => Number.isInteger(crop[k])) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) fail('Crop must be a valid integer image-pixel rectangle');
  const { createCanvas } = await import('@napi-rs/canvas'); const canvas = createCanvas(crop.width, crop.height), context = canvas.getContext('2d'); context.drawImage(image.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const grid = detectGrid(context, crop.width, crop.height);
  // Grid strokes interfere with glyph segmentation; retain original source/crop and record this preprocessing.
  context.fillStyle = 'white'; for (const y of grid.horizontalLines) context.fillRect(0, Math.max(0, y - 2), crop.width, 5); for (const x of grid.verticalLines) context.fillRect(Math.max(0, x - 2), 0, 5, crop.height);
  const id = tableId || makeID(sourceSha256, crop), imageFile = path.join(outputDir, `${makeID(sourceSha256, crop)}-ocr-input.png`);
  await writeFile(imageFile, canvas.toBuffer('image/png'));
  let worker, timeout, abort, cancelled = false;
  const notes = ['OCR is local and unverified. Numerical punctuation, inequalities, superscripts, footnotes and merged cells require visual confirmation.', 'English traineddata is packaged locally; non-English labels and chemical structure drawings are not reliably supported.', 'Confidence is an OCR engine score, not calibrated scientific correctness.'];
  try {
    const { createWorker, PSM } = await import('tesseract.js');
    const languageRoot = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    const langPath = path.join(languageRoot, '4.0.0_best_int');
    await stat(path.join(langPath, 'eng.traineddata.gz'));
    let rejectLimit;
    const limit = new Promise((_, reject) => { rejectLimit = reject; timeout = setTimeout(() => { cancelled = true; worker?.terminate(); reject(new Error('OCR execution exceeded the 90-second budget')); }, IMAGE_TABLE_LIMITS.ocrTimeoutMs); abort = () => { cancelled = true; worker?.terminate(); reject(new Error('OCR was cancelled')); }; signal?.addEventListener('abort', abort, { once: true }); });
    const work = (async () => {
      worker = await createWorker('eng', 1, { langPath, corePath: path.dirname(require.resolve('tesseract.js-core/package.json')), workerPath: require.resolve('tesseract.js/src/worker-script/node/index.js'), cacheMethod: 'none', gzip: true, errorHandler: error => { rejectLimit(new Error(String(error))); } });
      if (cancelled) { await worker.terminate(); throw new Error('OCR was cancelled during initialization'); }
      signal?.throwIfAborted(); await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
      return worker.recognize(imageFile, {}, { text: true, tsv: true, blocks: true });
    })();
    const recognized = await Promise.race([work, limit]);
    const words = wordsFromTsv(recognized.data.tsv); const layout = rowsFromWords(words, grid, crop);
    if (layout.layout !== 'detected_grid') notes.push('No reliable full grid was detected; each row contains positional word candidates and column semantics remain unverified.');
    const result = { id, sourceSha256, imagePath: await realpath(imagePath), imageWidth: image.width, imageHeight: image.height, crop, rows: layout.rows, status: words.length && layout.rows.length ? 'needs_review' : 'failed', provider: { name: 'tesseract.js', language: 'eng', route: 'local_wasm', networkRequestsRequired: false }, layout: layout.layout, grid, words: words.map(w => ({ ...w, bbox: { ...w.bbox, x: w.bbox.x + crop.x, y: w.bbox.y + crop.y } })), rawText: recognized.data.text, notes, preprocessing: { gridLinesMasked: true, originalModified: false, inputPath: imageFile } };
    if (!words.length) result.notes.push('No readable words were recognized; the image/table has not been checked.');
    await writeFile(path.join(outputDir, `${makeID(sourceSha256, crop)}-table.json`), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    return { id, sourceSha256, imageWidth: image.width, imageHeight: image.height, crop, rows: [], status: 'failed', provider: { name: 'tesseract.js', language: 'eng', route: 'local_wasm' }, notes: [...notes, String(error.message)] };
  } finally { clearTimeout(timeout); if (abort) signal?.removeEventListener('abort', abort); if (worker) await worker.terminate(); }
}
