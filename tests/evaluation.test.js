import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePredictions } from '../src/evaluation.js';
test('abstentions cannot inflate recall or hide unknown labels', () => {
  const r = evaluatePredictions([{ expected: 'positive', observed: 'positive' }, { expected: 'positive', observed: 'abstain' }, { expected: 'negative', observed: 'positive' }, { expected: 'negative', observed: 'negative' }, { expected: 'unknown', observed: 'abstain' }, { expected: 'unknown', observed: 'negative' }]);
  assert.equal(r.recallIncludingAbstentions, 0.5); assert.equal(r.precision, 0.5); assert.equal(r.decisionCoverageOnKnownCases, 0.75); assert.equal(r.unknownAbstentions, 1); assert.equal(r.definitiveOnUnknown, 1);
  assert.equal(evaluatePredictions([]).precision, null);
});
