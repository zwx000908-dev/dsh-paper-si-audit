import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExperiment, checkExperimentalMath } from '../src/experimental-math.js';
const docs = text => [{ id: 'd', blocks: [{ id: 'b', text }] }];
test('yield uses declared stoichiometry and molar mass, 48 mg gives 80 percent', () => {
  const r = calculateExperiment({ kind: 'yield', limitingAmountMmol: '0.20', productMassMg: '48', molarMassGmol: '300', stoichiometricFactor: 1, reportedYieldPercent: 90 });
  assert.equal(r.calculated, '80'); assert.equal(r.status, 'needs_review');
  assert.equal(calculateExperiment({ ...r.input, stoichiometricFactor: 2, reportedYieldPercent: 40 }).status, 'compatible_with_tolerance');
  assert.throws(() => calculateExperiment({ ...r.input, stoichiometricFactor: undefined }), /Missing/);
});
test('mass and solution concentration use explicit units, never HRMS m/z', () => {
  assert.equal(calculateExperiment({ kind: 'mass_amount', massMg: 60, amountMmol: 0.2, molarMassGmol: 300 }).status, 'compatible_with_tolerance');
  assert.equal(calculateExperiment({ kind: 'concentration', concentrationM: 0.1, volumeMl: 2, amountMmol: 2 }).calculated, '0.2');
  assert.throws(() => calculateExperiment({ kind: 'mass_amount', massMg: 60, amountMmol: 0.2, mz: 301 }), /Unknown/);
});
test('source extraction preserves exact quotes, normalized units and compound boundaries', () => {
  const text = 'Compound 3a: limiting_amount: 200 umol; product_mass: 0.048 g; molar_mass: 300 g/mol; stoichiometric_factor: 1; isolated_yield: 90%. Compound 3b: mass: 60 mg; amount: 0.20 mmol; MW: 300 g/mol.';
  const r = checkExperimentalMath(docs(text)); assert.equal(r.coverage.checked, 2); assert.equal(r.issues.length, 1); assert.equal(r.records[0].calculation.calculated, '80');
  for (const c of r.issues[0].citations) assert.equal(text.slice(c.start, c.end), c.quote);
});
test('missing or repeated values and nonfinite settings do not invent a complete calculation', () => {
  const r = checkExperimentalMath(docs('Compound 3a: product_mass: 48 mg; isolated_yield: 90%; Compound 3b: limiting_amount: 0.2 mmol; MW: 300 g/mol; stoichiometric_factor: 1;'));
  assert.equal(r.coverage.checked, 0); assert.ok(r.coverage.insufficient >= 1);
  assert.throws(() => calculateExperiment({ kind: 'concentration', concentrationM: Infinity, volumeMl: 1, amountMmol: 1 }), /Invalid/);
});
