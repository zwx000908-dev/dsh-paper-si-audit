export const SCIENTIFIC_DEFAULTS = Object.freeze({ nmrIntegralTolerance: 0.05, nmrShiftTolerance: 0.03, frequencyToleranceMHz: 1, yieldTolerancePercent: 1, amountRelativeTolerance: 0.02, imageRmse: 0.10, localImageRmse: 0.08, maxImageAssets: 1000, imagePairBudget: 2000, localImages: true });
export function validateScientificConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in SCIENTIFIC_DEFAULTS))) throw new Error('Unknown scientific configuration field');
  const result = { ...SCIENTIFIC_DEFAULTS, ...input };
  const bounds = { nmrIntegralTolerance: [0, 2], nmrShiftTolerance: [0, 5], frequencyToleranceMHz: [0, 100], yieldTolerancePercent: [0, 20], amountRelativeTolerance: [0, 0.5], imageRmse: [0.001, 0.5], localImageRmse: [0.001, 0.3], maxImageAssets: [1, 5000], imagePairBudget: [1, 100000] };
  for (const [key, [min, max]] of Object.entries(bounds)) if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max || (['maxImageAssets', 'imagePairBudget'].includes(key) && !Number.isInteger(result[key]))) throw new Error(`Invalid scientific setting ${key}`);
  if (typeof result.localImages !== 'boolean') throw new Error('localImages must be boolean');
  return result;
}
