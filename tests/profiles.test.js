import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfile, exampleProfile, parseProfile, validateProfile } from '../src/profiles.js';

test('default profile does not invent journal or decimal requirements', () => {
  const p = validateProfile(defaultProfile()); assert.equal(p.profile.journal, null); assert.deepEqual(p.rules, []);
});
test('profile JSON and YAML roundtrip, strict field-level formats', () => {
  const p = exampleProfile(); assert.deepEqual(parseProfile(JSON.stringify(p), 'custom.json'), p);
  const y = 'schema_version: 1\nprofile:\n  id: test\n  name: 自定义\n  version: 1.0.0\nrules:\n  - id: h1\n    field: nmr.h1.chemical_shift\n    number_format: {mode: decimal_places, digits: 4}\n';
  const q = parseProfile(y); assert.equal(q.rules[0].number_format.digits, 4); assert.equal(q.rules[0].number_format.rounding, 'half_up');
});
test('reject conflicting, unknown, scripted or malformed rules', () => {
  for (const mutate of [
    p => { p.rules[0].number_format.digits = -1; },
    p => { p.rules[0].number_format.digits = 1.5; },
    p => { p.rules[0].field = 'any_arbitrary_text'; },
    p => { p.rules[0].script = 'fetch(secret)'; },
    p => { p.rules[0].number_format.significant_figures = 3; },
    p => { p.rules.push({ ...p.rules[0], id: 'duplicate_scope' }); },
    p => { p.rules[0].expected_unit = 'banana'; },
    p => { p.rules[0].expected_unit = 'Hz'; },
    p => { p.rules[0].scope = 'unknown'; },
  ]) { const p = structuredClone(exampleProfile()); mutate(p); assert.throws(() => validateProfile(p), /格式配置无效/); }
});
test('verified provenance is necessary for journal mandatory rule', () => {
  const p = exampleProfile(); p.rules[0].requirement = 'journal_mandatory'; assert.throws(() => validateProfile(p), /已核实来源/);
  p.rules[0].source = { type: 'official_requirement', status: 'verified', url: 'https://journal.example/guide', quote: 'Example for testing, not a real journal rule', checked_at: '2026-11-09' };
  assert.equal(validateProfile(p).rules[0].source.status, 'verified');
  p.rules[0].enabled = false; assert.throws(() => validateProfile(p), /不可静默停用/);
});
test('override needs reason and rejects cycles', () => {
  const p = exampleProfile(); const base = p.rules[0];
  p.rules.push({ ...base, id: 'override', override_of: base.id }); assert.throws(() => validateProfile(p), /reason/);
  p.rules.at(-1).reason = '本项目局部约定'; assert.doesNotThrow(() => validateProfile(p));
  p.rules[0].override_of = 'override'; p.rules[0].reason = 'cycle'; assert.throws(() => validateProfile(p), /循环/);
});
test('YAML duplicate keys and aliases are rejected', () => {
  assert.throws(() => parseProfile('schema_version: 1\nschema_version: 2\n'), /无法解析/);
  assert.throws(() => parseProfile('schema_version: 1\nprofile: &p {id: x, name: x, version: 1.0.0}\nrules: [*p]\n'), /无法解析/);
});
