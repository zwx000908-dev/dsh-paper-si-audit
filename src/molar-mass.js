import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { parseFormula } from './hrms.js';
const data = JSON.parse(readFileSync(new URL('./average-weights.json', import.meta.url), 'utf8'));
const D = Decimal.clone({ precision: 40 });
export function calculateMolarMass(formula) {
  const p = parseFormula(formula);
  if (p.charge) throw new Error('An explicit electrically neutral molecular or full salt/hydrate formula is required');
  let sum = new D(0);
  for (const [element, count] of Object.entries(p.counts)) {
    if (!data.weights[element]) throw new Error(`Unsupported standard atomic weight or isotope: ${element}`);
    sum = sum.plus(new D(data.weights[element]).times(count));
  }
  return { formula: p.formula, molarMassGmol: sum.toString(), counts: p.counts, datasetVersion: data.version, source: data.source, checkedAt: data.checkedAt, meaning: 'Approximate standard-composition molar mass of exactly the supplied formula; no automatic counterion, hydrate, purity or isotope correction.' };
}
