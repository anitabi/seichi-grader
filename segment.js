// segment.js — AI 抠图结果（alpha）的后处理：阈值 → 去碎点 → 闭运算/填洞 → 羽化 → 裁出角色。
// （早期的纯算法「启发式前景提取」已随交互精简一并移除：它要用户先圈范围、效果不稳；
//   需要的话可从 git 标签 pre-redesign-20260929 找回。）

// 积分图，便于 O(1) 求窗口和
function integral(src, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return I;
}
function boxSum(I, w, x0, y0, x1, y1) {
  // 闭区间 [x0,x1] x [y0,y1]
  const W = w + 1;
  return I[(y1 + 1) * W + (x1 + 1)] - I[y0 * W + (x1 + 1)] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
}

// 连通域筛选(4 邻接)。mode:
//   'largest' — 只留最大域(经典算法用，前景假设唯一)
//   'multi'   — 保留所有足够大的域(≥最大域 15% 且 ≥画面 0.03%)，多角色同框不再只剩一人
function filterComponents(bin, w, h, mode) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const sizes = [];
  for (let s = 0; s < w * h; s++) {
    if (bin[s] === 0 || label[s] !== -1) continue;
    const cur = sizes.length;
    let sp = 0; stack[sp++] = s; label[s] = cur; let size = 0;
    while (sp > 0) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && bin[p - 1] && label[p - 1] === -1) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && label[p + 1] === -1) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - w] && label[p - w] === -1) { label[p - w] = cur; stack[sp++] = p - w; }
      if (y < h - 1 && bin[p + w] && label[p + w] === -1) { label[p + w] = cur; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  const out = new Uint8Array(w * h);
  if (!sizes.length) return out;
  let maxSize = 0;
  for (const sz of sizes) if (sz > maxSize) maxSize = sz;
  const minKeep = mode === 'largest' ? maxSize : Math.max(maxSize * 0.15, w * h * 0.0003);
  for (let i = 0; i < w * h; i++) out[i] = label[i] >= 0 && sizes[label[i]] >= minKeep ? 1 : 0;
  return out;
}

// 从边界 flood 背景，未到达的非前景=内部洞 -> 填为前景
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (mask[p] === 0 && outside[p] === 0) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(); const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (mask[i] === 1 || outside[i] === 0) ? 1 : 0;
  return out;
}

// 3x3 二值膨胀/腐蚀，重复 r 次实现半径 r
function morph(mask, w, h, r, dilate) {
  let cur = mask;
  for (let it = 0; it < r; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x; let v = cur[p];
        const neigh = [
          x > 0 ? cur[p - 1] : v, x < w - 1 ? cur[p + 1] : v,
          y > 0 ? cur[p - w] : v, y < h - 1 ? cur[p + w] : v,
        ];
        if (dilate) next[p] = (v || neigh.some(n => n)) ? 1 : 0;
        else next[p] = (v && neigh.every(n => n)) ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

// box blur 羽化得到 0..255 alpha
function feather(mask, w, h, radius = 2) {
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = mask[i] ? 255 : 0;
  const I = integral(f, w, h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * w + x] = boxSum(I, w, x0, y0, x1, y1) / area;
    }
  }
  return out;
}

// 用 alpha 生成裁剪后的角色 canvas（RGBA，仅 bbox 区域）
function cutoutCanvas(imageData, result) {
  const { width: w } = imageData;
  const { alpha, bbox } = result;
  if (!bbox) return null;
  const c = document.createElement('canvas');
  c.width = bbox.w; c.height = bbox.h;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(bbox.w, bbox.h);
  const src = imageData.data;
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      const sp = ((bbox.y + y) * w + (bbox.x + x));
      const dp = (y * bbox.w + x) * 4;
      out.data[dp] = src[sp * 4];
      out.data[dp + 1] = src[sp * 4 + 1];
      out.data[dp + 2] = src[sp * 4 + 2];
      out.data[dp + 3] = alpha[sp];
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

// 清理任意 alpha（如 AI 输出）：阈值 -> 可选去碎点 -> 可选闭运算/填洞 -> 羽化
// 能去掉与主体断开的噪点杂边。
// keepLargest: true=只留最大域(旧行为) / false=全保留 / 缺省=保留多个足够大的域(多角色安全)
function cleanupAlpha(alpha, w, h, opts = {}) {
  const thr = opts.thr ?? 110;
  const featherR = opts.featherR ?? 2;
  const erode = opts.erode ?? 0; // 收边：向内收缩像素数，去背景晕边
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = alpha[i] >= thr ? 1 : 0;
  let mask = opts.filter === false || opts.keepLargest === false ? bin
    : filterComponents(bin, w, h, opts.keepLargest === true ? 'largest' : 'multi');
  if (opts.close !== false) {
    mask = morph(mask, w, h, 1, true);
    mask = morph(mask, w, h, 1, false);
    mask = fillHoles(mask, w, h);
  }
  if (erode > 0) mask = morph(mask, w, h, erode, false);
  return feather(mask, w, h, featherR);
}

// 从 alpha 计算 bbox（alpha>thr 的外接框）
function alphaBBox(alpha, w, h, thr = 16) {
  let minX = w, minY = h, maxX = 0, maxY = 0, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > thr) {
      cnt++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return cnt ? { bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, coverage: cnt / (w * h) } : { bbox: null, coverage: 0 };
}

export { cutoutCanvas, cleanupAlpha, alphaBBox };
