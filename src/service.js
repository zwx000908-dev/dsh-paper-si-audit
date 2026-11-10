import { visualReviewAction, deliverVisualPair, submitVisualResult, visualReviewSnapshot, readVisualComparison } from './visual-review.js';
import { IMAGE_TYPES, IMAGE_RULE_VERSION } from './image-rules.js';
import { buildReviewGroups } from './review-groups.js';
import { readFile, writeFile, mkdir, readdir, realpath, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseDocument, documentByteLimit } from './parsers.js';
import { auditDocuments } from './engine.js';
import { validateProfile, defaultProfile } from './profiles.js';
import { checkStoichiometry } from './stoichiometry.js';
import { renderMarkdown, summarizeIssues } from './report.js';
import { VERSION, HOST_TARGET } from './version.js';
import { inspectVisuals, readImageTable as recognizeImageTable } from './image-tables.js';
import { checkHrms } from './hrms.js';
import { checkNmr } from './nmr.js';
import { checkImageDuplicates } from './image-duplicates.js';
import { buildCompoundRegistry, validateRequirements, validateCompoundDecision } from './compounds.js';
import { extractPanels, annotatedPair } from './panels.js';
import { validateScientificConfig } from './scientific-config.js';
import { parseSpectrumLabels, validateSpectrumFields, checkSpectrumReadings } from './spectrum-check.js';
import { checkExperimentalMath } from './experimental-math.js';
import { checkExperimentalProse } from './experimental-prose.js';
import { validateExperimentContext } from './experiment-context.js';
import { calculateMolarMass } from './molar-mass.js';
import { checkCrossReferences } from './cross-check.js';
import { buildRevisionLedger, applyRevalidations, validateRevalidation } from './revisions.js';
import { workflowAction } from './workflow.js';

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const STATES = new Set(['confirmed', 'reasonable_difference', 'extraction_error', 'insufficient', 'fixed_pending_recheck']);
const hash = x => createHash('sha256').update(x).digest('hex');
const within = (base, file) => { const r = path.relative(base, file); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
const clean = (s, max = 2000) => { if (typeof s !== 'string' || !s.trim() || s.length > max) throw new Error('Expected nonempty bounded text'); return s.trim(); };
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const safeID = id => { if (!ID.test(id ?? '')) throw new Error('Invalid identifier'); return id; };
const md = value => String(value ?? '').replace(/[|]/g, '\\|').replace(/[\r\n]/g, ' ');
const csv = value => { let s = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
const DEFAULT_HRMS = Object.freeze({ formulaBasis: 'ambiguous', ppmTolerance: 5, mDaTolerance: null });
function imageTableBlocks(table) {
  const rows = table.rows ?? [], headers = rows[0]?.cells.map(c => c.text) ?? [];
  return rows.map((row, i) => ({ id: `${table.id}-row-${i + 1}`, text: row.cells.map(c => c.text).join('\t'), locator: { ...table.source.locator, label: `${table.source.locator.label}; OCR table ${table.id} row ${i + 1}`, tableId: table.id, row: i + 1 }, metadata: { evidenceOrigin: 'image_table_ocr', assetId: table.assetId, originalSourceSha256: table.source.sourceSha256, rasterSha256: table.source.rasterSha256, visualReviewStatus: table.review.status, headerInferred: true, headerRow: i === 0, cells: row.cells.map((cell, j) => ({ column: j + 1, header: headers[j] ?? '', text: cell.text, originalOCRText: cell.originalOCRText ?? cell.text, bbox: cell.bbox, confidence: cell.confidence, precisionKnown: table.review.status === 'accepted' })) } }));
}

async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(temp, file);
}

export class AuditService {
  constructor({ dataDir, allowedRoots = [], executionPath = 'core_api' } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('dataDir must be absolute');
    this.dataDir = path.resolve(dataDir);
    this.allowedRoots = allowedRoots.map(r => path.resolve(r));
    if (!['core_api', 'harness_native_tools', 'local_workbench', 'cli'].includes(executionPath)) throw new Error('Unknown execution entrypoint');
    this.executionPath = executionPath;
  }
  async init() {
    await mkdir(path.join(this.dataDir, 'projects'), { recursive: true });
    this.dataDir = await realpath(this.dataDir);
    this.allowedRoots = await Promise.all(this.allowedRoots.map(r => realpath(r)));
    return this;
  }
  dir(id) { return path.join(this.dataDir, 'projects', safeID(id)); }
  async locked(id, fn, lockName = '.lock') {
    await mkdir(this.dir(id), { recursive: true });
    const lock = path.join(this.dir(id), lockName);
    const deadline = Date.now() + 30000;
    let handle;
    while (!handle) {
      try { handle = await open(lock, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
      catch (error) {
        if (error.code === 'EEXIST') {
          try { const owner = await json(lock); if (Number.isInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') { const again = await json(lock); if (JSON.stringify(again) === JSON.stringify(owner)) await unlink(lock); continue; } } } } catch (e) { if (e.code === 'ENOENT') continue; }
        }
        if (error.code !== 'EEXIST' || Date.now() > deadline) throw new Error(`Project busy or stale lock; retry or inspect ${lock}`); await new Promise(r => setTimeout(r, 75)); }
    }
    try { return await fn(); } finally { await handle.close(); await unlink(lock); }
  }
  async createProject({ name, roots } = {}) {
    await this.init();
    const selected = roots?.length ? roots : this.allowedRoots;
    if (!selected.length) throw new Error('Configure allowedRoots before selecting source directories');
    const canonical = await Promise.all(selected.map(r => realpath(path.resolve(r))));
    if (canonical.some(r => !this.allowedRoots.some(a => within(a, r)))) throw new Error('Project roots exceed configured allowedRoots');
    const project = { id: randomUUID(), name: clean(name, 200), roots: canonical, createdAt: new Date().toISOString(), documents: [], runIds: [], profile: defaultProfile(), profileRevision: 1, hrmsOptions: { ...DEFAULT_HRMS }, hrmsRevision: 0, visualAssets: [], imageTableIds: [], activeImageTables: {}, visualRevision: 0 };
    await atomic(path.join(this.dir(project.id), 'project.json'), project);
    return project;
  }
  async getProject(projectId) { return json(path.join(this.dir(projectId), 'project.json')); }
  async listProjects() {
    await this.init();
    const result = [];
    for (const entry of await readdir(path.join(this.dataDir, 'projects'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try { const p = await this.getProject(entry.name); result.push({ id: p.id, name: p.name, createdAt: p.createdAt, documentCount: p.documents.length, latestRunId: p.runIds.at(-1) ?? null }); } catch { /* ignore incomplete creation */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async sourcePath(project, input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Source path must be absolute');
    const target = await realpath(input);
    const imports = path.join(this.dir(project.id), 'imports');
    if (within(this.dataDir, target) && !within(imports, target)) throw new Error('Audit state files cannot be imported as sources');
    if (!within(imports, target) && !project.roots.some(r => within(r, target))) throw new Error('Source is outside project roots');
    if (!within(imports, target) && !this.allowedRoots.some(r => within(r, target))) throw new Error('Source is outside currently configured allowedRoots');
    return target;
  }
  async addDocument({ projectId, filePath, role = 'main', displayName, replaceKey }) {
    if (!['main', 'si', 'source'].includes(role)) throw new Error('Unknown document role');
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId);
      const target = await this.sourcePath(p, filePath);
      const document = await parseDocument({ filePath: target, role });
      if (displayName) document.name = path.basename(clean(displayName, 200));
      const imports = path.join(this.dir(projectId), 'imports');
      if (!replaceKey && displayName && within(imports, target)) replaceKey = p.documents.find(d => d.name === document.name && d.role === role && within(imports, d.filePath))?.key;
      if (replaceKey && !p.documents.some(d => d.key === replaceKey && d.role === role)) throw new Error('Replacement source does not exist with this role');
      const key = replaceKey ?? hash(`${target}\0${role}`).slice(0, 24);
      p.documents = p.documents.filter(d => d.key !== key && d.key !== replaceKey);
      if (p.documents.length >= 64) throw new Error('MVP supports at most 64 source entries');
      p.documents.push({ key, filePath: target, role, name: document.name, sha256: document.sha256, coverage: document.coverage });
      await atomic(path.join(this.dir(projectId), 'project.json'), p);
      return document;
    });
  }
  async importDocument({ projectId, name, contentBase64, role = 'main', replaceKey }) {
    const project = await this.getProject(projectId);
    const filename = path.basename(clean(name, 200));
    if (!/\.(?:txt|md|csv|json|docx|pdf|xlsx|png|jpg|jpeg|tif|tiff|webp|bmp)$/i.test(filename)) throw new Error('Unsupported file extension');
    const limit = documentByteLimit(filename);
    if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(limit / 3) * 4 || contentBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(contentBase64)) throw new Error('Invalid or oversized base64 upload');
    const padding = contentBase64.indexOf('=');
    if (padding >= 0 && !/^={1,2}$/.test(contentBase64.slice(padding))) throw new Error('Invalid base64 padding');
    const buffer = Buffer.from(contentBase64, 'base64');
    if (buffer.length > limit) throw new Error(`Input limit is ${limit / 1024 / 1024} MiB for this format`);
    const imports = path.join(this.dir(projectId), 'imports');
    await mkdir(imports, { recursive: true });
    const filePath = path.join(imports, `${randomUUID()}-${filename}`);
    await writeFile(filePath, buffer, { flag: 'wx' });
    return this.addDocument({ projectId, filePath, role, displayName: filename, replaceKey });
  }
  async setProfile({ projectId, profile }) {
    const valid = validateProfile(profile);
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId);
      p.profile = valid; p.profileRevision += 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p);
      return { profile: valid, revision: p.profileRevision };
    });
  }
  async configureHrms({ projectId, options }) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['formulaBasis', 'ppmTolerance', 'mDaTolerance'].includes(k))) throw new Error('Invalid HRMS configuration fields');
    const valid = { ...DEFAULT_HRMS, ...options };
    if (!['neutral', 'ion', 'ambiguous'].includes(valid.formulaBasis) || typeof valid.ppmTolerance !== 'number' || !Number.isFinite(valid.ppmTolerance) || valid.ppmTolerance <= 0 || valid.ppmTolerance > 10000 || (valid.mDaTolerance !== null && (typeof valid.mDaTolerance !== 'number' || !Number.isFinite(valid.mDaTolerance) || valid.mDaTolerance <= 0 || valid.mDaTolerance > 1000))) throw new Error('HRMS basis and bounded positive finite tolerances are required (ppm <= 10000; mDa <= 1000)');
    checkHrms([], valid);
    return this.locked(projectId, async () => { const p = await this.getProject(projectId); p.hrmsOptions = valid; p.hrmsRevision = (p.hrmsRevision ?? 0) + 1; await atomic(path.join(this.dir(projectId), 'project.json'), p); return { options: valid, revision: p.hrmsRevision, thresholdSource: 'user/software configuration; not journal requirements' }; });
  }
  async setRequirements({ projectId, requirements }) {
    const value = validateRequirements(requirements);
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId); p.requirements = value; p.scientificRevision = (p.scientificRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return { requirements: value, revision: p.scientificRevision };
    });
  }
  async configureScientific({ projectId, options }) {
    const value = validateScientificConfig(options);
    return this.locked(projectId, async () => { const p = await this.getProject(projectId); p.scientificOptions = value; p.scientificRevision = (p.scientificRevision ?? 0) + 1; await atomic(path.join(this.dir(projectId), 'project.json'), p); return { options: value, revision: p.scientificRevision, source: 'user/software settings, not journal requirements' }; });
  }
  async readSpectrumImage({ projectId, runId, recordId, assetId, crop, signal }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), run = await this.getRun({ projectId, runId });
      const record = run.compoundRegistry?.records.find(r => r.id === recordId); if (!record) throw new Error('Select an existing compound source record');
      const { asset } = await this.getVisualImage({ projectId, assetId });
      const source = p.documents.find(d => d.sha256 === record.sourceSha256 && d.role === record.role), imageSource = p.documents.find(d => d.key === asset.documentKey);
      if (!source || !imageSource || hash(await readFile(await this.sourcePath(p, source.filePath))) !== record.sourceSha256 || hash(await readFile(await this.sourcePath(p, imageSource.filePath))) !== asset.sourceSha256) throw new Error('Source changed; reimport/run and prepare current images before spectrum comparison');
      const id = 'spectrum-' + randomUUID(), outputDir = path.join(this.dir(projectId), 'spectrum-ocr', id);
      const ocr = await recognizeImageTable({ imagePath: asset.path, outputDir, crop, signal, tableId: id, mode: 'spectrum' });
      if (hash((await this.getVisualImage({ projectId, assetId })).data) !== asset.sha256) throw new Error('Raster changed during OCR');
      const parsed = parseSpectrumLabels(ocr.rawText ?? ''), reading = { id, recordId, basedOnRunId: run.id, assetId, sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256, crop: ocr.crop, rawText: ocr.rawText ?? '', words: ocr.words ?? [], status: ocr.status, provider: ocr.provider, ...parsed, originalFields: structuredClone(parsed.fields), review: { status: 'needs_review', reason: 'Local OCR or model interpretation is not human acceptance.' }, history: [], createdAt: new Date().toISOString(), preprocessing: { gridLinesMasked: false, originalModified: false } };
      reading.fieldOrigins = Object.fromEntries(Object.keys(reading.fields).map(k => [k, 'local_image_ocr']));
      const caption = asset.locator?.precedingText;
      if (caption && /\b(?:spectra|spectrum)\s+of\b/i.test(caption)) {
        const matches = run.documents.filter(d => d.id === asset.documentId && d.sha256 === asset.sourceSha256).flatMap(d => d.blocks.filter(b => b.text === caption));
        if (matches.length === 1) {
          const block = matches[0]; reading.captionCitation = { blockId: block.id, start: 0, end: block.text.length, quote: block.text }; reading.captionFields = parseSpectrumLabels(caption).fields; reading.captionConflicts = [];
          for (const [key, value] of Object.entries(reading.captionFields)) {
            if (reading.fields[key] === undefined && !reading.ambiguousFields.some(a => a.field === key)) { reading.fields[key] = value; reading.fieldOrigins[key] = 'document_caption'; }
            else if (reading.fields[key] !== undefined && JSON.stringify(reading.fields[key]) !== JSON.stringify(value)) reading.captionConflicts.push({ field: key, documentCaption: value, imageOcr: reading.fields[key] });
          }
          reading.missingFields = reading.missingFields.filter(k => reading.fields[k] === undefined);
        }
      }
      reading.originalFieldOrigins = structuredClone(reading.fieldOrigins);
      await atomic(path.join(this.dir(projectId), 'spectra', `${id}.json`), reading);
      p.activeSpectrumReadings ??= {}; p.activeSpectrumReadings[hash(JSON.stringify([recordId, assetId, ocr.crop]))] = id; p.scientificRevision = (p.scientificRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return reading;
    });
  }
  async getSpectrumReadings({ projectId, readingId }) {
    const p = await this.getProject(projectId), ids = Object.values(p.activeSpectrumReadings ?? {});
    if (readingId) { if (!ids.includes(readingId)) throw new Error('Spectrum reading is not active in this project'); return json(path.join(this.dir(projectId), 'spectra', `${safeID(readingId)}.json`)); }
    return Promise.all(ids.map(id => json(path.join(this.dir(projectId), 'spectra', `${safeID(id)}.json`))));
  }
  async reviewSpectrum({ projectId, readingId, status, reason, fields }) {
    if (!['accepted', 'rejected', 'needs_review'].includes(status)) throw new Error('Invalid spectrum review status');
    reason = clean(reason, 2000); const corrected = fields === undefined ? null : validateSpectrumFields(fields);
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), reading = await this.getSpectrumReadings({ projectId, readingId });
      const before = structuredClone(reading.fields);
      if (corrected) { reading.fields = corrected; reading.fieldOrigins = Object.fromEntries(Object.keys(corrected).map(k => [k, 'explicit_user_correction'])); reading.missingFields = ['nucleus', 'frequencyMHz', 'solvent', 'compoundLabel', 'integralSum'].filter(k => corrected[k] === undefined); reading.ambiguousFields = []; reading.status = 'needs_review'; }
      const record = { status, reason, before, after: structuredClone(reading.fields), createdAt: new Date().toISOString() }; reading.history.push(record); reading.review = { status, reason, createdAt: record.createdAt };
      await atomic(path.join(this.dir(projectId), 'spectra', `${safeID(readingId)}.json`), reading); p.scientificRevision = (p.scientificRevision ?? 0) + 1; await atomic(path.join(this.dir(projectId), 'project.json'), p); return record;
    });
  }
  async extractImagePanels({ projectId, assetId, rectangles, signal }) {
    return this.locked(projectId, async () => {
      signal?.throwIfAborted();
      const p = await this.getProject(projectId), { asset: parent, data } = await this.getVisualImage({ projectId, assetId });
      if (parent.parentAssetId) throw new Error('Extract panels from the original asset, not a nested panel');
      const result = await extractPanels(data, rectangles), assets = [];
      const dir = path.join(this.dir(projectId), 'visuals', 'content'); await mkdir(dir, { recursive: true });
      for (const panel of result.panels) {
        const sha256 = hash(panel.bytes), originKey = hash(JSON.stringify([parent.id, panel.crop])).slice(0, 24), id = 'panel-' + hash(originKey + sha256).slice(0, 24);
        const file = path.join(dir, `${sha256}.png`); await writeFile(file, panel.bytes);
        const asset = { ...parent, id, originKey, path: file, sha256, imageWidth: panel.width, imageHeight: panel.height, parentAssetId: parent.id, parentCrop: panel.crop, panelMode: result.mode, locations: [], locator: { ...parent.locator, label: `${parent.locator.label}; panel (${panel.crop.x},${panel.crop.y},${panel.crop.width},${panel.crop.height})`, crop: panel.crop }, status: 'ready' };
        p.visualAssets = p.visualAssets.filter(a => a.id !== id); p.visualAssets.push(asset); p.activeVisuals ??= {}; p.activeVisuals[originKey] = id; assets.push(asset);
      }
      if (assets.length) p.visualRevision = (p.visualRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return { assets, mode: result.mode, note: result.note, candidateCount: assets.length };
    });
  }
  async setCompound({ projectId, runId, decision }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), run = await this.getRun({ projectId, runId });
      const value = validateCompoundDecision(decision, run);
      p.compoundDecisions ??= []; p.compoundDecisions.push(value); p.scientificRevision = (p.scientificRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return value;
    });
  }
  async prepareVisuals({ projectId, documentKey, selection = {}, signal }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), source = p.documents.find(d => d.key === documentKey);
      if (!source) throw new Error('Document key not found in project');
      const filePath = await this.sourcePath(p, source.filePath);
      const originalHash = hash(await readFile(filePath));
      const documentId = `doc-${hash(`${originalHash}:${source.role}`).slice(0, 20)}`;
      const outputDir = path.join(this.dir(projectId), 'visuals', documentKey);
      const result = await inspectVisuals({ filePath, documentId, outputDir, selection, signal });
      if (result.sourceSha256 !== originalHash) throw new Error('Source changed during visual extraction');
      const ready = new Map(result.assets.map(a => [a.id, a]));
      const candidates = new Map((result.candidates ?? []).map(a => [a.id, a]));
      for (const asset of result.assets) candidates.set(asset.id, { ...candidates.get(asset.id), ...asset });
      const assets = [];
      for (const candidate of candidates.values()) {
        const raw = ready.get(candidate.id) ?? candidate;
        const originKey = hash(JSON.stringify([documentKey, originalHash, candidate.id])).slice(0, 24);
        const id = `asset-${hash(JSON.stringify([originKey, raw.sha256 ?? 'inventory'])).slice(0, 24)}`;
        const locator = { ...raw.locator, label: raw.locator?.label ?? (raw.locator?.page ? `PDF page ${raw.locator.page}` : raw.locator?.part ?? 'Standalone image') };
        const asset = { ...candidate, ...raw, id, originKey, documentKey, documentId, name: source.name, role: source.role, sourceSha256: originalHash, locator };
        if (asset.path) {
          const renderedPath = await realpath(asset.path); if (!within(await realpath(outputDir), renderedPath)) throw new Error('Visual extraction returned an out-of-project path');
          const bytes = await readFile(renderedPath); if (hash(bytes) !== asset.sha256) throw new Error('Rendered asset hash mismatch');
          const contentDir = path.join(this.dir(projectId), 'visuals', 'content'); await mkdir(contentDir, { recursive: true });
          asset.path = path.join(contentDir, `${asset.sha256}.png`);
          try { await writeFile(asset.path, bytes, { flag: 'wx' }); } catch (error) {
        if (error.code === 'EEXIST') {
          try { const owner = await json(lock); if (Number.isInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') { const again = await json(lock); if (JSON.stringify(again) === JSON.stringify(owner)) await unlink(lock); continue; } } } } catch (e) { if (e.code === 'ENOENT') continue; }
        }
        if (error.code !== 'EEXIST') throw error; if (hash(await readFile(asset.path)) !== asset.sha256) throw new Error('Stored visual content hash mismatch'); }
        }
        assets.push(asset);
      }
      p.visualAssets ??= [];
      p.activeVisuals ??= {};
      let visualChanged = false;
      for (const asset of assets) {
        const prior = p.visualAssets.find(a => a.id === p.activeVisuals[asset.originKey]);
        if (prior?.status === 'ready' && asset.status === 'unread') continue;
        if (prior?.id !== asset.id || prior?.status !== asset.status) visualChanged = true;
        if (prior?.id === asset.id && prior.sha256 === asset.sha256 && prior.sourceSha256 === asset.sourceSha256 && prior.imageType) asset.imageType = prior.imageType;
        p.visualAssets = p.visualAssets.filter(a => a.id !== asset.id); p.visualAssets.push(asset); p.activeVisuals[asset.originKey] = asset.id;
      }
      await atomic(path.join(this.dir(projectId), 'project.json'), p);
      if (visualChanged) { p.visualRevision = (p.visualRevision ?? 0) + 1; await atomic(path.join(this.dir(projectId), 'project.json'), p); }
      return { source: { key: source.key, name: source.name, role: source.role, documentId, sha256: originalHash }, assets, coverage: result.coverage };
    });
  }
  async listVisuals({ projectId }) {
    const p = await this.getProject(projectId), assets = (p.visualAssets ?? []).map(a => ({ ...a, active: !p.activeVisuals || p.activeVisuals[a.originKey] === a.id }));
    return { assets, coverage: { inventoried: assets.length, ready: assets.filter(a => a.status === 'ready').length, failed: assets.filter(a => a.status === 'failed').length, note: 'Prepared images are not yet verified tables; unselected figures and spectra are not read.' } };
  }
  async prepareImageAudit({ projectId, documentKey, offset = 0, limit = 10, signal }) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Image preparation requires offset >= 0 and limit 1–10');
    const inventory = await this.prepareVisuals({ projectId, documentKey, signal });
    const selected = inventory.assets.slice(offset, offset + limit);
    let result = inventory;
    if (selected.length) {
      const pages = selected.map(a => a.locator?.page).filter(Boolean), parts = selected.map(a => a.locator?.part).filter(Boolean);
      result = await this.prepareVisuals({ projectId, documentKey, selection: { ...(pages.length ? { pages } : {}), ...(parts.length ? { parts } : {}) }, signal });
    }
    return { source: result.source, selectedAssets: result.assets.filter(a => selected.some(s => s.originKey === a.originKey)), offset, limit, total: inventory.assets.length, nextOffset: offset + limit < inventory.assets.length ? offset + limit : null, note: 'Follow nextOffset for every requested source, then run paper_audit_run to compare prepared images. PDF extraction compares whole pages; use standalone panel images for panel-level comparison.' };
  }
  async getVisualImage({ projectId, assetId }) {
    const p = await this.getProject(projectId), asset = (p.visualAssets ?? []).find(a => a.id === assetId);
    if (!asset || asset.status !== 'ready' || !asset.path) throw new Error('A rendered, registered visual asset is required');
    const target = await realpath(asset.path);
    if (!within(await realpath(path.join(this.dir(projectId), 'visuals')), target)) throw new Error('Visual asset escaped its project');
    const data = await readFile(target);
    if (data.length > 32 * 1024 * 1024 || hash(data) !== asset.sha256) throw new Error('Visual asset changed or exceeds image limits');
    return { asset, data: new Uint8Array(data) };
  }
  async readImageTable({ projectId, assetId, crop, signal }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), { asset } = await this.getVisualImage({ projectId, assetId });
      const tableId = `table-${randomUUID()}`;
      const result = await recognizeImageTable({ imagePath: asset.path, outputDir: path.join(this.dir(projectId), 'tables', 'ocr'), tableId, crop, signal });
      if (result.sourceSha256 !== asset.sha256) throw new Error('OCR used a different raster than the registered asset');
      const table = { ...result, id: tableId, assetId, createdAt: new Date().toISOString(), source: { documentKey: asset.documentKey, documentId: asset.documentId, name: asset.name, role: asset.role, locator: asset.locator, sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256 }, review: { status: 'needs_review', reason: 'OCR is provisional; compare the source image before accepting.' } };
      if (!Array.isArray(table.rows) || table.rows.length > 3000) throw new Error('OCR table exceeds row bounds');
      for (const row of table.rows) {
        if (!Array.isArray(row.cells) || row.cells.length > 100) throw new Error('OCR table exceeds column bounds');
        for (const c of row.cells) {
          if (typeof c.text !== 'string' || c.text.length > 2000 || !c.bbox || ['x', 'y', 'width', 'height'].some(k => !Number.isFinite(c.bbox[k])) || c.bbox.x < 0 || c.bbox.y < 0 || c.bbox.width < 0 || c.bbox.height < 0 || c.bbox.x + c.bbox.width > asset.imageWidth + 1 || c.bbox.y + c.bbox.height > asset.imageHeight + 1) throw new Error('OCR table exceeds cell or coordinate bounds');
        }
      }
      await atomic(path.join(this.dir(projectId), 'tables', `${safeID(tableId)}.json`), table);
      p.imageTableIds ??= []; p.imageTableIds.push(tableId); p.activeImageTables ??= {};
      p.activeImageTables[`${asset.originKey}:${JSON.stringify(crop ? [crop.x, crop.y, crop.width, crop.height] : null)}`] = tableId;
      p.visualRevision = (p.visualRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p);
      return table;
    });
  }
  async listImageTables({ projectId }) {
    const p = await this.getProject(projectId), active = new Set(Object.values(p.activeImageTables ?? {})), tables = [];
    for (const id of p.imageTableIds ?? []) { const t = await json(path.join(this.dir(projectId), 'tables', `${safeID(id)}.json`)); tables.push({ id, assetId: t.assetId, source: t.source, provider: t.provider, status: t.status, review: t.review, active: active.has(id), rows: t.rows.length, rowPreview: t.rows.slice(0, 3) }); }
    return { tables };
  }
  async getImageTable({ projectId, tableId, offset = 0, limit = 30 }) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid table row page (offset >= 0; limit 1-100)');
    const p = await this.getProject(projectId);
    if (!(p.imageTableIds ?? []).includes(tableId)) throw new Error('Table not found in project');
    const table = await json(path.join(this.dir(projectId), 'tables', `${safeID(tableId)}.json`));
    return { id: table.id, assetId: table.assetId, source: table.source, provider: table.provider, status: table.status, review: table.review, reviewHistory: table.reviewHistory ?? [], rowCount: table.rows.length, items: table.rows.slice(offset, offset + limit), offset, limit, nextOffset: offset + limit < table.rows.length ? offset + limit : null };
  }
  async reviewImageTable({ projectId, tableId, status, reason, corrections = [] }) {
    if (!['accepted', 'rejected', 'needs_review'].includes(status)) throw new Error('Invalid table review state');
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId);
      if (!(p.imageTableIds ?? []).includes(tableId)) throw new Error('Table not found in project');
      const file = path.join(this.dir(projectId), 'tables', `${safeID(tableId)}.json`), table = await json(file);
      if (status === 'accepted' && (table.status === 'failed' || !table.rows.length)) throw new Error('Failed or empty OCR tables cannot be accepted');
      if (!Array.isArray(corrections) || corrections.length > 1000) throw new Error('Table corrections must be a bounded array');
      const corrected = [];
      for (const c of corrections) {
        if (!c || Object.keys(c).some(k => !['row', 'column', 'text'].includes(k)) || !Number.isInteger(c.row) || !Number.isInteger(c.column) || c.row < 1 || c.column < 1 || typeof c.text !== 'string' || c.text.length > 2000) throw new Error('Invalid table cell correction');
        const cell = table.rows[c.row - 1]?.cells[c.column - 1]; if (!cell) throw new Error('Corrected cell does not exist');
        corrected.push({ row: c.row, column: c.column, before: cell.text, after: c.text }); cell.originalOCRText ??= cell.text; cell.text = c.text;
      }
      const record = { id: randomUUID(), at: new Date().toISOString(), status, reason: clean(reason), corrections: corrected };
      table.review = record; table.reviewHistory = [...(table.reviewHistory ?? []), record];
      await atomic(file, table); p.visualRevision = (p.visualRevision ?? 0) + 1; await atomic(path.join(this.dir(projectId), 'project.json'), p); return record;
    });
  }
  async runAudit({ projectId, executionEvidence, workflowSnapshot }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId);
      if (!p.documents.length) throw new Error('Import documents before running an audit');
      const documents = [];
      for (const source of p.documents) {
        try { const target = await this.sourcePath(p, source.filePath); const document = await parseDocument({ filePath: target, role: source.role }); document.name = source.name; document.sourceKey = source.key; source.sha256 = document.sha256; source.coverage = document.coverage; documents.push(document); }
        catch (error) { documents.push({ id: `failed-${source.key}`, sourceKey: source.key, name: source.name, role: source.role, format: path.extname(source.name), sha256: null, blocks: [], coverage: { status: 'failed', totalUnits: 1, parsedUnits: 0, warnings: [String(error.message)] } }); }
      }
      const visualCoverage = { activeTables: 0, provisionalTables: 0, acceptedTables: 0, rejectedTables: 0, staleTables: [], failedTables: [] };
      const imageTables = [];
      for (const id of Object.values(p.activeImageTables ?? {})) {
        const table = await json(path.join(this.dir(projectId), 'tables', `${safeID(id)}.json`)); imageTables.push(table); visualCoverage.activeTables++;
        const source = documents.find(d => d.id === table.source.documentId && d.sha256 === table.source.sourceSha256);
        if (!source) { visualCoverage.staleTables.push(id); continue; }
        if (table.review.status === 'rejected') { visualCoverage.rejectedTables++; continue; }
        if (table.status === 'failed' || !table.rows.length) { visualCoverage.failedTables.push(id); continue; }
        table.review.status === 'accepted' ? visualCoverage.acceptedTables++ : visualCoverage.provisionalTables++;
        documents.push({ id: `visualdoc-${hash(id).slice(0, 20)}`, name: `${table.source.name} [OCR ${id}]`, role: table.source.role, format: 'image_table', sha256: table.source.rasterSha256, originalSourceSha256: table.source.sourceSha256, evidenceOrigin: 'image_table_ocr', blocks: imageTableBlocks(table), coverage: { status: table.review.status === 'accepted' ? 'complete' : 'partial', totalUnits: table.rows.length, parsedUnits: table.rows.length, warnings: [table.review.status === 'accepted' ? 'Human accepted the transcription; this does not validate the scientific result or original measurement.' : 'Unreviewed OCR; image readings can be wrong. Source image hash and cell boxes are retained.'] } });
      }
      if (documents.reduce((n, d) => n + d.blocks.reduce((m, b) => m + b.text.length, 0), 0) > 8 * 1024 * 1024) throw new Error('MVP text budget exceeded (8 Mi characters); split the project');
      const result = auditDocuments(documents, p.profile);
      const scientificOptions = validateScientificConfig(p.scientificOptions);
      const stoichiometry = checkStoichiometry(documents);
      const hrms = checkHrms(documents, p.hrmsOptions ?? DEFAULT_HRMS);
      const nmr = checkNmr(documents, hrms.records, scientificOptions);
      const experimental = checkExperimentalMath(documents, scientificOptions);
      const prose = checkExperimentalProse(documents, scientificOptions, { hrmsRecords: hrms.records, contexts: p.experimentContexts ?? [] });
      const cross = checkCrossReferences(documents, result.facts);
      const activeAssets = (p.visualAssets ?? []).filter(a => !p.activeVisuals || p.activeVisuals[a.originKey] === a.id);
      const currentAssets = activeAssets.filter(a => documents.some(d => d.id === a.documentId && d.sha256 === a.sourceSha256));
      const imageSignature = hash(JSON.stringify([IMAGE_RULE_VERSION, currentAssets.map(a => [a.id, a.sha256, a.status, a.imageType]), scientificOptions]));
      const previousProgress = p.duplicateProgress?.signature === imageSignature ? p.duplicateProgress : null;
      const cachedRun = previousProgress?.runId ? await json(path.join(this.dir(projectId), 'runs', `${safeID(previousProgress.runId)}.json`)) : null;
      const cacheDir = path.join(this.dir(projectId), 'image-features-v1');
      const cache = { get: async key => { try { const c = await json(path.join(cacheDir, `${key}.json`)); return c.variants && c.patches ? c : null; } catch { return null; } }, set: async (key, value) => atomic(path.join(cacheDir, `${key}.json`), value) };
      const duplicateOptions = { maxAssets: scientificOptions.maxImageAssets, pairBudget: scientificOptions.imagePairBudget, pairOffset: previousProgress ? previousProgress.nextPairOffset ?? previousProgress.totalEligiblePairs : 0, imageRmse: scientificOptions.imageRmse, localImageRmse: scientificOptions.localImageRmse, localImages: scientificOptions.localImages, imageTypeRules: scientificOptions.imageTypeRules, cache };
      let duplicates = await checkImageDuplicates(currentAssets, async asset => (await this.getVisualImage({ projectId, assetId: asset.id })).data, duplicateOptions);
      // A decoder failure changes the eligible pair order. Never resume at an old offset in a different ordering.
      let canReuse = !!cachedRun && JSON.stringify(previousProgress.skipped) === JSON.stringify(duplicates.coverage.skipped);
      if (cachedRun && !canReuse) duplicates = await checkImageDuplicates(currentAssets, async asset => (await this.getVisualImage({ projectId, assetId: asset.id })).data, { ...duplicateOptions, pairOffset: 0 });
      const priorImageIssues = canReuse ? cachedRun.issues.filter(i => i.category === 'image_duplicate') : [];
      duplicates.issues = [...new Map([...priorImageIssues, ...duplicates.issues].map(i => [i.id, i])).values()];
      duplicates.coverage.comparedPairsThisRun = duplicates.coverage.comparedPairs;
      duplicates.coverage.comparedPairs += canReuse ? cachedRun.coverage.imageDuplicates.comparedPairs : 0;
      duplicates.coverage.resumedFromRunId = canReuse ? cachedRun.id : null;
      for (const issue of duplicates.issues.slice(0, 30)) if (!issue.previewPath && issue.imageEvidence.length === 2) {
        try { const bytes = await annotatedPair(issue.imageEvidence, issue.calculation.boxes, async e => (await this.getVisualImage({ projectId, assetId: e.assetId })).data); const dir = path.join(this.dir(projectId), 'visuals', 'comparisons'); await mkdir(dir, { recursive: true }); issue.previewPath = path.join(dir, `${hash(bytes)}.png`); await writeFile(issue.previewPath, bytes); } catch (error) { issue.previewError = String(error.message); }
      }
      duplicates.coverage.previewsOmitted = duplicates.issues.filter(i => !i.previewPath).length;
      duplicates.coverage.staleAssets = activeAssets.filter(a => !currentAssets.includes(a)).map(a => a.id);
      duplicates.coverage.uninventoriedDocuments = documents.filter(d => ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'].includes(d.format) && !currentAssets.some(a => a.documentId === d.id)).map(d => ({ id: d.id, name: d.name }));
      const spectrumReadings = await this.getSpectrumReadings({ projectId });
      const registry = buildCompoundRegistry(documents, { nmrRecords: nmr.records, hrmsRecords: hrms.records, assets: currentAssets, decisions: p.compoundDecisions ?? [], requirements: p.requirements ?? null, spectrumReadings });
      const spectra = checkSpectrumReadings(spectrumReadings, registry, nmr.records, currentAssets, scientificOptions);
      const visualReview = await visualReviewSnapshot(this,projectId);
      const rank = i => ({ high: 0, medium: 1, low: 2 }[i.severity] ?? 3) * 10 + ({ data: 0, semantic: 1, alignment: 2, coverage: 3, format: 4 }[i.type] ?? 5);
      const issues = [...result.issues, ...stoichiometry.issues, ...hrms.issues, ...nmr.issues, ...duplicates.issues, ...registry.issues, ...experimental.issues, ...spectra.issues, ...prose.issues, ...cross.issues, ...visualReview.issues].sort((a, b) => rank(a) - rank(b));
      const execution = { entryPoint: this.executionPath, recordedBy: 'entrypoint-declared; confirm native calls in host logs', ...(this.executionPath === 'harness_native_tools' && executionEvidence ? { toolName: executionEvidence.toolName ?? 'paper_audit_run', toolCallId: typeof executionEvidence.toolCallId === 'string' ? executionEvidence.toolCallId : null } : {}) };
      const coverage = { ...result.coverage, hrms: hrms.coverage, imageTables: visualCoverage, stoichiometry: stoichiometry.coverage, semanticStatus: 'not_run', missingRoles: ['main', 'si'].filter(role => !documents.some(d => d.role === role)), documents: documents.map(d => ({ id: d.id, name: d.name, role: d.role, ...d.coverage })) };
      coverage.visualAgentReview = visualReview.coverage;
      if (visualReview.coverage.currentSourceModelObservedPairs) coverage.completedChecks.push('visual_model_observations_not_scientific_verification');
      if (visualReview.coverage.status !== 'completed' || visualReview.coverage.decisionCounts?.uncertain) coverage.incompleteChecks.push('visual_model_image_review_scope');
      coverage.nmrFormula = nmr.coverage; coverage.imageDuplicates = duplicates.coverage;
      coverage.compounds = registry.coverage;
      coverage.crossReferences = cross.coverage; coverage.experimentalProse = prose.coverage;
      if (prose.coverage.checked) coverage.completedChecks.push('experimental_prose_explicit_input_recalculation');
      if (prose.coverage.conditional) coverage.conditionalChecks = ['experimental_prose_assumption_scenarios'];
      if (prose.coverage.insufficient || prose.coverage.conditional) coverage.incompleteChecks.push('experimental_input_basis_or_linking');
      coverage.experimentalMath = experimental.coverage; coverage.spectrumComparison = spectra.coverage;
      if (experimental.coverage.checked) coverage.completedChecks.push('explicit_experimental_numeric_recalculation');
      if (spectra.coverage.readings) coverage.completedChecks.push('spectrum_label_comparison');
      if (experimental.coverage.insufficient || spectra.coverage.stale.length || spectra.coverage.provisionalReadings || spectra.coverage.recordsWithGaps) coverage.incompleteChecks.push('scientific_source_interpretation');
      if (nmr.coverage.comparedRecords) coverage.completedChecks.push('reported_nmr_formula_count_comparison');
      if (nmr.coverage.insufficientRecords || nmr.coverage.ambiguousRecords) coverage.incompleteChecks.push('nmr_formula_association_or_count');
      if (duplicates.coverage.checkedAssets) coverage.completedChecks.push('prepared_image_duplicate_comparison');
      if (duplicates.coverage.exactOnlyAssetIds.length) coverage.incompleteChecks.push('nonexact_image_content_requires_review');
      if (duplicates.coverage.uninventoriedDocuments.length || duplicates.coverage.skipped.length || duplicates.coverage.staleAssets.length || duplicates.coverage.truncatedAssets || duplicates.coverage.nextPairOffset !== null) coverage.incompleteChecks.push('image_duplicate_source_coverage');
      if (hrms.coverage.calculatedRecords + hrms.coverage.ambiguousRecords > 0) { coverage.notPerformed = coverage.notPerformed.filter(s => !s.includes('HRMS 分子式精确质量复算')); coverage.completedChecks.push('hrms_conditional_exact_mass_recalculation'); }
      if (hrms.coverage.ambiguousRecords) coverage.incompleteChecks.push('hrms_formula_basis_confirmation');
      if (hrms.coverage.unsupportedRecords) coverage.incompleteChecks.push('hrms_expression_coverage');
      if (hrms.coverage.foundUnreadableRecords || hrms.coverage.foundNotReportedRecords || hrms.records.some(r => r.status !== 'unsupported' && r.foundCheckStatus !== 'checked')) coverage.incompleteChecks.push('hrms_observed_mass_coverage');
      if (visualCoverage.activeTables) { coverage.completedChecks.push('selected_image_table_ocr'); if (visualCoverage.provisionalTables || visualCoverage.staleTables.length || visualCoverage.failedTables.length) coverage.incompleteChecks.push('image_table_transcription_review'); }
      const run = { id: randomUUID(), projectId, createdAt: new Date().toISOString(), engineVersion: VERSION, hostTarget: HOST_TARGET, execution, profile: structuredClone(p.profile), profileRevision: p.profileRevision, hrmsOptions: structuredClone(p.hrmsOptions ?? DEFAULT_HRMS), hrmsRevision: p.hrmsRevision ?? 0, hrmsRecords: hrms.records, visualRevision: p.visualRevision ?? 0, imageTables, documents, facts: result.facts, issues, issueSummary: summarizeIssues(issues), coverage, previousRunId: p.runIds.at(-1) ?? null };
      run.visualReview = visualReview; run.visualReviewRevision = p.visualReviewRevision ?? 0;
      run.crossReferences = cross; run.experimentalProseRecords = prose.records; run.experimentalMethods = prose.methods;
      run.reviewGroups = buildReviewGroups(run);
      run.materialReadings = await this.getMaterialReadings({ projectId });
      run.materialReadings = run.materialReadings.filter(r => documents.some(d => d.id === r.source.documentId && d.sha256 === r.source.sourceSha256));
      coverage.materialOCR = { readings: run.materialReadings.length, failed: run.materialReadings.filter(r => r.status === "failed").length, provisional: run.materialReadings.filter(r => r.status !== "failed").length, note: "Provisional page/image text only; not automatic table, spectrum, structure or semantic verification." };
      let ocrBudget = 2_000_000;
      for (const r of run.materialReadings) {
        const text = r.rawText.slice(0, Math.max(0, Math.min(200_000, ocrBudget))); ocrBudget -= text.length;
        const truncated = text.length !== r.rawText.length;
        documents.push({ id: 'ocrdoc-' + r.id, sourceKey: r.source.documentKey, name: `Material OCR ${r.id}`, role: 'source', format: 'material_ocr', sha256: r.source.rasterSha256, blocks: text ? [{ id: `${r.id}:text`, text, locator: r.source.locator, metadata: { evidenceOrigin: 'material_ocr', assetId: r.assetId, originalSourceSha256: r.source.sourceSha256, rasterSha256: r.source.rasterSha256, visualReviewStatus: 'needs_review' } }] : [], coverage: { status: text ? 'partial' : 'failed', totalUnits: 1, parsedUnits: text ? 1 : 0, truncated, warnings: ['Provisional OCR evidence only; not used automatically as numerical facts, tables, spectra or structures.', ...(truncated ? ['OCR evidence text truncated by snapshot budget; paged original words remain available.'] : [])] } });
      }
      coverage.documents = documents.map(d => ({ id: d.id, name: d.name, role: d.role, ...d.coverage }));
      run.nmrRecords = nmr.records; run.duplicateImageAssets = duplicates.assets;
      run.compoundRegistry = registry; run.scientificRevision = p.scientificRevision ?? 0;
      run.scientificOptions = scientificOptions;
      run.experimentalRecords = experimental.records; run.spectrumReadings = spectrumReadings; run.spectrumComparisons = spectra.records;
      run.status = documents.some(d => d.coverage.status !== 'complete') || run.coverage.missingRoles.length || run.coverage.truncated ? 'partial' : 'completed_with_limited_scope';
      if (run.previousRunId) {
        const previous = await this.getRun({ projectId, runId: run.previousRunId });
        run.revisionLedger = buildRevisionLedger(run, previous);
        const currentIDs = new Set(run.issues.map(i => i.id));
        run.changes = { currentIssues: run.issues.length, priorIssuesNotReproduced: previous.issues.filter(i => !currentIDs.has(i.id)).map(i => ({ id: i.id, title: i.title, state: 'needs_revalidation' })), note: 'Issue disappearance can reflect changed evidence or matching; it is not automatic closure.' };
      }
      if (workflowSnapshot) run.workflow = structuredClone(workflowSnapshot);
      run.revisionLedger ??= buildRevisionLedger(run, null);
      await atomic(path.join(this.dir(projectId), 'runs', `${run.id}.json`), run);
      p.runIds.push(run.id);
      p.duplicateProgress = { signature: imageSignature, runId: run.id, nextPairOffset: duplicates.coverage.nextPairOffset, totalEligiblePairs: duplicates.coverage.totalEligiblePairs, skipped: duplicates.coverage.skipped };
      await atomic(path.join(this.dir(projectId), 'project.json'), p);
      return { ...run, reviews: [] };
    });
  }
  async readVisualComparison(args) { return readVisualComparison(this,args); }
  async visualReview(args) { return visualReviewAction(this,args); }
  async deliverVisualPair(args,deliver) { return deliverVisualPair(this,args,deliver); }
  async submitVisualResult(args,actor) { return submitVisualResult(this,args,actor); }
  async setImageType({ projectId, assetId, type, reason }) {
    if (!IMAGE_TYPES.includes(type) || typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw new Error('Valid image type and explicit user reason required');
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), asset = p.visualAssets?.find(a => a.id === assetId);
      if (!asset || (p.activeVisuals && p.activeVisuals[asset.originKey] !== asset.id)) throw new Error('Active registered image required');
      await this.getVisualImage({ projectId, assetId });
      const source = p.documents.find(d => d.key === asset.documentKey);
      if (!source || hash(await readFile(await this.sourcePath(p, source.filePath))) !== asset.sourceSha256) throw new Error('Source changed; prepare current image before classification');
      const decision = { id: randomUUID(), assetId, type, reason, origin: 'explicit_user', sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256, createdAt: new Date().toISOString() };
      p.imageTypeDecisions ??= []; p.imageTypeDecisions.push(decision); asset.imageType = decision;
      p.scientificRevision = (p.scientificRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return decision;
    });
  }
  async setExperimentContext({ projectId, runId, context }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), run = await this.getRun({ projectId, runId });
      if (p.runIds.at(-1) !== run.id) throw new Error('Use the latest audit run');
      const value = validateExperimentContext(context, run);
      if (value.neutralFormula) calculateMolarMass(value.neutralFormula);
      const doc = run.documents.find(d => d.id === value.documentId), source = p.documents.find(d => d.key === doc.sourceKey);
      if (!source || hash(await readFile(await this.sourcePath(p, source.filePath))) !== value.sourceSha256) throw new Error('Source changed; audit again before confirming experimental context');
      p.experimentContexts ??= []; p.experimentContexts.push(value); p.scientificRevision = (p.scientificRevision ?? 0) + 1;
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return value;
    });
  }
  async workflow(args) { return workflowAction(this, args); }
  async readMaterialImage({ projectId, assetId, signal }) {
    return this.locked(projectId, async () => {
      const p = await this.getProject(projectId), { asset } = await this.getVisualImage({ projectId, assetId });
      const id = 'material-' + hash(JSON.stringify([asset.id, asset.sha256])).slice(0, 24);
      const file = path.join(this.dir(projectId), 'materials', `${id}.json`);
      let reading;
      try { reading = await json(file); if (reading.status === 'failed') reading = null; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!reading) {
        const r = await recognizeImageTable({ imagePath: asset.path, outputDir: path.join(this.dir(projectId), 'materials', 'ocr'), tableId: id, mode: 'spectrum', signal });
        signal?.throwIfAborted();
        reading = { id, assetId, status: r.status, rawText: r.rawText ?? '', words: r.words ?? [], provider: r.provider, notes: r.notes, source: { documentId: asset.documentId, documentKey: asset.documentKey, sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256, locator: asset.locator }, createdAt: new Date().toISOString(), interpretation: 'provisional_text_only_not_table_or_trace_validation' };
        if (r.sourceSha256 !== asset.sha256) throw new Error('Material OCR source changed');
        await atomic(file, reading);
      }
      p.materialReadingIds = [...new Set([...(p.materialReadingIds ?? []), id])];
      await atomic(path.join(this.dir(projectId), 'project.json'), p); return reading;
    });
  }
  async getMaterialReadings({ projectId }) {
    const p = await this.getProject(projectId);
    return Promise.all((p.materialReadingIds ?? []).map(id => json(path.join(this.dir(projectId), 'materials', `${safeID(id)}.json`))));
  }
  async revalidateIssue({ projectId, runId, trackingId, status, reason, citations }) {
    return this.locked(projectId, async () => {
      const run = await this.getRun({ projectId, runId });
      const p = await this.getProject(projectId);
      if (p.runIds.at(-1) !== run.id || run.profileChangedSinceRun || run.hrmsSettingsChangedSinceRun || run.scientificSettingsChangedSinceRun || run.imageTablesChangedSinceRun) throw new Error('Revalidate the latest run with current settings');
      for (const d of run.documents.filter(d => !['image_table', 'material_ocr'].includes(d.format))) {
        const source = p.documents.find(s => s.key === d.sourceKey || s.name === d.name && s.role === d.role);
        if (!source || hash(await readFile(await this.sourcePath(p, source.filePath))) !== d.sha256) throw new Error('Source changed since audit; run again before revalidation');
      }
      const record = validateRevalidation(run, { trackingId, status, reason, citations });
      const prior = await this.extras(projectId, 'revalidations', run.id);
      await atomic(path.join(this.dir(projectId), 'revalidations', `${run.id}.json`), [...prior, record]); return record;
    });
  }
  async extras(projectId, type, runId) {
    try { return await json(path.join(this.dir(projectId), type, `${safeID(runId)}.json`)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async getRun({ projectId, runId } = {}) {
    const p = await this.getProject(projectId);
    const selected = runId ?? p.runIds.at(-1);
    if (!selected || !p.runIds.includes(selected)) throw new Error('Run not found in project');
    const run = await json(path.join(this.dir(projectId), 'runs', `${safeID(selected)}.json`));
    const semantic = await this.extras(projectId, 'semantic', selected);
    const reviews = await this.extras(projectId, 'reviews', selected);
    run.revisionLedger = applyRevalidations(run.revisionLedger, await this.extras(projectId, 'revalidations', selected));
    const signature = docs => docs.map(d => `${d.name}\0${d.role}\0${d.sha256}`).sort().join('\n');
    const issues = [...run.issues, ...semantic];
    if (run.reviewGroups && semantic.length) run.reviewGroups = { ...run.reviewGroups, ungroupedIssueIds: [...new Set([...run.reviewGroups.ungroupedIssueIds, ...semantic.map(i => i.id)])] };
    const physicalDocs = run.documents.filter(d => !['image_table', 'material_ocr'].includes(d.format));
    run.visualReviewsChangedSinceRun = (p.visualReviewRevision ?? 0) !== (run.visualReviewRevision ?? 0);
    run.scientificSettingsChangedSinceRun = (p.scientificRevision ?? 0) !== (run.scientificRevision ?? 0);
    return { ...run, execution: run.execution ?? { entryPoint: 'legacy_unknown', recordedBy: 'not recorded in original run' }, issues, issueSummary: summarizeIssues(issues), reviews, coverage: { ...run.coverage, semanticStatus: semantic.length ? 'candidates_submitted_not_exhaustive' : 'not_run' }, profileChangedSinceRun: p.profileRevision !== run.profileRevision, hrmsSettingsChangedSinceRun: (p.hrmsRevision ?? 0) !== (run.hrmsRevision ?? 0), imageTablesChangedSinceRun: (p.visualRevision ?? 0) !== (run.visualRevision ?? 0), sourcesChangedSinceRun: signature(p.documents) !== signature(physicalDocs) };
  }
  evidenceFrom(run, evidenceId) {
    const fact = run.facts.find(f => f.id === evidenceId);
    const blockId = fact?.blockId ?? evidenceId;
    for (const document of run.documents) {
      const block = document.blocks.find(b => b.id === blockId);
      if (block) return { document: { id: document.id, name: document.name, role: document.role, sha256: document.sha256 }, block, fact: fact ?? null };
    }
    throw new Error('Evidence does not exist in this run');
  }
  async getEvidence({ projectId, runId, evidenceId }) { return this.evidenceFrom(await this.getRun({ projectId, runId }), evidenceId); }
  async reviewIssue({ projectId, runId, issueId, status, reason }) {
    if (!STATES.has(status)) throw new Error('Unsupported review state; direct closure requires a new audit and human revalidation');
    return this.locked(projectId, async () => {
      const run = await this.getRun({ projectId, runId });
      if (!run.issues.some(i => i.id === issueId)) throw new Error('Issue not found');
      const record = { id: randomUUID(), issueId, status, reason: clean(reason), at: new Date().toISOString() };
      await atomic(path.join(this.dir(projectId), 'reviews', `${run.id}.json`), [...run.reviews, record]);
      return record;
    });
  }
  async submitSemantic({ projectId, runId, candidates }) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 30) throw new Error('Submit 1–30 bounded candidates');
    return this.locked(projectId, async () => {
      const run = await this.getRun({ projectId, runId });
      const proposed = candidates.map(c => {
        if (!['high', 'medium', 'low'].includes(c.severity)) throw new Error('Invalid severity');
        if (!Array.isArray(c.evidence) || !c.evidence.length || c.evidence.length > 10) throw new Error('Candidate needs 1–10 source quotations');
        const citations = c.evidence.map(e => {
          const { block } = this.evidenceFrom(run, e.blockId);
          clean(e.quote, 5000);
          const quote = e.quote;
          const start = e.start ?? block.text.indexOf(quote);
          if (!Number.isInteger(start) || start < 0 || block.text.slice(start, start + quote.length) !== quote) throw new Error('Quotation is not an exact source substring');
          if (e.start === undefined && block.text.indexOf(quote, start + 1) !== -1) throw new Error('Ambiguous quotation; specify start offset');
          return { blockId: block.id, quote, start, end: start + quote.length };
        });
        const title = clean(c.title, 300), description = clean(c.description, 6000);
        return { id: `semantic-${hash(JSON.stringify([title, citations])).slice(0, 24)}`, type: 'semantic', severity: c.severity, evidenceStatus: 'needs_review', status: 'open', title, description, evidenceIds: citations.map(e => e.blockId), citations, suggestion: c.suggestion ? clean(c.suggestion, 2000) : null, note: 'Exact quotation validation does not validate the scientific inference.' };
      });
      const existing = await this.extras(projectId, 'semantic', run.id);
      const ids = new Set(existing.map(i => i.id));
      const added = proposed.filter(i => { if (ids.has(i.id)) return false; ids.add(i.id); return true; });
      await atomic(path.join(this.dir(projectId), 'semantic', `${run.id}.json`), [...existing, ...added]);
      return { accepted: added.length, issues: added, semanticCoverage: 'not_exhaustive' };
    });
  }
  async exportReport({ projectId, runId, format = 'md' }) {
    const run = await this.getRun({ projectId, runId });
    if (!['md', 'json', 'csv'].includes(format)) throw new Error('Unknown report format');
    let content;
    if (format === 'json') content = JSON.stringify(run, null, 2);
    else if (format === 'csv') {
      const ledger = run.revisionLedger?.items ?? [];
      const rows = run.issues.map(i => { const r = run.reviews.filter(r => r.issueId === i.id).at(-1), t = ledger.find(t => t.currentIssueId === i.id); return [i.id, i.type, i.severity, i.evidenceStatus, i.title, i.description, i.evidenceIds.join(';'), r?.status, r?.reason, i.category, i.calculation ? JSON.stringify(i.calculation) : '', i.imageEvidence ? JSON.stringify(i.imageEvidence) : '', i.citations ? JSON.stringify(i.citations) : '', t?.id, t?.state, t?.originRunId]; });
      for (const r of run.visualReview?.records ?? []) if (r.state === 'submitted' && r.record.observation.decision === 'no_correspondence') rows.push([r.record.id, 'model_observation', '', 'not_scientifically_verified', '视觉模型未发现对应', r.record.observation.reason, '', '', '', 'visual_duplicate_observation', JSON.stringify(r.record), JSON.stringify(r.assetIds), '', '', '', '']);
      for (const t of ledger.filter(t => !t.currentIssueId)) rows.push([t.originIssueId, 'revision', '', t.state, t.title, 'Historical issue tracked across revisions; disappearance is not closure.', t.currentCitations.map(c => c.blockId).join(';'), t.closure?.status, t.closure?.reason, 'revision', '', '', JSON.stringify(t.currentCitations), t.id, t.state, t.originRunId]);
      content = [['id', 'type', 'severity', 'evidence_status', 'title', 'description', 'evidence', 'latest_review', 'reason', 'category', 'calculation_json', 'image_evidence_json', 'citations_json', 'tracking_id', 'revision_state', 'origin_run_id'], ...rows].map(row => row.map(csv).join(',')).join('\r\n');
    }
    else content = renderMarkdown(run, this.evidenceFrom.bind(this));
    const file = path.join(this.dir(projectId), 'exports', `${run.id}-${randomUUID().slice(0, 8)}.${format}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return { path: file, content, format };
  }
}
