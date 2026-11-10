import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNmr } from '../src/nmr.js';
import { checkHrms } from '../src/hrms.js';
const docs = (...texts) => [{ id: 'doc', role: 'si', blocks: texts.map((text, i) => ({ id: `b${i}`, text, locator: { label: `paragraph ${i}` } })) }];
const run = (...texts) => { const d = docs(...texts); return checkNmr(d, checkHrms(d).records); };

test('complete proton integration equals formula; carbon symmetry is not an error', () => {
  const r = run('Compound 3a: molecular formula: C6H6. 1H NMR (400 MHz) δ 7.20 (s, 6H). 13C NMR (100 MHz) δ 128.0.');
  assert.equal(r.records.length, 2); assert.equal(r.issues.length, 0); assert.equal(r.coverage.comparedRecords, 2);
});
test('proton excess and deficit are review candidates with exact citations', () => {
  for (const count of [5, 7]) {
    const text = `Compound 3a: molecular formula: C6H6. 1H NMR δ 7.20 (s, ${count}H).`;
    const r = run(text); assert.equal(r.issues[0].evidenceStatus, 'needs_review');
    assert.deepEqual(r.issues[0].calculation.expectedCounts, [6]);
    for (const c of r.issues[0].citations) assert.equal(text.slice(c.start, c.end), c.quote);
  }
});
test('incomplete integration never substitutes partial sum', () => {
  const r = run('Compound 3a: formula: C2H6O; 1H NMR δ 3.2 (q, J = 7 Hz, 2H), 1.1 (t), 2.0 (s, 1H).');
  assert.equal(r.records[0].status, 'insufficient'); assert.equal(r.records[0].count, undefined);
});
test('range integrated once and decimal J excluded', () => {
  const r = run('Compound 3a: formula: C2H6O; 1H NMR δ 3.2–3.5 (m, 2H), 1.1 (t, J = 7.1 Hz, 3H), 2.0 (s, 1H).');
  assert.equal(r.records[0].count, 6); assert.equal(r.issues.length, 0);
});
test('13C multiplet once and 2C annotations count atoms, no equality assumption', () => {
  const r = run('Compound 3a: formula: C2H6O; 13C NMR δ 60.0 (d, J = 30 Hz), 20.0 (2C).');
  assert.equal(r.records[0].count, 3); assert.equal(r.issues[0].evidenceStatus, 'needs_review');
});
test('analytical continuations join only under an explicit compound record', () => {
  const r = run('Compound 3a:', '1H NMR δ 1.0 (s, 6H).', 'HRMS calcd for ion formula C2H7O [M+H]+ 47.0491; found 47.0491.');
  assert.deepEqual(r.records[0].expectedCounts, [6]); assert.equal(r.records[0].status, 'compatible_count_only');
  const unbound = run('1H NMR δ 1.0 (s, 6H).', 'molecular formula: C2H6O');
  assert.equal(unbound.records[0].status, 'insufficient');
});
test('ambiguous HRMS formula retains both neutral atom counts', () => {
  const r = run('Compound 3a: 1H NMR δ 1.0 (s, 6H). HRMS calcd for C2H7O [M+H]+ 47.0491; found 47.0491.');
  assert.deepEqual(r.records[0].expectedCounts, [7, 6]); assert.equal(r.records[0].status, 'ambiguous');
});
test('neighboring compounds and unknown paragraphs cannot donate formulas', () => {
  const r = run('Compound 3a: 1H NMR δ 1.0 (s, 6H). Compound 3b: formula: C2H6O;');
  assert.equal(r.records[0].status, 'insufficient');
  const interrupted = run('Compound 3a:', 'Unrelated procedure.', '1H NMR δ 1.0 (s, 6H).', 'formula: C2H6O');
  assert.equal(interrupted.records[0].status, 'insufficient');
});
test('unicode formula and NMR headers, deuterium not counted as 1H', () => {
  const r = run('Compound 3a: 分子式：C₂H₃D₃O; ¹H NMR δ 1.0 (s, 3H).');
  assert.deepEqual(r.records[0].expectedCounts, [3]); assert.equal(r.issues.length, 0);
});
test('separate NMR experiments are not summed together', () => {
  const r = run('Compound 3a: formula: C2H6O; 1H NMR (CDCl3) δ 1.0 (s, 6H). 1H NMR (DMSO) δ 2.0 (s, 6H).');
  assert.equal(r.records.length, 2); assert.equal(r.issues.length, 0);
});
