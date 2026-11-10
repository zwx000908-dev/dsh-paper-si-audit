import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const hash = data => createHash('sha256').update(data).digest('hex');
export const DUPLICATE_LIMITS = Object.freeze({ assets: 200, pairs: 19900, normalizedRmse: 0.10, aspectRatioTolerance: 0.03, minimumStdDev: 12 });
const transforms = ['identity', 'rotate90', 'rotate180', 'rotate270', 'mirror', 'mirror90', 'mirror180', 'mirror270'];
function transformed(values, index) {
  const result = new Float32Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let a = index >= 4 ? 31 - x : x, b = y;
    for (let k = 0; k < index % 4; k++) [a, b] = [31 - b, a];
    result[b * 32 + a] = values[y * 32 + x];
  }
  return result;
}
export async function fingerprint(bytes) {
  const img = await loadImage(bytes);
  if (img.width * img.height > 20_000_000 || Math.max(img.width, img.height) > 12000) throw new Error('Image exceeds bounded pixel budget');
  const full = createCanvas(img.width, img.height), fc = full.getContext('2d'); fc.fillStyle = 'white'; fc.fillRect(0, 0, img.width, img.height); fc.drawImage(img, 0, 0);
  const pixelHash = hash(Buffer.concat([Buffer.from(`${img.width}:${img.height}:`), Buffer.from(fc.getImageData(0, 0, img.width, img.height).data)]));
  const canvas = createCanvas(32, 32), c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 32, 32); c.drawImage(full, 0, 0, 32, 32);
  const rgba = c.getImageData(0, 0, 32, 32).data, values = new Float32Array(1024);
  for (let i = 0; i < values.length; i++) values[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const darkFraction = [...values].filter(v => v < 245).length / values.length;
  const normalized = values.map(v => (v - mean) / Math.max(deviation, 1));
  const patches = [];
  const tile = createCanvas(16, 16), tc = tile.getContext('2d');
  for (const fraction of [1, 0.75, 0.5]) for (let y = 0; y <= Math.round((1 - fraction) * 4); y++) for (let x = 0; x <= Math.round((1 - fraction) * 4); x++) {
    const box = { x: Math.round(x / 4 * img.width), y: Math.round(y / 4 * img.height), width: Math.floor(img.width * fraction), height: Math.floor(img.height * fraction) };
    if (Math.min(box.width, box.height) < 32) continue;
    tc.drawImage(full, box.x, box.y, box.width, box.height, 0, 0, 16, 16); const d = tc.getImageData(0, 0, 16, 16).data;
    const values = Array.from({ length: 256 }, (_, i) => (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3), mean = values.reduce((a, b) => a + b, 0) / 256, sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / 256);
    if (sd < 15 || values.filter(v => v < 240).length < 40) continue;
    const normalized = values.map(v => (v - mean) / sd);
    patches.push({ box, values: normalized, coarse: Array.from({ length: 16 }, (_, i) => { const x = (i % 4) * 4, y = Math.floor(i / 4) * 4; let sum = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) sum += normalized[(y + a) * 16 + x + b]; return sum / 16; }) });
  }
  return { pixelHash, width: img.width, height: img.height, deviation, darkFraction, variants: transforms.map((_, i) => [...transformed(normalized, i)]), patches };
}
function compare(a, b, threshold) {
  if (a.pixelHash === b.pixelHash) return { kind: 'exact_pixels', transform: 'identity', normalizedRmse: 0 };
  if ([a, b].some(f => f.deviation < DUPLICATE_LIMITS.minimumStdDev || f.darkFraction < 0.02)) return null;
  let best = null;
  for (let t = 0; t < transforms.length; t++) {
    const ratio = t % 2 ? b.height / b.width : b.width / b.height;
    if (Math.abs(a.width / a.height / ratio - 1) > DUPLICATE_LIMITS.aspectRatioTolerance) continue;
    const error = Math.sqrt(a.variants[0].reduce((s, v, i) => s + (v - b.variants[t][i]) ** 2, 0) / 1024);
    if (error <= threshold && (!best || error < best.normalizedRmse)) best = { kind: 'similar_image', transform: transforms[t], normalizedRmse: error };
  }
  return best;
}
function localMatch(a, b, threshold, sameAsset = false) {
  let best = null;
  for (const p of a.patches ?? []) for (const q of b.patches ?? []) {
    if (sameAsset) {
      const overlap = Math.max(0, Math.min(p.box.x + p.box.width, q.box.x + q.box.width) - Math.max(p.box.x, q.box.x)) * Math.max(0, Math.min(p.box.y + p.box.height, q.box.y + q.box.height) - Math.max(p.box.y, q.box.y));
      if (overlap > 0.05 * Math.min(p.box.width * p.box.height, q.box.width * q.box.height)) continue;
    }
    if (Math.abs(p.box.width / p.box.height / (q.box.width / q.box.height) - 1) > 0.05) continue;
    let coarse = 0; for (let i = 0; i < 16; i++) coarse += (p.coarse[i] - q.coarse[i]) ** 2;
    if (coarse / 16 > threshold ** 2) continue;
    let error = 0; for (let i = 0; i < 256; i++) { error += (p.values[i] - q.values[i]) ** 2; if (error > threshold ** 2 * 256) break; }
    error = Math.sqrt(error / 256);
    if (error <= threshold && (!best || error < best.normalizedRmse)) best = { kind: 'local_similarity', transform: 'identity', normalizedRmse: error, boxes: [p.box, q.box], method: 'bounded_multiscale_grid_patches' };
  }
  return best;
}
const evidence = asset => ({ assetId: asset.id, documentId: asset.documentId, name: asset.name, role: asset.role, locator: asset.locator, locations: asset.locations ?? [], sourceSha256: asset.sourceSha256, rasterSha256: asset.sha256, path: asset.path, parentAssetId: asset.parentAssetId, parentCrop: asset.parentCrop, panelMode: asset.panelMode });

/** Compare only registered, source-current, hash-verified assets supplied by service. */
export async function checkImageDuplicates(assets, loadBytes, options = {}) {
  const maxAssets = options.maxAssets ?? DUPLICATE_LIMITS.assets, pairBudget = options.pairBudget ?? DUPLICATE_LIMITS.pairs, pairOffset = options.pairOffset ?? 0;
  const threshold = options.imageRmse ?? DUPLICATE_LIMITS.normalizedRmse, localThreshold = options.localImageRmse ?? 0.08;
  const issues = [], fingerprints = [], skipped = [];
  for (const asset of assets.slice(0, maxAssets)) {
    if (asset.status !== 'ready') { skipped.push({ assetId: asset.id, reason: asset.status ?? 'unread' }); continue; }
    try { const bytes = await loadBytes(asset); const key = hash(bytes); let fp = await options.cache?.get(key); if (!fp) { fp = await fingerprint(bytes); await options.cache?.set(key, fp); } fingerprints.push({ asset, fp }); }
    catch (error) { skipped.push({ assetId: asset.id, reason: String(error.message) }); }
  }
  const add = (a, b, match, repeatedLocations) => {
    const imageEvidence = b ? [evidence(a), evidence(b)] : [evidence(a)];
    issues.push({ id: 'duplicate_' + hash(JSON.stringify([a.id, b?.id ?? 'locations', match.kind])).slice(0, 24), type: 'data', category: 'image_duplicate', severity: 'medium', evidenceStatus: 'needs_review', status: 'open', title: ['similar_image', 'local_similarity'].includes(match.kind) ? '科研图片疑似重复（需原图复核）' : '科研图片内容完全重复（用途待确认）', description: `${match.kind === 'same_media_multiple_locations' ? '同一 DOCX 媒体在多个位置出现' : match.kind === 'exact_pixels' ? '解码并铺白底后的整图像素一致' : match.kind === 'local_similarity' ? '多尺度网格区域出现相似内容；红框为候选比较窗口，不是精确篡改边界' : '整图缩放及亮度归一化后相似'}；${match.transform ?? 'identity'}。重复可能来自合理引用、共用对照、标志或正文/SI 复用；本结果不认定不当使用或科研不端。`, evidenceIds: [], imageEvidence, calculation: { ...match, ...(repeatedLocations ? { repeatedLocations } : {}), thresholds: { imageRmse: threshold, localImageRmse: localThreshold } } });
  };
  let comparedPairs = 0, pairIndex = 0, nextPairOffset = null;
  for (let i = 0; i < fingerprints.length; i++) {
    const { asset, fp } = fingerprints[i];
    const locations = [...new Map((asset.locations ?? []).map(l => [JSON.stringify([l.part, l.xmlOffset, l.relationshipId]), l])).values()];
    if (locations.length > 1) add(asset, null, { kind: 'same_media_multiple_locations' }, locations);
    if (options.localImages) { const self = localMatch(fp, fp, localThreshold, true); if (self) add(asset, asset, self); }
    for (let j = i + 1; j < fingerprints.length; j++) {
      const other = fingerprints[j].asset;
      if (asset.parentAssetId === other.id || other.parentAssetId === asset.id) continue;
      if (pairIndex++ < pairOffset) continue;
      if (comparedPairs >= pairBudget) { nextPairOffset ??= pairIndex - 1; continue; }
      comparedPairs++; const match = compare(fp, fingerprints[j].fp, threshold) ?? (options.localImages ? localMatch(fp, fingerprints[j].fp, localThreshold) : null); if (match) add(asset, other, match);
    }
  }
  return { issues, assets: assets.map(evidence), coverage: { status: fingerprints.length ? 'limited' : 'not_performed', inventoriedAssets: assets.length, checkedAssets: fingerprints.length, comparedPairs, pairOffset, nextPairOffset, totalEligiblePairs: pairIndex, skipped, truncatedAssets: Math.max(0, assets.length - maxAssets), thresholds: { imageRmse: threshold, localImageRmse: localThreshold }, localImages: !!options.localImages, note: 'Whole images and optional bounded multiscale grid patches; registered panel crops retain parent coordinates. Local search is heuristic, not exhaustive crop/rotation/edit detection. Shared layouts and similar spectra can be false positives. Continue pair batches within the same project; no misconduct inference.' } };
}
