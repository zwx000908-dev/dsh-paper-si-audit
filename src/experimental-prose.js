import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { calculateExperiment } from './experimental-math.js';
import { calculateMolarMass } from './molar-mass.js';
import { checkHrms } from './hrms.js';
import { procedureIndex, resolveProcedure, explicitParameters, amountEquivalents } from './experiment-context.js';
const D = Decimal.clone({ precision: 40 });
const N = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const id = x => 'prose_' + createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const cite = (b, start, end) => ({ blockId: b.id, start, end, quote: b.text.slice(start, end) });
const amount = (n, u) => new D(n).times(u === 'mol' ? 1000 : /^[µμu]mol$/.test(u) ? .001 : 1).toString();
const mass = (n, u) => new D(n).times(u === 'g' ? 1000 : 1).toString();
function unique(text, pattern, convert = m => m[1]) { const values = [...text.matchAll(pattern)]; return { value: values.length === 1 ? convert(values[0]) : null, matches: values, ambiguous: values.length > 1 }; }
export function checkExperimentalProse(documents, options = {}, { hrmsRecords, contexts = [] } = {}) {
  const records = [], issues = [], methods = procedureIndex(documents);
  hrmsRecords ??= checkHrms(documents).records;
  function massSources(doc, block, entity, group) {
    const candidates = [], citations = [], problems = [];
    const text = group?.text ?? block.text, offset = group?.start ?? 0;
    // Outside a single reagent group, require a unique named product in this block.
    if (!group && (!entity || new Set([...block.text.matchAll(/(?:product|compound)\s*([0-9]+[a-zA-Z]*)/gi)].map(m => m[1])).size > 1)) return { candidates, citations, problems: [{ type: 'not_linked', code: 'formula_entity_not_uniquely_linked' }] };
    for (const m of text.matchAll(/(?:neutral(?: molecular)? formula|molecular formula|中性分子式|分子式)\s*[:=：]\s*([A-Za-z0-9()[\]·₀-₉+^−-]+)/gi)) {
      if (/\b(?:HRMS|MS|ion)\b/i.test(text.slice(Math.max(0, m.index - 35), m.index))) continue;
      try { const calculation = calculateMolarMass(m[1]); candidates.push({ ...calculation, basis: 'explicit_neutral_formula', conditional: false }); citations.push(cite(block, offset + m.index, offset + m.index + m[0].length)); } catch (e) { problems.push({ type: 'not_linked', code: 'unsupported_formula', detail: e.message }); }
    }
    if (!group && !candidates.length) for (const h of hrmsRecords.filter(h => h.blockId === block.id && h.formula)) {
      for (const c of h.candidates ?? []) {
        const f = c.basis === 'neutral' ? h.formula : c.adductCompositionCheck?.moleculeFormula;
        if (!f) { problems.push({ type: 'not_linked', code: 'ion_to_neutral_formula_not_resolved' }); continue; }
        try { candidates.push({ ...calculateMolarMass(f), basis: c.basis, conditional: h.formulaBasis === 'ambiguous', formulaBasisSource: 'MS formula/adduct atom bookkeeping, not reported m/z' }); } catch (e) { problems.push({ type: 'not_linked', code: 'unsupported_formula', detail: e.message }); }
      }
      citations.push(...[h.citations.formula, h.citations.ion].filter(Boolean));
    }
    if (candidates.length > 1 || candidates.some(c => c.conditional)) problems.push({ type: 'ambiguous', code: 'neutral_or_ion_formula_basis' });
    return { candidates, citations, problems };
  }
  function add(doc, block, kind, input, citations, context, ambiguous = [], links = {}) {
    const recordId = id([doc.id, block.id, kind, citations]);
    const sourceCitations = [...citations];
    const fieldSources = links.fieldSources ?? {}, problems = [...(links.problems ?? [])];
    const matchingContext = contexts.filter(c => c.documentId === doc.id && c.sourceSha256 === doc.sha256 && c.scope === 'record' && c.recordId === recordId).at(-1);
    if (matchingContext) {
      for (const key of ['limitingAmountMmol', 'stoichiometricFactor']) if (matchingContext[key] !== undefined) { input[key] = String(matchingContext[key]); fieldSources[key] = { origin: 'explicit_user_interpretation', citations: matchingContext.citations }; }
      if (matchingContext.neutralFormula) { try { input.molarMassGmol = calculateMolarMass(matchingContext.neutralFormula).molarMassGmol; fieldSources.molarMassGmol = { origin: 'explicit_user_neutral_formula', calculation: calculateMolarMass(matchingContext.neutralFormula), citations: matchingContext.citations }; } catch (e) { problems.push({ type: 'not_linked', code: 'unsupported_user_formula', detail: e.message }); } }
      sourceCitations.push(...matchingContext.citations);
    }
    const useMoles = kind === 'yield' && input.productAmountMmol !== null && input.productAmountMmol !== undefined;
    const calcKind = useMoles ? 'molar_yield' : kind;
    const keys = { yield: ['limitingAmountMmol', 'productMassMg', 'molarMassGmol', 'stoichiometricFactor', 'reportedYieldPercent'], molar_yield: ['limitingAmountMmol', 'productAmountMmol', 'stoichiometricFactor', 'reportedYieldPercent'], mass_amount: ['massMg', 'amountMmol', 'molarMassGmol'], concentration: ['concentrationM', 'volumeMl', 'amountMmol'] }[calcKind];
    const missing = keys.filter(k => input[k] === null || input[k] === undefined);
    sourceCitations.push(...(links.citations ?? []));
    const uniqueCitations = [...new Map(sourceCitations.map(c => [JSON.stringify(c), c])).values()];
    const record = { id: recordId, documentId: doc.id, entity: context.entity ?? null, kind, origin: 'experimental_prose', input: { kind: calcKind, ...input }, context, fieldSources, citations: uniqueCitations, missing, ambiguous, problems, massCandidates: links.massCandidates ?? [], status: 'insufficient', conditionalCalculations: [] };
    if (kind === 'mass_amount' && input.massMg && input.amountMmol && !ambiguous.length) record.impliedMolarMassGmol = new D(input.massMg).div(input.amountMmol).toString();
    const inputFor = values => ({ kind: calcKind, ...Object.fromEntries(keys.map(k => [k, values[k]])) });
    if (!missing.length && !ambiguous.length && !links.blockCalculation) { try { record.calculation = calculateExperiment(inputFor(input), options); record.status = record.calculation.status; } catch (e) { record.reason = e.message; } }
    // Exploratory arithmetic is separate from verified input selection and never becomes a pass.
    if (!record.calculation && !ambiguous.length) {
      const trial = { ...input }, assumptions = [];
      if (kind === 'yield' && !trial.limitingAmountMmol && links.baseline) { trial.limitingAmountMmol = links.baseline.value; assumptions.push('Treat the uniquely reported 1-equiv amount as the yield reference, not a proven limiting reagent.'); }
      if (kind === 'yield' && !trial.stoichiometricFactor) { trial.stoichiometricFactor = '1'; assumptions.push('Hypothetical 1:1 product stoichiometry; requires reaction/user confirmation.'); }
      if (kind === 'concentration' && !trial.amountMmol && links.baseline) { trial.amountMmol = links.baseline.value; assumptions.push('Concentration is assumed to refer to the uniquely reported 1-equiv reagent.'); }
      if (links.blockCalculation) assumptions.push('Linked general procedure contains unresolved amount/equivalent inconsistency.');
      const candidates = !useMoles && !trial.molarMassGmol && record.massCandidates.length ? record.massCandidates : [null];
      for (const candidate of candidates) {
        const values = { ...trial, ...(candidate ? { molarMassGmol: candidate.molarMassGmol } : {}) };
        if (keys.some(k => values[k] === null || values[k] === undefined)) continue;
        try { record.conditionalCalculations.push({ calculation: calculateExperiment(inputFor(values), options), assumptions: [...assumptions, ...(candidate ? [`Molar mass computed under ${candidate.basis} formula interpretation (${candidate.formula}).`] : [])], formulaInterpretation: candidate }); } catch { /* invalid candidates do not constitute a check */ }
      }
      if (record.conditionalCalculations.length) { record.status = 'conditional'; const states = new Set(record.conditionalCalculations.map(c => c.calculation.status)); record.conditionalNumericStatus = states.size > 1 ? 'interpretation_dependent' : states.has('needs_review') ? 'all_conflict' : 'all_compatible'; }
    }
    record.gaps = missing.map(field => ({ field, type: field === 'molarMassGmol' && record.massCandidates.length || field === 'limitingAmountMmol' && links.baseline || field === 'amountMmol' && links.baseline ? 'ambiguous' : problems.some(p => p.type === 'not_linked') ? 'not_linked' : 'not_found_in_checked_scope' }));
    record.gaps.push(...ambiguous.map(code => ({ type: 'ambiguous', code })), ...problems);
    records.push(record);
    if (record.status !== 'compatible_with_tolerance') issues.push({ id: record.id, type: record.status === 'needs_review' ? 'data' : 'coverage', category: 'experimental_prose', severity: record.status === 'needs_review' || record.conditionalNumericStatus === 'all_conflict' ? 'medium' : 'low', status: 'open', evidenceStatus: record.status === 'needs_review' || record.status === 'conditional' ? 'needs_review' : 'insufficient', title: record.status === 'conditional' ? '实验数字已作条件性复算，依据待确认' : record.status === 'insufficient' ? '实验叙述复算存在缺项或关联限制' : '实验叙述的数值复算不一致', description: '区分已检查范围未找到(not_found_in_checked_scope)、尚未关联(not_linked)、存在多个解释(ambiguous)。条件性计算不代表验证通过；保留全部假设和原文引用。', evidenceIds: [...new Set(uniqueCitations.map(c => c.blockId))], citations: uniqueCitations, calculation: record });
  }
  for (const doc of documents.filter(d => !['image_table', 'material_ocr'].includes(d.format))) for (const b of doc.blocks ?? []) {
    if (b.metadata?.cells) continue;
    const text = b.text;
    // Multiple steps/scales and percentages other than isolated yield require interpretation.
    const complexPattern = /\b(?:crude|NMR yield|GC yield|HPLC yield|assay yield|purity|two steps|over \d+ steps|aliquot|recovered|conversion)\b|纯度|粗产物|两步|分取|回收/i;
    const isComplex = (start, end) => complexPattern.test(text.slice(Math.max(0, start - 120), Math.min(text.length, end + 100)));
    const procedure = resolveProcedure(doc, b, methods);
    const explicit = explicitParameters(b);
    const methodUser = contexts.filter(c => c.scope === 'method' && c.documentId === procedure.method?.documentId && c.sourceSha256 === procedure.method?.sourceSha256 && c.methodLabel === procedure.label).at(-1);
    const localPairs = amountEquivalents(b), localBases = localPairs.filter(p => new D(p.equivalent).eq(1));
    if (procedure.method && localPairs.length) { procedure.overrides = true; procedure.problems.push({ type: 'not_linked', code: 'local_reagent_amounts_override_general_scale' }); }
    const inheritedBases = procedure.method && !procedure.overrides ? procedure.method.baselines : [];
    const baseline = localBases.length === 1 ? localBases[0] : !localPairs.length && inheritedBases.length === 1 ? inheritedBases[0] : null;
    for (const m of text.matchAll(/\([^()\n]{1,250}\)/g)) {
      const inner = m[0], a = unique(inner, new RegExp(`(${N})\\s*(mmol|[µμu]mol|mol)\\b`, 'g'), m => amount(m[1], m[2]));
      const w = unique(inner, new RegExp(`(${N})\\s*(mg|g)(?!\\s*(?:/|mol))\\b`, 'g'), m => mass(m[1], m[2]));
      const mw = unique(inner, new RegExp(`(?:MW|molar mass|molecular weight|摩尔质量)\\s*(?:of|is|=|:|为|：)?\\s*(${N})\\s*g\\s*(?:/\\s*mol|mol[−-]1)`, 'gi'));
      const c = unique(inner, new RegExp(`(${N})\\s*(mM|M|mol/L)(?![A-Za-z])`, 'g'), m => new D(m[1]).times(m[2] === 'mM' ? .001 : 1).toString());
      const v = unique(inner, new RegExp(`(${N})\\s*(mL|[µμu]L|L)\\b`, 'g'), m => new D(m[1]).times(m[2] === 'L' ? 1000 : /^[µμu]L$/.test(m[2]) ? .001 : 1).toString());
      const context = { localLabel: text.slice(Math.max(0, m.index - 100), m.index).split(/[;,。]/).at(-1).trim(), grouping: 'single_parenthesis' };
      const named = /(?:product|compound|产物|化合物)\s*([0-9]+[a-zA-Z]*)\s+(?:was\s+)?(?:obtained|isolated)/i.exec(context.localLabel); if (named) context.entity = named[1];
      const ambiguous = [a, w, mw, c, v].some(x => x.ambiguous) ? ['multiple_values_in_group'] : [];
      if (isComplex(m.index, m.index + inner.length)) ambiguous.push('explicit_local_purity_or_multistep_context');
      if (w.matches.length && a.matches.length) {
        const formula = massSources(doc, b, context.entity, context.entity ? null : { text: inner.slice(1, -1), start: m.index + 1 });
        if (mw.value && formula.candidates.length === 1 && !formula.candidates[0].conditional && new D(mw.value).minus(formula.candidates[0].molarMassGmol).abs().gt(new D(formula.candidates[0].molarMassGmol).times(options.amountRelativeTolerance ?? .02))) ambiguous.push('explicit_molar_mass_conflicts_with_neutral_formula');
        if (!mw.value && !formula.candidates.length && /[A-Za-z]/.test(context.localLabel)) formula.problems.push({ type: 'not_linked', code: 'chemical_identity_to_neutral_formula_not_resolved' });
        const massValue = mw.value ?? (formula.candidates.length === 1 && !formula.candidates[0].conditional ? formula.candidates[0].molarMassGmol : null);
        add(doc, b, 'mass_amount', { massMg: w.value, amountMmol: a.value, molarMassGmol: massValue }, [cite(b, Math.max(0, text.lastIndexOf(context.localLabel, m.index)), m.index + inner.length)], context, ambiguous, { massCandidates: formula.candidates, citations: formula.citations, problems: formula.problems, fieldSources: { molarMassGmol: { origin: mw.value ? 'explicit_local_molar_mass' : 'formula_calculation', candidates: formula.candidates } } });
      }
      if (c.matches.length && v.matches.length) {
        const explicitBasis = /(?:based on|with respect to|relative to|基于)\s*(?:the\s+)?(?:limiting (?:reagent|substrate)|substrate|reagent)/i.test(text.slice(Math.max(0, m.index - 90), m.index + inner.length + 90));
        const linked = a.value ?? (explicitBasis && explicit.limitingAmountMmol.length === 1 ? explicit.limitingAmountMmol[0].value : null);
        add(doc, b, 'concentration', { concentrationM: c.value, volumeMl: v.value, amountMmol: linked }, [cite(b, m.index, m.index + inner.length)], { ...context, concentrationBasis: explicitBasis ? 'explicit_reference' : 'not_stated' }, ambiguous, { baseline, citations: [...(baseline ? [baseline.citation] : []), ...(linked && !a.value ? explicit.limitingAmountMmol.map(x => x.citation) : [])], problems: localBases.length > 1 ? [{ type: 'ambiguous', code: 'multiple_one_equivalent_reagents' }] : [], fieldSources: { amountMmol: { origin: a.value ? 'same_parenthesis' : explicitBasis && linked ? 'explicit_same_block_basis' : 'unresolved_reference', candidate: baseline } } });
      }
    }
    const products = [...text.matchAll(new RegExp(`(?:afforded|gave|yielded|obtained|isolated|得到|获得)\\s+(?:(?:the|desired|title|product|compound)\\s+)*([0-9]+[a-zA-Z]*)\\s*(?:as\\s+[^()\n]{0,80})?\\((${N})\\s*(mg|g)\\s*[,;，]\\s*(${N})\\s*%\\s*(?:isolated\\s+)?(?:yield|收率)?\\)`, 'gi'))];
    for (const m of text.matchAll(new RegExp(`(?:product|compound|产物|化合物)\\s*([0-9]+[a-zA-Z]*)\\s+(?:was\\s+)?(?:obtained|isolated)\\s+in\\s+(${N})\\s*%\\s*(?:isolated\\s+)?yield\\s*\\((${N})\\s*(mg|g)(?:\\s*[,;]\\s*(${N})\\s*(mmol|[µμu]mol|mol))?\\)`, 'gi'))) {
      const normalized = [m[0], m[1], m[3], m[4], m[2]]; normalized.index = m.index; normalized.reportedAmountMmol = m[5] ? amount(m[5], m[6]) : null; products.push(normalized);
    }
    for (const m of products) {
      const parameterAmbiguities = [];
      const parameters = {}, fieldSources = {}, extraCitations = [...procedure.citations];
      for (const key of ['limitingAmountMmol', 'stoichiometricFactor', 'molarMassGmol']) {
        const local = explicit[key], inherited = key !== 'molarMassGmol' && !procedure.overrides ? procedure.method?.parameters[key] ?? [] : [];
        const source = local.length ? local : inherited;
        if (source.length > 1) parameterAmbiguities.push('multiple_' + key);
        parameters[key] = source.length === 1 ? source[0].value : null;
        fieldSources[key] = { origin: local.length ? 'local_explicit' : inherited.length ? 'referenced_general_method' : 'not_found', citations: source.map(x => x.citation) };
        extraCitations.push(...source.map(x => x.citation));
        if (methodUser?.[key] !== undefined && !local.length && !procedure.overrides) { parameters[key] = String(methodUser[key]); fieldSources[key] = { origin: 'explicit_user_method_interpretation', citations: methodUser.citations }; extraCitations.push(...methodUser.citations); }
      }
      const formula = massSources(doc, b, m[1]);
      if (!parameters.molarMassGmol && formula.candidates.length === 1 && !formula.candidates[0].conditional) { parameters.molarMassGmol = formula.candidates[0].molarMassGmol; fieldSources.molarMassGmol = { origin: 'neutral_formula_calculation', calculation: formula.candidates[0], citations: formula.citations }; }
      const ambiguous = [...parameterAmbiguities];
      if (Object.values(explicit).some(x => x.length > 1) || products.length !== 1) ambiguous.push('multiple_products_or_parameters');
      if (isComplex(m.index, m.index + m[0].length)) ambiguous.push('explicit_local_purity_assay_or_multistep_context');
      if (localBases.length > 1) ambiguous.push('multiple_local_one_equivalent_reagents');
      const citations = [cite(b, m.index, m.index + m[0].length)];
      add(doc, b, 'yield', { productMassMg: mass(m[2], m[3]), productAmountMmol: m.reportedAmountMmol ?? null, reportedYieldPercent: m[4], ...parameters }, citations,
        { entity: m[1], grouping: 'one_product_with_explicit_method_reference', reportedProductAmountMmol: m.reportedAmountMmol ?? null, method: procedure.label, methodLinked: !!procedure.method, methodDocumentId: procedure.method?.documentId, methodSourceSha256: procedure.method?.sourceSha256, methodHeadingBlockId: procedure.method?.heading.blockId, methodOverridden: procedure.overrides }, ambiguous,
        { baseline, massCandidates: formula.candidates, citations: [...extraCitations, ...formula.citations, ...(baseline ? [baseline.citation] : [])], problems: [...procedure.problems, ...(!m.reportedAmountMmol ? formula.problems : [])], fieldSources, blockCalculation: !!procedure.method?.conflict });
    }
  }
  const gapCounts = {};
  for (const r of records) for (const g of r.gaps) gapCounts[g.type] = (gapCounts[g.type] ?? 0) + 1;
  return { records, issues, methods, coverage: { extracted: records.length, checked: records.filter(r => r.calculation).length, conditional: records.filter(r => r.conditionalCalculations.length).length, insufficient: records.filter(r => r.status === 'insufficient').length, gapCounts, contextDecisions: contexts.length, staleContextDecisions: contexts.filter(c => !documents.some(d => d.id === c.documentId && d.sha256 === c.sourceSha256)).length, scope: 'Local numeric groups and explicitly referenced general methods. Confirmed inputs and conditional hypotheses are separated; m/z is never used as molar mass.' } };
}
