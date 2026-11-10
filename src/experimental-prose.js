import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { calculateExperiment } from './experimental-math.js';
const D = Decimal.clone({ precision: 40 });
const N = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const id = x => 'prose_' + createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const cite = (b, start, end) => ({ blockId: b.id, start, end, quote: b.text.slice(start, end) });
const amount = (n, u) => new D(n).times(u === 'mol' ? 1000 : /^[µμu]mol$/.test(u) ? .001 : 1).toString();
const mass = (n, u) => new D(n).times(u === 'g' ? 1000 : 1).toString();
function unique(text, pattern, convert = m => m[1]) { const values = [...text.matchAll(pattern)]; return { value: values.length === 1 ? convert(values[0]) : null, matches: values, ambiguous: values.length > 1 }; }
export function checkExperimentalProse(documents, options = {}) {
  const records = [], issues = [];
  function add(doc, block, kind, input, citations, context, ambiguous = []) {
    const keys = { yield: ['limitingAmountMmol', 'productMassMg', 'molarMassGmol', 'stoichiometricFactor', 'reportedYieldPercent'], mass_amount: ['massMg', 'amountMmol', 'molarMassGmol'], concentration: ['concentrationM', 'volumeMl', 'amountMmol'] }[kind];
    const missing = keys.filter(k => input[k] === null || input[k] === undefined);
    const record = { id: id([doc.id, block.id, kind, citations]), documentId: doc.id, entity: context.entity ?? null, kind, origin: 'experimental_prose', input: { kind, ...input }, context, citations, missing, ambiguous, status: 'insufficient' };
    if (kind === 'mass_amount' && input.massMg && input.amountMmol && !ambiguous.length) record.impliedMolarMassGmol = new D(input.massMg).div(input.amountMmol).toString();
    if (!missing.length && !ambiguous.length) { try { record.calculation = calculateExperiment(record.input, options); record.status = record.calculation.status; } catch (e) { record.reason = e.message; } }
    records.push(record);
    if (record.status !== 'compatible_with_tolerance') issues.push({ id: record.id, type: record.status === 'insufficient' ? 'coverage' : 'data', category: 'experimental_prose', severity: record.status === 'insufficient' ? 'low' : 'medium', status: 'open', evidenceStatus: record.status === 'insufficient' ? 'insufficient' : 'needs_review', title: record.status === 'insufficient' ? '实验叙述已提取，复算条件尚不完整' : '实验叙述的数值复算不一致', description: `按同一括号组/产物句归属提取，未借用其他试剂或其他段落。缺少：${missing.join(', ') || '无'}；歧义：${ambiguous.join(', ') || '无'}。1 equiv 不自动等于限制试剂，HRMS m/z 不作为摩尔质量。`, evidenceIds: [...new Set(citations.map(c => c.blockId))], citations, calculation: record });
  }
  for (const doc of documents.filter(d => !['image_table', 'material_ocr'].includes(d.format))) for (const b of doc.blocks ?? []) {
    if (b.metadata?.cells) continue;
    const text = b.text;
    // Multiple steps/scales and percentages other than isolated yield require interpretation.
    const complex = /\b(?:crude|NMR yield|GC yield|HPLC yield|assay yield|purity|pure|two steps|over \d+ steps|aliquot|portion|recovered|conversion|solution of|mixture of)\b|纯度|粗产物|两步|分取|回收/i.test(text);
    for (const m of text.matchAll(/\([^()\n]{1,250}\)/g)) {
      const inner = m[0], a = unique(inner, new RegExp(`(${N})\\s*(mmol|[µμu]mol|mol)\\b`, 'g'), m => amount(m[1], m[2]));
      const w = unique(inner, new RegExp(`(${N})\\s*(mg|g)(?!\\s*(?:/|mol))\\b`, 'g'), m => mass(m[1], m[2]));
      const mw = unique(inner, new RegExp(`(?:MW|molar mass|molecular weight|摩尔质量)\\s*(?:of|is|=|:|为|：)?\\s*(${N})\\s*g\\s*(?:/\\s*mol|mol[−-]1)`, 'gi'));
      const c = unique(inner, new RegExp(`(${N})\\s*(mM|M|mol/L)(?![A-Za-z])`, 'g'), m => new D(m[1]).times(m[2] === 'mM' ? .001 : 1).toString());
      const v = unique(inner, new RegExp(`(${N})\\s*(mL|[µμu]L|L)\\b`, 'g'), m => new D(m[1]).times(m[2] === 'L' ? 1000 : /^[µμu]L$/.test(m[2]) ? .001 : 1).toString());
      const context = { localLabel: text.slice(Math.max(0, m.index - 100), m.index).split(/[;,。]/).at(-1).trim(), grouping: 'single_parenthesis' };
      const named = /(?:product|compound|产物|化合物)\s*([0-9]+[a-zA-Z]+)\s+(?:was\s+)?(?:obtained|isolated)/i.exec(context.localLabel); if (named) context.entity = named[1];
      const ambiguous = [a, w, mw, c, v].some(x => x.ambiguous) ? ['multiple_values_in_group'] : [];
      if (complex) ambiguous.push('purity_solution_or_multistep_context');
      if (w.matches.length && a.matches.length) add(doc, b, 'mass_amount', { massMg: w.value, amountMmol: a.value, molarMassGmol: mw.value }, [cite(b, Math.max(0, m.index - context.localLabel.length), m.index + inner.length)], context, ambiguous);
      if (c.matches.length && v.matches.length) add(doc, b, 'concentration', { concentrationM: c.value, volumeMl: v.value, amountMmol: a.value }, [cite(b, m.index, m.index + inner.length)], context, ambiguous);
    }
    const products = [...text.matchAll(new RegExp(`(?:afforded|gave|yielded|obtained|isolated|得到|获得)\\s+(?:(?:the|desired|title|product|compound)\\s+)*([0-9]+[a-zA-Z]+)\\s*(?:as\\s+[^()\n]{0,80})?\\((${N})\\s*(mg|g)\\s*[,;，]\\s*(${N})\\s*%\\s*(?:isolated\\s+)?(?:yield|收率)?\\)`, 'gi'))];
    for (const m of text.matchAll(new RegExp(`(?:product|compound|产物|化合物)\\s*([0-9]+[a-zA-Z]+)\\s+(?:was\\s+)?(?:obtained|isolated)\\s+in\\s+(${N})\\s*%\\s*(?:isolated\\s+)?yield\\s*\\((${N})\\s*(mg|g)(?:\\s*[,;]\\s*(${N})\\s*(mmol|[µμu]mol|mol))?\\)`, 'gi'))) {
      const normalized = [m[0], m[1], m[3], m[4], m[2]]; normalized.index = m.index; normalized.reportedAmountMmol = m[5] ? amount(m[5], m[6]) : null; products.push(normalized);
    }
    for (const m of products) {
      const limit = unique(text, new RegExp(`(?:limiting (?:reagent|substrate)|限制(?:试剂|底物))[^.;。()]{0,60}?\\(?\\s*(${N})\\s*(mmol|[µμu]mol|mol)\\b`, 'gi'), m => amount(m[1], m[2]));
      const mw = unique(text, new RegExp(`(?:product molar mass|product molecular weight|产物摩尔质量)\\s*(?:of|is|=|:|为|：)?\\s*(${N})\\s*g\\s*(?:/\\s*mol|mol[−-]1)`, 'gi'));
      const ratio = unique(text, new RegExp(`(?:stoichiometric (?:factor|ratio)|产物计量系数)\\s*(?:of|is|=|:|为|：)?\\s*(${N})(?!\\d|\\.\\d)`, 'gi'));
      const citations = [cite(b, m.index, m.index + m[0].length), ...[limit, mw, ratio].flatMap(x => x.matches.map(m => cite(b, m.index, m.index + m[0].length)))];
      const ambiguous = []; if ([limit, mw, ratio].some(x => x.ambiguous) || products.length !== 1) ambiguous.push('multiple_products_or_parameters'); if (complex) ambiguous.push('purity_solution_or_multistep_context');
      add(doc, b, 'yield', { productMassMg: mass(m[2], m[3]), reportedYieldPercent: m[4], limitingAmountMmol: limit.value, molarMassGmol: mw.value, stoichiometricFactor: ratio.value }, citations, { entity: m[1], grouping: 'one_product_in_one_block', reportedProductAmountMmol: m.reportedAmountMmol ?? null }, ambiguous);
    }
  }
  return { records, issues, coverage: { extracted: records.length, checked: records.filter(r => r.calculation).length, insufficient: records.filter(r => !r.calculation).length, scope: 'Explicit local prose groups and product clauses, not general-procedure inheritance. Missing molar mass, limiting reagent, stoichiometry and ambiguous purity are retained.' } };
}
