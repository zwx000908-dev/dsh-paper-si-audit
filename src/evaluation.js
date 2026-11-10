/** Abstentions remain in coverage and the all-positive recall denominator. */
export function evaluatePredictions(cases) {
  if (!Array.isArray(cases) || cases.some(c => !['positive', 'negative', 'unknown'].includes(c.expected) || !['positive', 'negative', 'abstain'].includes(c.observed))) throw new Error('Invalid evaluation labels');
  const result = { total: cases.length, truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, positiveAbstentions: 0, negativeAbstentions: 0, unknownCases: 0, unknownAbstentions: 0, definitiveOnUnknown: 0 };
  for (const c of cases) {
    if (c.expected === 'unknown') { result.unknownCases++; result[c.observed === 'abstain' ? 'unknownAbstentions' : 'definitiveOnUnknown']++; }
    else if (c.observed === 'abstain') result[c.expected === 'positive' ? 'positiveAbstentions' : 'negativeAbstentions']++;
    else result[c.expected === 'positive' ? c.observed === 'positive' ? 'truePositive' : 'falseNegative' : c.observed === 'positive' ? 'falsePositive' : 'trueNegative']++;
  }
  const divide = (a, b) => b ? a / b : null;
  return { ...result, precision: divide(result.truePositive, result.truePositive + result.falsePositive), recallIncludingAbstentions: divide(result.truePositive, result.truePositive + result.falseNegative + result.positiveAbstentions), falsePositiveRateOnDecidedNegatives: divide(result.falsePositive, result.falsePositive + result.trueNegative), decisionCoverageOnKnownCases: divide(result.truePositive + result.falsePositive + result.trueNegative + result.falseNegative, cases.length - result.unknownCases), note: 'Metrics describe only these frozen cases. Unknown labels and abstentions are reported separately; no unlabelled paper regions enter the denominator.' };
}
