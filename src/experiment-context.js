import Decimal from 'decimal.js';
const D = Decimal.clone({ precision: 40 });
export const NUMBER = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
export const cite = (b, start = 0, end = b.text.length) => ({ blockId: b.id, start, end, quote: b.text.slice(start, end) });
export const mmol = (n, u) => new D(n).times(u === 'mol' ? 1000 : /^[µμu]mol$/.test(u) ? .001 : 1).toString();
export function observations(block, pattern, convert = m => m[1], offset = 0, text = block.text) { return [...text.matchAll(pattern)].map(m => ({ value: convert(m), citation: cite(block, offset + m.index, offset + m.index + m[0].length), raw: m[0] })); }
export function explicitParameters(b) {
  return {
    limitingAmountMmol: observations(b, new RegExp(`(?:limiting (?:reagent|substrate)|限制(?:试剂|底物))[^.;。()]{0,60}?\\(?\\s*(${NUMBER})\\s*(mmol|[µμu]mol|mol)\\b`, 'gi'), m => mmol(m[1], m[2])),
    stoichiometricFactor: observations(b, new RegExp(`(?:stoichiometric (?:factor|ratio)|产物计量系数)\\s*(?:of|is|=|:|为|：)?\\s*(${NUMBER})(?!\\d|\\.\\d|\\s*:)`, 'gi')),
    molarMassGmol: observations(b, new RegExp(`(?:product molar mass|product molecular weight|产物摩尔质量)\\s*(?:of|is|=|:|为|：)?\\s*(${NUMBER})\\s*g\\s*(?:/\\s*mol|mol[−-]1)`, 'gi')),
  };
}
export function amountEquivalents(b) {
  return [...b.text.matchAll(new RegExp(`\\(\\s*(?:${NUMBER}\\s*(?:mg|g)\\s*[,;]\\s*)?(${NUMBER})\\s*(mmol|[µμu]mol|mol)\\s*[,;]\\s*(${NUMBER})\\s*(?:equiv(?:alents?)?\\.?|eq\\.?)\\s*\\)`, 'gi'))].map(m => ({ value: mmol(m[1], m[2]), equivalent: m[3], citation: cite(b, m.index, m.index + m[0].length), label: b.text.slice(Math.max(0, m.index - 50), m.index).split(/[,;.)]/).at(-1).trim() }));
}
const heading = /^\s*(?:\d+[.)]\s*)?General\s+(?:procedure|method)\s+([A-Za-z0-9]+)\b/i;
export function procedureIndex(documents) {
  const methods = [];
  for (const doc of documents) for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i], m = heading.exec(b.text); if (!m || b.text.length > 200) continue;
    const pieces = [b];
    for (let j = i + 1; j < Math.min(doc.blocks.length, i + 5); j++) {
      const next = doc.blocks[j];
      if (heading.test(next.text) || next.metadata?.cells || /^(?:Characterization|Preparation|Optimization|Table|Figure|Scheme)\b/i.test(next.text.trim()) || /Following|\bproduct\s+\d+[a-z]/i.test(next.text) || next.text.length < 70 && !/\d\s*(?:mmol|mol|equiv)/i.test(next.text)) break;
      pieces.push(next);
    }
    const parameters = { limitingAmountMmol: [], stoichiometricFactor: [], molarMassGmol: [] };
    for (const piece of pieces) { const p = explicitParameters(piece); for (const k of Object.keys(parameters)) parameters[k].push(...p[k]); }
    const pairs = pieces.flatMap(amountEquivalents), baselines = pairs.filter(p => new D(p.equivalent).eq(1));
    const conflict = baselines.length === 1 && pairs.some(p => { const ratio = new D(p.value).div(new D(baselines[0].value).times(p.equivalent)); return ratio.lt(.8) || ratio.gt(1.25); });
    methods.push({ label: m[1].toUpperCase(), documentId: doc.id, sourceSha256: doc.sha256, heading: cite(b), pieces: pieces.map(b => cite(b)), parameters, baselines, conflict });
  }
  return methods;
}
export function resolveProcedure(doc, block, methods) {
  const refs = [...block.text.matchAll(/\b(?:following|according to|using)\s+(?:the\s+)?general\s+(?:procedure|method)\s+([A-Za-z0-9]+)\b/gi)];
  const result = { label: null, method: null, citations: [], problems: [], overrides: false };
  if (!refs.length) return result;
  if (refs.length !== 1) { result.problems.push({ type: 'ambiguous', code: 'multiple_method_references' }); return result; }
  result.label = refs[0][1].toUpperCase(); result.citations.push(cite(block, refs[0].index, refs[0].index + refs[0][0].length));
  const same = methods.filter(m => m.documentId === doc.id && m.label === result.label), targets = same.length ? same : methods.filter(m => m.label === result.label);
  if (targets.length !== 1) { result.problems.push({ type: targets.length ? 'ambiguous' : 'not_linked', code: targets.length ? 'duplicate_method_labels' : 'method_definition_not_located' }); return result; }
  result.method = targets[0]; result.citations.push(targets[0].heading, ...targets[0].pieces.slice(1));
  result.overrides = /\b(?:scale[- ]up|gram[- ]scale|modified|modification|except|instead|doubled|halved)\b|\d(?:\.\d+)?\s*(?:mmol|mol)\s+scale|放大|改为|改用/i.test(block.text);
  if (result.overrides) result.problems.push({ type: 'not_linked', code: 'local_scale_or_method_override_requires_resolution' });
  if (targets[0].conflict) result.problems.push({ type: 'ambiguous', code: 'method_amount_equivalent_conflict' });
  return result;
}
export function validateExperimentContext(input, run) {
  if (!input || !['record', 'method'].includes(input.scope) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('Explicit user context scope and reason required');
  const allowed = ['scope', 'recordId', 'documentId', 'methodLabel', 'limitingAmountMmol', 'stoichiometricFactor', 'neutralFormula', 'reason', 'citations'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Unknown experimental context field');
  const record = input.scope === 'record' ? run.experimentalProseRecords?.find(r => r.id === input.recordId) : null;
  if (input.scope === 'record' && !record) throw new Error('Unknown experimental record');
  const doc = run.documents.find(d => d.id === (record?.documentId ?? input.documentId));
  if (!doc || ['image_table', 'material_ocr'].includes(doc.format)) throw new Error('Current textual source required');
  const method = input.scope === 'method' ? procedureIndex([doc]).filter(m => m.label === String(input.methodLabel).toUpperCase()) : [];
  if (input.scope === 'method' && method.length !== 1) throw new Error('Method label must identify one definition');
  if (input.scope === 'method' && input.neutralFormula) throw new Error('A product formula cannot be applied to an entire general method');
  for (const key of ['limitingAmountMmol', 'stoichiometricFactor']) if (input[key] !== undefined) { const n = new D(input[key]); if (!n.isFinite() || n.lte(0) || n.gt(1e9)) throw new Error('Invalid positive context parameter'); }
  if (!['limitingAmountMmol', 'stoichiometricFactor', 'neutralFormula'].some(k => input[k] !== undefined)) throw new Error('At least one contextual parameter required');
  if (!Array.isArray(input.citations) || !input.citations.length || input.citations.length > 20) throw new Error('Source citations required');
  const relevant = new Set(record ? record.citations.map(c => c.blockId) : method[0].pieces.map(c => c.blockId));
  for (const c of input.citations) { const b = doc.blocks.find(b => b.id === c.blockId); if (!b || !relevant.has(b.id) || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start || c.end > b.text.length || b.text.slice(c.start, c.end) !== c.quote) throw new Error('Context quote must exactly match relevant current evidence'); }
  return { ...structuredClone(input), documentId: doc.id, sourceSha256: doc.sha256, methodLabel: input.methodLabel?.toUpperCase(), at: new Date().toISOString(), source: 'explicit_user_interpretation_not_automatic_extraction' };
}
