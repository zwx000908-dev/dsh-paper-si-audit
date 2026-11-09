import Decimal from 'decimal.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DATA = JSON.parse(readFileSync(new URL('./isotope-masses.json', import.meta.url), 'utf8'));
const D = Decimal.clone({ precision: 50 });
const ELECTRON = new D(DATA.electronMassU);
const BASES = new Set(['neutral', 'ion', 'ambiguous']);
const MS_LABEL = /\b(?:HRMS(?:\s*[-–−]?\s*(?:ESI|EI|APCI|MALDI))?|(?:ESI|EI|APCI|MALDI)\s*[-–−]\s*MS|MS)\b/gi;
const stableId = (...parts) => 'hrms_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const fail = message => { throw new Error(`HRMS: ${message}`); };
const subDigits = '₀₁₂₃₄₅₆₇₈₉', superDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const massSources = Object.freeze({ datasetVersion: DATA.version, checkedAt: DATA.checkedAt, isotopeSourceTemplate: DATA.isotopeSourceTemplate, isotopeDefinitionSource: DATA.isotopeDefinitionSource, electronMassSource: DATA.electronMassSource, electronMassAdjustment: DATA.electronMassAdjustment });

function normalizeFormulaText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('formula must be 1–512 characters');
  return value.trim().replace(/[₀-₉]/g, n => String(subDigits.indexOf(n))).replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])$/, (_, digits, sign) => '^' + [...digits].map(x => superDigits.indexOf(x)).join('') + (sign === '⁺' ? '+' : '-')).replaceAll('−', '-');
}
function parseCharge(value) {
  if (!Number.isInteger(value) || Math.abs(value) > 10) fail('charge must be an integer from -10 to 10');
  return value;
}
function merge(target, source, multiplier = 1) {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count * multiplier;
    if (!Number.isSafeInteger(target[key]) || Math.abs(target[key]) > 1_000_000) fail('atom count exceeds limit');
    if (target[key] === 0) delete target[key];
  }
}
function atom(key) {
  const match = /^(?:\[(\d+)([A-Z][a-z]?)\]|([A-Z][a-z]?))$/.exec(key);
  if (!match) fail(`unsupported atom ${key}`);
  const element = match[2] ?? match[3], record = DATA.elements[element];
  if (!record) fail(`element ${element} is not in the pinned isotope table`);
  const isotope = match[1] ?? String(record.defaultIsotope), mass = record.isotopes[isotope];
  if (!mass) fail(`isotope [${isotope}${element}] is not in the pinned table`);
  return { element, isotope: Number(isotope), mass };
}
function canonical(counts) {
  const keys = Object.keys(counts).sort((a, b) => {
    const priority = key => atom(key).element === 'C' ? 0 : atom(key).element === 'H' ? 1 : 2;
    return priority(a) - priority(b) || atom(a).element.localeCompare(atom(b).element) || a.localeCompare(b);
  });
  return keys.map(key => key + (counts[key] === 1 ? '' : counts[key])).join('');
}

/** Strict formula parser; no structural, valence, neutral/ion, or isotope-envelope inference. */
export function parseFormula(value) {
  let text = normalizeFormulaText(value), charge = 0;
  const outer = /^\[([\s\S]+)\](\d*)([+-])$/.exec(text);
  if (outer) { text = outer[1]; charge = (outer[3] === '+' ? 1 : -1) * Number(outer[2] || 1); }
  else {
    const explicit = /\^(\d*)([+-])$/.exec(text);
    if (explicit) { charge = (explicit[2] === '+' ? 1 : -1) * Number(explicit[1] || 1); text = text.slice(0, explicit.index); }
    else if (/[+-]$/.test(text)) {
      if (/^[A-Z][a-z]?\d+[+-]$/.test(text)) fail('single-element charge/count shorthand is ambiguous; use Fe^3+ or an explicit charge argument');
      charge = text.endsWith('+') ? 1 : -1; text = text.slice(0, -1);
    }
  }
  parseCharge(charge);
  if (/\s/.test(text)) fail('formula cannot contain internal whitespace');
  let cursor = 0;
  function count() {
    const match = /^\d+/.exec(text.slice(cursor));
    if (!match) return 1;
    cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isSafeInteger(result) || result < 1 || result > 100000) fail('atom/group counts must be 1–100000');
    return result;
  }
  function group(depth, ending) {
    if (depth > 8) fail('formula parentheses exceed depth 8');
    const result = {}; let terms = 0;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === ')') { if (!ending) fail('unmatched closing parenthesis'); cursor++; if (!terms) fail('empty group'); return result; }
      if (char === '·') break;
      let piece;
      if (char === '(') { cursor++; piece = group(depth + 1, true); }
      else {
        const token = /^(?:\[\d+[A-Z][a-z]?\]|[A-Z][a-z]?)/.exec(text.slice(cursor));
        if (!token) fail(`unsupported formula token at position ${cursor}`);
        cursor += token[0].length;
        const key = token[0] === 'D' ? '[2H]' : token[0] === 'T' ? '[3H]' : token[0];
        atom(key); piece = { [key]: 1 };
      }
      merge(result, piece, count()); terms++;
    }
    if (ending) fail('unclosed parentheses');
    if (!terms) fail('empty formula');
    return result;
  }
  const counts = group(0, false);
  while (cursor < text.length && text[cursor] === '·') {
    cursor++; const multiplier = count(); merge(counts, group(0, false), multiplier);
  }
  if (cursor !== text.length || !Object.keys(counts).length) fail('formula was not completely parsed');
  const totalAtoms = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalAtoms > 1_000_000) fail('formula exceeds one million atoms');
  return { input: value, formula: canonical(counts), counts, charge, totalAtoms };
}

function atomicMass(counts) { return Object.entries(counts).reduce((sum, [key, count]) => sum.plus(new D(atom(key).mass).times(count)), new D(0)); }
function parseIon(ion, explicitCharge) {
  if (ion == null || ion === '') return { text: null, multiplier: 1, modifications: [], charge: explicitCharge ?? null };
  if (typeof ion !== 'string' || ion.length > 160) fail('ion annotation is too long');
  const text = ion.replace(/\s/g, '').replaceAll('−', '-').replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])$/, (_, d, s) => [...d].map(n => superDigits.indexOf(n)).join('') + (s === '⁺' ? '+' : '-'));
  const match = /^\[(\d*)M((?:[+-][^\]]+)?)\](?:\^?(\d*)([+-]))?$/.exec(text);
  if (!match) fail('ion must be an explicit [M+H]+, [2M+H]+, [M+2H]2+ or analogous atom annotation');
  const multiplier = Number(match[1] || 1);
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 10) fail('molecular multiplier must be 1–10');
  const charge = match[4] ? (match[4] === '+' ? 1 : -1) * Number(match[3] || 1) : explicitCharge ?? null;
  if (charge === null || charge === 0) fail('ion annotation needs a nonzero explicit charge'); parseCharge(charge);
  if (explicitCharge !== undefined && charge !== explicitCharge) fail('ion annotation conflicts with charge argument');
  const modifications = []; const tail = match[2]; let cursor = 0;
  while (cursor < tail.length) {
    const term = /^([+-])(\d*)([^+-]+)/.exec(tail.slice(cursor));
    if (!term) fail('unsupported ion modification');
    const coefficient = Number(term[2] || 1);
    if (!Number.isInteger(coefficient) || coefficient < 1 || coefficient > 100) fail('adduct coefficient must be 1–100');
    const formula = parseFormula(term[3]); if (formula.charge) fail('ion modification cannot contain another charge');
    modifications.push({ sign: term[1] === '+' ? 1 : -1, coefficient, counts: formula.counts, formula: formula.formula });
    cursor += term[0].length;
  }
  return { text, multiplier, modifications, charge };
}

/** Atomic-isotope additivity with electron correction. Binding energies are not modeled. */
export function calculateExactMass({ formula, ion, formulaBasis = 'ambiguous', charge } = {}) {
  if (formulaBasis === 'auto') formulaBasis = 'ambiguous';
  if (!BASES.has(formulaBasis)) fail('formulaBasis must be neutral, ion, or ambiguous');
  if (charge !== undefined) parseCharge(charge);
  const parsed = parseFormula(formula);
  const descriptor = parseIon(ion, charge);
  const resolvedCharge = descriptor.charge ?? charge ?? (parsed.charge || null);
  if (parsed.charge && resolvedCharge !== parsed.charge) fail('formula charge conflicts with ion or charge argument');
  if (formulaBasis === 'neutral' && parsed.charge) fail('a charged formula cannot be declared neutral');
  let bases = formulaBasis === 'ambiguous' ? parsed.charge ? ['ion'] : ['neutral', 'ion'] : [formulaBasis];
  const candidates = [], rejectedInterpretations = [];
  for (const basis of bases) {
    try {
      const counts = {}; let adductCompositionCheck = null;
      if (basis === 'neutral') {
        merge(counts, parsed.counts, descriptor.multiplier);
        for (const term of descriptor.modifications) merge(counts, term.counts, term.sign * term.coefficient);
      } else {
        if (resolvedCharge === null || resolvedCharge === 0) fail('ion formula requires an explicit nonzero charge');
        merge(counts, parsed.counts);
        if (descriptor.text) {
          // Validate final-ion/adduct bookkeeping by reversing it, never by applying it twice.
          const molecule = { ...counts };
          for (const term of descriptor.modifications) merge(molecule, term.counts, -term.sign * term.coefficient);
          if (!Object.keys(molecule).length || Object.values(molecule).some(n => n < 0 || n % descriptor.multiplier !== 0)) fail('final ion composition is inconsistent with the adduct/loss or molecular multiplier: reversing it must yield nonnegative integer molecular atom counts');
          for (const key of Object.keys(molecule)) molecule[key] /= descriptor.multiplier;
          adductCompositionCheck = { status: 'consistent', moleculeFormula: canonical(molecule), meaning: 'atom bookkeeping only; does not establish structure or ion formation' };
        }
      }
      if (Object.values(counts).some(n => n < 0) || !Object.keys(counts).length) fail('ion losses exceed the supplied atom composition');
      const z = resolvedCharge ?? 0, sum = atomicMass(counts), correction = ELECTRON.times(z).neg(), mass = sum.plus(correction);
      if (mass.lte(0)) fail('nonpositive ion mass');
      const mz = z ? mass.div(Math.abs(z)) : null;
      candidates.push({ basis, charge: z, ionFormula: canonical(counts), atomicCompositionMassDa: sum.toString(), neutralMonoisotopicMassDa: basis === 'neutral' ? atomicMass(parsed.counts).toString() : null, electronCorrectionDa: correction.toString(), ionMassDa: mass.toString(), mz: mz?.toString() ?? null, adductCompositionCheck, formulaAppliedAs: basis === 'neutral' ? 'molecule formula; apply molecular multiplier and signed adduct/loss atoms once' : 'final ion composition; do not apply M multiplier/adduct atoms again' });
    } catch (error) { rejectedInterpretations.push({ basis, reason: error.message }); }
  }
  if (!candidates.length) fail(rejectedInterpretations.map(r => r.reason).join('; '));
  const ambiguous = formulaBasis === 'ambiguous' && !parsed.charge;
  return { status: ambiguous ? 'ambiguous' : 'calculated', formula: parsed.formula, originalFormula: formula, ion: descriptor.text, formulaBasis, candidates, rejectedInterpretations, datasetVersion: DATA.version, sources: massSources, notes: ['Unlabelled elements use their pinned most abundant isotope, not average atomic weights.', 'Atomic-mass additivity with charge × electron-mass correction; molecular/atomic binding-energy differences are not modeled.', ...(ambiguous ? ['Formula basis is not resolved from the reported calculated mass; do not pick whichever candidate matches it.'] : []), ...(candidates.some(c => c.mz === null) ? ['No charge is known; neutral mass can be calculated but m/z cannot.'] : [])] };
}

export function massError(observed, theoretical) {
  if ([observed, theoretical].some(value => !['string', 'number'].includes(typeof value) || String(value).length > 120)) fail('m/z values must be bounded numeric strings or numbers');
  const value = new D(observed), expected = new D(theoretical);
  if (!value.isFinite() || !expected.isFinite() || value.lte(0) || expected.lte(0) || Math.abs(value.e) > 12 || Math.abs(expected.e) > 12) fail('mass comparison requires bounded finite positive m/z values');
  const difference = value.minus(expected);
  return { observed: value.toString(), theoretical: expected.toString(), deltaDa: difference.toString(), deltaMDa: difference.times(1000).toString(), ppm: difference.div(expected).times(1_000_000).toString() };
}

function citation(block, start, end) { return { blockId: block.id, quote: block.text.slice(start, end), start, end }; }
// Keep plain integer counts/charges out of the unanchored calculated-value scan.
// A scientific-notation mantissa may be an integer; decimal notation needs a decimal point.
const MASS_NUMBER = String.raw`[+\-]?(?:(?:\d+\.\d+|\.\d+)(?:[eE][+\-]?\d+)?|\d+[eE][+\-]?\d+)`;
const MASS_END = String.raw`(?![A-Za-z0-9_]|\.\d)`;
function valueMatch(text, adjacentToMarker = false) {
  const prefix = adjacentToMarker
    ? String.raw`^\s*(?:[:：=]\s*)?(?:m\s*/\s*z\s*(?:[:：=]\s*)?)?`
    : String.raw`(?<![A-Za-z0-9_.])`;
  const match = new RegExp(`${prefix}(${MASS_NUMBER})${MASS_END}`, 'id').exec(text);
  return match ? { text: match[1], index: match.indices[1][0] } : null;
}
function roundingCompatible(theoretical, reported) {
  const match = /^[+\-]?(?:\d+|\d*\.(\d+))(?:[eE]([+\-]?\d+))?$/.exec(reported);
  if (!match) fail('unsupported reported calculated mass precision');
  // 1.810707e2 reports four places in m/z units, just like 181.0707.
  const quantum = new D(10).pow(Number(match[2] ?? 0) - (match[1]?.length ?? 0));
  return new D(theoretical).div(quantum).toDecimalPlaces(0, D.ROUND_HALF_UP).times(quantum).eq(reported);
}
function formulaFrom(prefix) {
  // The bracketed M annotation is not a molecular formula. Unsupported prose is not silently normalized.
  const withoutIon = prefix.replace(/\[(?:\d*)M[^\]]*\](?:\^?\d*[+-])?/g, m => ' '.repeat(m.length));
  const tokens = [...withoutIon.matchAll(/(?:\[\d+[A-Z][a-z]?\]|[A-Z][A-Za-z0-9()[\]·.^+−-]*)+/g)];
  const valid = [];
  for (const token of tokens) { try { const parsed = parseFormula(token[0]); if (parsed.totalAtoms >= 2) valid.push({ raw: token[0], start: token.index, end: token.index + token[0].length }); } catch { /* retain the record as unsupported if no full formula is recovered */ } }
  return valid.length === 1 ? valid[0] : undefined;
}
function validateCalculatedPrefix(prefix, formula, ion) {
  const spans = [formula, ...(ion ? [{ start: ion.index, end: ion.index + ion[0].length }] : [])].sort((a, b) => b.start - a.start);
  let rest = prefix;
  for (const span of spans) rest = rest.slice(0, span.start) + ' '.repeat(span.end - span.start) + rest.slice(span.end);
  rest = rest.replace(/^\s*\.\s*/, '').replace(/\bm\s*\/\s*z\b|\b(?:for|as|neutral|molecular|ion|ionic|formula|ESI|EI|APCI|MALDI|HRMS)\b/gi, ' ');
  if (/[^\s:：,=()]/.test(rest)) fail('calculated m/z is separated from its formula/ion by unsupported prose or another analytical field; do not search ahead for a substitute mass');
}
function compareCandidate(candidate, calcd, found, options) {
  if (!candidate.mz) return { ...candidate, calcdError: null, foundError: null, calcdRoundingCompatible: null, foundWithinTolerance: null };
  const calcdError = massError(calcd, candidate.mz), foundError = found ? massError(found, candidate.mz) : null;
  const calcdRoundingCompatible = roundingCompatible(candidate.mz, calcd);
  const foundWithinTolerance = foundError ? new D(foundError.ppm).abs().lte(options.ppmTolerance) && (options.mDaTolerance == null || new D(foundError.deltaMDa).abs().lte(options.mDaTolerance)) : null;
  return { ...candidate, calcdError, foundError, calcdRoundingCompatible, foundWithinTolerance };
}

/** Recalculate labelled MS records while preserving formula-basis ambiguity and exact source spans. */
export function checkHrms(documents, options = {}) {
  const config = { formulaBasis: options.formulaBasis ?? 'ambiguous', ppmTolerance: options.ppmTolerance ?? 5, mDaTolerance: options.mDaTolerance ?? null };
  if (config.formulaBasis === 'auto') config.formulaBasis = 'ambiguous';
  if (!BASES.has(config.formulaBasis) || typeof config.ppmTolerance !== 'number' || !Number.isFinite(config.ppmTolerance) || config.ppmTolerance <= 0 || config.ppmTolerance > 10000 || config.mDaTolerance !== null && (typeof config.mDaTolerance !== 'number' || !Number.isFinite(config.mDaTolerance) || config.mDaTolerance <= 0 || config.mDaTolerance > 1000)) fail('invalid HRMS configuration');
  const records = [], issues = []; let labelledBlocks = 0, unsupportedRecords = 0;
  for (const document of documents) for (const block of document.blocks ?? []) {
    const labels = [...block.text.matchAll(MS_LABEL)]; if (labels.length) labelledBlocks++;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i], segmentStart = label.index, segmentEnd = labels[i + 1]?.index ?? block.text.length;
      const segment = block.text.slice(segmentStart, segmentEnd), markers = [...segment.matchAll(/\b(?:calcd?\.?|calculated)\b/gi)];
      for (let j = 0; j < markers.length; j++) {
        const marker = markers[j], start = segmentStart + marker.index, afterMarker = segmentStart + marker.index + marker[0].length;
        const end = Math.min(segmentStart + (markers[j + 1]?.index ?? segment.length), segmentEnd, afterMarker + 650);
        const tail = block.text.slice(afterMarker, end), foundMarker = /\bfound\b/i.exec(tail);
        const calcPart = tail.slice(0, foundMarker?.index ?? tail.length), calcd = valueMatch(calcPart);
        // Never search ahead past prose, a sentence, or another analytical technique.
        const found = foundMarker ? valueMatch(tail.slice(foundMarker.index + foundMarker[0].length), true) : null;
        const foundStatus = foundMarker ? found ? 'reported' : 'unreadable' : 'not_reported';
        const record = { id: stableId(document.id, block.id, start), documentId: document.id, blockId: block.id, role: document.role, sourceLabel: label[0], reportedResolution: /^HRMS/i.test(label[0]) ? 'reported_high' : 'unspecified', start, end, foundStatus, foundCheckStatus: 'not_checked', config: { ...config } };
        const evidence = [citation(block, start, end)];
        try {
          if (!calcd || calcd.index > 250 || /\b(?:mmol|mol|mg|equiv|Hz|MHz)\b/.test(calcPart.slice(0, calcd.index))) fail('no bounded, explicit calculated m/z value found');
          const prefix = calcPart.slice(0, calcd.index), formula = formulaFrom(prefix);
          if (!formula) fail('no supported explicit formula was recovered; do not infer it from a mass');
          const ion = /\[(?:\d*)M[^\]]*\](?:\^?\d*[+-])?/.exec(prefix);
          validateCalculatedPrefix(prefix, formula, ion);
          const formulaBasis = config.formulaBasis === 'ambiguous' ? /\bneutral\s+(?:molecular\s+)?formula\b/i.test(prefix) ? 'neutral' : /\bion(?:ic)?\s+formula\b/i.test(prefix) ? 'ion' : 'ambiguous' : config.formulaBasis;
          const calculation = calculateExactMass({ formula: formula.raw, ion: ion?.[0], formulaBasis });
          const foundStart = found ? afterMarker + foundMarker.index + foundMarker[0].length + found.index : null;
          const values = calculation.candidates.map(c => compareCandidate(c, calcd.text, found?.text, config));
          Object.assign(record, { status: calculation.status, formula: formula.raw, ion: ion?.[0] ?? null, formulaBasis, calculatedReported: calcd.text, foundReported: found?.text ?? null, foundCheckStatus: values.some(v => v.foundError !== null) ? 'checked' : 'not_checked', candidates: values, rejectedInterpretations: calculation.rejectedInterpretations, sources: massSources, citations: { formula: citation(block, afterMarker + formula.start, afterMarker + formula.end), calculated: citation(block, afterMarker + calcd.index, afterMarker + calcd.index + calcd.text.length), ...(ion ? { ion: citation(block, afterMarker + ion.index, afterMarker + ion.index + ion[0].length) } : {}), ...(foundMarker ? { foundMarker: citation(block, afterMarker + foundMarker.index, afterMarker + foundMarker.index + foundMarker[0].length) } : {}), ...(found ? { found: citation(block, foundStart, foundStart + found.text.length) } : {}) } });
          if (foundStatus === 'unreadable') issues.push({ id: stableId(record.id, 'unreadable-found'), type: 'coverage', category: 'hrms', severity: 'medium', evidenceStatus: 'insufficient', status: 'open', title: 'MS 实测 m/z 未能读取', description: '原文含 found 标记，但其后没有紧邻的受支持 m/z 数字。已保留理论复算；实测偏差未检查，未从后续句子、NMR 或其他文字中寻找替代数字。', evidenceIds: [block.id], citations: evidence, hrmsRecordId: record.id });
          let title, description;
          if (values.every(v => !v.mz)) { title = 'MS 复算缺少明确电荷或离子标注'; description = '可以计算中性原子组成质量，但没有足够信息得到 m/z；未假定 [M+H]+。'; }
          else if (calculation.status === 'ambiguous') { title = 'MS 分子式口径待确认：精确质量有多种解释'; description = '原文未明确该分子式是中性分子组成还是最终离子组成。已分别复算并保留候选解释；未根据与 reported calculated 的接近程度反推口径，不直接判定哪个数字错误。'; }
          else if (values.some(v => v.calcdRoundingCompatible === false)) { title = '报告计算质量与指定分子式/离子口径不相容'; description = '在已指定的分子式口径和原子质量加和约定下，理论 m/z 不能舍入为原文 calculated 值。请确认分子式、离子加合物、电荷及质量计算约定；此检查不证明结构错误。'; }
          else if (values.some(v => v.foundWithinTolerance === false)) { title = '实测 m/z 与复算质量偏差超过配置阈值'; description = `原文 found 与理论 m/z 的偏差超过软件配置（${config.ppmTolerance} ppm${config.mDaTolerance == null ? '' : `，且 ${config.mDaTolerance} mDa`}）。该阈值不是推断的期刊要求，需结合仪器和样品复核。`; }
          else if (values.some(v => !v.mz)) { title = 'MS 复算缺少明确电荷或离子标注'; description = '可以计算中性原子组成质量，但没有足够信息得到 m/z；未假定 [M+H]+。'; }
          if (title) issues.push({ id: stableId(record.id, title), type: 'data', category: 'hrms', severity: 'medium', evidenceStatus: 'needs_review', status: 'open', title, description, evidenceIds: [block.id], citations: evidence, calculation: { formula: record.formula, ion: record.ion, formulaBasis, candidates: values, convention: 'neutral atom isotope mass sum minus z electron masses; binding energies not modeled' }, hrmsRecordId: record.id });
        } catch (error) {
          unsupportedRecords++; Object.assign(record, { status: 'unsupported', reason: error.message, citations: { record: evidence[0] } });
          issues.push({ id: stableId(record.id, 'unsupported'), type: 'coverage', category: 'hrms', severity: 'medium', evidenceStatus: 'insufficient', status: 'open', title: 'MS 精确质量复算资料不足或表达未支持', description: error.message, evidenceIds: [block.id], citations: evidence, hrmsRecordId: record.id });
        }
        records.push(record);
      }
    }
  }
  return { issues, records, coverage: { status: 'limited', labelledBlocks, recordCount: records.length, calculatedRecords: records.filter(r => r.status === 'calculated').length, ambiguousRecords: records.filter(r => r.status === 'ambiguous').length, unsupportedRecords, foundReportedRecords: records.filter(r => r.foundStatus === 'reported').length, foundUnreadableRecords: records.filter(r => r.foundStatus === 'unreadable').length, foundNotReportedRecords: records.filter(r => r.foundStatus === 'not_reported').length, foundCheckedRecords: records.filter(r => r.foundCheckStatus === 'checked').length, declaredConfiguration: config, thresholdSource: 'software/user configuration, not inferred journal requirement', datasetVersion: DATA.version, supportedElements: Object.keys(DATA.elements), sources: massSources, note: 'Recalculation is conditional on formula interpretation and ion annotation. A calculated record status does not mean an observed mass was reported or checked; see foundStatus and foundCheckStatus. It does not confirm structure, instrument resolution, isotope envelope, sample identity or measurement authenticity.' } };
}

export const HRMS_DATA_INFO = Object.freeze({ ...massSources, electronMassU: DATA.electronMassU, supportedElements: Object.keys(DATA.elements) });
