import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { validateProfile, defaultProfile } from './profiles.js';

const D = Decimal.clone({ precision: 50 });
export const AUDIT_LIMITS = Object.freeze({ pairBudget: 100_000 });
const NUM = '[+\\-−]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+\\-]?\\d+)?';
const stableId = (prefix, ...parts) => `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20)}`;
const normalizeNumber = raw => new D(raw.replaceAll('−', '-')).toString();
const comparators = /[<>≤≥]/;
const unitCanonical = unit => ({ '℃': '°C', '° C': '°C', 'μmol': 'µmol', umol: 'µmol', hours: 'h', hour: 'h', minutes: 'min', minute: 'min', seconds: 's', second: 's' })[unit] ?? unit;
const matchAll = (text, pattern, extra = '') => [...text.matchAll(new RegExp(pattern, `gdi${extra}`))];
const headerKey = text => String(text ?? '').toLowerCase().replace(/[¹]/g, '1').replace(/[³]/g, '3').replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_').replace(/^_|_$/g, '');
const ENTITY_ID = '(?:[A-Za-z][A-Za-z0-9_-]*\\d[A-Za-z0-9_′\'*-]*|\\d+[A-Za-z0-9_′\'*-]*)';
const ENTITY_NOUN = '(?:compounds?|products?|alcohols?|derivatives?|species|entities|entity|化合物|产物)';
const MS_LABEL_PATTERN = '\\b(?:HRMS(?:\\s*[-–−]?\\s*(?:ESI|EI|APCI|MALDI))?|(?:ESI|EI|APCI|MALDI)\\s*[-–−]\\s*MS|MS)\\b';

function identityOf(text, metadata) {
  const values = {};
  for (const cell of metadata?.cells ?? []) values[headerKey(cell.header)] = String(cell.text ?? '').trim();
  const from = (...keys) => keys.map(k => values[k]).find(Boolean);
  const tag = names => [...text.matchAll(new RegExp(`(?:^|[\\s;,|])(?:${names})\\s*[:=]\\s*([\\w.-]+)`, 'gi'))].at(-1)?.[1];
  const entity = from('compound', 'product', 'entity', 'compound_id', '产物', '化合物') ?? tag('compound|product|entity|化合物|产物');
  const experiment = from('experiment', 'experiment_id', 'exp', 'run', '实验') ?? tag('experiment(?:_id)?|exp|run|实验');
  const batch = from('batch', 'batch_id', '批次') ?? tag('batch(?:_id)?|批次');
  const conditions = from('conditions', 'condition', '条件') ?? /(?:conditions?|条件)\s*[:=]\s*([^;\n|]+)/i.exec(text)?.[1]?.trim();
  const methodValue = from('method', 'yield_basis', 'basis', '测量方法') ?? tag('method|yield_basis|basis|测量方法');
  const method = methodValue ? yieldMethod(methodValue) ?? methodValue.toLowerCase() : undefined;
  return { ...(entity ? { entity } : {}), ...(experiment ? { experiment } : {}), ...(batch ? { batch } : {}), ...(conditions ? { conditions } : {}), ...(method ? { method } : {}) };
}

/** Noun/label mentions retain source spans; plural/range mentions are deliberately not singular identities. */
function entityMentions(text) {
  const mentions = [];
  for (const m of matchAll(text, `(?<![A-Za-z0-9_])${ENTITY_NOUN}\\s*[:=]?\\s*(${ENTITY_ID})(?![A-Za-z0-9_])`)) {
    const entities = [m[1]]; let end = m.indices[1][1];
    const tail = text.slice(end);
    const list = new RegExp(`^\\s*(?:,\\s*(?:(?:and|or)\\s+)?|(?:and|or)\\s+|[−–—-]\\s*)(${ENTITY_ID})(?![A-Za-z0-9_])`, 'i');
    let offset = 0, next;
    while (entities.length < 12 && (next = list.exec(tail.slice(offset)))) { entities.push(next[1]); offset += next[0].length; end = m.indices[1][1] + offset; }
    mentions.push({ start: m.index, end, entities: [...new Set(entities)], explicit: /[:=]/.test(text.slice(m.index, m.indices[1][0])) });
  }
  const heading = new RegExp(`^\\s*(${ENTITY_ID})\\s*[:：]`, 'd').exec(text);
  if (heading && !mentions.some(m => m.start <= heading.indices[1][0] && m.end >= heading.indices[1][1])) mentions.unshift({ start: heading.indices[1][0], end: heading.indices[1][1], entities: [heading[1]], explicit: false });
  return mentions;
}

function sentenceRanges(text) {
  const ranges = []; let start = 0;
  // PDF newlines are often line wraps, so they are not sentence boundaries. Decimal points never match this boundary.
  for (const m of text.matchAll(/[.!?](?:\s+|$)/g)) { ranges.push({ start, end: m.index + m[0].length }); start = m.index + m[0].length; }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges.length ? ranges : [{ start: 0, end: text.length }];
}

function sourceContexts(text, metadata) {
  const mentions = entityMentions(text), sentences = sentenceRanges(text);
  const records = mentions.filter(m => m.explicit);
  const allEntities = [...new Set(mentions.flatMap(m => m.entities))];
  const rowIdentity = metadata?.cells?.length ? identityOf(text, metadata) : null;
  return (field, start, end) => {
    const recordIndex = records.findLastIndex(r => r.start <= start);
    const record = recordIndex >= 0 ? { start: records[recordIndex].start, end: records[recordIndex + 1]?.start ?? text.length } : null;
    const scope = rowIdentity ? { start: 0, end: text.length } : record ?? sentences.find(s => s.start <= start && s.end >= end) ?? { start, end };
    const scopeText = text.slice(scope.start, scope.end);
    const beforeFact = text.slice(scope.start, end);
    const local = rowIdentity ?? identityOf(beforeFact);
    const localMentions = mentions.filter(m => m.start >= scope.start && m.end <= scope.end);
    const preceding = localMentions.filter(m => m.end <= start && start - m.end <= 300);
    let chosen = preceding.at(-1);
    if (!chosen) {
      const following = localMentions.find(m => m.start >= end && m.start - end < 80);
      if (following && /^\s*%?\s*(?:isolated\s+)?yields?\s+(?:of|for)\b/i.test(text.slice(end, following.start))) chosen = following;
    }
    let entity = rowIdentity?.entity ?? local.entity;
    let candidates = chosen?.entities ?? [];
    let ambiguous = false;
    if (!rowIdentity && chosen) {
      if (candidates.length === 1) {
        if (entity && entity !== candidates[0]) ambiguous = true;
        entity = candidates[0];
      } else { entity = undefined; ambiguous = true; }
    }
    if (!entity && !ambiguous && (field.startsWith('nmr.') || field.startsWith('hrms.')) && allEntities.length === 1) entity = allEntities[0];
    // A bare source/substrate mention is not enough to attach a subsequent product yield.
    if (!rowIdentity && !record && field === 'yield.percent' && chosen && chosen.end <= start) {
      const bridge = text.slice(chosen.end, start);
      if (/\b(?:substrates?|starting materials?|reactants?)\b/i.test(bridge) || /\b(?:of|from|using|with)\s*$/i.test(text.slice(Math.max(scope.start, chosen.start - 12), chosen.start)) && !/\b(?:was|were)\s+(?:obtained|isolated|synthesized|formed|afforded)/i.test(bridge)) { entity = undefined; ambiguous = true; }
    }
    const context = { ...local, contextStart: scope.start, contextEnd: scope.end, identityBasis: rowIdentity ? 'structured_row' : record ? 'explicit_record' : 'local_sentence' };
    delete context.entity;
    if (entity) context.entity = entity;
    if (ambiguous) { context.identityAmbiguous = true; context.entityCandidates = candidates; delete context.experiment; delete context.batch; }
    // Source references distinguish optimization entries; a general procedure is not automatically mapped to an entry.
    const refs = [...scopeText.matchAll(/\bTable\s+(S?\d+)\s*,?\s*entr(?:y|ies)\s+(\d+(?:\s*(?:[−–—-]|and|,)\s*\d+)*)/gi)];
    if (refs.length) {
      const ref = refs.sort((a, b) => Math.abs(scope.start + a.index - end) - Math.abs(scope.start + b.index - end))[0];
      const raw = ref[2], numbers = raw.match(/\d+/g).map(Number);
      const entries = /[−–—-]/.test(raw) && numbers.length === 2 && numbers[1] >= numbers[0] && numbers[1] - numbers[0] <= 100 ? Array.from({ length: numbers[1] - numbers[0] + 1 }, (_, i) => numbers[0] + i) : numbers;
      context.experimentContext = { kind: 'table_entries', table: ref[1].toUpperCase(), entries };
    } else {
      const procedure = /\bgeneral\s+(?:procedure|method)\s+([A-Za-z0-9]+)/i.exec(scopeText);
      if (procedure) context.experimentContext = { kind: 'general_procedure', label: procedure[1].toUpperCase() };
      else if (/\bprecatalyst\b/i.test(beforeFact)) context.experimentContext = { kind: 'precatalyst_experiment' };
      else if (/\d+(?:\.\d+)?\s*(?:m?mol)\s+scale|\b(?:scale[- ]up|gram[- ]scale)\b/i.test(scopeText)) context.experimentContext = { kind: 'scale_up' };
      else if (/\b(?:optimized|optimal)\s+(?:reaction\s+)?conditions\b/i.test(scopeText)) context.experimentContext = { kind: 'optimization', label: 'optimized' };
      else if (/\binitial\s+(?:reaction\s+)?conditions\b/i.test(scopeText)) context.experimentContext = { kind: 'optimization', label: 'initial' };
    }
    return context;
  };
}

function yieldMethodNear(text) {
  const match = /\b(isolated|NMR|assay|GC|HPLC|分离)\s+(?:[^;.%]{0,12}\s+)?(?:yield|产率)\b/i.exec(text);
  return match ? yieldMethod(match[1]) : undefined;
}

function yieldMethod(text) {
  if (/isolated|分离/.test(text.toLowerCase())) return 'isolated';
  if (/nmr|核磁/.test(text.toLowerCase())) return 'nmr';
  if (/assay|分析产率/.test(text.toLowerCase())) return 'assay';
  if (/gc|hplc/.test(text.toLowerCase())) return /hplc/i.test(text) ? 'hplc' : 'gc';
  return undefined;
}

export function extractFacts(document) {
  const facts = []; const seen = new Set();
  for (const block of document.blocks ?? []) {
    const blockFactStart = facts.length;
    const text = String(block.text ?? ''); const resolveIdentity = sourceContexts(text, block.metadata);
    const identity = identityOf(text, block.metadata);
    const add = (field, start, end, unit, extra = {}) => {
      const raw = text.slice(start, end); if (!raw || raw.length > 120 || /(?:±|\+\/-)\s*$/.test(text.slice(Math.max(0, start - 10), start))) return;
      const key = `${field}|${start}|${end}`; if (seen.has(`${block.id}|${key}`)) return;
      let value; try { value = extra.ratio ? raw.replace(/\s/g, '') : normalizeNumber(raw); } catch { return; }
      if (!extra.ratio && (!new D(value).isFinite() || Math.abs(new D(value).e) > 100)) return;
      const before = text.slice(Math.max(0, start - 3), start);
      const comparator = extra.comparator ?? /([<>≤≥]=?)\s*$/.exec(before)?.[1] ?? '=';
      const local = resolveIdentity(field, start, end);
      const fact = { id: stableId('fact', document.id, block.id, field, start, raw), documentId: document.id, blockId: block.id, role: document.role, field, raw, value, unit: unitCanonical(unit ?? ''), offset: start, end, comparator, ...local, ...extra };
      if (block.metadata?.evidenceOrigin === 'image_table_ocr') Object.assign(fact, { evidenceOrigin: 'image_table_ocr', visualReviewStatus: block.metadata.visualReviewStatus, unverifiedVisual: block.metadata.visualReviewStatus !== 'accepted', assetId: block.metadata.assetId, rasterSha256: block.metadata.rasterSha256 });
      if (field === 'yield.percent') fact.method = extra.method ?? local.method ?? yieldMethodNear(text.slice(Math.max(local.contextStart, start - 50), Math.min(local.contextEnd, end + 25)));
      facts.push(fact); seen.add(`${block.id}|${key}`);
    };
    const regexFact = (pattern, field, numberGroup = 1, unit = '', extra) => {
      for (const m of matchAll(text, pattern)) {
        const [start, end] = m.indices[numberGroup] ?? []; if (start === undefined) continue;
        add(field, start, end, typeof unit === 'function' ? unit(m) : unit, typeof extra === 'function' ? extra(m) : extra);
      }
    };
    // Structured row cells use their headers, never a guessed column position.
    let cellCursor = 0;
    for (const cell of block.metadata?.cells ?? []) {
      const cellText = String(cell.text ?? ''); const start = text.indexOf(cellText, cellCursor); if (start < 0) continue; cellCursor = start + cellText.length + 1;
      const key = headerKey(cell.header); const m = new RegExp(`^\\s*([<>≤≥]=?)?\\s*(${NUM})(?:\\s*:\\s*(${NUM}))?\\s*(%|mmol|mol|[µμu]mol|mM|M|h|min|s|°C|K|ppm|MHz|Hz)?\\s*$`, 'di').exec(cellText);
      if (!m) continue;
      const numericStart = start + m.indices[2][0]; const numericEnd = start + m.indices[2][1];
      const extra = { comparator: m[1] ?? '=', ...(cell.precisionKnown === false ? { displayPrecisionKnown: false } : {}), ...(cell.cachedFormula ? { cachedFormula: true } : {}), ...(cell.numberFormat ? { sourceNumberFormat: cell.numberFormat } : {}) };
      if (/^(?:er|dr|enantiomeric_ratio|diastereomeric_ratio)(?:_|$)/.test(key) && m[3]) {
        add(key.startsWith('dr') || key.startsWith('diastereomeric') ? 'stereo.dr' : 'stereo.er', numericStart, start + m.indices[3][1], '', { ...extra, ratio: true }); continue;
      }
      const nmr = /^(?:nmr_)?(?:h1|1h)_?(?:chemical_)?shift/.test(key) ? 'nmr.h1.chemical_shift' : /^(?:nmr_)?(?:c13|13c)_?(?:chemical_)?shift/.test(key) ? 'nmr.c13.chemical_shift' : undefined;
      let field = nmr; let unit = nmr ? 'ppm' : m[4] ?? '';
      if (/^(?:isolated_|nmr_|assay_)?yield(?:_|$)|^产率/.test(key)) { field = 'yield.percent'; unit = '%'; extra.method = yieldMethod(key) ?? identity.method; }
      else if (/^(?:ee|enantiomeric_excess)(?:_|$)/.test(key)) { field = 'stereo.ee'; unit = '%'; }
      else if (/^(?:temperature|temp|温度)(?:_|$)/.test(key)) { field = 'reaction.temperature'; unit ||= key.includes('k') ? 'K' : '°C'; }
      else if (/^(?:time|duration|时间)(?:_|$)/.test(key)) { field = 'reaction.time'; unit ||= key.endsWith('_min') ? 'min' : key.endsWith('_s') ? 's' : 'h'; }
      else if (/^(?:scale|amount|规模)(?:_|$)/.test(key)) { field = 'reaction.scale'; unit ||= key.endsWith('_mol') ? 'mol' : 'mmol'; }
      else if (/^(?:concentration|浓度)(?:_|$)/.test(key)) { field = 'reaction.concentration'; unit ||= key.endsWith('_mm') ? 'mM' : 'M'; }
      else if (/^(?:j|coupling)(?:_|$)/.test(key)) { field = 'nmr.coupling_constant'; unit = 'Hz'; }
      else if (/^hrms|^m_z/.test(key)) { field = 'hrms.mass_to_charge'; unit = 'm/z'; extra.measurement = /calc/.test(key) ? 'calculated' : /found/.test(key) ? 'found' : 'unspecified'; }
      if (field && !m[3]) add(field, numericStart, numericEnd, unit, extra);
    }
    regexFact(`(${NUM})\\s*%\\s*(?:ee|e\\.e\\.)(?![a-z])`, 'stereo.ee', 1, '%');
    regexFact(`(?:\\bee|e\\.e\\.)\\s*[:=]\\s*([<>≤≥]=?)?\\s*(${NUM})\\s*%`, 'stereo.ee', 2, '%', m => ({ comparator: m[1] ?? '=' }));
    regexFact(`\\b(er|dr)\\s*[:=]?\\s*((${NUM})\\s*:\\s*(${NUM}))`, 'stereo.er', 2, '', m => ({ ratio: true, ratioKind: m[1].toLowerCase() }));
    // Correct dr field after the shared ratio tokenizer.
    for (let fi = blockFactStart; fi < facts.length; fi++) { const f = facts[fi]; if (f.ratioKind === 'dr') { f.field = 'stereo.dr'; f.id = stableId('fact', document.id, block.id, f.field, f.offset, f.raw); } }
    regexFact(`(?:yield|产率)\\s*[:=]?\\s*([<>≤≥]=?)?\\s*(${NUM})\\s*%`, 'yield.percent', 2, '%', m => ({ comparator: m[1] ?? '=' }));
    regexFact(`(${NUM})\\s*%\\s*(?:(isolated|NMR|assay|GC|HPLC|分离)\\s*)?(?:yield|产率)`, 'yield.percent', 1, '%', m => ({ method: m[2] ? yieldMethod(m[2]) : undefined }));
    regexFact(`(?:temperature|temp|温度)\\s*[:=]\\s*(${NUM})\\s*(°\\s*C|℃|K)`, 'reaction.temperature', 1, m => m[2].replace(/\s/g, ''));
    regexFact(`(?:time|duration|时间)\\s*[:=]\\s*(${NUM})\\s*(h|min|s|hours?|minutes?|seconds?)\\b`, 'reaction.time', 1, m => m[2].toLowerCase());
    regexFact(`(?:scale|amount|规模)\\s*[:=]\\s*(${NUM})\\s*([µμu]?mol|mmol)\\b`, 'reaction.scale', 1, m => m[2]);
    regexFact(`(?:concentration|浓度)\\s*[:=]\\s*(${NUM})\\s*(mM|M)(?![a-z])`, 'reaction.concentration', 1, m => m[2]);
    const nmrHeaders = matchAll(text, '(?:\\^?1H|¹H|\\^?13C|¹³C|\\^?19F|¹⁹F|\\^?31P|³¹P)\\s*NMR');
    for (let i = 0; i < nmrHeaders.length; i++) {
      const h = nmrHeaders[i]; const segmentStart = h.index; let segmentEnd = nmrHeaders[i + 1]?.index ?? text.length;
      const tail = text.slice(segmentStart, segmentEnd); const boundary = new RegExp(`\\n|${MS_LABEL_PATTERN}`, 'i').exec(tail); if (boundary) segmentEnd = segmentStart + boundary.index;
      const segment = text.slice(segmentStart, segmentEnd); const field = /1H|¹H/.test(h[0]) ? 'nmr.h1.chemical_shift' : /13C|¹³C/.test(h[0]) ? 'nmr.c13.chemical_shift' : 'nmr.other.chemical_shift';
      const delta = /(?:δ|\bdelta\b)\s*[:=]?\s*/i.exec(segment); if (!delta) continue;
      const shiftStart = segmentStart + delta.index + delta[0].length;
      const shiftText = text.slice(shiftStart, segmentEnd); const masked = shiftText.replace(/\([^)]*\)/g, x => ' '.repeat(x.length)).replace(new RegExp(`\\bJ\\s*=\\s*${NUM}(?:\\s*,\\s*${NUM})*\\s*Hz`, 'gi'), x => ' '.repeat(x.length));
      for (const m of matchAll(masked, NUM)) {
        // Outside peak annotations, shifts form a comma/semicolon/range list. Do not swallow following prose.
        const before = masked.slice(0, m.index).trimEnd(); const after = masked.slice(m.index + m[0].length);
        if (/[a-zA-Z]/.test(before.slice(-1)) || /^\s*(?:H|Hz|MHz|mg|mmol)\b/.test(after)) continue;
        add(field, shiftStart + m.index, shiftStart + m.index + m[0].length, 'ppm', { characterization: true, rangePart: /^\s*[–—-]/.test(after) || /[–—-]\s*$/.test(before) });
      }
      for (const m of matchAll(segment, `\\bJ\\s*=\\s*(${NUM}(?:\\s*,\\s*${NUM})*)\\s*Hz`)) {
        for (const n of matchAll(m[1], NUM)) add('nmr.coupling_constant', segmentStart + m.indices[1][0] + n.index, segmentStart + m.indices[1][0] + n.index + n[0].length, 'Hz', { characterization: true });
      }
      for (const m of matchAll(segment.slice(0, delta.index), `(${NUM})\\s*MHz`)) add('nmr.frequency', segmentStart + m.indices[1][0], segmentStart + m.indices[1][1], 'MHz', { characterization: true });
    }
    const msLabels = matchAll(text, MS_LABEL_PATTERN);
    for (let i = 0; i < msLabels.length; i++) {
      const label = msLabels[i], start = label.index;
      let end = msLabels[i + 1]?.index ?? text.length;
      const nextNmr = nmrHeaders.find(h => h.index > start && h.index < end); if (nextNmr) end = nextNmr.index;
      const segment = text.slice(start, end);
      const markers = matchAll(segment, '\\b(calcd?\\.?|calculated|found)\\b');
      for (let j = 0; j < markers.length; j++) {
        const marker = markers[j], valueStart = marker.index + marker[0].length, valueEnd = markers[j + 1]?.index ?? segment.length;
        const tail = segment.slice(valueStart, valueEnd);
        // Only labelled decimal calculated/found records are supported, not unlabeled low-resolution peak lists.
        const number = new RegExp(`(?<![A-Za-z0-9_.])(${NUM})(?![A-Za-z0-9_])`, 'd').exec(tail);
        const decimals = [...tail.matchAll(/(?<![A-Za-z0-9_.])([+\-−]?(?:\d+\.\d+|\.\d+)(?:[eE][+\-]?\d+)?)(?![A-Za-z0-9_])/gd)];
        const mass = decimals[0];
        if (!mass || mass.index > 200 || /[.!?]\s+[A-Z][a-z]/.test(tail.slice(0, mass.index)) || /^\s*(?:m?mol|mg|g|equiv|MHz|Hz|%)(?![a-z])/i.test(tail.slice(mass.index + mass[0].length))) continue;
        // A decimal stoichiometry before a mass marker is not assumed to be an m/z value.
        if (number && number.index < mass.index && /\b(?:mmol|mol|mg|equiv|MHz|Hz)\b/i.test(tail.slice(number.index, mass.index))) continue;
        const sourceLabel = label[0];
        add('hrms.mass_to_charge', start + valueStart + mass.indices[1][0], start + valueStart + mass.indices[1][1], 'm/z', {
          characterization: true, measurement: /^found/i.test(marker[1]) ? 'found' : 'calculated',
          measurementClass: 'mass_spectrometry', sourceLabel,
          resolution: /^HRMS/i.test(sourceLabel) ? 'reported_high' : 'unspecified',
          fieldAliasNote: 'Legacy hrms.mass_to_charge field covers explicitly labelled calculated/found MS values; the field name does not establish high resolution.',
        });
      }
    }
  }
  return facts;
}

function issue(type, title, description, evidence, extra = {}) {
  return { id: stableId('issue', type, title, evidence, extra.ruleId ?? '', extra.suggestion ?? ''), type, severity: 'medium', evidenceStatus: 'needs_review', title, description, evidenceIds: evidence, status: 'open', ...extra };
}
function normalized(fact) {
  const value = new D(fact.value); const unit = fact.unit;
  if (fact.field === 'reaction.time') return unit === 'h' ? value.times(3600) : unit === 'min' ? value.times(60) : value;
  if (fact.field === 'reaction.scale') return unit === 'mol' ? value.times(1000) : unit === 'µmol' ? value.div(1000) : value;
  if (fact.field === 'reaction.temperature') return unit === 'K' ? value.minus('273.15') : value;
  if (fact.field === 'reaction.concentration') return unit === 'mM' ? value.div(1000) : value;
  return value;
}
function decimals(raw) { const m = /^[+-]?(?:\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw.replaceAll('−', '-')); return m ? (m[1]?.length ?? 0) - Number(m[2] ?? 0) : null; }
function precisionCompatible(a, b) {
  if (a.field !== b.field || a.unit !== b.unit) return false;
  const da = decimals(a.raw); const db = decimals(b.raw); if (da === null || db === null || da === db) return false;
  const coarser = da < db ? a : b; const finer = da < db ? b : a;
  return new D(finer.value).toDecimalPlaces(Math.min(da, db), D.ROUND_HALF_UP).eq(coarser.value);
}
function sameKnownIdentity(a, b) {
  const exp = a.experiment && b.experiment && a.experiment === b.experiment;
  const batch = a.batch && b.batch && a.batch === b.batch;
  return Boolean(exp || batch) && !a.identityAmbiguous && !b.identityAmbiguous;
}
function contextRelation(a, b) {
  const left = a.experimentContext, right = b.experimentContext;
  if (!left && !right) return 'unknown';
  if (left?.kind === 'table_entries' && right?.kind === 'table_entries' && left.table === right.table) return left.entries.some(e => right.entries.includes(e)) ? 'same' : 'different';
  if (left?.kind === 'general_procedure' && right?.kind === 'general_procedure') return left.label === right.label ? 'same' : 'different';
  if (left?.kind === 'optimization' && right?.kind === 'optimization') return left.label === right.label ? 'same' : 'different';
  return 'unmapped';
}
function explicitlyDifferent(a, b) { return ['entity', 'experiment', 'batch'].some(k => a[k] && b[k] && a[k] !== b[k]) || contextRelation(a, b) === 'different'; }
function conditionsDiffer(a, b) {
  if (a.conditions && b.conditions && a.conditions !== b.conditions || a.conditionAmbiguous || b.conditionAmbiguous) return true;
  return Object.entries(a.conditionValues ?? {}).some(([field, value]) => b.conditionValues?.[field] !== undefined && b.conditionValues[field] !== value);
}
function eeFromRatio(fact) {
  const [a, b] = fact.value.split(':').map(x => new D(x)); if (a.isNegative() || b.isNegative() || a.plus(b).isZero()) return null;
  return a.minus(b).abs().div(a.plus(b)).times(100);
}
function crossChecks(facts, pairBudget) {
  const issues = []; const groups = new Map();
  // Group by entity, compatible field family and document before producing pairs.
  // This avoids quadratic work on unrelated compounds or a long single document.
  for (const f of facts) {
    if (!f.entity || f.field.startsWith('nmr.') || f.field.startsWith('hrms.') || f.field === 'stereo.dr') continue;
    const stereo = f.field === 'stereo.ee' || f.field === 'stereo.er';
    const key = JSON.stringify([f.entity, stereo ? 'ee_er' : f.field]);
    const group = groups.get(key) ?? { stereo, documents: new Map() };
    const bucket = group.documents.get(f.documentId) ?? { values: [], ee: [], er: [] };
    bucket[stereo ? f.field === 'stereo.ee' ? 'ee' : 'er' : 'values'].push(f);
    group.documents.set(f.documentId, bucket); groups.set(key, group);
  }
  const work = []; let candidatePairs = 0;
  for (const group of groups.values()) {
    const docs = [...group.documents.values()];
    for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
      const products = group.stereo ? [[docs[i].ee, docs[j].ee], [docs[i].ee, docs[j].er], [docs[i].er, docs[j].ee]] : [[docs[i].values, docs[j].values]];
      for (const [left, right] of products) if (left.length && right.length) { candidatePairs += left.length * right.length; work.push([left, right]); }
    }
  }
  let comparedPairs = 0; let needsIdentity = 0; let skippedDifferentIdentity = 0; let roundingCompatible = 0; let visitedPairs = 0; let contextReviewPairs = 0;
  candidates: for (const [left, right] of work) for (const a of left) for (const b of right) {
    if (visitedPairs >= pairBudget) break candidates;
    visitedPairs++;
    const eeRatioPair = a.field !== b.field;
    if (explicitlyDifferent(a, b)) { skippedDifferentIdentity++; continue; }
    if (a.field === 'yield.percent' && a.method && b.method && a.method !== b.method) continue;
    const unresolvedContext = contextRelation(a, b) === 'unmapped';
    const strong = sameKnownIdentity(a, b) && !unresolvedContext && !conditionsDiffer(a, b) && !a.cachedFormula && !b.cachedFormula && !a.unverifiedVisual && !b.unverifiedVisual && (a.field !== 'yield.percent' || Boolean(a.method && b.method));
    if (!strong) { needsIdentity++; }
    if (a.comparator !== '=' || b.comparator !== '=') continue;
    let av, bv;
    try { av = a.field === 'stereo.er' ? eeFromRatio(a) : normalized(a); bv = b.field === 'stereo.er' ? eeFromRatio(b) : normalized(b); } catch { continue; }
    if (av === null || bv === null) continue;
    comparedPairs++;
    if (av.eq(bv)) continue;
    if (!eeRatioPair && precisionCompatible(a, b)) { roundingCompatible++; continue; }
    if (unresolvedContext) {
      contextReviewPairs++;
      issues.push(issue('alignment', `${a.field} 实验语境待确认`, '两处数值属于同一实体，但表格条目、通用方法、放大或前催化剂实验等语境未建立对应；当前不能将其判为同一实验的数值不一致。', [a.id, b.id], {
        severity: 'medium', evidenceStatus: 'needs_review', experimentContexts: [a.experimentContext ?? null, b.experimentContext ?? null],
        reportedValues: [{ raw: a.raw, unit: a.unit }, { raw: b.raw, unit: b.unit }],
      })); continue;
    }
    issues.push(issue(strong ? 'data' : 'alignment', eeRatioPair ? 'ee 与 er 报告不一致' : `${a.field} 跨文档数值差异`, strong ? '已明确对应同一实验/批次且口径可比；两处报告不一致，尚未决定哪一处正确。' : '同一实体的数字存在差异，但实验身份、方法或条件尚未完全对齐，不能确认属于数据错误。', [a.id, b.id], {
      severity: strong ? 'high' : 'medium', evidenceStatus: strong ? 'confirmed_difference' : 'needs_review', calculation: `${a.raw} ${a.unit} → ${av.toString()}；${b.raw} ${b.unit} → ${bv.toString()}${eeRatioPair ? ' % ee（|a-b|/(a+b)×100）' : '（按字段统一单位）'}`, comparisonKey: [a.entity, a.experiment ?? '', a.batch ?? '', a.field].join('|'),
    }));
  }
  return { issues, comparedPairs, needsIdentity, skippedDifferentIdentity, roundingCompatible, contextReviewPairs, pairBudget, candidatePairs, visitedPairs, remainingPairs: candidatePairs - visitedPairs, truncated: candidatePairs > visitedPairs };
}

function scopeMatches(rule, fact) {
  if (rule.entity && rule.entity !== fact.entity || rule.block_id && rule.block_id !== fact.blockId) return false;
  if (rule.scope === 'all') return true;
  if (rule.scope === 'si.characterization') return fact.role === 'si' && Boolean(fact.characterization || fact.field.startsWith('nmr.') || fact.field.startsWith('hrms.'));
  return rule.scope === fact.role;
}
const roundingModes = { half_up: D.ROUND_HALF_UP, half_even: D.ROUND_HALF_EVEN, truncate: D.ROUND_DOWN };
function formatting(raw, format) {
  const n = new D(raw.replaceAll('−', '-')); const rounding = roundingModes[format.rounding];
  return format.mode === 'decimal_places' ? n.toFixed(format.digits, rounding) : n.toPrecision(format.digits, rounding);
}
function formatChecks(facts, profile) {
  const issues = []; let checked = 0; let matchedRules = 0; const matchedIds = new Set();
  for (const f of facts) {
    let applicable = profile.rules.filter(r => r.enabled && r.field === f.field && scopeMatches(r, f));
    // Mandatory checks remain visible even if the user's display preference overrides them.
    const overridden = new Set(applicable.map(r => r.override_of).filter(Boolean));
    applicable = applicable.filter(r => r.requirement === 'journal_mandatory' || !overridden.has(r.id));
    const specificity = r => (r.scope === 'all' ? 0 : r.scope === 'si.characterization' ? 2 : 1) + (r.entity ? 4 : 0) + (r.block_id ? 8 : 0);
    const highestSpecificity = Math.max(-1, ...applicable.filter(r => r.requirement !== 'journal_mandatory').map(specificity));
    applicable = applicable.filter(r => r.requirement === 'journal_mandatory' || specificity(r) === highestSpecificity);
    for (const rule of applicable) {
      matchedRules++; matchedIds.add(rule.id); checked++;
      if (rule.expected_unit && unitCanonical(rule.expected_unit) !== f.unit) issues.push(issue('format', '单位不符合所选格式规则', `当前单位 ${f.unit || '未提供'}；期望 ${rule.expected_unit}。这是一条格式偏差，不等于测量结果错误。`, [f.id], { severity: 'low', evidenceStatus: f.unverifiedVisual ? 'needs_review' : 'confirmed_difference', ruleId: rule.id, ruleSource: rule.source ?? null }));
      if (!rule.number_format) continue;
      if (f.displayPrecisionKnown === false) {
        issues.push(issue('format', '源单元格显示精度未恢复', '此字段来自储存数值或公式缓存，不能从数值字符串推断原始显示位数。请查看源单元格格式，当前不判为格式错误或生成数值修改建议。', [f.id], { severity: 'low', evidenceStatus: 'insufficient', ruleId: rule.id, sourceNumberFormat: f.sourceNumberFormat ?? null })); continue;
      }
      if (f.ratio) { issues.push(issue('format', '比例字段需分别设置数值格式', '当前规则不自动格式化整个比例，以免改变比例含义。', [f.id], { severity: 'low', evidenceStatus: 'needs_review', ruleId: rule.id })); continue; }
      const suggestion = formatting(f.raw, rule.number_format);
      if (suggestion === f.raw.replaceAll('−', '-')) continue;
      const changedValue = !new D(suggestion).eq(f.value);
      if (f.comparator !== '=' || f.rangePart || f.uncertainty) {
        issues.push(issue('format', '边界或复合数值需要人工格式复核', '不等号、范围端点或误差表达不自动舍入，避免改变界限或科学含义。', [f.id], { severity: 'medium', evidenceStatus: 'needs_review', ruleId: rule.id, ruleSource: rule.source ?? null })); continue;
      }
      const appendedZeros = !changedValue && suggestion.length > f.raw.length;
      issues.push(issue('format', '数字显示格式不符合所选规则', `目标为${rule.number_format.mode === 'decimal_places' ? '小数' : '有效数字'} ${rule.number_format.digits} 位；${appendedZeros ? '补零仅为展示，来源测量精度未知，需确认。' : changedValue ? '预览包含舍入，原始值保留；须确认不影响阈值和结论。' : '原始值保留。'}该提示不代表科学数据错误。`, [f.id], { severity: 'low', evidenceStatus: 'needs_review', ruleId: rule.id, ruleSource: rule.source ?? null, ...(rule.action === 'preview_only' ? { suggestion } : {}), changesNumericValue: changedValue, precisionKnown: false }));
    }
  }
  return { issues, checked, matchedRules, unmatchedRuleIds: profile.rules.filter(r => r.enabled && !matchedIds.has(r.id)).map(r => r.id), disabledRuleIds: profile.rules.filter(r => !r.enabled).map(r => r.id) };
}

export function auditDocuments(documents, profile = defaultProfile(), { pairBudget = AUDIT_LIMITS.pairBudget } = {}) {
  if (!Array.isArray(documents) || documents.length > 100) throw new Error('documents 必须是最多 100 个文档的数组');
  if (!Number.isInteger(pairBudget) || pairBudget < 1 || pairBudget > AUDIT_LIMITS.pairBudget) throw new Error(`pairBudget 必须为 1–${AUDIT_LIMITS.pairBudget} 的整数`);
  const config = validateProfile(profile); const facts = documents.flatMap(extractFacts); const issues = [];
  // Explicit conditions in the same paragraph/row participate in comparability; a shared ID cannot erase a scale or temperature difference.
  const conditionsByBlock = new Map();
  const contextKey = f => [f.blockId, f.contextStart ?? 0, f.contextEnd ?? '', f.experiment ?? '', f.batch ?? ''].join('|');
  for (const f of facts.filter(x => x.field.startsWith('reaction.') && x.comparator === '=')) {
    const key = contextKey(f), context = conditionsByBlock.get(key) ?? { values: {}, ambiguous: false };
    const value = normalized(f).toString();
    if (context.values[f.field] !== undefined && context.values[f.field] !== value) context.ambiguous = true;
    context.values[f.field] = value; conditionsByBlock.set(key, context);
  }
  for (const f of facts) { const context = conditionsByBlock.get(contextKey(f)); if (context) { f.conditionValues = { ...context.values }; f.conditionAmbiguous = context.ambiguous; } }
  for (const doc of documents) {
    if (doc.coverage?.status !== 'complete') issues.push(issue('coverage', '文档存在未完成的解析范围', `${doc.name}：${(doc.coverage?.warnings ?? ['未提供解析覆盖状态']).join('；')}`, (doc.blocks ?? []).slice(0, 1).map(b => b.id), { evidenceStatus: 'insufficient', severity: 'medium', documentId: doc.id }));
    if (!(doc.blocks ?? []).length || !facts.some(f => f.documentId === doc.id)) issues.push(issue('coverage', '未提取到支持的科学数值字段', `${doc.name} 未提取到当前规则支持的字段。不能将零告警解释为全文已通过；可提供明确表格或用宿主模型辅助登记候选证据。`, (doc.blocks ?? []).slice(0, 1).map(b => b.id), { evidenceStatus: 'insufficient', documentId: doc.id }));
  }
  const cross = crossChecks(facts, pairBudget); const format = formatChecks(facts, config); issues.push(...cross.issues, ...format.issues);
  if (cross.truncated) issues.push(issue('coverage', '跨文档配对达到本次预算，存在未检查部分', `本次最多检查 ${cross.pairBudget} 个同实体、可比字段的跨文档候选配对；已访问 ${cross.visitedPairs}/${cross.candidatePairs}，剩余 ${cross.remainingPairs} 个配对未检查。请按实验或化合物拆分项目后继续；未检查部分不能视为通过。`, [], { severity: 'medium', evidenceStatus: 'insufficient', pairBudget: cross.pairBudget, remainingPairs: cross.remainingPairs }));
  const byId = new Map(issues.map(i => [i.id, i]));
  return { facts, issues: [...byId.values()], coverage: {
    status: 'partial',
    extraction: 'rule_based_subset', documentCount: documents.length, blockCount: documents.reduce((n, d) => n + (d.blocks?.length ?? 0), 0), extractedFactCount: facts.length,
    documents: documents.map(d => ({ documentId: d.id, name: d.name, ...d.coverage, extractedFacts: facts.filter(f => f.documentId === d.id).length })),
    comparedPairs: cross.comparedPairs, identityReviewPairs: cross.needsIdentity, contextReviewPairs: cross.contextReviewPairs, skippedDifferentIdentity: cross.skippedDifferentIdentity, roundingCompatiblePairs: cross.roundingCompatible,
    identityResolution: { assigned: facts.filter(f => f.entity).length, ambiguous: facts.filter(f => f.identityAmbiguous).length, unassigned: facts.filter(f => !f.entity && !f.identityAmbiguous).length },
    massSpectrometry: { labelledValues: facts.filter(f => f.measurementClass === 'mass_spectrometry').length, reportedHighResolution: facts.filter(f => f.measurementClass === 'mass_spectrometry' && f.resolution === 'reported_high').length, unspecifiedResolution: facts.filter(f => f.measurementClass === 'mass_spectrometry' && f.resolution === 'unspecified').length, note: 'Legacy hrms.mass_to_charge formatting accepts labelled MS values; EI/ESI-MS labels alone do not establish high resolution. No formula/exact-mass validation is performed.' },
    pairBudget: cross.pairBudget, candidatePairs: cross.candidatePairs, visitedPairs: cross.visitedPairs, remainingPairs: cross.remainingPairs, truncated: cross.truncated,
    formatChecks: format.checked, unmatchedRuleIds: format.unmatchedRuleIds, disabledRuleIds: format.disabledRuleIds,
    completedChecks: ['supported_numeric_extraction', ...(cross.truncated ? [] : ['explicit_identity_cross_document_comparison', 'ee_er_conversion']), 'configured_number_and_unit_format'],
    incompleteChecks: cross.truncated ? ['explicit_identity_cross_document_comparison', 'ee_er_conversion'] : [],
    notPerformed: ['全文语义判断（需要宿主模型）', '谱图/化学结构确证', '未明确标注的实验条件自动对齐', '产率原料质量平衡复算', 'HRMS 分子式精确质量复算', '图表引用完整性', '原始数据真实性鉴定'],
    note: '解析完成不等于所有科学内容已核对；本次覆盖仅限已提取字段、明确实验身份和配置规则。',
  } };
}
