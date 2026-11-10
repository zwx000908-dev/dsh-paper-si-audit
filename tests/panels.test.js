import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { extractPanels, annotatedPair } from '../src/panels.js';
import { checkImageDuplicates } from '../src/image-duplicates.js';
function pattern(size = 256) {
  const c = createCanvas(size, size), x = c.getContext('2d'); let seed = 713;
  for (let y = 0; y < size; y += 8) for (let a = 0; a < size; a += 8) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; x.fillStyle = `rgb(${seed % 256},${(seed >>> 8) % 256},${(seed >>> 16) % 256})`; x.fillRect(a, y, 8, 8); }
  return c;
}
test('local image crop match retains pixel boxes and creates a readable comparison image', async () => {
  const c = pattern(), bytes = c.toBuffer('image/png');
  const extracted = await extractPanels(bytes, [{ x: 64, y: 64, width: 128, height: 128 }]);
  const images = [bytes, extracted.panels[0].bytes], assets = images.map((_, i) => ({ id: `a${i}`, status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' }, locator: { label: `image ${i}` } }));
  const r = await checkImageDuplicates(assets, a => images[Number(a.id.slice(1))], { localImages: true });
  assert.equal(r.issues.length, 1); assert.equal(r.issues[0].calculation.kind, 'local_similarity'); assert.deepEqual(r.issues[0].calculation.boxes[0], { x: 64, y: 64, width: 128, height: 128 });
  const marked = await annotatedPair(r.issues[0].imageEvidence, r.issues[0].calculation.boxes, e => images[Number(e.assetId.slice(1))]); assert.equal(marked.subarray(1, 4).toString(), 'PNG');
});
test('same-image distant copied regions are flagged, parent crop containment is excluded', async () => {
  const tile = pattern(128), c = createCanvas(256, 128), x = c.getContext('2d'); x.drawImage(tile, 0, 0); x.drawImage(tile, 128, 0);
  const r = await checkImageDuplicates([{ id: 'a', status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' } }], () => c.toBuffer('image/png'), { localImages: true });
  assert.equal(r.issues[0].calculation.kind, 'local_similarity'); assert.equal(r.issues[0].imageEvidence[0].assetId, r.issues[0].imageEvidence[1].assetId);
  const excluded = await checkImageDuplicates([{ id: 'a', status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' } }, { id: 'b', status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' }, parentAssetId: 'a' }], () => tile.toBuffer('image/png'));
  assert.equal(excluded.coverage.totalEligiblePairs, 0);
});
test('whitespace panel discovery is explicitly heuristic and bad crops are rejected', async () => {
  const c = createCanvas(400, 200), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 400, 200); x.drawImage(pattern(160), 10, 20); x.drawImage(pattern(160), 230, 20);
  const r = await extractPanels(c.toBuffer('image/png')); assert.equal(r.mode, 'whitespace_candidates'); assert.ok(r.panels.length >= 2);
  await assert.rejects(extractPanels(c.toBuffer('image/png'), [{ x: -1, y: 0, width: 30, height: 30 }]), /in-bounds/);
});
test('pair continuation covers every eligible pair without cross-batch omissions', async () => {
  const assets = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' } })), bytes = pattern().toBuffer('image/png');
  let offset = 0, pairs = 0; const ids = new Set();
  do { const r = await checkImageDuplicates(assets, () => bytes, { pairBudget: 2, pairOffset: offset }); pairs += r.coverage.comparedPairs; r.issues.forEach(i => ids.add(i.id)); offset = r.coverage.nextPairOffset; } while (offset !== null);
  assert.equal(pairs, 6); assert.equal(ids.size, 6);
});
