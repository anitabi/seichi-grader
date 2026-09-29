// ai-segment.js — 浏览器内 AI 抠图（onnxruntime-web + 量化 ISNet）。
// 全部在访客浏览器里跑，服务器零算力成本。按需懒加载。
// 两种模式：
//   extractForegroundAI  — 整图直抠（显著性），适合角色占画面主体的特写
//   extractCharactersAI  — 检测→裁剪→抠→合并，多角色/角色偏小时用这个
import { cleanupAlpha } from './segment.js';
import { getSession, releaseAllSessions, MODEL_BASE } from './ort-env.js';
import { detectPersons } from './detect.js';
import { samMaskForBox } from './sam-segment.js?v=20260929-manual3';
import { createCanvas } from './canvas-util.js';

const DEFAULT_SIZE = 1024;
// isnet-anime 预处理：/255 后减均值（RGB），std=1，保宽高比 letterbox 补边到 1024
const MEAN = [0.485, 0.456, 0.406];
// 推理输出（sigmoid 0..1）最大值低于此值视为"没找到前景"——
// 直接 min-max 归一化会把空场景的噪声放大成假前景
const MIN_RAW_MAX = 0.05;

// letterbox 预处理：保宽高比缩放到 longest=1024，左上对齐，其余补 0。
// 返回 { chw, validW, validH }（valid 为有效区像素尺寸，补边区张量值=0）
function preprocess(imageData, size = DEFAULT_SIZE) {
  const W = imageData.width, H = imageData.height;
  const scale = size / Math.max(W, H);
  const validW = Math.round(W * scale), validH = Math.round(H * scale);
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const tmp = createCanvas(W, H);
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, validW, validH); // 左上对齐
  const d = ctx.getImageData(0, 0, size, size).data;
  const chw = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (x < validW && y < validH) {
        const i = p * 4;
        chw[p] = d[i] / 255 - MEAN[0];
        chw[plane + p] = d[i + 1] / 255 - MEAN[1];
        chw[2 * plane + p] = d[i + 2] / 255 - MEAN[2];
      } // 否则保持 0（补边）
    }
  }
  return { chw, validW, validH };
}

// 取 mask 有效区（validW×validH），缩放回原尺寸，得到 alpha(Uint8 w*h)
function postprocess(mask01, validW, validH, w, h, size = DEFAULT_SIZE) {
  const mc = createCanvas(size, size);
  const mctx = mc.getContext('2d');
  const img = mctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, Math.round(mask01[i] * 255)));
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(img, 0, 0);
  // 裁出有效区再缩放回原尺寸
  const oc = createCanvas(w, h);
  const octx = oc.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.drawImage(mc, 0, 0, validW, validH, 0, 0, w, h);
  const od = octx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < od.length; i += 4, p++) alpha[p] = od[i];
  return alpha;
}

// 从 ImageData 裁一块子区域出来
function cropImageData(imageData, rect) {
  const c = createCanvas(imageData.width, imageData.height);
  const ctx = c.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  return ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
}

// 整图直抠：返回 { alpha, width, height, bbox, coverage, empty }
async function extractForegroundAI(imageData, opts = {}) {
  const modelUrl = opts.modelUrl || `${MODEL_BASE}/models/isnet-anime-w8.onnx`;
  const size = opts.inputSize || DEFAULT_SIZE;
  // ISNet 含 ceil_mode 的 MaxPool，WebGPU EP 暂不支持，统一用 WASM
  const { ort, session, ep } = await getSession(modelUrl, {
    onProgress: opts.onProgress, eps: [['wasm']],
  });
  opts.onStage && opts.onStage(`推理中…(${ep})`);

  const { chw, validW, validH } = preprocess(imageData, size);
  const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
  const feeds = { [session.inputNames[0]]: tensor };
  let results;
  try {
  results = await session.run(feeds);
  const out = results[session.outputNames[0]];
  const data = out.data; // Float32Array, [1,1,SIZE,SIZE]

  // 仅在有效区统计（避免补边 0 干扰）
  let mn = Infinity, mx = -Infinity;
  for (let y = 0; y < validH; y++) for (let x = 0; x < validW; x++) {
    const v = data[y * size + x];
    if (v < mn) mn = v; if (v > mx) mx = v;
  }

  const w = imageData.width, h = imageData.height;
  const debug = { rawMin: mn, rawMax: mx, validW, validH, ep };

  // 空场景守卫：模型输出整体极低说明没找到前景，直接返回空
  if (!(mx >= (opts.minRawMax ?? MIN_RAW_MAX))) {
    return { alpha: new Uint8ClampedArray(w * h), width: w, height: h, bbox: null, coverage: 0, empty: true, debug };
  }

  const range = (mx - mn) || 1;
  const mask01 = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) mask01[i] = Math.max(0, Math.min(1, (data[i] - mn) / range));

  // 返回原始 alpha（不清理）；清理/阈值/收边交给上层
  let alpha = postprocess(mask01, validW, validH, w, h, size);
  if (opts.cleanup === true) alpha = cleanupAlpha(alpha, w, h, { thr: 110, featherR: 2 });

  // bbox + coverage
  let minX = w, minY = h, maxX = 0, maxY = 0, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 24) {
      cnt++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const bbox = cnt ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return { alpha, width: w, height: h, bbox, coverage: cnt / (w * h), empty: false, debug };
  } finally {
    tensor.dispose?.();
    if (results) for (const value of Object.values(results)) value?.dispose?.();
  }
}

// 两级流水线：检测人物框 → 每框外扩裁剪 → ISNet 抠裁剪区。
// 返回 { chars: [{ box, rect, score, alpha, empty }], width, height }
//   box  = 检测框（原图坐标）
//   rect = 外扩后的裁剪区（alpha 与 rect 同尺寸）
//   empty= ISNet 对该框没有响应（角色太小/太糊），mask 为空
// opts.hires: 远景小人模式（1536 检测 + 低置信度阈值）
async function extractCharactersAI(imageData, opts = {}) {
  const hires = !!opts.hires;
  const maxDet = 8;
  const W = imageData.width, H = imageData.height;
  const detected = await detectPersons(imageData, {
    size: hires ? 1536 : 1024,
    conf: hires ? 0.12 : 0.25,
    maxDet,
    onProgress: opts.onProgress,
    onStage: opts.onStage,
  });
  // 大框 + 低置信度基本是误检：实测「加强搜索」(conf 0.12) 会把碎石地、汉堡整块当成人（占画面 24%~33%），
  // 首轮 0.39 分的整盘食物也是这样。真正的大角色置信度都很高；加强搜索本来就只为找「小」角色，
  // 所以那一轮直接不接受大于画面 12% 的框。
  const boxes = detected.filter((b) => {
    const area = (b.w * b.h) / (W * H);
    if (b.score < 0.5 && area > 0.2) return false;
    if (b.score < 0.7 && area > 0.4) return false; // 整块甜点特写 0.61 分、占画面近六成，真正的大特写角色是 0.8+
    if (hires && area > 0.12) return false;
    return true;
  });

  const chars = [];
  // 第一阶段：所有框只跑 ISNet。不要在循环中交错加载 SAM，否则检测器、
  // ISNet、SAM encoder/decoder 会同时常驻 WASM 堆，iOS 峰值可达数 GB。
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    opts.onStage && opts.onStage(`抠角色 ${i + 1}/${boxes.length}…`);
    // 外扩：横向多留些（手臂/围巾），纵向少些
    const padX = Math.round(b.w * 0.2), padY = Math.round(b.h * 0.12);
    const x = Math.max(0, b.x - padX), y = Math.max(0, b.y - padY);
    const rect = {
      x, y,
      w: Math.min(W, b.x + b.w + padX) - x,
      h: Math.min(H, b.y + b.h + padY) - y,
    };
    const crop = cropImageData(imageData, rect);
    const res = await extractForegroundAI(crop, {
      onProgress: opts.onProgress, modelUrl: opts.isnetModelUrl, inputSize: opts.isnetSize,
    });
    // 质量闸：ISNet 名义上有输出，但前景占裁剪区 <4%（噪声被归一化放大成稀碎的假 mask）
    // 或 >85%（整块矩形，人形不可能占满带外扩的裁剪框）都不可信，按「没抠出」处理，交给 SAM 兜底。
    // 实测（74 张真实巡礼动画帧）：远景人群/小人里出现的「带着背景的方块」就是这种输出。
    let empty = res.empty;
    if (!empty) {
      let cnt = 0;
      for (let k = 0; k < res.alpha.length; k++) if (res.alpha[k] > 127) cnt++;
      const frac = cnt / res.alpha.length;
      if (frac < 0.04 || frac > 0.85) empty = true;
    }
    chars.push({ box: b, rect, score: b.score, alpha: res.alpha, empty, via: 'isnet' });
  }

  // 第二阶段：释放检测器/ISNet，再集中处理所有需要 SAM 的框。
  // SAM 每个框要十几秒（桌面单线程更久）：人群画面里最多只兜底框面积最大的 3 个，其余保持「太小没抠出」，
  // 时间有上界；抠不出的可以用「手动框选」单独补。
  const fallback = chars.map((char, i) => (char.empty ? i : -1)).filter((i) => i >= 0)
    .sort((a, b) => chars[b].box.w * chars[b].box.h - chars[a].box.w * chars[a].box.h).slice(0, 3);
  if (fallback.length && opts.samFallback !== false) {
    opts.onStage && opts.onStage('释放检测模型，准备 SAM 小角色兜底…');
    await releaseAllSessions();
    for (let n = 0; n < fallback.length; n++) {
      const i = fallback[n], char = chars[i], b = char.box;
      opts.onStage && opts.onStage(`SAM 兜底 ${n + 1}/${fallback.length}…`);
      try {
        const sPadX = Math.round(b.w * 0.35), sPadY = Math.round(b.h * 0.25);
        const sx = Math.max(0, b.x - sPadX), sy = Math.max(0, b.y - sPadY);
        const sRect = {
          x: sx, y: sy,
          w: Math.min(W, b.x + b.w + sPadX) - sx,
          h: Math.min(H, b.y + b.h + sPadY) - sy,
        };
        const sCrop = cropImageData(imageData, sRect);
        const inner = { x: b.x - sx, y: b.y - sy, w: b.w, h: b.h };
        const samAlpha = await samMaskForBox(sCrop, inner, { onProgress: opts.onProgress });
        if (samAlpha) Object.assign(char, { alpha: samAlpha, rect: sRect, empty: false, via: 'sam' });
      } catch (e) {
        console.warn('SAM 兜底失败，保持"太小未抠出"', e);
      }
    }
  }
  // capped：检测框数触顶（画面里人比 maxDet 多），提示用户只处理了最显眼的一部分
  return { chars, width: W, height: H, capped: detected.length >= maxDet };
}

// ---------- 手动框选：把用户框当成「最小包围矩形」的强先验 ----------
// 用户手动框，说明自动检测已经漏了/错了；框本身就是「目标就在这里面、并且顶到四条边」的证据。
// 所以这条路径比自动路径大胆得多：
//   · 不再跑人物检测（检测器漏检才需要手动，让它再当门槛是自相矛盾；也不限于「人形」，羊驼、吉祥物都行）
//   · 不因为「响应太弱 / 像矩形 / 占比太小」就放弃，永远给出一个结果，让用户用画笔接着修
//   · 三路候选（ISNet / SAM / 边框色泛洪）按「抠出的外接框与用户框有多吻合」打分，挑最像的
//
// 外接框吻合度：mask 的外接矩形与用户框的 IoU。用户框是最小包围矩形，所以真正的目标 mask
// 外接框应该几乎等于它；只抠了一半（少了一个人）、连汽车一起抠（多出一大块）都会明显掉分。
function maskFit(alpha, w, h, inner) {
  let minX = w, minY = h, maxX = -1, maxY = -1, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 127) {
      cnt++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!cnt) return { score: 0, cnt: 0 };
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const ix = Math.max(0, Math.min(maxX + 1, inner.x + inner.w) - Math.max(minX, inner.x));
  const iy = Math.max(0, Math.min(maxY + 1, inner.y + inner.h) - Math.max(minY, inner.y));
  const inter = ix * iy, uni = bw * bh + inner.w * inner.h - inter;
  const iou = uni > 0 ? inter / uni : 0;
  const fill = cnt / (bw * bh);          // 外接框里被填满的比例：太低=稀碎噪声
  const cov = cnt / (inner.w * inner.h); // 占用户框的比例：太高=整块矩形，或把旁边的大物体（车）也吞进来了
  // 最小包围矩形意味着目标顶到四条边：数一数 mask 有几条边「够得着」（留 6% 余量，容忍手抖）。
  // 只抠了一半（漏了框右侧的另一个人）时，右边就够不着。
  const bandX = Math.max(3, inner.w * 0.06), bandY = Math.max(3, inner.h * 0.06);
  const contacts = (minX <= inner.x + bandX) + (maxX >= inner.x + inner.w - bandX)
    + (minY <= inner.y + bandY) + (maxY >= inner.y + inner.h - bandY);
  let score = iou * [0.55, 0.65, 0.75, 0.88, 1][contacts];
  if (fill < 0.12) score *= 0.5;
  if (cov > 0.7) score *= Math.max(0.5, 1 - (cov - 0.7) * 1.5); // 人形很少占满框的 70% 以上
  return { score, iou, fill, cov, contacts, cnt };
}

// 框外清零（留 tol 像素余量）：用户框就是最小包围矩形，框外不是目标
function clipToBox(alpha, w, h, inner, tol) {
  const x0 = inner.x - tol, y0 = inner.y - tol, x1 = inner.x + inner.w + tol, y1 = inner.y + inner.h + tol;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) alpha[y * w + x] = 0;
  }
  return alpha;
}

// ISNet 对「白羊驼站在米色地上」这类低显著度目标只会给一层淡淡的中间值，交给固定阈值会被削掉一半。
// 框内目标占大头，直接用框内直方图的 Otsu 阈值二值化（带一点软边），让它敢于下结论。
function decisive(alpha, w, h, inner) {
  const hist = new Float64Array(256);
  let n = 0;
  for (let y = inner.y; y < inner.y + inner.h; y++) for (let x = inner.x; x < inner.x + inner.w; x++) { hist[alpha[y * w + x]]++; n++; }
  if (!n) return alpha;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  thr = Math.max(30, Math.min(200, thr));
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = Math.max(0, Math.min(255, 128 + (alpha[i] - thr) * 4));
  return out;
}

// 最后一路兜底：边框色泛洪。用户框之外的那一圈外扩带肯定是背景，取它的主色，
// 从这一圈向内泛洪，凡是「颜色像背景、且与相邻像素色差不大」的都算背景，剩下的就是目标。
// 动画多为平涂，这个思路对低显著度、夜景剪影这类模型不响应的目标反而稳。
function colorFloodMask(crop, inner) {
  const { width: w, height: h, data: d } = crop;
  const inBox = (x, y) => x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h;
  const bins = new Map();
  let ring = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (inBox(x, y)) continue;
    const i = (y * w + x) * 4, key = (d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(key, b); ring++;
  }
  if (!ring) return null; // 框贴着图边、没有外扩带：无从取背景色
  const refs = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
  const T2 = 46 * 46, S2 = 30 * 30;
  const bgDist2 = (i) => {
    let m = Infinity;
    for (const c of refs) { const dr = d[i] - c[0], dg = d[i + 1] - c[1], db = d[i + 2] - c[2]; const v = dr * dr + dg * dg + db * db; if (v < m) m = v; }
    return m;
  };
  const bg = new Uint8Array(w * h), stack = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inBox(x, y)) { bg[y * w + x] = 1; stack.push(y * w + x); }
  }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0, i = p * 4;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q < 0 || bg[q]) continue;
      const j = q * 4;
      const dr = d[j] - d[i], dg = d[j + 1] - d[i + 1], db = d[j + 2] - d[i + 2];
      if (dr * dr + dg * dg + db * db > S2 || bgDist2(j) > T2) continue;
      bg[q] = 1; stack.push(q);
    }
  }
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = inner.y; y < inner.y + inner.h; y++) for (let x = inner.x; x < inner.x + inner.w; x++) {
    if (!bg[y * w + x]) alpha[y * w + x] = 255;
  }
  return cleanupAlpha(alpha, w, h, { thr: 128, featherR: 1, close: true });
}

async function extractInUserBox(imageData, box, opts = {}) {
  const W = imageData.width, H = imageData.height;
  // 外扩 4%：给 ISNet 一点上下文、给色彩泛洪留出「肯定是背景」的一圈；再多就稀释了「目标顶满框」的先验
  const padX = Math.max(3, Math.round(box.w * 0.04)), padY = Math.max(3, Math.round(box.h * 0.04));
  const x = Math.max(0, box.x - padX), y = Math.max(0, box.y - padY);
  const rect = { x, y, w: Math.min(W, box.x + box.w + padX) - x, h: Math.min(H, box.y + box.h + padY) - y };
  const inner = { x: box.x - x, y: box.y - y, w: box.w, h: box.h };
  const tol = Math.max(2, Math.round(Math.min(box.w, box.h) * 0.02));
  const crop = cropImageData(imageData, rect);
  const w = rect.w, h = rect.h;
  const cands = [];
  const add = (via, alpha, bonus = 1) => {
    if (!alpha) return;
    clipToBox(alpha, w, h, inner, tol);
    const fit = maskFit(alpha, w, h, inner);
    if (fit.cnt) cands.push({ via, alpha, fit, score: fit.score * bonus });
  };

  opts.onStage && opts.onStage('在框里抠图…');
  // A. ISNet（不设「响应太弱就放弃」的门槛，交给下面的吻合度打分）
  const isnet = await extractForegroundAI(crop, {
    onProgress: opts.onProgress, modelUrl: opts.isnetModelUrl, inputSize: opts.isnetSize, minRawMax: 0,
  });
  if (!isnet.empty) add('isnet', decisive(isnet.alpha, w, h, inner), 1.1); // 边缘更细，同分时略优先

  // B. SAM：框中心一带是正点，框的四个角是负点（最小包围矩形的角落几乎必然是背景），
  //    取 3 个候选里与用户框最吻合的那个。ISNet 已经很吻合时不必再跑（省一次十几秒的推理）
  // （占框超过 70% 时不算「够好」：那多半是把旁边的大物体也吞进来了，值得让 SAM 用角点负提示再试一次）
  const good = () => cands.some((c) => c.score >= 0.85 && c.fit.cov <= 0.7);
  if (!good() && opts.samFallback !== false) {
    opts.onStage && opts.onStage('用 SAM 再抠一遍…');
    try {
      const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2;
      const ix = inner.w * 0.04, iy = inner.h * 0.04;
      const positives = [[cx, cy], [cx, inner.y + inner.h * 0.3], [cx, inner.y + inner.h * 0.7],
        [inner.x + inner.w * 0.3, cy], [inner.x + inner.w * 0.7, cy]];
      if (opts.samPoints && opts.samPoints.length) positives.push(...opts.samPoints.map((p) => [p[0] - rect.x, p[1] - rect.y]));
      const negatives = [[inner.x + ix, inner.y + iy], [inner.x + inner.w - ix, inner.y + iy],
        [inner.x + ix, inner.y + inner.h - iy], [inner.x + inner.w - ix, inner.y + inner.h - iy]];
      const masks = await samMaskForBox(crop, inner, { onProgress: opts.onProgress, positives, negatives, allMasks: true });
      for (const m of masks) add('sam', m);
    } catch (e) {
      console.warn('框选 SAM 失败', e);
    }
  }

  // C. 边框色泛洪：便宜，前两路都不吻合（<0.6）时才上
  if (!cands.some((c) => c.score >= 0.65)) {
    const flood = colorFloodMask(crop, inner);
    if (flood) add('color', flood);
  }

  if (!cands.length) return { box, rect, score: 1, alpha: new Uint8ClampedArray(w * h), empty: true, via: 'isnet', manual: true };
  cands.sort((a, b) => b.score - a.score);
  const win = cands[0];
  return { box, rect, score: 1, alpha: win.alpha, empty: false, via: win.via, manual: true, fit: +win.score.toFixed(2) };
}

// 手动框选入口：框里的东西就是要抠的目标（见上）。返回与自动路径同构的 chars 数组，manual: true。
async function extractCharactersInRegion(imageData, box, opts = {}) {
  return [await extractInUserBox(imageData, box, opts)];
}

// 把各角色的裁剪区 alpha 合并回整图尺寸（取最大值）。
// included: Set<index>；缺省合并全部
function mergeCharacterAlphas(chars, width, height, included) {
  const alpha = new Uint8ClampedArray(width * height);
  chars.forEach((c, i) => {
    if (included && !included.has(i)) return;
    const { x, y, w, h } = c.rect;
    for (let yy = 0; yy < h; yy++) {
      const src = yy * w;
      const dst = (y + yy) * width + x;
      for (let xx = 0; xx < w; xx++) {
        const v = c.alpha[src + xx];
        if (v > alpha[dst + xx]) alpha[dst + xx] = v;
      }
    }
  });
  return alpha;
}

export { extractForegroundAI, extractCharactersAI, extractCharactersInRegion, mergeCharacterAlphas };
