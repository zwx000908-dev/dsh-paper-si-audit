import { createHash } from 'node:crypto';
import { nmrMetadata, readSpectrum } from './nmr.js';
const hash = (...v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
const unique = values => [...new Set(values)];

export function parseSpectrumLabels(rawText = '') {
  const text = rawText.replace(/\b(1|13)\s+([HC])\s+NMR/gi, '$1$2 NMR');
  const nuclei = unique([...text.matchAll(/(?:1H|¹H|13C|¹³C)\s*NMR/gi)].map(m => /13C|¹³C/.test(m[0]) ? '13C' : '1H'));
  const frequencies = unique([...text.matchAll(/(\d+(?:\.\d+)?)\s*MHz\b/gi)].map(m => Number(m[1])));
  const compounds = unique([...text.matchAll(/\b(?:(?:compound|product)\s*[:=]?\s*|(?:spectra|spectrum)\s+of\s+)(\d+[a-zA-Z]*)\b/gi)].map(m => m[1]));
  const solvents = unique([...text.matchAll(/\b(?:CDCl3|Chloroform[−-]d|DMSO[−-]?d6|CD3OD|D2O|C6D6|CD3CN|acetone[−-]?d6|THF[−-]?d8)\b/gi)].map(m => nmrMetadata(m[0]).solvent));
  const totals = unique([...text.matchAll(/\b(?:integral\s*(?:sum|total)|total\s*integral)\s*[:=]\s*(\d+(?:\.\d+)?)\s*H?\b/gi)].map(m => Number(m[1])));
  const fields = {}, ambiguousFields = [];
  for (const [name, values] of Object.entries({ nucleus: nuclei, frequencyMHz: frequencies, compoundLabel: compounds, solvent: solvents, integralSum: totals })) {
    if (values.length === 1) fields[name] = values[0]; else if (values.length > 1) ambiguousFields.push({ field: name, values });
  }
  // Peak lists are only read when explicitly marked. Bare plotted labels and
  // arbitrary numbers in the image are never interpreted as integrals/shifts.
  const list = /(?:δ|\bdelta\b)\s*[:=]?\s*([^\n]+)/i.exec(text);
  if (list && fields.nucleus) {
    const spectrum = readSpectrum('δ ' + list[1], fields.nucleus);
    if (spectrum.status === 'parsed') {
      fields.peaks = spectrum.peaks;
      if (fields.nucleus === '1H' && fields.integralSum !== undefined && fields.integralSum !== spectrum.count) { ambiguousFields.push({ field: 'integralSum', values: [fields.integralSum, spectrum.count] }); delete fields.integralSum; }
      else if (fields.nucleus === '1H' && fields.integralSum === undefined && !ambiguousFields.some(a => a.field === 'integralSum')) fields.integralSum = spectrum.count;
    }
  }
  return { fields, ambiguousFields, missingFields: ['nucleus', 'frequencyMHz', 'solvent', 'compoundLabel', 'integralSum'].filter(k => fields[k] === undefined), note: 'Explicit labels/peak lists only. Bare plot numbers, trace picking, baseline correction and quantitative integration are not inferred.' };
}

export function validateSpectrumFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(k => !['nucleus', 'frequencyMHz', 'solvent', 'compoundLabel', 'integralSum', 'peaks'].includes(k))) throw new Error('Invalid spectrum correction fields');
  if (fields.nucleus !== undefined && !['1H', '13C'].includes(fields.nucleus)) throw new Error('Unsupported nucleus');
  for (const [key, max] of [['frequencyMHz', 2000], ['integralSum', 100000]]) if (fields[key] !== undefined && (typeof fields[key] !== 'number' || !Number.isFinite(fields[key]) || fields[key] <= 0 || fields[key] > max)) throw new Error(`Invalid ${key}`);
  for (const key of ['solvent', 'compoundLabel']) if (fields[key] !== undefined && (typeof fields[key] !== 'string' || !fields[key].trim() || fields[key].length > 100)) throw new Error(`Invalid ${key}`);
  if (fields.peaks !== undefined) {
    if (!Array.isArray(fields.peaks) || fields.peaks.length > 500) throw new Error('At most 500 peak annotations');
    for (const p of fields.peaks) if (!p || Object.keys(p).some(k => !['shift', 'integral'].includes(k)) || !Number.isFinite(p.shift) || Math.abs(p.shift) > 1000 || (p.integral !== undefined && (!Number.isFinite(p.integral) || p.integral <= 0 || p.integral > 100000))) throw new Error('Invalid annotated peak');
  }
  return structuredClone(fields);
}

export function checkSpectrumReadings(readings, registry, nmrRecords, assets, options) {
  const issues = [], records = []; const stale = [], rejected = [];
  for (const reading of readings) {
    if (reading.review?.status === 'rejected') { rejected.push(reading.id); continue; }
    const source = registry.records.find(r => r.id === reading.recordId), asset = assets.find(a => a.id === reading.assetId && a.sha256 === reading.rasterSha256 && a.sourceSha256 === reading.sourceSha256);
    if (!source || !asset) { stale.push(reading.id); continue; }
    const fields = reading.fields ?? {}, candidates = nmrRecords.filter(r => r.documentId === source.documentId && source.citations.some(c => r.citation.blockId === c.blockId && r.citation.start >= c.start && r.citation.start < c.end));
    const targets = candidates.filter(r => !fields.nucleus || r.nucleus === fields.nucleus), target = targets.length === 1 ? targets[0] : null;
    const differences = [...(reading.captionConflicts ?? []).map(c => ({ ...c, field: 'caption_vs_image:' + c.field }))], gaps = [...reading.missingFields ?? []], checkedFields = [];
    const label = source.assignedLabel ?? source.label;
    if (fields.compoundLabel && label) checkedFields.push('compoundLabel');
    if (fields.nucleus && candidates.length) checkedFields.push('nucleus');
    if (fields.compoundLabel && label && fields.compoundLabel !== label) differences.push({ field: 'compoundLabel', text: label, image: fields.compoundLabel });
    if (fields.nucleus && candidates.length && !targets.length) differences.push({ field: 'nucleus', text: unique(candidates.map(r => r.nucleus)), image: fields.nucleus });
    if (!target) gaps.push('unique_text_spectrum');
    else {
      for (const [key, expected, actual, tolerance] of [['frequencyMHz', target.frequencyMHz, fields.frequencyMHz, options.frequencyToleranceMHz], ['integralSum', target.nucleus === '1H' ? target.count : null, fields.integralSum, options.nmrIntegralTolerance]]) {
        if (expected == null || actual == null) { gaps.push(key); continue; }
        checkedFields.push(key);
        if (Math.abs(expected - actual) > tolerance) differences.push({ field: key, text: expected, image: actual, tolerance });
      }
      if (target.solvent && fields.solvent) { checkedFields.push('solvent'); if (target.solvent !== (nmrMetadata(fields.solvent).solvent ?? fields.solvent.toUpperCase().replace(/[−-]/g, ''))) differences.push({ field: 'solvent', text: target.solvent, image: fields.solvent }); } else gaps.push('solvent');
      const used = new Set();
      for (const peak of fields.peaks ?? []) {
        const matched = (target.peaks ?? []).map((p, i) => ({ p, i })).filter(({ p, i }) => !used.has(i) && Math.min(p.shift, p.endShift ?? p.shift) - options.nmrShiftTolerance <= peak.shift && Math.max(p.shift, p.endShift ?? p.shift) + options.nmrShiftTolerance >= peak.shift);
        if (matched.length !== 1) { gaps.push(`peak_assignment:${peak.shift}`); continue; }
        const { p, i } = matched[0]; used.add(i);
        checkedFields.push(`peak_shift:${peak.shift}`);
        if (peak.integral !== undefined && p.integral !== undefined && Math.abs(peak.integral - p.integral) > options.nmrIntegralTolerance) differences.push({ field: 'peak_integral', shift: peak.shift, text: p.integral, image: peak.integral });
      }
    }
    const citations = [...(target ? [target.citation] : source.citations), ...(reading.captionCitation ? [reading.captionCitation] : [])];
    const record = { readingId: reading.id, recordId: source.id, status: differences.length ? 'needs_review' : target && checkedFields.length ? 'compatible_observed_fields_only' : 'insufficient', differences, checkedFields, unchecked: unique(gaps), fieldOrigins: reading.fieldOrigins ?? {}, transcriptionStatus: reading.review?.status ?? 'needs_review', comparisonScope: 'explicit_image_annotations_and_separately_cited_document_caption' }; records.push(record);
    if (differences.length || !target || !checkedFields.length || reading.status === 'failed') issues.push({ id: 'spectrum_' + hash(reading.id, differences), type: differences.length ? 'data' : 'coverage', category: 'nmr_image', severity: differences.length ? 'medium' : 'low', evidenceStatus: differences.length ? 'needs_review' : 'insufficient', status: 'open', title: differences.length ? '核磁文字与谱图标注存在待核实差异' : '核磁谱图互查信息不足', description: '核对谱图明确文字/标注或有独立引用的文档谱图标题与绑定的表征记录；每个字段的来源单独保留。OCR、编号归属和数值需结合原图复核，未从谱线形状推算积分或认定结构错误。', evidenceIds: [...new Set(citations.map(c => c.blockId))], citations, imageEvidence: [{ assetId: asset.id, name: asset.name, locator: asset.locator, path: asset.path, sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256, crop: reading.crop }], calculation: record });
  }
  return { issues, records, coverage: { status: records.length ? 'limited' : 'not_performed', readings: records.length, recordsWithGaps: records.filter(r => r.unchecked.length).length, provisionalReadings: records.filter(r => r.transcriptionStatus !== 'accepted').length, stale, rejected, note: 'Label/annotation comparison only. Missing and ambiguous fields remain unchecked; compatible observed fields do not establish complete spectral agreement.' } };
}
