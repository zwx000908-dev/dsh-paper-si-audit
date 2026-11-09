import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStoichiometry } from '../src/stoichiometry.js';
const doc = text => [{ id: 'd', role: 'si', blocks: [{ id: 'b', text, locator: { label: 'paragraph' } }] }];
test('explicit amount/equivalent conflict from reported general procedure is a cited review candidate', () => {
  const documents = doc('General procedure A: the 1 (0.20 mmol, 1.0 equiv.), 2 (3.0 mmol, 1.5 equiv.) were added.');
  const result = checkStoichiometry(documents); const issue = result.issues[0];
  assert.equal(result.issues.length, 1); assert.equal(issue.discrepancyFactor, '10'); assert.equal(issue.expectedMmol, '0.3');
  assert.equal(issue.evidenceStatus, 'needs_review'); assert.equal(issue.severity, 'high');
  for (const c of issue.citations) assert.equal(documents[0].blocks[0].text.slice(c.start, c.end), c.quote);
});
test('equivalent units and scales, rounded amounts, and distinct 1-eq baselines do not create gross errors', () => {
  assert.equal(checkStoichiometry(doc('1 (0.20 mmol, 1.0 equiv.), 2 (300 µmol, 1.5 equiv.)')).issues.length, 0);
  assert.equal(checkStoichiometry(doc('1 (0.2 mmol, 1 equiv), 2 (0.299 mmol, 1.5 equiv)')).issues.length, 0);
  assert.equal(checkStoichiometry(doc('first (0.20 mmol, 1 equiv), second (3.0 mmol, 1 equiv)')).issues.length, 0);
});
test('no implicit conversion of concentration or cross-block experiments and hostile numeric exponents', () => {
  const documents = [{ id: 'd', blocks: [{ id: 'a', text: '1 (0.20 mmol, 1 equiv)' }, { id: 'b', text: '2 (3 mmol, 1.5 equiv)' }] }];
  assert.equal(checkStoichiometry(documents).issues.length, 0);
  assert.equal(checkStoichiometry(doc('1 (0.2 M, 1 equiv), 2 (3 mmol, 1.5 equiv)')).issues.length, 0);
  assert.equal(checkStoichiometry(doc('1 (1e999 mmol, 1 equiv), 2 (1 mmol, 2 equiv)')).issues.length, 0);
});
