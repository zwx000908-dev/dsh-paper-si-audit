import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExperimentalProse } from '../src/experimental-prose.js';
import { calculateExperiment } from '../src/experimental-math.js';
import { calculateMolarMass } from '../src/molar-mass.js';
const doc = (...text) => ({ id: 'd', sha256: 'sha', role: 'si', blocks: text.map((text, i) => ({ id: 'b' + i, text })) });
const product = 'Following the general procedure A, the product 3a was obtained in 86% yield (51.3 mg, 0.171 mmol) as a pure yellow oil.';
const method = 'The limiting substrate 1a (0.20 mmol) was used; stoichiometric factor is 1. Stirred in solvent.';
const yieldRecord = r => r.records.find(r => r.kind === 'yield');
test('molar yield and zero product need no molar mass; ratio remains required', () => {
  const input = { kind: 'molar_yield', limitingAmountMmol: '.2', productAmountMmol: '.171', stoichiometricFactor: 1, reportedYieldPercent: 86 };
  assert.equal(calculateExperiment(input).calculated, '85.5'); assert.equal(calculateExperiment(input).status, 'compatible_with_tolerance');
  assert.equal(calculateExperiment({ ...input, productAmountMmol: 0, reportedYieldPercent: 0 }).calculated, '0');
  assert.throws(() => calculateExperiment({ ...input, stoichiometricFactor: undefined }));
  assert.equal(calculateExperiment({ ...input, stoichiometricFactor: 2 }).calculated, '42.75');
});
test('general method supplies explicit yield basis with exact cross-paragraph evidence', () => {
  const d = doc('General procedure A', method, product), r = yieldRecord(checkExperimentalProse([d]));
  assert.equal(r.calculation.kind, 'molar_yield'); assert.equal(r.calculation.calculated, '85.5'); assert.equal(r.status, 'compatible_with_tolerance'); assert.ok(!r.missing.includes('molarMassGmol')); assert.equal(r.context.methodLinked, true);
  for (const c of r.citations) assert.equal(d.blocks.find(b => b.id === c.blockId).text.slice(c.start, c.end), c.quote);
});
test('1 equiv and implicit stoichiometry produce only an explicit conditional scenario', () => {
  const d = doc('General procedure A', 'Substrate 1 (0.20 mmol, 1.0 equiv.) and reagent 2 (0.30 mmol, 1.5 equiv.) in solvent were stirred for one hour.', product);
  const r = yieldRecord(checkExperimentalProse([d])); assert.equal(r.status, 'conditional'); assert.equal(r.calculation, undefined); assert.equal(r.input.limitingAmountMmol, null);
  assert.equal(r.conditionalCalculations[0].calculation.calculated, '85.5'); assert.equal(r.conditionalCalculations[0].assumptions.length, 2); assert.ok(r.gaps.some(g => g.type === 'ambiguous')); assert.ok(r.gaps.some(g => g.type === 'not_found_in_checked_scope'));
});
test('unknown or duplicate methods, modified scale and local overrides do not inherit blindly', () => {
  const unknown = yieldRecord(checkExperimentalProse([doc(product)])); assert.ok(unknown.gaps.some(g => g.type === 'not_linked'));
  const duplicate = yieldRecord(checkExperimentalProse([doc('General procedure A', method, 'General procedure A', method, product)])); assert.equal(duplicate.context.methodLinked, false);
  const modified = yieldRecord(checkExperimentalProse([doc('General procedure A', method, product.replace('procedure A', 'procedure A on a doubled scale'))])); assert.equal(modified.calculation, undefined);
  const local = yieldRecord(checkExperimentalProse([doc('General procedure A', method, product + ' Substrate (0.50 mmol, 1.0 equiv.).')])); assert.equal(local.calculation, undefined); assert.equal(local.conditionalCalculations[0].calculation.calculated, '34.2');
});
test('contradictory amount/equivalent method is not resolved by choosing matching yield', () => {
  const r = yieldRecord(checkExperimentalProse([doc('General procedure A', method + ' Substrate (0.20 mmol, 1.0 equiv.) and reagent (3.0 mmol, 1.5 equiv.).', product)]));
  assert.equal(r.status, 'conditional'); assert.ok(r.gaps.some(g => g.code === 'method_amount_equivalent_conflict'));
});
test('concentration can use explicit same-paragraph basis, otherwise shows conditional 1-equiv reference', () => {
  const a = checkExperimentalProse([doc('The limiting substrate 1a (0.20 mmol) was stirred in DCM (1.0 mL, 0.2 M) based on the limiting substrate.')]).records[0];
  assert.equal(a.status, 'compatible_with_tolerance'); assert.equal(a.input.amountMmol, '0.2');
  const b = checkExperimentalProse([doc('Substrate 1a (0.20 mmol, 1 equiv.) in DCM (1.0 mL, 0.2 M) gave the pure product.')]).records[0]; assert.equal(b.status, 'conditional'); assert.equal(b.conditionalCalculations[0].calculation.calculated, '0.2');
});
test('pure product is not a purity problem; actual purity and aliquot remain flagged', () => {
  const a = yieldRecord(checkExperimentalProse([doc('General procedure A', method, product)])); assert.equal(a.ambiguous.length, 0);
  for (const suffix of [' Purity 90%.', ' An aliquot was taken.']) assert.equal(yieldRecord(checkExperimentalProse([doc('General procedure A', method, product + suffix)])).status, 'insufficient');
});
test('standard-composition molar mass supports neutral salts/hydrates, rejects charge/isotope/unsupported atoms', () => {
  assert.equal(calculateMolarMass('C2H6O').molarMassGmol, '46.069'); assert.equal(calculateMolarMass('NaCl').molarMassGmol, '58.44'); assert.equal(calculateMolarMass('CuSO4·5H2O').molarMassGmol, '249.677');
  for (const f of ['C2H7O+', '[13C]H4', 'Xe']) assert.throws(() => calculateMolarMass(f));
  assert.equal(calculateExperiment({ kind: 'molar_mass', neutralFormula: 'C2H6O' }).molarMassGmol, '46.069');
});
test('product formula links to local product mass, never a neighboring reagent or MS number', () => {
  const r = checkExperimentalProse([doc('The product 3a was obtained in 86% yield (92.14 mg, 2 mmol). Molecular formula: C2H6O.')]);
  assert.equal(r.records.find(r => r.kind === 'mass_amount').status, 'compatible_with_tolerance');
  const x = checkExperimentalProse([doc('Substrate (400 mg, 2 mmol, MW 200 g/mol, neutral formula: C2H6O).')]).records[0]; assert.ok(x.ambiguous.includes('explicit_molar_mass_conflicts_with_neutral_formula'));
});
test('ambiguous MS formula gives average-mass candidates without selecting closest interpretation', () => {
  const r = checkExperimentalProse([doc(product + ' EI-MS: calculated C18H22NO3 [M+H]+ 300.1600; Found 300.1605.')]);
  const x = r.records.find(r => r.kind === 'mass_amount'); assert.equal(x.status, 'conditional'); assert.equal(x.massCandidates.length, 2); assert.equal(x.calculation, undefined); assert.ok(x.massCandidates.every(c => c.molarMassGmol !== '300.1600')); assert.ok(x.gaps.some(g => g.type === 'ambiguous'));
});
test('numeric-only product labels remain valid identities for local formula and yield', () => {
  const r = checkExperimentalProse([doc('The product 7 was obtained in 80% yield (92.14 mg, 2 mmol). Molecular formula: C2H6O.')]);
  assert.equal(r.records.find(r => r.kind === 'mass_amount').entity, '7'); assert.equal(r.records.find(r => r.kind === 'mass_amount').status, 'compatible_with_tolerance'); assert.equal(r.records.find(r => r.kind === 'yield').entity, '7');
});
