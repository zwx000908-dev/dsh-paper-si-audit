import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDocuments, extractFacts, AUDIT_LIMITS } from '../src/engine.js';
import { defaultProfile, exampleProfile } from '../src/profiles.js';

function doc(text, id = 'main', metadata) { return { id, name: `${id}.txt`, role: id === 'main' ? 'main' : 'si', format: 'txt', sha256: id, blocks: [{ id: `${id}:b1`, text, locator: { label: 'line 1' }, ...(metadata ? { metadata } : {}) }], coverage: { status: 'complete', totalUnits: 1, parsedUnits: 1, warnings: [] } }; }
function profileFor(field, digits, rounding = 'half_up', mode = 'decimal_places') { const p = defaultProfile(); p.rules = [{ id: 'custom', field, scope: 'all', number_format: { mode, digits, rounding } }]; return p; }

test('explicit same experiment and isolated yield basis confirms difference and preserves exact source spans', () => {
  const docs = [doc('compound=3a; experiment=E1; batch=B1; isolated yield=92%'), doc('compound=3a; experiment=E1; batch=B1; isolated yield=80%', 'si')];
  const result = auditDocuments(docs); assert.equal(result.issues.filter(x => x.type === 'data').length, 1);
  assert.equal(result.issues.find(x => x.type === 'data').evidenceStatus, 'confirmed_difference');
  for (const f of result.facts) { const b = docs.find(d => d.id === f.documentId).blocks.find(x => x.id === f.blockId); assert.equal(b.text.slice(f.offset, f.end), f.raw); }
  assert.deepEqual(auditDocuments(docs).issues.map(x => x.id), result.issues.map(x => x.id));
});
test('compound number alone cannot establish experiment identity; different batches and yield bases are excluded', () => {
  const result = auditDocuments([doc('Compound 3a: isolated yield=92%'), doc('Compound 3a: isolated yield=80%', 'si')]);
  assert.equal(result.issues.filter(x => x.type === 'data').length, 0); assert.equal(result.issues.filter(x => x.type === 'alignment').length, 1);
  const batch = auditDocuments([doc('compound=3a; batch=B1; isolated yield=92%'), doc('compound=3a; batch=B2; isolated yield=80%', 'si')]);
  assert.equal(batch.issues.length, 0); assert.equal(batch.coverage.skippedDifferentIdentity, 1);
  const method = auditDocuments([doc('compound=3a; experiment=E1; isolated yield=92%'), doc('compound=3a; experiment=E1; NMR yield=80%', 'si')]);
  assert.equal(method.issues.filter(x => x.type === 'data' || x.type === 'alignment').length, 0);
});
test('conditions mismatch prevents definitive outcome conflict', () => {
  const result = auditDocuments([doc('compound=3a; experiment=E1; conditions=blue; isolated yield=92%'), doc('compound=3a; experiment=E1; conditions=red; isolated yield=80%', 'si')]);
  assert.equal(result.issues.find(x => x.type === 'alignment')?.evidenceStatus, 'needs_review');
  const scale = auditDocuments([doc('compound=3a; experiment=E1; scale=0.1 mmol; isolated yield=92%'), doc('compound=3a; experiment=E1; scale=1 mmol; isolated yield=80%', 'si')]);
  assert.equal(scale.issues.find(x => x.title.startsWith('yield.percent'))?.type, 'alignment');
});
test('structured table headers carry experiment identity and numeric offsets', () => {
  const make = (y, id) => { const texts = ['3a', 'E1', 'B1', y, 'isolated']; return doc(texts.join('\t'), id, { cells: ['compound', 'experiment', 'batch', 'yield (%)', 'method'].map((header, i) => ({ column: i + 1, header, text: texts[i] })) }); };
  const result = auditDocuments([make('92', 'main'), make('80', 'si')]); assert.equal(result.issues.filter(x => x.type === 'data').length, 1);
  assert.equal(result.facts[0].raw, '92'); assert.equal(result.facts[0].method, 'isolated');
});
test('er to ee conversion is exact and does not interpret er as ee', () => {
  const result = auditDocuments([doc('compound=3a; experiment=E1; ee=98%'), doc('compound=3a; experiment=E1; er=98:2', 'si')]);
  const i = result.issues.find(x => x.title === 'ee 与 er 报告不一致'); assert.ok(i); assert.match(i.calculation, /96/);
  const equal = auditDocuments([doc('compound=3a; experiment=E1; ee=96%'), doc('compound=3a; experiment=E1; er=98:2', 'si')]); assert.equal(equal.issues.length, 0);
});
test('display rounding and equivalent units do not become data conflicts', () => {
  const r = auditDocuments([doc('compound=3a; experiment=E1; isolated yield=94.6%; time=1 h; temperature=25 °C'), doc('compound=3a; experiment=E1; isolated yield=95%; time=60 min; temperature=298.15 K', 'si')]);
  assert.equal(r.issues.length, 0); assert.equal(r.coverage.roundingCompatiblePairs, 1);
});
test('inequality is preserved and not mechanically reformatted', () => {
  const r = auditDocuments([doc('compound=3a; experiment=E1; ee=<0.001%', 'si')], profileFor('stereo.ee', 2));
  assert.equal(r.facts[0].comparator, '<'); assert.equal(r.facts[0].raw, '0.001');
  const i = r.issues.find(x => x.type === 'format'); assert.equal(i.evidenceStatus, 'needs_review'); assert.equal(i.suggestion, undefined);
});
test('NMR chemical shifts exclude frequency, J and integrals; HRMS is distinct', () => {
  const d = doc('Compound 3a: 1H NMR (400 MHz, CDCl3) δ 7.26 (d, J = 8.55 Hz, 2H), 3.123 (s, 3H); 13C NMR (101 MHz, CDCl3) δ 128.12345, 55.1; HRMS (ESI) calcd for C10H13O [M+H]+ 149.0966; found 149.0967', 'si');
  const f = extractFacts(d); assert.deepEqual(f.filter(x => x.field === 'nmr.h1.chemical_shift').map(x => x.raw), ['7.26', '3.123']);
  assert.deepEqual(f.filter(x => x.field === 'nmr.coupling_constant').map(x => x.raw), ['8.55']);
  assert.deepEqual(f.filter(x => x.field === 'nmr.c13.chemical_shift').map(x => x.raw), ['128.12345', '55.1']);
  assert.deepEqual(f.filter(x => x.field === 'hrms.mass_to_charge').map(x => x.raw), ['149.0966', '149.0967']);
  for (const x of f) assert.equal(d.blocks[0].text.slice(x.offset, x.end), x.raw);
});
test('decimal rounding modes and significant figures have reproducible previews', () => {
  const source = doc('1H NMR (400 MHz, CDCl3) δ 1.235 (s, 3H), 1.245 (s, 3H)', 'si');
  const previews = (rounding, mode = 'decimal_places', digits = 2) => auditDocuments([source], profileFor('nmr.h1.chemical_shift', digits, rounding, mode)).issues.filter(x => x.suggestion).map(x => x.suggestion);
  assert.deepEqual(previews('half_up'), ['1.24', '1.25']); assert.deepEqual(previews('half_even'), ['1.24', '1.24']); assert.deepEqual(previews('truncate'), ['1.23', '1.24']);
  assert.deepEqual(previews('half_up', 'significant_figures', 3), ['1.24', '1.25']);
});
test('padding zeros requires review and never modifies the source', () => {
  const source = doc('1H NMR (400 MHz, CDCl3) δ 1.2 (s, 3H)', 'si'); const before = source.blocks[0].text;
  const result = auditDocuments([source], profileFor('nmr.h1.chemical_shift', 4)); const i = result.issues.find(x => x.suggestion);
  assert.equal(i.suggestion, '1.2000'); assert.equal(i.precisionKnown, false); assert.match(i.description, /补零/); assert.equal(source.blocks[0].text, before);
});
test('mandatory journal rule remains active after user display override', () => {
  const p = profileFor('nmr.h1.chemical_shift', 2); p.rules[0].requirement = 'journal_mandatory';
  p.rules[0].source = { type: 'official_requirement', status: 'verified', url: 'https://journal.example/guide', quote: 'Synthetic fixture only', checked_at: '2026-11-09' };
  p.rules.push({ id: 'personal', field: 'nmr.h1.chemical_shift', scope: 'all', override_of: 'custom', reason: '测试个人显示偏好', number_format: { mode: 'decimal_places', digits: 3 } });
  const r = auditDocuments([doc('1H NMR (400 MHz, CDCl3) δ 1.234 (s, 3H)', 'si')], p);
  assert.ok(r.issues.some(x => x.ruleId === 'custom')); assert.ok(!r.issues.some(x => x.ruleId === 'personal'));
});
test('range endpoints do not receive blind rounding suggestions', () => {
  const r = auditDocuments([doc('1H NMR (400 MHz, CDCl3) δ 7.265–7.295 (m, 2H)', 'si')], profileFor('nmr.h1.chemical_shift', 2));
  const issues = r.issues.filter(x => x.type === 'format'); assert.equal(issues.length, 2); assert.ok(issues.every(x => !x.suggestion));
});
test('partial parsing and unsupported text stay explicit in coverage', () => {
  const source = doc('This is an image-only plot with no machine-readable numeric labels.'); source.coverage.status = 'partial'; source.coverage.warnings.push('图像未解析');
  const r = auditDocuments([source], exampleProfile()); assert.equal(r.coverage.status, 'partial'); assert.equal(r.coverage.extractedFactCount, 0); assert.equal(r.issues.filter(x => x.type === 'coverage').length, 2); assert.ok(r.coverage.notPerformed.length);
});

test('stored spreadsheet values do not masquerade as original display precision', () => {
  const source = doc('3a\t1.2', 'si', { cells: [{ header: 'compound', text: '3a' }, { header: '1H shift', text: '1.2', precisionKnown: false, numberFormat: '0.0000' }] });
  const r = auditDocuments([source], profileFor('nmr.h1.chemical_shift', 3));
  const i = r.issues.find(x => x.type === 'format'); assert.equal(i.evidenceStatus, 'insufficient'); assert.equal(i.suggestion, undefined); assert.equal(i.sourceNumberFormat, '0.0000');
});

test('more-specific local formatting overrides display preferences but preserves general mandatory checks', () => {
  const p = profileFor('nmr.h1.chemical_shift', 2); p.rules.push({ id: 'local', field: 'nmr.h1.chemical_shift', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 3 } });
  const r = auditDocuments([doc('1H NMR (400 MHz, CDCl3) δ 1.234 (s, 3H)', 'si')], p); assert.equal(r.issues.filter(x => x.type === 'format').length, 0);
});

test('uncertainty is not mistaken for the mean and hostile exponents are bounded', () => {
  assert.equal(extractFacts(doc('95 ± 2% ee')).length, 0);
  assert.equal(extractFacts(doc('ee=1e99999999%')).length, 0);
});

test('pair budget truncates explicitly, exact boundary completes, and unrelated entities do not consume budget', () => {
  const make = (id, count, entity = '3a') => {
    const d = doc('', id); d.blocks = Array.from({ length: count }, (_, i) => ({ id: `${id}:b${i}`, text: `compound=${entity}; experiment=E1; ee=98%`, locator: { label: `line ${i + 1}` } })); return d;
  };
  const truncated = auditDocuments([make('main', 20), make('si', 20)], defaultProfile(), { pairBudget: 7 });
  assert.equal(truncated.coverage.candidatePairs, 400); assert.equal(truncated.coverage.visitedPairs, 7); assert.equal(truncated.coverage.remainingPairs, 393);
  assert.equal(truncated.coverage.truncated, true); assert.equal(truncated.coverage.pairBudget, 7);
  assert.ok(truncated.issues.some(i => i.type === 'coverage' && i.evidenceStatus === 'insufficient' && /预算/.test(i.title)));
  assert.ok(!truncated.coverage.completedChecks.includes('explicit_identity_cross_document_comparison'));
  assert.ok(truncated.coverage.incompleteChecks.includes('explicit_identity_cross_document_comparison'));
  const exact = auditDocuments([make('main', 1), make('si', 7)], defaultProfile(), { pairBudget: 7 });
  assert.equal(exact.coverage.truncated, false); assert.equal(exact.coverage.remainingPairs, 0); assert.equal(exact.issues.length, 0);
  const unrelated = auditDocuments([make('main', 200, '3a'), make('si', 200, '3b')], defaultProfile(), { pairBudget: 1 });
  assert.equal(unrelated.coverage.candidatePairs, 0); assert.equal(unrelated.coverage.visitedPairs, 0); assert.equal(unrelated.coverage.truncated, false);
  const single = auditDocuments([make('main', 200)], defaultProfile(), { pairBudget: 1 }); assert.equal(single.coverage.candidatePairs, 0);
  assert.throws(() => auditDocuments([], defaultProfile(), { pairBudget: AUDIT_LIMITS.pairBudget + 1 }), /pairBudget/);
});

// Minimal excerpts from the user's first real-paper run (2026-11-09), not a copy of a paper/page.
test('real-run regression: different product yields on one PDF page never inherit the first 3a mention', () => {
  const source = doc([
    'Considering product 3a, the following transformations were studied.',
    'This provided product 10a in a 76% yield.',
    'Reduction of 3a afforded alcohol 10b in 67% yield.',
    'This provided derivatives 11a and 11b in 99% and 65% yields, respectively.',
    'This provided the target product 14a in 70% yield.',
    'Species 12 was synthesized in 95% yield and used as a precatalyst, affording compound 5a in 71% yield.',
  ].join('\n'));
  const facts = extractFacts(source).filter(f => f.field === 'yield.percent');
  assert.deepEqual(facts.map(f => [f.raw, f.entity]), [['76', '10a'], ['67', '10b'], ['65', undefined], ['70', '14a'], ['95', '12'], ['71', '5a']]);
  assert.deepEqual(facts.find(f => f.raw === '65').entityCandidates, ['11a', '11b']);
  const documents = [source, doc('Following the general procedure A, the product 3a was obtained in 86% yield.', 'si')];
  const run = auditDocuments(documents);
  assert.equal(run.issues.filter(i => ['data', 'alignment'].includes(i.type)).length, 0);
  for (const f of run.facts) { const d = documents.find(d => d.id === f.documentId); assert.equal(d.blocks[0].text.slice(f.offset, f.end), f.raw); }
});

test('local record and condition scopes preserve real same-experiment conflicts within multi-record blocks', () => {
  const source = doc('compound=3a; experiment=E1; scale=0.1 mmol; isolated yield=92%; compound=3b; experiment=E2; scale=1 mmol; NMR yield=50%');
  const other = doc('compound=3a; experiment=E1; scale=0.1 mmol; isolated yield=80%; compound=3b; experiment=E2; scale=1 mmol; NMR yield=50%', 'si');
  const result = auditDocuments([source, other]);
  const differences = result.issues.filter(i => i.type === 'data'); assert.equal(differences.length, 1);
  assert.equal(differences[0].evidenceStatus, 'confirmed_difference');
  const yieldFacts = result.facts.filter(f => f.field === 'yield.percent');
  assert.equal(yieldFacts.find(f => f.raw === '92').method, 'isolated');
  assert.equal(yieldFacts.find(f => f.raw === '50').method, 'nmr');
  assert.equal(yieldFacts.find(f => f.raw === '92').conditionAmbiguous, false);
  for (const f of result.facts) { const b = [source, other].find(d => d.id === f.documentId).blocks[0]; assert.equal(b.text.slice(f.offset, f.end), f.raw); assert.ok(f.contextStart <= f.offset && f.contextEnd >= f.end); }
});

test('plural entities, ranges, and unknown following products remain unassigned rather than taking a first entity', () => {
  const source = doc('Products 3a and 3b were obtained in 80% yield. Products 4a–4d were obtained in 60% yield. Reaction of product 5a gave a new product in 50% yield.');
  const yields = extractFacts(source).filter(f => f.field === 'yield.percent');
  assert.ok(yields.every(f => !f.entity));
  assert.ok(yields.slice(0, 2).every(f => f.identityAmbiguous));
});

test('optimization entries and general procedures remain distinct experiment contexts', () => {
  const initial = doc('The product 3a was obtained in 24% yield (Table S1, entry 1).');
  const optimized = doc('The product 3a was obtained in 86% yield (Table S1, entries 16 − 18).', 'si');
  const different = auditDocuments([initial, optimized]);
  assert.equal(different.issues.filter(i => ['data', 'alignment'].includes(i.type)).length, 0);
  assert.equal(different.coverage.skippedDifferentIdentity, 1);
  assert.deepEqual(different.facts.find(f => f.raw === '86').experimentContext.entries, [16, 17, 18]);
  const procedure = doc('Following the general procedure A, the product 3a was obtained in 86% yield.', 'si');
  const unresolved = auditDocuments([initial, procedure]);
  const candidate = unresolved.issues.find(i => i.type === 'alignment');
  assert.ok(candidate); assert.match(candidate.title, /实验语境待确认/); assert.equal(candidate.calculation, undefined);
  assert.equal(unresolved.issues.filter(i => i.type === 'data').length, 0); assert.equal(unresolved.coverage.contextReviewPairs, 1);
});

test('same explicit table entry still exposes a genuine reporting difference', () => {
  const result = auditDocuments([doc('Compound 3a was obtained in 24% isolated yield (Table S1, entry 1).'), doc('Compound 3a was obtained in 36% isolated yield (Table S1, entry 1).', 'si')]);
  assert.equal(result.issues.filter(i => i.type === 'alignment').length, 1);
  assert.equal(result.facts.every(f => f.entity === '3a'), true);
});

test('EI-MS calculated/found records activate legacy mass formatting without asserting high resolution or leaking into NMR', () => {
  const source = doc('Compound 3a: 13C NMR (151 MHz, CDCl3) δ 128.12, 55.10. EI-MS: calculated C18H22NO3 [M+H]+ 300.1600; Found 300.1605.', 'si');
  const result = auditDocuments([source], profileFor('hrms.mass_to_charge', 3));
  const masses = result.facts.filter(f => f.field === 'hrms.mass_to_charge');
  assert.deepEqual(masses.map(f => [f.raw, f.measurement]), [['300.1600', 'calculated'], ['300.1605', 'found']]);
  assert.ok(masses.every(f => f.measurementClass === 'mass_spectrometry' && f.sourceLabel === 'EI-MS' && f.resolution === 'unspecified'));
  assert.deepEqual(result.facts.filter(f => f.field === 'nmr.c13.chemical_shift').map(f => f.raw), ['128.12', '55.10']);
  assert.deepEqual(result.coverage.unmatchedRuleIds, []); assert.equal(result.coverage.massSpectrometry.unspecifiedResolution, 2); assert.equal(result.coverage.massSpectrometry.reportedHighResolution, 0);
  assert.deepEqual(result.issues.filter(i => i.ruleId === 'custom').map(i => i.suggestion), ['300.160', '300.161']);
  for (const f of result.facts) assert.equal(source.blocks[0].text.slice(f.offset, f.end), f.raw);
});

test('only explicit HRMS labels report high resolution; unlabeled peak lists and missing calculated values are not invented', () => {
  const low = extractFacts(doc('EI-MS: m/z 300.16 (100), 282.15 (80), 145 (30).', 'si')); assert.equal(low.filter(f => f.field === 'hrms.mass_to_charge').length, 0);
  const high = extractFacts(doc('HRMS (ESI) calcd for C18H22NO3 [M+H]+ 300.1600; found 300.1605.', 'si'));
  assert.ok(high.filter(f => f.field === 'hrms.mass_to_charge').every(f => f.resolution === 'reported_high'));
  const missing = extractFacts(doc('ESI-MS: calculated for C18H22NO3 [M+H]+; Found 300.1605.', 'si')).filter(f => f.field === 'hrms.mass_to_charge');
  assert.equal(missing.length, 1); assert.equal(missing[0].measurement, 'found'); assert.equal(missing[0].resolution, 'unspecified');
});

test('scale-up and precatalyst text is not silently equated to a general characterization procedure', () => {
  const scaled = doc('A 3.0 mmol scale reaction afforded product 3b in 73% yield.');
  const standard = doc('Following the general procedure A, product 3b was obtained in 76% yield.', 'si');
  const r = auditDocuments([scaled, standard]); assert.equal(r.issues.find(i => i.type === 'alignment')?.title, 'yield.percent 实验语境待确认');
  assert.equal(r.facts.find(f => f.raw === '73').experimentContext.kind, 'scale_up');
  const precatalyst = extractFacts(doc('Species 12 was used as a precatalyst, affording compound 5a in 71% yield.'));
  assert.equal(precatalyst.find(f => f.field === 'yield.percent').experimentContext.kind, 'precatalyst_experiment');
});
