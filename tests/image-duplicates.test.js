import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { checkImageDuplicates } from '../src/image-duplicates.js';
function picture({ rotated = false, mirror = false, other = false, size = 160, blank = false } = {}) {
  const c = createCanvas(size, size), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, size, size); x.scale(size / 160, size / 160);
  if (rotated) { x.translate(160, 0); x.rotate(Math.PI / 2); }
  if (mirror) { x.translate(160, 0); x.scale(-1, 1); }
  if (!blank) { x.fillStyle = 'black'; x.fillRect(other ? 15 : 20, other ? 10 : 30, other ? 120 : 35, other ? 50 : 110); x.fillStyle = '#c08060'; x.fillRect(80, other ? 80 : 15, 50, 40); }
  return c.toBuffer('image/png');
}
const compare = async (...buffers) => checkImageDuplicates(buffers.map((_, i) => ({ id: `a${i}`, name: `image${i}`, status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' }, path: `image${i}.png`, locator: { label: `page ${i}` } })), a => buffers[Number(a.id.slice(1))]);
test('decoded identical pixels get exact match with both source positions', async () => {
  const b = picture(), r = await compare(b, b);
  assert.equal(r.issues[0].calculation.kind, 'exact_pixels'); assert.equal(r.issues[0].imageEvidence.length, 2); assert.equal(r.issues[0].evidenceStatus, 'needs_review');
});
test('resizing, rotation, reflection are similarity candidates, not probabilities', async () => {
  for (const options of [{ size: 320 }, { rotated: true }, { mirror: true }]) {
    const r = await compare(picture(), picture(options)); assert.equal(r.issues.length, 1); assert.equal(r.issues[0].calculation.kind, 'similar_image');
  }
});
test('different images and near blank images do not become similarity matches', async () => {
  assert.equal((await compare(picture(), picture({ other: true }))).issues.length, 0);
  assert.equal((await compare(picture({ blank: true }), picture({ blank: true, size: 320 }))).issues.length, 0);
});
test('unread, corrupt and truncated assets remain explicit coverage gaps', async () => {
  const assets = [{ id: 'unread', status: 'unread' }, { id: 'bad', status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' } }, ...Array.from({ length: 199 }, (_, i) => ({ id: `u${i}`, status: 'unread' }))];
  const r = await checkImageDuplicates(assets, () => Buffer.from('bad'));
  assert.equal(r.coverage.checkedAssets, 0); assert.equal(r.coverage.truncatedAssets, 1); assert.equal(r.coverage.skipped.length, 200);
});
test('one DOCX media object at multiple XML locations is reported', async () => {
  const r = await checkImageDuplicates([{ id: 'a', status: 'ready', imageType: { type: 'photograph', origin: 'synthetic_fixture' }, locations: [{ part: 'word/media/a.png', xmlOffset: 10 }, { part: 'word/media/a.png', xmlOffset: 20 }] }], () => picture());
  assert.equal(r.issues[0].calculation.kind, 'same_media_multiple_locations');
});
