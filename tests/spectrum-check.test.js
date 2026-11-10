import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpectrumLabels, checkSpectrumReadings, validateSpectrumFields } from '../src/spectrum-check.js';
import { checkNmr } from '../src/nmr.js';
import { buildCompoundRegistry } from '../src/compounds.js';
import { validateScientificConfig } from '../src/scientific-config.js';
const documents = [{ id: 'd', role: 'si', sha256: 'source', blocks: [{ id: 'b', text: 'Compound 3a: formula: C2H6O; 1H NMR (400 MHz, CDCl3) δ 3.8 (s, 3H), 1.0 (s, 3H).', locator: { label: 'p1' } }] }];
test('explicit spectrum labels parsed; bare plot numbers never become integrals', () => {
  const p = parseSpectrumLabels('Compound 3a 1H NMR 400 MHz CDCl3\n3.00 2.00 7.26 0.00'); assert.equal(p.fields.integralSum, undefined); assert.equal(p.fields.frequencyMHz, 400);
  const ambiguous = parseSpectrumLabels('1H NMR 400 MHz 13C NMR 100 MHz'); assert.equal(ambiguous.fields.nucleus, undefined); assert.equal(ambiguous.ambiguousFields.length, 2);
});
test('metadata, explicit integral total and per-peak disagreement are review candidates', () => {
  const nmr = checkNmr(documents), registry = buildCompoundRegistry(documents, { nmrRecords: nmr.records });
  const asset = { id: 'a', sha256: 'raster', sourceSha256: 'imageSource' };
  const reading = { id: 'r', recordId: registry.records[0].id, assetId: 'a', rasterSha256: 'raster', sourceSha256: 'imageSource', fields: { nucleus: '1H', compoundLabel: '3b', frequencyMHz: 500, solvent: 'DMSOD6', integralSum: 5, peaks: [{ shift: 3.8, integral: 2 }] }, review: { status: 'needs_review' } };
  const r = checkSpectrumReadings([reading], registry, nmr.records, [asset], validateScientificConfig());
  assert.equal(r.issues[0].evidenceStatus, 'needs_review'); assert.equal(r.records[0].differences.length, 5); assert.equal(r.coverage.provisionalReadings, 1);
  assert.equal(checkSpectrumReadings([reading], registry, nmr.records, [], validateScientificConfig()).coverage.stale.length, 1);
});
test('correction validation and rejected transcription remain explicit', () => {
  assert.throws(() => validateSpectrumFields({ integralSum: Infinity }), /Invalid/);
  assert.throws(() => validateSpectrumFields({ peaks: [{ shift: '3.8' }] }), /Invalid/);
  assert.equal(checkSpectrumReadings([{ id: 'r', review: { status: 'rejected' } }], { records: [] }, [], [], validateScientificConfig()).coverage.rejected.length, 1);
});
test('no observed fields cannot be called compatible, even with one text spectrum', () => {
  const nmr = checkNmr(documents), registry = buildCompoundRegistry(documents, { nmrRecords: nmr.records });
  const r = checkSpectrumReadings([{ id: 'r', recordId: registry.records[0].id, assetId: 'a', rasterSha256: 'raster', sourceSha256: 'source', fields: {} }], registry, nmr.records, [{ id: 'a', sha256: 'raster', sourceSha256: 'source' }], validateScientificConfig());
  assert.equal(r.records[0].status, 'insufficient'); assert.equal(r.issues[0].evidenceStatus, 'insufficient');
});
