import { createHash } from 'node:crypto';
import { recordsFor } from './nmr.js';

export const MATERIAL_KINDS = ['procedure', 'formula', 'h1_text', 'c13_text', 'hrms_text', 'ms_text', 'elemental_analysis', 'h1_spectrum', 'c13_spectrum', 'chromatogram', 'structure', 'reference'];
export const CLASSIFICATIONS = ['unknown', 'new', 'known', 'key_intermediate'];
const hash = (...p) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 24);
const fail = s => { throw new Error(`Compound registry: ${s}`); };
function bounded(s, max = 200) { if (typeof s !== 'string' || !s.trim() || s.length > max) fail('nonempty bounded text required'); return s.trim(); }
export function validateRequirements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['name', 'version', 'source_type', 'source', 'rules'].includes(k))) fail('unknown checklist fields');
  bounded(value.name); bounded(value.version);
  if (!['user_defined', 'official_requirement'].includes(value.source_type)) fail('declare checklist source_type');
  if (value.source_type === 'official_requirement' && (!value.source || value.source.status !== 'verified' || !/^https?:\/\//.test(value.source.url ?? '') || !value.source.quote || !value.source.checked_at)) fail('official checklist requires verified URL, quote and date');
  if (value.source) { if (JSON.stringify(value.source).length > 6000) fail('source too long'); }
  if (!Array.isArray(value.rules) || value.rules.length > 100) fail('at most 100 checklist rules');
  for (const rule of value.rules) {
    if (!rule || Object.keys(rule).some(k => !['classification', 'allOf', 'anyOf'].includes(k)) || !['any', ...CLASSIFICATIONS].includes(rule.classification)) fail('invalid classification/rule');
    for (const kinds of [rule.allOf ?? [], ...(rule.anyOf ?? [])]) if (!Array.isArray(kinds) || kinds.length > MATERIAL_KINDS.length || kinds.some(k => !MATERIAL_KINDS.includes(k))) fail('unknown material kind');
    if (rule.anyOf && (!Array.isArray(rule.anyOf) || rule.anyOf.length > 20 || rule.anyOf.some(g => !g.length))) fail('invalid alternatives');
  }
  return structuredClone(value);
}
export function compoundSourceRecords(documents) {
  const records = [];
  for (const document of documents.filter(d => d.format !== 'image_table')) for (const group of recordsFor(document)) {
    const text = group.pieces.map(p => p.block.text.slice(p.start, p.end)).join('\n');
    if (!group.entity && !/(?:1H|¹H|13C|¹³C)\s*NMR|\bHRMS\b/.test(text)) continue;
    const kinds = [];
    for (const [kind, pattern] of [
      ['h1_text', /(?:1H|¹H)\s*NMR[^]*?(?:δ|\bdelta\b)/], ['c13_text', /(?:13C|¹³C)\s*NMR[^]*?(?:δ|\bdelta\b)/],
      ['hrms_text', /\bHRMS\b/], ['ms_text', /\b(?:HRMS|(?:EI|ESI|APCI)-MS)\b/], ['formula', /(?:molecular\s+formula|分子式|formula\s*[:=])|\b(?:calcd?|calculated)\.?\s+(?:for\s+)?C\d/i],
      ['procedure', /\b(?:yield|stirred|purified|prepared|synthesized)\b|收率|搅拌/i],
      ['elemental_analysis', /\b(?:elemental analysis|Anal\.\s*Calcd)/i], ['reference', /\b(?:reported|literature|reference)\b|文献/i],
    ]) if (pattern.test(text)) kinds.push(kind);
    const first = group.pieces[0];
    const spectrumLabels = [...text.matchAll(/\b(?:spectra|spectrum)\s+of\s+(\d+[a-zA-Z]*)\b/gi)];
    records.push({ id: 'record_' + hash(document.id, first.block.id, first.start), label: group.entity ?? (spectrumLabels.length === 1 ? spectrumLabels[0][1] : null), documentId: document.id, sourceSha256: document.sha256, name: document.name, role: document.role, kinds, parsedKinds: [], association: 'candidate', citations: group.pieces.map(p => ({ blockId: p.block.id, start: p.start, end: p.end, quote: p.block.text.slice(p.start, p.end), locator: p.block.locator })) });
  }
  return records;
}

export function buildCompoundRegistry(documents, { nmrRecords = [], hrmsRecords = [], assets = [], decisions = [], requirements = null, spectrumReadings = [] } = {}) {
  const records = compoundSourceRecords(documents), compounds = new Map(), staleDecisions = [], issues = [];
  const ensure = label => {
    if (!compounds.has(label)) compounds.set(label, { id: 'compound_' + hash(label), label, classification: 'unknown', association: 'candidate', recordIds: [], materials: Object.fromEntries(MATERIAL_KINDS.map(k => [k, { status: 'not_located', evidence: [] }])), decisions: [] });
    return compounds.get(label);
  };
  const latest = new Map();
  for (const decision of decisions) latest.set(decision.compoundLabel, decision);
  const owners = new Map();
  for (const d of latest.values()) {
    const row = ensure(d.compoundLabel); row.classification = d.classification; row.decisions.push(d); row.association = 'user_declared';
    for (const link of d.links) {
      const source = link.recordId ? records.find(r => r.id === link.recordId && r.sourceSha256 === link.sourceSha256) : assets.find(a => a.id === link.assetId && a.sourceSha256 === link.sourceSha256);
      if (!source) { staleDecisions.push({ compoundLabel: d.compoundLabel, link }); continue; }
      const key = link.recordId ?? link.assetId;
      if (owners.has(key) && owners.get(key).label !== row.label) { owners.set(key, { conflict: true }); continue; }
      owners.set(key, { label: row.label, kind: link.kind, reason: d.reason });
    }
  }
  const add = (row, kind, evidence, parsed = false) => {
    if (!row.materials[kind]) return;
    const material = row.materials[kind]; material.evidence.push(evidence);
    material.status = parsed || material.status === 'parsed' ? 'parsed' : 'located_unread';
  };
  for (const record of records) {
    const owner = owners.get(record.id);
    if (owner?.conflict) { record.association = 'conflicting_user_links'; continue; }
    const label = owner?.label ?? record.label;
    if (!label) continue;
    const row = ensure(label); row.recordIds.push(record.id); record.assignedLabel = label;
    if (owner) record.association = 'user_confirmed';
    for (const kind of record.kinds) {
      const overlaps = r => r.documentId === record.documentId && record.citations.some(c => (r.citation?.blockId ?? r.blockId) === c.blockId && (r.citation?.start ?? r.start) >= c.start && (r.citation?.start ?? r.start) < c.end);
      const parsed = kind === 'h1_text' || kind === 'c13_text' ? nmrRecords.some(r => overlaps(r) && r.nucleus === (kind === 'h1_text' ? '1H' : '13C') && r.count !== undefined) : kind === 'hrms_text' ? hrmsRecords.some(r => overlaps(r) && r.formula) : false;
      if (parsed) record.parsedKinds.push(kind);
      add(row, kind, { recordId: record.id, documentId: record.documentId, sourceSha256: record.sourceSha256, association: record.association, citations: record.citations }, parsed);
    }
  }
  for (const asset of assets) {
    const owner = owners.get(asset.id);
    if (owner?.conflict) continue;
    // Caption-derived links are candidates only and cannot invent a spectrum type.
    const caption = [asset.panelLabel, asset.locator?.precedingText, asset.locator?.currentText].filter(Boolean).join(' ');
    const labels = [...caption.matchAll(/\b(?:(?:compound|product)\s+|(?:spectra|spectrum)\s+of\s+)(\d+[a-zA-Z]*)\b/gi)];
    const label = owner?.label ?? (labels.length === 1 ? labels[0][1] : null);
    const kind = owner?.kind ?? (/(?:1H|¹H)\s*NMR/i.test(caption) ? 'h1_spectrum' : /(?:13C|¹³C)\s*NMR/i.test(caption) ? 'c13_spectrum' : null);
    if (!label || !kind) continue;
    const reading = spectrumReadings.find(r => r.assetId === asset.id && r.rasterSha256 === asset.sha256 && r.status !== 'failed' && r.review?.status !== 'rejected');
    add(ensure(label), kind, { assetId: asset.id, documentId: asset.documentId, sourceSha256: asset.sourceSha256, locator: asset.locator, association: owner ? 'user_confirmed' : 'caption_candidate' }, !!reading);
  }
  for (const row of compounds.values()) {
    row.requirements = [];
    for (const rule of requirements?.rules ?? []) if (rule.classification === 'any' || rule.classification === row.classification) {
      for (const alternatives of [...(rule.allOf ?? []).map(k => [k]), ...(rule.anyOf ?? [])]) {
        const located = alternatives.some(k => row.materials[k].status !== 'not_located');
        const confirmed = alternatives.some(k => row.materials[k].evidence.some(e => e.association === 'user_confirmed'));
        row.requirements.push({ alternatives, status: !located ? 'not_located' : confirmed ? 'located' : 'candidate_association' });
        if (!located) issues.push({ id: 'checklist_' + hash(row.label, alternatives), type: 'coverage', category: 'compound_completeness', severity: 'low', evidenceStatus: 'insufficient', status: 'open', title: `${row.label}：清单材料尚未定位`, description: `用户选择的清单「${requirements.name}」要求 ${alternatives.join(' 或 ')}；当前解析及绑定中未定位。可能是未提供、未解析或未正确关联，不能据此断言作者缺失数据。`, evidenceIds: [...new Set(records.filter(r => row.recordIds.includes(r.id)).flatMap(r => r.citations.map(c => c.blockId)))], calculation: { compound: row.label, alternatives, requirementSource: requirements.source_type } });
      }
    }
  }
  return { compounds: [...compounds.values()], records, issues, requirements, coverage: { compoundCount: compounds.size, recordCount: records.length, unassignedRecords: records.filter(r => !r.assignedLabel).map(r => r.id), staleDecisions, conflictingLinks: [...owners].filter(([, o]) => o.conflict).map(([key]) => key), status: 'limited', note: 'Same labels are candidate groups, not proven identity. Located or parsed material does not establish scientific correctness. Checklist requirements are only those explicitly configured.' } };
}

export function validateCompoundDecision(value, run) {
  if (!value || Object.keys(value).some(k => !['compoundLabel', 'classification', 'links', 'reason'].includes(k))) fail('unknown decision fields');
  const compoundLabel = bounded(value.compoundLabel, 100), reason = bounded(value.reason, 2000);
  if (!CLASSIFICATIONS.includes(value.classification)) fail('unknown compound classification');
  if (!Array.isArray(value.links) || value.links.length > 100) fail('at most 100 evidence links');
  const links = value.links.map(link => {
    if (!link || Object.keys(link).some(k => !['recordId', 'assetId', 'kind'].includes(k)) || !!link.recordId === !!link.assetId) fail('link exactly one record or asset');
    const item = link.recordId ? run.compoundRegistry.records.find(r => r.id === link.recordId) : run.duplicateImageAssets.find(a => a.assetId === link.assetId);
    if (!item) fail('evidence must exist in selected run');
    if (link.assetId && !['h1_spectrum', 'c13_spectrum', 'chromatogram', 'structure'].includes(link.kind)) fail('declare visual material kind');
    return { ...link, sourceSha256: item.sourceSha256, documentId: item.documentId };
  });
  return { compoundLabel, classification: value.classification, links, reason, basedOnRunId: run.id, createdAt: new Date().toISOString() };
}
