import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { recordsFor } from './nmr.js';
import { validateScientificConfig } from './scientific-config.js';
const D = Decimal.clone({ precision: 40 });
const hash = (...v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
const NUM = '[+]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,2})?';
function number(v, key, allowZero = false) {
  if (!['string', 'number'].includes(typeof v) || String(v).length > 80) throw new Error(`Missing/invalid ${key}`);
  const n = new D(v); if (!n.isFinite() || (allowZero ? n.lt(0) : n.lte(0)) || Math.abs(n.e) > 12) throw new Error(`Invalid positive bounded ${key}`); return n;
}
export function calculateExperiment(input, options = {}) {
  const config = validateScientificConfig(options);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Experimental input must be an object');
  const allowed = { yield: ['limitingAmountMmol', 'productMassMg', 'molarMassGmol', 'stoichiometricFactor', 'reportedYieldPercent'], mass_amount: ['massMg', 'amountMmol', 'molarMassGmol'], concentration: ['concentrationM', 'volumeMl', 'amountMmol'] }[input.kind];
  if (!allowed || Object.keys(input).some(k => k !== 'kind' && !allowed.includes(k))) throw new Error('Unknown experimental fields');
  const v = Object.fromEntries(allowed.map(k => [k, number(input[k], k, k === 'reportedYieldPercent' || k === 'productMassMg')]));
  let calculated, reported, threshold, unit, equation;
  if (input.kind === 'yield') {
    calculated = v.productMassMg.div(v.molarMassGmol).div(v.limitingAmountMmol.times(v.stoichiometricFactor)).times(100); reported = v.reportedYieldPercent; threshold = new D(config.yieldTolerancePercent); unit = '%'; equation = '100 × productMassMg / (molarMassGmol × limitingAmountMmol × stoichiometricFactor)';
  } else if (input.kind === 'mass_amount') {
    calculated = v.amountMmol.times(v.molarMassGmol); reported = v.massMg; threshold = calculated.times(config.amountRelativeTolerance); unit = 'mg'; equation = 'amountMmol × molarMassGmol';
  } else {
    calculated = v.concentrationM.times(v.volumeMl); reported = v.amountMmol; threshold = calculated.times(config.amountRelativeTolerance); unit = 'mmol'; equation = 'concentrationM × volumeMl';
  }
  const difference = reported.minus(calculated);
  return { kind: input.kind, input: structuredClone(input), calculated: calculated.toString(), reported: reported.toString(), difference: difference.toString(), tolerance: threshold.toString(), unit, equation, status: difference.abs().gt(threshold) ? 'needs_review' : 'compatible_with_tolerance', assumptions: input.kind === 'yield' ? 'Explicit limiting amount, product molar mass and reaction stoichiometric factor are required. No automatic 1:1 assumption, purity correction or substitution of HRMS monoisotopic m/z for molar mass.' : 'Explicit co-referent fields in one record; mathematical consistency only.' };
}

const FIELD_PATTERNS = {
  limitingAmountMmol: ['limiting_amount|limiting amount|limiting_reagent_amount|限制试剂用量', 'mmol|[µμu]mol|mol'],
  productMassMg: ['product_mass|product mass|产物质量', 'mg|g'],
  molarMassGmol: ['molar_mass|molar mass|molecular weight|MW|摩尔质量', 'g\\s*[/·]\\s*mol(?:[−-]1)?|g\\s+mol[−-]1'],
  stoichiometricFactor: ['stoichiometric_factor|stoichiometric factor|产物计量系数', ''],
  reportedYieldPercent: ['isolated_yield|isolated yield|yield|收率|产率', '%'],
  massMg: ['mass|质量', 'mg|g'], amountMmol: ['amount|物质的量', 'mmol|[µμu]mol|mol'],
  concentrationM: ['concentration|浓度', 'mM|M|mol/L'], volumeMl: ['volume|体积', 'mL|[µμu]L|L'],
};
function unitValue(raw, unit, field) {
  let n = new D(raw); unit = unit?.replace(/\s/g, '') ?? '';
  if (['limitingAmountMmol', 'amountMmol'].includes(field)) { if (unit === 'mol') n = n.times(1000); else if (/^[µμu]mol$/.test(unit)) n = n.div(1000); }
  if (['productMassMg', 'massMg'].includes(field) && unit === 'g') n = n.times(1000);
  if (field === 'volumeMl') { if (unit === 'L') n = n.times(1000); else if (/^[µμu]L$/.test(unit)) n = n.div(1000); }
  if (field === 'concentrationM' && unit === 'mM') n = n.div(1000);
  return n.toString();
}
export function checkExperimentalMath(documents, options) {
  const issues = [], records = [];
  for (const doc of documents.filter(d => d.format !== 'image_table')) for (const group of recordsFor(doc)) {
    const fields = {}, duplicateFields = new Set();
    for (const piece of group.pieces) {
      const text = piece.block.text.slice(piece.start, piece.end);
      for (const [field, [label, units]] of Object.entries(FIELD_PATTERNS)) {
        const re = new RegExp(`(?<![A-Za-z_])(?:${label})\\s*[:=：]\\s*(${NUM})\\s*(${units})(?![A-Za-z0-9])`, 'gd');
        for (const m of text.matchAll(re)) {
          if (fields[field]) duplicateFields.add(field);
          fields[field] = { value: unitValue(m[1], m[2], field), citation: { blockId: piece.block.id, start: piece.start + m.index, end: piece.start + m.index + m[0].length, quote: m[0] } };
        }
      }
    }
    const checks = [['yield', ['limitingAmountMmol', 'productMassMg', 'molarMassGmol', 'stoichiometricFactor', 'reportedYieldPercent']], ['mass_amount', ['massMg', 'amountMmol', 'molarMassGmol']], ['concentration', ['concentrationM', 'volumeMl', 'amountMmol']]];
    for (const [kind, keys] of checks) {
      if (!(kind === 'yield' ? fields.productMassMg || fields.limitingAmountMmol : kind === 'mass_amount' ? fields.massMg : fields.concentrationM || fields.volumeMl)) continue;
      const missing = keys.filter(k => !fields[k]), ambiguous = keys.filter(k => duplicateFields.has(k));
      const citations = keys.filter(k => fields[k]).map(k => fields[k].citation);
      const record = { id: 'experiment_' + hash(doc.id, citations, kind), documentId: doc.id, entity: group.entity, kind, missing, ambiguous, citations, status: 'insufficient' };
      if (!missing.length && !ambiguous.length) {
        try { record.calculation = calculateExperiment({ kind, ...Object.fromEntries(keys.map(k => [k, fields[k].value])) }, options); record.status = record.calculation.status; } catch (error) { record.reason = String(error.message); }
      }
      records.push(record);
      if (record.status !== 'compatible_with_tolerance') issues.push({ id: record.id, type: record.status === 'insufficient' ? 'coverage' : 'data', category: 'experimental_math', severity: record.status === 'insufficient' ? 'low' : 'medium', evidenceStatus: record.status === 'insufficient' ? 'insufficient' : 'needs_review', status: 'open', title: record.status === 'insufficient' ? '实验数字复算缺少明确字段或存在多组数值' : '实验数字与复算结果不相容', description: record.status === 'insufficient' ? `缺少：${missing.join(', ') || '无'}；同名字段多次出现：${ambiguous.join(', ') || '无'}。没有从相邻化合物或通用步骤借用数值，没有默认 1:1 反应。` : '依据同一记录明确字段进行单位换算及复算；请确认限制试剂、产物质量、摩尔质量、反应计量、溶液体积或记录归属。', evidenceIds: [...new Set(citations.map(c => c.blockId))], citations, calculation: record.calculation ?? { missing, ambiguous, reason: record.reason } });
    }
  }
  return { issues, records, coverage: { status: records.length ? 'limited' : 'not_performed', recordCount: records.length, checked: records.filter(r => r.calculation).length, insufficient: records.filter(r => !r.calculation).length, note: 'Only explicitly labelled, co-referent fields in one analytical record. Ordinary unlabeled prose, purity and implicit reaction stoichiometry are not resolved; calculator accepts explicit inputs separately.' } };
}
