import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompoundRegistry, validateRequirements, validateCompoundDecision } from '../src/compounds.js';
const docs = [{ id: 'd', sha256: 'hash', role: 'si', name: 'si.txt', blocks: [{ id: 'b1', text: 'Compound 3a: 1H NMR δ 1.0 (s, 6H).', locator: { label: 'p1' } }, { id: 'b2', text: 'Compound 3b: HRMS calcd for C2H7O [M+H]+ 47.0491.', locator: { label: 'p2' } }] }];
const checklist = { name: 'lab', version: '1', source_type: 'user_defined', rules: [{ classification: 'new', allOf: ['h1_text', 'c13_text'], anyOf: [['hrms_text', 'elemental_analysis']] }] };
test('dossiers preserve candidate identity and do not invent mandatory requirements', () => {
  const r = buildCompoundRegistry(docs); assert.equal(r.compounds.length, 2); assert.equal(r.issues.length, 0);
  assert.equal(r.compounds[0].association, 'candidate'); assert.equal(r.compounds[0].materials.h1_text.status, 'located_unread');
});
test('explicit links organize evidence and alternatives create coverage concerns only', () => {
  const before = buildCompoundRegistry(docs), run = { id: 'run', compoundRegistry: before, duplicateImageAssets: [] };
  const d = validateCompoundDecision({ compoundLabel: '3a', classification: 'new', links: [{ recordId: before.records[0].id }], reason: 'user confirmed' }, run);
  const r = buildCompoundRegistry(docs, { decisions: [d], requirements: validateRequirements(checklist) });
  assert.equal(r.issues.length, 2); assert.ok(r.issues.every(i => i.evidenceStatus === 'insufficient'));
  assert.equal(r.compounds.find(c => c.label === '3a').requirements[0].status, 'located');
});
test('stale decisions cannot bind changed sources and conflicting labels stay unassigned', () => {
  const before = buildCompoundRegistry(docs), record = before.records[0];
  const d = { compoundLabel: '3a', classification: 'new', links: [{ recordId: record.id, sourceSha256: 'old' }], reason: 'old' };
  assert.equal(buildCompoundRegistry(docs, { decisions: [d] }).coverage.staleDecisions.length, 1);
  d.links[0].sourceSha256 = 'hash';
  assert.equal(buildCompoundRegistry(docs, { decisions: [d, { ...d, compoundLabel: '4a' }] }).coverage.conflictingLinks.length, 1);
});
test('journal requirements and invented evidence cannot pass validation', () => {
  assert.throws(() => validateRequirements({ ...checklist, source_type: 'official_requirement' }), /verified/);
  assert.throws(() => validateRequirements({ ...checklist, rules: [{ classification: 'new', allOf: ['guess'] }] }), /unknown/);
  assert.throws(() => validateCompoundDecision({ compoundLabel: '3a', classification: 'new', links: [{ recordId: 'fake' }], reason: 'x' }, { compoundRegistry: { records: [] } }), /evidence/);
});
