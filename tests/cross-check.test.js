import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCrossReferences } from '../src/cross-check.js';
import { extractFacts } from '../src/engine.js';
const b = (id, text, metadata = {}, locator = {}) => ({ id, text, metadata, locator });
function fixture(claim = 'An isolated yield of up to 98% yield was obtained (Table S1).', rows = ['80', '92'], header = 'isolated yield') {
  const main = { id: 'main', role: 'main', blocks: [b('claim', claim)] };
  const blocks = [b('caption', 'Table S1. Optimization.')];
  blocks.push(b('head', `Entry\tProduct\t${header}`, { cells: [{ header: 'Entry', text: 'Entry' }, { header: 'Product', text: 'Product' }, { header, text: header }], headerRow: true }, { table: 1, row: 1 }));
  rows.forEach((v, i) => blocks.push(b(`r${i}`, `${i + 1}\t3a\t${v}`, { cells: [{ header: 'Entry', text: String(i + 1) }, { header: 'Product', text: '3a' }, { header, text: v }] }, { table: 1, row: i + 2 })));
  const docs = [main, { id: 'si', role: 'si', blocks }]; return { docs, facts: docs.flatMap(extractFacts) };
}
test('explicit maximum claim compares same-basis table with exact citations', () => {
  const { docs, facts } = fixture('The isolated yield reached up to 98% yield (Table S1).');
  const r = checkCrossReferences(docs, facts); const c = r.records.find(r => r.kind === 'maximum');
  assert.ok(c); assert.equal(c.status, 'needs_review'); assert.equal(c.actual, 92);
  for (const c of r.issues.flatMap(i => i.citations)) assert.equal(docs.flatMap(d => d.blocks).find(b => b.id === c.blockId).text.slice(c.start, c.end), c.quote);
});
test('different methods, missing cells, unreviewed OCR and inequalities cannot validate maxima', () => {
  for (const [rows, header] of [[['80', '92'], 'NMR yield'], [['80', 'n.d.'], 'isolated yield'], [['80', '>99'], 'isolated yield']]) {
    const { docs, facts } = fixture('The isolated yield reached up to 98% yield (Table S1).', rows, header);
    assert.equal(checkCrossReferences(docs, facts).records.find(r => r.kind === 'maximum').status, 'insufficient');
  }
  const { docs, facts } = fixture('The isolated yield reached up to 98% yield (Table S1).'); facts.find(f => f.blockId === 'r0').unverifiedVisual = true;
  assert.equal(checkCrossReferences(docs, facts).records.find(r => r.kind === 'maximum').status, 'insufficient');
});
test('missing and ambiguous references remain unlocated, figures are not numerical tables', () => {
  const docs = [{ id: 'm', role: 'main', blocks: [b('b', 'See Figure 9 and Table S8.'), b('c', 'Figure 9. Scope.'), b('d', 'Figure 9. Another caption.')] }];
  const r = checkCrossReferences(docs); assert.equal(r.issues.length, 2); assert.ok(r.records.every(r => r.status === 'insufficient'));
});
test('entry selection is scoped and same-number main/SI tables do not mix', () => {
  const { docs, facts } = fixture('Product 3a gave 80% isolated yield (Table S1, entry 1).');
  const r = checkCrossReferences(docs, facts); assert.equal(r.records.find(r => r.kind === 'value').status, 'consistent_in_parsed_scope');
});
test('PDF line captions and explicitly continued captions locate one target', () => {
  const docs = [{ id: 'm', role: 'main', blocks: [b('a', 'Results are in Figure 2.\nFigure 2. Results and controls.'), b('b', 'Discussion paragraph.\nFigure 2. continued\nMore labels.')] }];
  const r = checkCrossReferences(docs); assert.equal(r.definitions.length, 1); assert.equal(r.definitions[0].continuations.length, 1); assert.equal(r.records[0].status, 'located');
});
test('standalone labels and title-style captions locate, narrative shows is not a caption', () => {
  const docs = [{ id: 's', role: 'si', blocks: [b('a', 'Table S1'), b('b', 'Table 1 Crystal data and refinement.'), b('c', 'Table S1 shows the results.')] }];
  const r = checkCrossReferences(docs); assert.equal(r.definitions.length, 2); assert.equal(r.records[0].status, 'located');
});
