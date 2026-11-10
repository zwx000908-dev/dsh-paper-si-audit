import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExperimentalProse } from '../src/experimental-prose.js';
const run = text => checkExperimentalProse([{ id: 'd', blocks: [{ id: 'b', text }] }]);
test('natural product clause, declared limiting reagent and stoichiometry reproduce yield', () => {
  const text = 'The limiting reagent 1a (0.20 mmol) was used; the product molar mass is 300 g/mol and the stoichiometric factor is 1. Purification afforded 3a (48 mg, 90% yield).';
  const r = run(text), y = r.records.find(r => r.kind === 'yield'); assert.equal(y.calculation.calculated, '80'); assert.equal(y.status, 'needs_review');
  for (const c of y.citations) assert.equal(text.slice(c.start, c.end), c.quote);
});
test('reagent groups do not borrow molecular weights and 1 equiv does not imply limiting', () => {
  const r = run('Substrate 1a (32 mg, 0.2 mmol, 1 equiv) and catalyst (2 mg, 0.01 mmol, MW 200 g/mol) afforded 3a (48 mg, 80%).');
  const amounts = r.records.filter(r => r.kind === 'mass_amount'); assert.equal(amounts.length, 2); assert.equal(amounts[0].status, 'insufficient'); assert.equal(amounts[1].status, 'compatible_with_tolerance');
  const y = r.records.find(r => r.kind === 'yield'); assert.ok(y.missing.includes('limitingAmountMmol')); assert.ok(y.missing.includes('stoichiometricFactor')); assert.ok(y.missing.includes('molarMassGmol'));
});
test('concentration units convert locally; multiple values and purity cause abstention', () => {
  assert.equal(run('Reagent (100 mM, 2 mL, 0.3 mmol).').records[0].status, 'needs_review');
  assert.equal(run('Reagent (0.1 M, 2000 uL, 0.2 mmol).').records[0].status, 'compatible_with_tolerance');
  assert.equal(run('Reagent (100 mM, 200 mM, 2 mL, 0.2 mmol).').records[0].status, 'insufficient');
  assert.equal(run('The solution of reagent (100 mM, 2 mL, 0.2 mmol), purity 90%.').records[0].status, 'insufficient');
});
test('obtained-in-yield prose retains product identity and mmol without borrowing general method', () => {
  const r = run('Following general procedure A, the product 3a was obtained in 86% yield (51.3 mg, 0.171 mmol) as a yellow oil. EI-MS: calculated C18H22NO3 [M+H]+ 300.1600.');
  const y = r.records.find(r => r.kind === 'yield'); assert.equal(y.entity, '3a'); assert.equal(y.input.productMassMg, '51.3'); assert.equal(y.context.reportedProductAmountMmol, '0.171'); assert.equal(y.status, 'insufficient'); assert.equal(y.input.molarMassGmol, null);
  assert.equal(r.records.find(r => r.kind === 'mass_amount').impliedMolarMassGmol, '300');
});
