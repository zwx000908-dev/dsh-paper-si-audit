import { createCanvas, loadImage } from '@napi-rs/canvas';

export function validateCrop(crop, width, height) {
  if (!crop || Object.keys(crop).some(k => !['x', 'y', 'width', 'height'].includes(k)) || !['x', 'y', 'width', 'height'].every(k => Number.isInteger(crop[k])) || crop.x < 0 || crop.y < 0 || crop.width < 16 || crop.height < 16 || crop.x + crop.width > width || crop.y + crop.height > height) throw new Error('Panel crop must be an in-bounds integer rectangle, at least 16×16 pixels');
  return { ...crop };
}

export async function extractPanels(bytes, rectangles) {
  const image = await loadImage(bytes), width = image.width, height = image.height;
  const source = createCanvas(width, height), ctx = source.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0);
  let boxes = rectangles, mode = 'user_selected';
  if (rectangles === undefined) {
    mode = 'whitespace_candidates';
    const scale = Math.min(1, 640 / Math.max(width, height)), w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const small = createCanvas(w, h), c = small.getContext('2d'); c.drawImage(source, 0, 0, w, h); const data = c.getImageData(0, 0, w, h).data;
    const split = (box, depth) => {
      if (depth >= 4) return [box];
      let best = null;
      for (const axis of ['x', 'y']) {
        const length = axis === 'x' ? box.width : box.height, across = axis === 'x' ? box.height : box.width;
        let start = -1;
        for (let p = 0; p <= length; p++) {
          let ink = 0;
          if (p < length) for (let q = 0; q < across; q++) { const x = box.x + (axis === 'x' ? p : q), y = box.y + (axis === 'x' ? q : p), at = (y * w + x) * 4; if (data[at] + data[at + 1] + data[at + 2] < 720) ink++; }
          if (p < length && ink / across < 0.003) { if (start < 0) start = p; }
          else if (start >= 0) { const gap = p - start, mid = Math.floor((start + p) / 2); if (gap >= 8 && mid >= 40 && length - mid >= 40 && (!best || gap > best.gap)) best = { axis, gap, mid }; start = -1; }
        }
      }
      if (!best) return [box];
      const a = { ...box }, b = { ...box };
      if (best.axis === 'x') { a.width = best.mid; b.x += best.mid; b.width -= best.mid; } else { a.height = best.mid; b.y += best.mid; b.height -= best.mid; }
      return [...split(a, depth + 1), ...split(b, depth + 1)];
    };
    boxes = split({ x: 0, y: 0, width: w, height: h }, 0).map(b => { const x = Math.floor(b.x / w * width), y = Math.floor(b.y / h * height); return { x, y, width: Math.min(width - x, Math.round(b.width / w * width)), height: Math.min(height - y, Math.round(b.height / h * height)) }; });
    if (boxes.length === 1) boxes = []; // no segmentation is not a successful panel discovery
  }
  if (!Array.isArray(boxes) || boxes.length > 16) throw new Error('At most 16 panel rectangles per extraction');
  const panels = boxes.map(box => {
    const crop = validateCrop(box, width, height), canvas = createCanvas(crop.width, crop.height), c = canvas.getContext('2d'); c.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { crop, bytes: canvas.toBuffer('image/png'), width: crop.width, height: crop.height };
  });
  return { mode, panels, note: mode === 'whitespace_candidates' ? 'Whitespace segmentation is a candidate layout only; axes, captions and graphs can be split incorrectly. Supply explicit rectangles when necessary.' : 'User-selected rectangles; originals remain unchanged.' };
}

export async function annotatedPair(evidence, boxes, loadBytes) {
  const images = await Promise.all(evidence.map(loadBytes));
  const canvas = createCanvas(1200, 660), c = canvas.getContext('2d'); c.fillStyle = '#ffffff'; c.fillRect(0, 0, 1200, 660); c.font = '18px sans-serif';
  for (let i = 0; i < images.length; i++) {
    const image = await loadImage(images[i]), scale = Math.min(560 / image.width, 560 / image.height), x = 20 + i * 600, y = 70;
    c.drawImage(image, x, y, image.width * scale, image.height * scale);
    const box = boxes?.[i] ?? { x: 0, y: 0, width: image.width, height: image.height };
    c.strokeStyle = '#e22525'; c.lineWidth = 3; c.strokeRect(x + box.x * scale, y + box.y * scale, box.width * scale, box.height * scale);
    c.fillStyle = '#222222'; c.fillText(`${i ? 'B' : 'A'}: ${evidence[i].assetId}`, x, 28, 560); c.fillText(evidence[i].locator?.label ?? '', x, 52, 560);
  }
  return canvas.toBuffer('image/png');
}
