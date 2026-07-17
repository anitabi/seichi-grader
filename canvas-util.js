// Canvas factory shared by Window and Web Worker inference paths.
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}

// 顺时针旋转 canvas（deg 取 0/90/180/270），返回新 canvas；0 度原样返回。
function rotateCanvas(src, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (!d) return src;
  const out = document.createElement('canvas');
  if (d === 180) { out.width = src.width; out.height = src.height; }
  else { out.width = src.height; out.height = src.width; }
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(d * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

export { createCanvas, rotateCanvas };
