export const IMAGE_RULE_VERSION = 'typed-v1';
export const IMAGE_TYPES = Object.freeze(['unknown', 'mixed_page', 'spectrum', 'chart', 'table', 'reaction_scheme', 'microscopy', 'blot', 'photograph']);
const exactOnly = { whole: false, local: false, transforms: false };
export const IMAGE_TYPE_RULES = Object.freeze(Object.fromEntries(IMAGE_TYPES.map(type => [type, Object.freeze(
  ['microscopy', 'photograph'].includes(type) ? { whole: true, local: true, transforms: true } :
  type === 'blot' ? { whole: true, local: true, transforms: false } : exactOnly
)])));
export function imageType(asset) { return IMAGE_TYPES.includes(asset.imageType?.type) ? asset.imageType.type : 'unknown'; }
export function imagePolicy(a, b = a, options = {}) {
  const types = [imageType(a), imageType(b)], rules = types.map(t => ({ ...IMAGE_TYPE_RULES[t], ...(options.imageTypeRules?.[t] ?? {}) }));
  const sameType = types[0] === types[1];
  return { version: IMAGE_RULE_VERSION, types, exact: true,
    whole: sameType && rules.every(r => r.whole), local: sameType && !!options.localImages && rules.every(r => r.local),
    transforms: rules.every(r => r.transforms),
    imageRmse: Math.min(...rules.map(r => r.imageRmse ?? options.imageRmse ?? .1)),
    localImageRmse: Math.min(...rules.map(r => r.localImageRmse ?? options.localImageRmse ?? .08)),
    basis: sameType ? 'type_specific_rules' : 'different_types_exact_only',
    note: 'Exact reuse is reported for every type. Plot axes, reaction drawings, tables, mixed pages and unknown images default to exact-only; non-exact content needs panel/trace review. No misconduct inference.' };
}
export function validateImageTypeRules(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('imageTypeRules must be an object');
  const result = {};
  for (const [type, rule] of Object.entries(input)) {
    if (!IMAGE_TYPES.includes(type) || !rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Unknown image type or invalid rule');
    if (Object.keys(rule).some(k => !['whole', 'local', 'transforms', 'imageRmse', 'localImageRmse'].includes(k))) throw new Error('Unknown image type rule field');
    for (const key of ['whole', 'local', 'transforms']) if (rule[key] !== undefined && typeof rule[key] !== 'boolean') throw new Error('Image rule flags must be boolean');
    for (const key of ['imageRmse', 'localImageRmse']) if (rule[key] !== undefined && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]) || rule[key] < .001 || rule[key] > (key === 'imageRmse' ? .5 : .3))) throw new Error('Invalid image type threshold');
    result[type] = { ...rule };
  }
  return result;
}
