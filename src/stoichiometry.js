import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
const D = Decimal.clone({ precision: 40 });
const NUM = '[+\\-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+\\-]?\\d{1,3})?';
const id = parts => 'stoich_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

/** Local internal consistency check. Does not decide which amount or equivalent is correct. */
export function checkStoichiometry(documents) {
  const issues = []; let blocksChecked = 0, pairsRead = 0;
  for (const document of documents) for (const block of document.blocks ?? []) {
    // Parentheses explicitly containing an amount and an equivalent declaration only.
    // Do not combine different paragraphs/steps or implicit concentrations.
    const pattern = new RegExp(`\\(\\s*(${NUM})\\s*(mmol|[µμu]mol|mol)\\s*[,;]\\s*(${NUM})\\s*(?:equiv(?:alents?)?\\.?|eq\\.?)\\s*\\)`, 'gdi');
    const pairs = [];
    for (const match of block.text.matchAll(pattern)) {
      try {
        const amount = new D(match[1]), equivalent = new D(match[3]);
        if (!amount.isFinite() || !equivalent.isFinite() || amount.lte(0) || equivalent.lte(0) || Math.abs(amount.e) > 30 || Math.abs(equivalent.e) > 30) continue;
        const mmol = match[2] === 'mol' ? amount.times(1000) : match[2] === 'mmol' ? amount : amount.div(1000);
        pairs.push({ raw: match[0], start: match.index, end: match.index + match[0].length, amount: amount.toString(), unit: match[2], mmol, equivalent });
      } catch { /* unsupported amount is not a passing check */ }
    }
    pairsRead += pairs.length;
    if (pairs.length < 2) continue;
    blocksChecked++;
    const references = pairs.filter(p => p.equivalent.eq(1));
    // More than one distinct 1-eq baseline may represent separate scales or steps.
    if (!references.length || references.some(p => !p.mmol.eq(references[0].mmol))) continue;
    const reference = references[0];
    for (const actual of pairs) {
      if (actual === reference) continue;
      const expected = reference.mmol.times(actual.equivalent);
      const factor = actual.mmol.div(expected);
      // Conservative gross-inconsistency trigger; do not enforce exact experimental precision.
      if (factor.gte('0.8') && factor.lte('1.25')) continue;
      const baseline = { raw: reference.raw, start: reference.start, end: reference.end };
      const target = { raw: actual.raw, start: actual.start, end: actual.end };
      issues.push({ id: id([document.id, block.id, baseline.start, target.start]), type: 'data', category: 'stoichiometry', severity: 'high', evidenceStatus: 'needs_review', status: 'open', title: '同段用量与当量比例不自洽', description: '本段明确给出 1.0 equiv 基准，另一组 mmol 与 equiv 的比例与其存在显著差异。可能是用量、当量或实验规模表述错误；也可能存在未解析的分步语境，需作者确认。此检查不决定应修改哪个数字。', evidenceIds: [block.id], citations: [{ blockId: block.id, quote: baseline.raw, start: baseline.start, end: baseline.end }, { blockId: block.id, quote: target.raw, start: target.start, end: target.end }], calculation: `基准 ${reference.mmol.toString()} mmol / 1 equiv；${actual.equivalent.toString()} equiv 对应 ${expected.toString()} mmol；原文 ${actual.mmol.toString()} mmol；相差 ${factor.toString()} 倍。`, baseline, target, expectedMmol: expected.toString(), actualMmol: actual.mmol.toString(), discrepancyFactor: factor.toString(), checkScope: 'explicit_same_block_pairs_gross_consistency' });
    }
  }
  return { issues, coverage: { blocksChecked, amountEquivalentPairsRead: pairsRead, status: 'limited', threshold: 'outside 0.8–1.25 ratio; gross consistency only', note: 'Only explicit parenthesized amount/equivalent pairs in one block; absence of a flag is not stoichiometry validation.' } };
}
