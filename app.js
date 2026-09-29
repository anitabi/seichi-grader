// app.js — 界面编排。主线：选动画截图 → 拍/选实景 → 自动调色 → 保存。
// 角色合成、构图对齐是可选步骤。界面阶段（empty / anime / photo / ready / align）见 updateUI()。
import {
  imageDataToLab, labStats, makeLabTransform, makeLumaCdfMap, makeGradeTransform,
  applyTransfer, applyTransferRegioned, skyMask, makeBloomLayer, applyBloom, generateCubeLUT,
} from './color.js?v=20260712d';
import { cutoutCanvas, cleanupAlpha, alphaBBox } from './segment.js?v=20260929-redesign';
import { mergeCharacterAlphas } from './ai-segment.js';
import { releaseAllSessions, MODEL_BASE } from './ort-env.js';
import { embedImage, cosineSimilarity, SCENE_EMBED_MODEL_URL } from './embed.js';
import { profile as DEVICE } from './platform.js';
import { launchViewfinder } from './camera/viewfinder.js?v=20260929-redesign';
import {
  MAX_DIM, isHeicFile, isImageFile, fileToImageData, readExifGPS,
  urlToImageData, canvasToPhotoData, imageReady,
} from './image-io.js';
import { encodeGif } from './gif.js';

const IS_MOBILE = DEVICE.isMobile;
const EXPORT_TILE = DEVICE.exportTile;
const EXPORT_MAX_PIXELS = DEVICE.exportMaxPixels;
const EXPORT_MAX_SIDE = 16_384;

// 这些曾经都是界面上的滑杆/开关，现在固定成验证过的默认值：
// 普通用户只需要「调色强度」，其余在「微调」里；抠图细节交给修边画笔。
const SUBTITLE_BAND = 0.12;                       // 动画底部字幕带不参与统计
const CUTOUT_THR = 110;                           // AI 抠图 alpha 阈值
const CHAR_LOOK = { harmonize: 0.35, shadow: 0.25, grain: 0.12 }; // 光照融合 / 落地阴影 / 颗粒匹配
const GRADE_DEFAULTS = { mode: 'tone', skyRegion: true, strength: 85, satBoost: 15, bloom: 25 };

const state = {
  anime: null,   // { imgData, canvas, width, height, srcUrl }
  photo: null,   // { imgData, width, height, srcUrl, align, originalWidth, originalHeight, fileName, gps }
                 // srcUrl = 原始文件 objectURL，导出时全分辨率重放用
                 // align  = 构图对齐裁剪框 {x,y,w,h}（原图归一化坐标），null=未裁剪
  left: 'orig',  // 对比滑块左侧显示：'orig' 原图 | 'anime' 动画截图
  gradedData: null,
  transform: null,
  gradeCache: null,    // 图片不变时复用统计、CDF 与天空掩膜；滑杆只重套用
  cutout: null,        // 清理后的角色 canvas（bbox 裁剪）
  rawAlpha: null,      // 抠图原始 alpha（Uint8，与 anime 同尺寸），只属算法结果，供收边重算
  rawW: 0, rawH: 0,
  erode: 0,            // 边缘收紧像素数（修边面板里的滑杆）
  maskOps: [],         // 手工修补操作，按时间序重放：keep(补回)/erase(擦除)
  opsOverlay: null,    // maskOps 重放结果 Uint8Array：0 无操作 / 1 强制保留 / 2 强制擦除
  finalAlpha: null,    // applyRefine 的最终输出 alpha（修边面板的蒙版以它为准）
  charSeg: null,       // AI 检测结果 { chars, included:Set }，供勾选角色重新合并
  charPos: { cx: 0.5, cy: 0.62 }, // 角色中心在场景中的归一化位置
  charBase: null,      // 角色 bbox 中心在动画帧里的归一化位置 { cx, cy }；大小 100% = 与动画同比例
  charDraw: null,      // 角色在 canvas 坐标的绘制矩形，用于拖拽命中
  hiresTried: false,   // 已经用过「加强搜索小角色」
  harmonizedCache: null,
  aiBusy: false,       // 抠图/找图共用一个开关，避免双 ORT 堆并存
  fromMap: null,
};

const $ = (id) => document.getElementById(id);
const HINT_KEY = 'seichi-hint-compare-v1';
const hasFlag = (k) => { try { return !!localStorage.getItem(k); } catch { return false; } };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 把浏览器/ORT 的英文报错翻成人话：用户能据此决定「换个网络」还是「换张图」
function friendlyError(e) {
  const m = String(e?.message || e);
  if (/Failed to fetch|NetworkError|Load failed|dynamically imported|模型下载失败/i.test(m)) return '网络不通，模型没能下载下来。请检查网络（内地可先连代理）后重试。';
  if (/memory|allocat|out of/i.test(m)) return '内存不够了。关掉其他应用后重试，或换一张较小的截图。';
  return m;
}

// Android 对包含 RAW 扩展名的 accept 往往直接打开文件管理器。
// 改用通用图片 MIME 类型，会优先给出系统图库/照片选择器；桌面仍可选 RAW 文件。
if (DEVICE.isAndroid) {
  ['fileAnime', 'filePhoto', 'matchFiles'].forEach((id) => { $(id).accept = 'image/*'; });
}

// ---------- 状态提示（浮在预览底部）与错误记录 ----------
let statusTimer = 0;
// ms=0：常驻（长任务进度），任务结束时 setStatus('') 清掉
function setStatus(text = '', ms = 5000) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.hidden = !text;
  if (text && ms > 0) statusTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const recentErrors = [];
function rememberError(where, error) {
  recentErrors.push({ at: new Date().toISOString(), where, name: error?.name || 'Error', message: String(error?.message || error) });
  if (recentErrors.length > 12) recentErrors.shift();
}
window.addEventListener('error', (event) => rememberError('window.error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => rememberError('unhandledrejection', event.reason));

// ---------- 弹层 ----------
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog')?.close();
});
// 点弹层外面的暗处即关闭（全屏修边与确认框除外）
document.querySelectorAll('dialog.sheet:not(#askDialog)').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return; // 键盘 Enter 触发按钮 click 时坐标是 (0,0)，不能靠坐标判断
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
});

function ask({ title, body, ok = '继续', cancel = '取消' }) {
  return new Promise((resolve) => {
    const dlg = $('askDialog');
    $('askTitle').textContent = title; $('askBody').textContent = body;
    $('askOk').textContent = ok; $('askCancel').textContent = cancel;
    let answer = false;
    $('askOk').onclick = () => { answer = true; dlg.close(); };
    $('askCancel').onclick = () => dlg.close();
    dlg.addEventListener('close', () => resolve(answer), { once: true });
    dlg.showModal();
  });
}

// ---------- 界面阶段 ----------
// empty：什么都没有 → anime / photo：只有一张 → ready：两张都有（预览调色结果）→ align：构图对齐
function currentPhase() {
  if (alignState.active) return 'align';
  return state.anime && state.photo ? 'ready' : state.anime ? 'anime' : state.photo ? 'photo' : 'empty';
}

function updateUI() {
  const phase = currentPhase();
  document.documentElement.dataset.phase = phase;
  for (const pane of $('dock').children) pane.hidden = pane.dataset.for !== phase;
  $('assets').hidden = phase === 'align';
  $('emptyHint').hidden = phase !== 'empty';
  $('slotAnime').classList.toggle('filled', !!state.anime);
  $('slotPhoto').classList.toggle('filled', !!state.photo);
  // 下一步该点哪一格：先动画，再实景
  $('slotAnime').classList.toggle('next', !state.anime);
  $('slotPhoto').classList.toggle('next', !!state.anime && !state.photo);
  $('slotAnimeHint').textContent = state.anime ? '点此更换' : '点此选择';
  $('slotPhotoHint').textContent = state.photo ? '点此更换' : '拍摄或选择';
  refreshBusyButtons();
  syncCanvasSize();
}

function refreshBusyButtons() {
  const busy = state.aiBusy;
  for (const id of ['btnAddChar', 'btnCharHires', 'btnCharBox', 'btnCharRefine', 'btnCharRemove', 'btnMatchPhotos', 'btnMatchAnimes']) $(id).disabled = busy;
}

function setAIBusy(on) { state.aiBusy = on; refreshBusyButtons(); }

function drawToCanvas(canvas, imgData) {
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  canvas.getContext('2d').putImageData(imgData, 0, 0);
}

// ---------- 调色核心 ----------
function inverseMask(mask) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 1 - mask[i];
  return out;
}

// 只在换图时生成统计与 CDF；滑杆不重新扫直方图/天空。
function getGradeCache() {
  const old = state.gradeCache;
  if (old && old.anime === state.anime && old.photo === state.photo) return old;
  const ignoreSub = SUBTITLE_BAND;
  const photoOpts = { cov: true };
  const animeOpts = { cov: true, ignoreBottomRatio: ignoreSub };
  const photoLab = imageDataToLab(state.photo.imgData), animeLab = imageDataToLab(state.anime.imgData);
  const cache = {
    anime: state.anime, photo: state.photo,
    photoLab, animeLab,
    global: {
      srcStats: labStats(state.photo.imgData, 2, { ...photoOpts, labData: photoLab }),
      tgtStats: labStats(state.anime.imgData, 2, { ...animeOpts, labData: animeLab }),
      map: makeLumaCdfMap(state.photo.imgData, state.anime.imgData, { ignoreBottomRatio: ignoreSub, srcLabData: photoLab, tgtLabData: animeLab }),
    },
    photoSky: skyMask(state.photo.imgData),
    animeSky: skyMask(state.anime.imgData, { ignoreBottomRatio: ignoreSub }),
  };
  if (cache.photoSky.valid && cache.animeSky.valid) {
    const ps = cache.photoSky.weight, as = cache.animeSky.weight;
    const pl = inverseMask(ps), al = inverseMask(as);
    cache.region = {
      sky: {
        srcStats: labStats(state.photo.imgData, 2, { weightMask: ps, cov: true, labData: photoLab }),
        tgtStats: labStats(state.anime.imgData, 2, { weightMask: as, ignoreBottomRatio: ignoreSub, cov: true, labData: animeLab }),
        map: makeLumaCdfMap(state.photo.imgData, state.anime.imgData, { srcWeightMask: ps, tgtWeightMask: as, ignoreBottomRatio: ignoreSub, srcLabData: photoLab, tgtLabData: animeLab }),
      },
      land: {
        srcStats: labStats(state.photo.imgData, 2, { weightMask: pl, cov: true, labData: photoLab }),
        tgtStats: labStats(state.anime.imgData, 2, { weightMask: al, ignoreBottomRatio: ignoreSub, cov: true, labData: animeLab }),
        map: makeLumaCdfMap(state.photo.imgData, state.anime.imgData, { srcWeightMask: pl, tgtWeightMask: al, ignoreBottomRatio: ignoreSub, srcLabData: photoLab, tgtLabData: animeLab }),
      },
    };
  }
  state.gradeCache = cache;
  return cache;
}

// 用当前滑杆值构建全套变换闭包。预览（recompute）与全分辨率导出共用，
// 保证两边永远是同一套映射。
function buildTransforms(cache) {
  const mode = $('mode').value;
  const strength = parseInt($('strength').value, 10) / 100;
  const satBoost = parseInt($('satBoost').value, 10) / 100;
  const g = cache.global;
  const out = {
    global: makeGradeTransform(g.srcStats, g.tgtStats, { mode, strength, mapL: g.map.build(strength), satBoost }),
    tSky: null, tLand: null,
  };
  if (cache.region) {
    const s = cache.region.sky, l = cache.region.land;
    out.tSky = makeGradeTransform(s.srcStats, s.tgtStats, { mode, strength, mapL: s.map.build(strength), satBoost });
    out.tLand = makeGradeTransform(l.srcStats, l.tgtStats, { mode, strength, mapL: l.map.build(strength), satBoost });
  }
  return out;
}

// 重活：重新计算调色，再重绘。滑杆拖动时经 rAF 合并。
function recompute() {
  if (!state.anime || !state.photo) { renderSingle(); return; }
  const cache = getGradeCache();
  const skyControl = $('skyRegion');
  skyControl.disabled = !cache.region;
  $('skyLabel').textContent = cache.region ? '天空单独调色' : '天空单独调色（这组图没检测到天空，已自动整体调色）';
  const t = buildTransforms(cache);
  state.transform = t.global;
  state.gradedData = skyControl.checked && cache.region
    ? applyTransferRegioned(state.photo.imgData, t.tSky, t.tLand, cache.photoSky.weight, cache.photoLab)
    : applyTransfer(state.photo.imgData, t.global, cache.photoLab);
  state.gradedData = applyBloom(state.gradedData, parseInt($('bloom').value, 10) / 100);
  for (const id of ['canvasGraded', 'clip', 'handle', 'badgeLeft', 'badgeRight']) $(id).hidden = false;
  $('badgeRight').textContent = '调色后';
  redrawComposite();
  drawLeftLayer();
  syncCanvasSize();
}

let gradeFrame = 0;
function scheduleRecompute() {
  cancelAnimationFrame(gradeFrame);
  gradeFrame = requestAnimationFrame(() => { gradeFrame = 0; recompute(); });
}

// 只有一张图时，预览就是那张图本身
function renderSingle() {
  const src = state.photo?.imgData || state.anime?.imgData;
  for (const id of ['clip', 'handle', 'badgeLeft']) $(id).hidden = true;
  $('canvasGraded').hidden = !src;
  $('badgeRight').hidden = !src;
  if (!src) return;
  $('badgeRight').textContent = state.photo ? '实景照片' : '动画截图';
  drawToCanvas($('canvasGraded'), src);
  syncCanvasSize();
}

// 轻活：把缓存的 gradedData 重画到调色后 canvas，再叠角色（拖拽/缩放时只跑这个）
function redrawComposite() {
  if (!state.gradedData || alignState.active) return; // 对齐模式下画布正被虚影对准占用，别覆盖
  drawToCanvas($('canvasGraded'), state.gradedData);
  if (state.cutout) compositeCharacter($('canvasGraded'));
}

// 动画截图按 cover 裁切到 w×h：与实景画框重合，用于对照层与 GIF
function animeCover(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const a = state.anime.canvas, s = Math.max(w / a.width, h / a.height);
  c.getContext('2d').drawImage(a, (w - a.width * s) / 2, (h - a.height * s) / 2, a.width * s, a.height * s);
  return c;
}

// 滑块左侧的对照层：原图或动画截图（点左上角标签切换）
function drawLeftLayer() {
  const g = $('canvasGraded'), o = $('canvasOrig');
  if (state.left === 'anime') {
    o.width = g.width; o.height = g.height;
    o.getContext('2d').drawImage(animeCover(g.width, g.height), 0, 0);
  } else {
    drawToCanvas(o, state.photo.imgData);
  }
  $('badgeLeft').textContent = state.left === 'anime' ? '动画 ⇄' : '原图 ⇄';
}

$('badgeLeft').addEventListener('click', () => {
  state.left = state.left === 'anime' ? 'orig' : 'anime';
  drawLeftLayer();
  syncCanvasSize();
});

// 让叠放的 canvas 在预览区内等比同尺寸显示（contain）。预览区大小随阶段变化，由 ResizeObserver 触发。
function syncCanvasSize() {
  const box = $('compare'), g = $('canvasGraded');
  const cw = box.clientWidth, ch = box.clientHeight, iw = g.width, ih = g.height;
  if (!cw || !ch || !iw || !ih) return;
  const scale = Math.min(cw / iw, ch / ih);
  const w = iw * scale, h = ih * scale;
  for (const c of [g, $('canvasOrig'), $('alignGhost')]) {
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }
}
new ResizeObserver(syncCanvasSize).observe($('compare'));

// ---------- 载入图片 ----------
async function readImageFile(file) {
  if (!file) return null;
  if (!isImageFile(file)) { setStatus('请选择 JPEG、PNG、WebP 或 HEIC 图片'); return null; }
  try {
    setStatus(isHeicFile(file) ? '正在解码 HEIC…' : '读取图片…', 0);
    const [data, gps] = await Promise.all([fileToImageData(file), readExifGPS(file)]);
    data.gps = gps;
    setStatus('');
    return data;
  } catch (e) {
    rememberError('read-image', e);
    setStatus('读取失败：' + (e.message || e), 9000);
    return null;
  }
}

async function handleAnimeData(data) {
  if (state.anime?.srcUrl?.startsWith('blob:')) URL.revokeObjectURL(state.anime.srcUrl);
  const canvas = document.createElement('canvas');
  drawToCanvas(canvas, data.imgData);
  state.anime = { imgData: data.imgData, canvas, width: data.width, height: data.height, srcUrl: data.url };
  state.gradeCache = null;
  state.fromMap = null; // 换了截图，地图带来的巡礼点名字就不再适用
  clearCharacter(); // 旧截图上抠的角色作废
  $('thumbAnime').crossOrigin = 'anonymous'; // 页面带 COEP：跨域缩略图必须走 CORS，否则会被拦
  $('thumbAnime').src = data.url; $('thumbAnime').hidden = false;
  updateUI();
  recompute();
}

async function handlePhotoData(data) {
  if (state.photo?.srcUrl?.startsWith('blob:')) URL.revokeObjectURL(state.photo.srcUrl);
  state.photo = {
    imgData: data.imgData, width: data.width, height: data.height, srcUrl: data.url, align: null,
    originalWidth: data.originalWidth || data.width, originalHeight: data.originalHeight || data.height,
    fileName: data.fileName || '', gps: data.gps || null,
  };
  state.gradeCache = null;
  invalidateHarmonize();
  $('thumbPhoto').src = data.url; $('thumbPhoto').hidden = false;
  exitAlignMode(false);
  updateUI();
  recompute();
  if (state.anime) {
    // 现场取景拍的照片已经是动画比例；从相册选的多半不是，提示一下对齐构图。
    // 否则只在第一次教一下怎么对比，之后不再打扰。
    if (Math.abs(data.width / data.height - state.anime.width / state.anime.height) > 0.05) {
      setStatus('已自动调色。想让构图和动画一致？点「对齐构图」', 7000);
    } else if (!hasFlag(HINT_KEY)) {
      setStatus('左右拖动看前后对比 · 点左上角的标签可以对照动画', 8000);
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* 隐私模式 */ }
    }
  }
}

async function pickAnime(file) { const d = await readImageFile(file); if (d) await handleAnimeData(d); }
async function pickPhoto(file) { const d = await readImageFile(file); if (d) await handlePhotoData(d); }

function bindFileInput(inputId, handler) {
  const input = $(inputId);
  input.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; await handler(f); });
}
bindFileInput('fileAnime', pickAnime);
bindFileInput('filePhoto', pickPhoto);

// 桌面：把文件直接拖到素材格上
function bindDrop(el, handler) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('dragover'); handler(e.dataTransfer.files[0]); });
}
bindDrop($('slotAnime'), pickAnime);
bindDrop($('slotPhoto'), pickPhoto);

const chooseAnime = () => $('fileAnime').click();
const choosePhoto = () => $('filePhoto').click();
$('slotAnime').addEventListener('click', chooseAnime);
$('btnPickAnime').addEventListener('click', chooseAnime);
$('btnPickAnime2').addEventListener('click', chooseAnime);
$('btnPickPhoto').addEventListener('click', choosePhoto);

$('slotPhoto').addEventListener('click', () => {
  $('psShoot').disabled = $('psMatch').disabled = !state.anime;
  $('psTip').hidden = !!state.anime;
  $('photoSheet').showModal();
});
$('psShoot').addEventListener('click', () => { $('photoSheet').close(); shoot(); });
$('psPick').addEventListener('click', () => { $('photoSheet').close(); choosePhoto(); });
$('psMatch').addEventListener('click', () => { $('photoSheet').close(); startMatch(false); });

// 从 anitabi 地图跳转载入：?url=<巡礼点动画截图>，可选 name/bid/pid/g 作展示与预设标识。
// 仅接受 https 且 anitabi.cn 域名的图，避免被构造链接载入任意外部图片。
async function loadFromQuery() {
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  if (!url) return;
  let u;
  try { u = new URL(url); } catch { return; }
  if (u.protocol !== 'https:' || !/(^|\.)anitabi\.cn$/i.test(u.hostname)) {
    console.warn('忽略不受信任的跳转图片来源：', url); // 静默回到空状态，不打断正常上传引导
    return;
  }
  const name = params.get('name') || '';
  try {
    setStatus(name ? `正在载入「${name}」的动画截图…` : '正在载入动画截图…', 0);
    await handleAnimeData(await urlToImageData(url));
    state.fromMap = { name, bid: params.get('bid') || '', pid: params.get('pid') || '', g: params.get('g') || '' };
    setStatus(name ? `已载入「${name}」· 接下来到现场拍摄，或选一张已有照片` : '动画截图已载入 · 接下来拍摄或选一张实景照片', 7000);
  } catch (e) {
    setStatus('动画截图载入失败（' + (e.message || e) + '）· 你仍可手动选择', 9000);
  }
}

// ---------- 调色控件 ----------
const GRADE_LABELS = { strength: 'strengthVal', satBoost: 'satBoostVal', bloom: 'bloomVal' };
for (const [id, label] of Object.entries(GRADE_LABELS)) {
  $(id).addEventListener('input', (e) => { $(label).textContent = e.target.value + '%'; scheduleRecompute(); });
}
$('mode').addEventListener('change', recompute);
$('skyRegion').addEventListener('change', recompute);
$('btnGradeMore').addEventListener('click', () => $('gradeSheet').showModal());
$('btnGradeDefault').addEventListener('click', () => { applySettings({ values: GRADE_DEFAULTS }); queueSettingsSave(); });

// ---------- 角色合成 ----------
// 光照融合：把实景场景的色调轻轻染到角色上，让它融入场景（带缓存）。
function invalidateHarmonize() { state.harmonizedCache = null; }

// 去色渗：半透明边缘像素的颜色被动画背景污染。用 5×5 邻域内实心像素
// （alpha>235）的均值色替换，越透明越信任内部色。只处理边缘带，开销可忽略。
function decontaminateEdges(img) {
  const { width: w, height: h, data: d } = img;
  const orig = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, a = orig[i + 3];
    if (a < 8 || a > 235) continue;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
        const j = (yy * w + xx) * 4;
        if (orig[j + 3] > 235) { sr += orig[j]; sg += orig[j + 1]; sb += orig[j + 2]; n++; }
      }
    }
    if (!n) continue;
    const t = 0.7 * (1 - a / 255);
    d[i] += (sr / n - orig[i]) * t;
    d[i + 1] += (sg / n - orig[i + 1]) * t;
    d[i + 2] += (sb / n - orig[i + 2]) * t;
  }
}

// 亮度颗粒：动画平涂 vs 照片噪点的质感差是"贴纸感"来源之一。
// 确定性 xorshift，参数不变时输出不变（缓存友好、不闪烁）。
function addLumaGrain(img, amp) {
  const d = img.data;
  let s = 0x9e3779b9;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    if (d[i + 3] < 8) continue;
    const n = ((s / 4294967296) - 0.5) * 2 * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
}

function harmonizedCutout() {
  if (state.harmonizedCache) return state.harmonizedCache;
  const src = state.cutout;
  if (!state.photo) { state.harmonizedCache = src; return src; }
  let cdata = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const tf = makeLabTransform(labStats(cdata, 1), labStats(state.photo.imgData, 2), 'chroma', CHAR_LOOK.harmonize);
  cdata = applyTransfer(cdata, tf); // 仅改 RGB，保留 alpha
  addLumaGrain(cdata, CHAR_LOOK.grain * 18);
  const oc = document.createElement('canvas');
  oc.width = src.width; oc.height = src.height;
  oc.getContext('2d').putImageData(cdata, 0, 0);
  state.harmonizedCache = oc;
  return oc;
}

// 按 charPos（中心归一化坐标）+ 角色大小滑杆绘制角色，并记录绘制矩形供拖拽命中。
// 全部用相对坐标，因此预览画布和全分辨率导出画布走同一函数。
// record=false 时不更新拖拽命中矩形（导出时用，避免污染预览坐标）。
function compositeCharacter(canvas, record = true) {
  const ctx = canvas.getContext('2d');
  const ch = harmonizedCutout();
  const scalePct = parseInt($('charScale').value, 10) / 100;
  // 每个动画像素在画布上占 k 个像素：只取决于画布高度、大小百分比和动画帧高，
  // 与 bbox 无关——修边时 bbox 变了，角色的大小和位置也不会跟着漂
  const k = canvas.height * scalePct / state.anime.height;
  const dh = ch.height * k;
  const scale = k;
  const dw = ch.width * scale;
  const dx = state.charPos.cx * canvas.width - dw / 2;
  const dy = state.charPos.cy * canvas.height - dh / 2;
  // 落地软阴影：贴着角色脚底的横椭圆，径向渐变淡出
  const rx = dw * 0.44, ry = Math.max(4, dw * 0.10);
  const cx = dx + dw / 2, cy = dy + dh - ry * 0.5;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(1, ry / rx);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, `rgba(0,0,0,${(CHAR_LOOK.shadow * 0.8).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.drawImage(ch, dx, dy, dw, dh);
  if (record) state.charDraw = { dx, dy, dw, dh };
}

// 角色缩放的唯一入口：钳到滑杆范围，标签同步后重绘
function setCharScale(value) {
  const v = clamp(Math.round(Number(value) || 100), 20, 300);
  $('charScale').value = v;
  $('charScaleVal').textContent = v + '%';
  redrawComposite();
}
$('charScale').addEventListener('input', (e) => setCharScale(e.target.value));

// 还原：回到抠图时自动给出的大小（100% = 与动画同比例）和动画原位
$('btnCharReset').addEventListener('click', () => {
  if (state.charBase) state.charPos = { cx: state.charBase.cx, cy: state.charBase.cy };
  setCharScale(100);
});

// 角色面板：有角色时显示大小/修边/移除；没抠出来时显示原因和补救按钮
// failed：没抠出来，给补救按钮；retry：是程序/网络出错（不是画面里没角色），只给「重试」。
// 不带参数调用（如修边后刷新）时沿用上次的提示，别让「还有角色太小」的补救按钮被一笔擦除冲掉
let charUiState = {};
function updateCharUI(opts) {
  if (opts) charUiState = opts;
  const { msg = '', failed = false, retry = false } = charUiState;
  const has = !!state.cutout;
  const chips = !!state.charSeg && state.charSeg.chars.length > 1;
  $('btnAddChar').hidden = has;
  $('charCtl').hidden = !has;
  $('charMsg').hidden = !msg; $('charMsg').textContent = msg;
  $('charFail').hidden = !failed;
  $('btnCharRetry').hidden = !retry;
  $('btnCharHires').hidden = retry || state.hiresTried;
  $('btnCharBox').hidden = retry;
  $('charChips').hidden = !chips;
  $('charBox').hidden = !(has || failed || msg || chips);
}

// 清空角色相关的全部状态（换动画截图、移除角色、重新抠图时用）
function clearCharacter() {
  state.cutout = null;
  state.rawAlpha = null; state.rawW = 0; state.rawH = 0; state.finalAlpha = null;
  state.maskOps = []; state.opsOverlay = null; state.erode = 0; state.hiresTried = false;
  state.charBase = null; state.charDraw = null; state.charPos = { cx: 0.5, cy: 0.62 };
  invalidateHarmonize();
  setCharSeg(null);
  $('charScale').value = 100; $('charScaleVal').textContent = '100%';
  updateCharUI({});
  redrawComposite();
}
$('btnCharRemove').addEventListener('click', () => { clearCharacter(); setStatus('已移除角色'); });

// AI 检测出多个角色时，可勾选要哪些
function setCharSeg(seg) {
  state.charSeg = seg;
  const box = $('charChips');
  box.innerHTML = '';
  if (!seg) return;
  seg.chars.forEach((c, i) => {
    const chip = document.createElement('label');
    chip.className = 'char-chip' + (c.empty ? ' empty' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = seg.included.has(i);
    cb.disabled = c.empty;
    cb.addEventListener('change', () => {
      if (cb.checked) seg.included.add(i); else seg.included.delete(i);
      applyCharSelection(false);
    });
    const text = document.createElement('span');
    text.textContent = c.empty ? `角色${i + 1}（太小）` : c.manual ? `框选${i + 1}` : `角色${i + 1}`;
    chip.appendChild(cb); chip.appendChild(text);
    box.appendChild(chip);
  });
}

// 按勾选合并各角色 mask -> rawAlpha -> 走统一的清理/重绘
function applyCharSelection(resetPos) {
  const seg = state.charSeg;
  if (!seg || !state.anime) return;
  state.rawAlpha = mergeCharacterAlphas(seg.chars, state.anime.width, state.anime.height, seg.included);
  state.rawW = state.anime.width; state.rawH = state.anime.height;
  return applyRefine(resetPos);
}

// 抠图后/修补后：从 rawAlpha 重建清理过的角色 cutout
function applyRefine(resetPos) {
  if (!state.rawAlpha || !state.anime) return;
  const w = state.rawW, h = state.rawH;
  const clean = cleanupAlpha(state.rawAlpha, w, h, { thr: CUTOUT_THR, erode: state.erode, featherR: 2, filter: true, close: true });
  // 手工修补层（补回/擦除的时间序重放结果）盖在算法输出之上
  if (state.opsOverlay?.length === clean.length) {
    const ov = state.opsOverlay;
    for (let i = 0; i < clean.length; i++) {
      if (ov[i] === 1) clean[i] = 255;
      else if (ov[i] === 2) clean[i] = 0;
    }
  }
  state.finalAlpha = clean;
  const { bbox, coverage } = alphaBBox(clean, w, h);
  state.cutout = bbox ? cutoutCanvas(state.anime.imgData, { alpha: clean, bbox }) : null;
  if (bbox) {
    const base = { cx: (bbox.x + bbox.w / 2) / w, cy: (bbox.y + bbox.h / 2) / h };
    // 修边会改变 bbox 中心；charPos 记的是 bbox 中心，要按同样的位移补偿，角色内容才不会「跳位」
    const g = state.gradedData;
    if (!resetPos && state.charBase && g) {
      const k = g.height * parseInt($('charScale').value, 10) / 100 / state.anime.height;
      state.charPos.cx += (base.cx - state.charBase.cx) * w * k / g.width;
      state.charPos.cy += (base.cy - state.charBase.cy) * h * k / g.height;
    }
    state.charBase = base;
  }
  if (state.cutout) {
    // 去色渗：羽化边缘的 RGB 混有动画背景色，向内部实心像素取色修正
    const ctx = state.cutout.getContext('2d');
    const cimg = ctx.getImageData(0, 0, state.cutout.width, state.cutout.height);
    decontaminateEdges(cimg);
    ctx.putImageData(cimg, 0, 0);
  }
  invalidateHarmonize();
  // 新抠图默认按动画里的原位、原比例落地（照片已与动画同构图），拖拽/滑杆仍可自由调整
  if (resetPos) {
    state.charPos = state.charBase ? { cx: state.charBase.cx, cy: state.charBase.cy } : { cx: 0.5, cy: 0.62 };
    setCharScale(100);
  } else {
    redrawComposite();
  }
  updateCharUI();
  return coverage;
}

// 模型推理和 1024px 遮罩的预/后处理都不能占用页面主线程。
// 即便是桌面浏览器也统一交给一次性 Worker，避免用户在等待时点击任何控件就让标签页假死。
function runAIInWorker(imageData, opts = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./ai-worker.js?v=20260929-fallback3', { type: 'module', name: 'seichi-ai-once' });
    // 看门狗：3 分钟没有任何进度消息（iOS 悄悄杀掉 Worker、下载卡死）就放弃，别让界面永远停在「忙」
    let watchdog = 0;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { worker.terminate(); reject(new Error('AI 任务长时间没有响应，请重试')); }, 180_000);
    };
    arm();
    const finish = () => clearTimeout(watchdog);
    worker.onmessage = (event) => {
      arm();
      const msg = event.data;
      if (msg.type === 'progress') opts.onProgress?.(msg.received, msg.total);
      else if (msg.type === 'stage') opts.onStage?.(msg.text);
      else if (msg.type === 'done') { finish(); worker.terminate(); resolve(msg.result); }
      else if (msg.type === 'error') {
        finish(); worker.terminate();
        const error = new Error(msg.error?.message || 'AI Worker 失败'); error.name = msg.error?.name || 'Error'; error.stack = msg.error?.stack || error.stack;
        reject(error);
      }
    };
    worker.onerror = (event) => { finish(); worker.terminate(); reject(new Error(event.message || 'AI Worker 加载失败')); };
    // 不转移 imageData.data.buffer：主页面仍需拿它显示预览/继续调色。
    worker.postMessage({ imageData, job: opts.job || 'auto', box: opts.box, samPoints: opts.samPoints || [], hires: !!opts.hires, samFallback: !DEVICE.isAppleMobile, mobileModel: DEVICE.isAppleMobile });
  });
}

const aiProgress = () => ({
  onStage: (s) => setStatus(s, 0),
  onProgress: (recv, total) => setStatus(`下载模型 ${(recv / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB`, 0),
});

// 「加角色」：一步到位——检测角色 → 逐个抠图 → 摆到动画里的原位
async function addCharacter({ hires = false } = {}) {
  if (!state.anime || state.aiBusy) return;
  if (!(await ensurePack('char'))) return;
  clearCharacter();
  state.hiresTried = hires;
  const anime = state.anime; // AI 期间用户可能换了截图：结果只属于发起时的那一张
  setAIBusy(true);
  setStatus('准备模型…', 0);
  try {
    const t0 = performance.now();
    const runAI = () => runAIInWorker(state.anime.imgData, { hires, ...aiProgress() });
    let aiResult;
    try {
      aiResult = await runAI();
    } catch (firstError) {
      // 每次 Worker 都是一次性实例；失败后重建一个干净 Worker，只重试一次避免死循环。
      setStatus('重新建立 AI 任务并重试一次…', 0);
      try { aiResult = await runAI(); }
      catch (retryError) { retryError.cause = firstError; throw retryError; }
    }
    if (state.anime !== anime) return;
    const { seg, escalated } = aiResult;
    if (escalated) state.hiresTried = true; // 一个都没找到时 worker 已自动加强搜索过
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    if (seg.chars.length) {
      const included = new Set(seg.chars.map((c, i) => (c.empty ? -1 : i)).filter((i) => i >= 0));
      setCharSeg({ chars: seg.chars, included });
      applyCharSelection(true);
      const nEmpty = seg.chars.filter((c) => c.empty).length;
      const n = seg.chars.length - nEmpty;
      const notes = [];
      if (seg.capped) notes.push('画面里人很多，只处理了最显眼的一部分');
      if (nEmpty) notes.push(`还有 ${nEmpty} 个角色太小，没抠出来`);
      updateCharUI({ failed: nEmpty > 0 || !state.cutout, msg: notes.join('；') });
      setStatus(state.cutout ? `已抠出 ${n} 个角色（${secs} 秒）· 拖动摆放，双指缩放` : '没能抠出角色');
    } else {
      // 没找到就老实说没找到，不再硬抠「画面里最显眼的东西」（那多半是建筑、食物、字幕）
      setCharSeg(null);
      updateCharUI({ failed: true, msg: '没找到角色。画面里的角色如果很小、被遮挡或不是人形，请手动框选' });
      setStatus('没找到角色');
    }
  } catch (e) {
    console.error(e); rememberError('add-character', e);
    updateCharUI({ failed: true, retry: true, msg: '抠图失败：' + friendlyError(e) });
    setStatus('');
  } finally {
    setAIBusy(false);
    updateModelStatus();
  }
}
$('btnAddChar').addEventListener('click', () => addCharacter());
$('btnCharRetry').addEventListener('click', () => addCharacter());
$('btnCharHires').addEventListener('click', () => addCharacter({ hires: true }));
$('btnCharBox').addEventListener('click', () => openRefine('box'));
$('btnCharRefine').addEventListener('click', () => openRefine('erase'));

// ---------- 修边（全屏画笔）----------
// rawAlpha 永远只属 AI 结果；一切手工修正记录成操作列表，按时间序重放成 opsOverlay，
// 在 applyRefine 里盖到 AI 输出上。撤销 = 弹出最后一项全量重放。
// 这样勾选角色重建 rawAlpha、调收边都不会丢手工修正，且每一步可逆。
function rebuildOpsOverlay() {
  const w = state.rawW, h = state.rawH;
  if (!w || !h || !state.maskOps.length) { state.opsOverlay = null; return; }
  const overlay = new Uint8Array(w * h);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const op of state.maskOps) {
    if (op.type === 'erase') { // 落笔时就记录“当时已是目标”的像素索引，划过背景不会留下痕迹
      for (const i of op.idx) overlay[i] = 2;
      continue;
    }
    ctx.clearRect(0, 0, w, h);
    strokePath(ctx, op.stroke);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0, p = 3; p < d.length; i++, p += 4) if (d[p]) overlay[i] = 1;
  }
  state.opsOverlay = overlay;
}

function strokePath(ctx, stroke) {
  const { pts, width } = stroke;
  ctx.strokeStyle = ctx.fillStyle = '#fff';
  ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], width / 2, 0, Math.PI * 2); ctx.fill(); }
}

// 将一笔橡皮刷出的轨迹裁成“当前已经属于目标”的像素集合
function selectedIndicesInStroke(stroke) {
  const w = state.rawW, h = state.rawH, alpha = state.finalAlpha;
  if (!w || !h || !alpha || alpha.length !== w * h) return [];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  strokePath(ctx, stroke);
  const painted = ctx.getImageData(0, 0, w, h).data;
  const idx = [];
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) if (painted[p] && alpha[i] > 8) idx.push(i);
  return idx;
}

function pushMaskOp(op) {
  state.maskOps.push(op);
  rebuildOpsOverlay();
  applyRefine(false);
  rfRefresh();
}

function undoMaskOp() {
  if (!state.maskOps.length) return;
  state.maskOps.pop();
  rebuildOpsOverlay();
  applyRefine(false);
  rfRefresh();
}

const rf = {
  tool: 'erase', brush: 30, view: { s: 1, x: 0, y: 0 }, base: { w: 0, h: 0 },
  overlay: null, stroke: null, box: null, pointers: new Map(), gesture: null,
};

function rfBuildOverlay() {
  const src = state.finalAlpha;
  if (!src || src.length !== state.rawW * state.rawH) { rf.overlay = null; return; }
  const overlay = document.createElement('canvas'); overlay.width = state.rawW; overlay.height = state.rawH;
  const image = new ImageData(overlay.width, overlay.height);
  // 识别目标保持完整；其它部分以深色半透明蒙版呈现，一眼看出漏了哪里
  for (let i = 0, p = 3; i < src.length; i++, p += 4) image.data[p] = Math.round((255 - src[i]) * .72);
  overlay.getContext('2d').putImageData(image, 0, 0);
  rf.overlay = overlay;
}

function rfDraw() {
  const c = $('rfCanvas'), ctx = c.getContext('2d');
  ctx.drawImage(state.anime.canvas, 0, 0);
  if (rf.overlay) ctx.drawImage(rf.overlay, 0, 0);
  if (rf.stroke) {
    ctx.save();
    ctx.globalAlpha = rf.tool === 'erase' ? .7 : .55;
    ctx.strokeStyle = ctx.fillStyle = rf.tool === 'erase' ? '#000' : '#fff';
    ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = rf.stroke.width;
    const pts = rf.stroke.pts;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }
  if (rf.box) {
    const b = rf.box;
    ctx.save();
    ctx.lineWidth = Math.max(2, c.width / 300); ctx.strokeStyle = '#00c8ff'; ctx.fillStyle = 'rgba(0,200,255,.16)';
    ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

// 蒙版变了（补画、撤销、收边）：重建暗蒙版并刷新按钮
function rfRefresh() {
  if (!$('refineDialog').open) return;
  rfBuildOverlay();
  rfDraw();
  $('rfUndo').disabled = !state.maskOps.length;
}

function rfApplyView() {
  const v = rf.view, stage = $('rfStage');
  const w = rf.base.w * v.s, h = rf.base.h * v.s;
  // 放大后不许把画面拖出屏幕；缩小到比舞台还小时居中
  v.x = w <= stage.clientWidth ? (stage.clientWidth - w) / 2 : clamp(v.x, stage.clientWidth - w, 0);
  v.y = h <= stage.clientHeight ? (stage.clientHeight - h) / 2 : clamp(v.y, stage.clientHeight - h, 0);
  $('rfCanvas').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
}

const RF_TIPS = {
  erase: '把手指划过多余的部分，亮的部分会被擦掉',
  keep: '把手指划过缺失的部分，暗的部分会被补回',
  box: '在角色周围拖出一个框，AI 会在框里再找一遍',
};

function rfSetTool(tool) {
  if (!state.cutout && tool !== 'box') tool = 'box'; // 还没有角色时擦除/补回无处下笔
  rf.tool = tool; rf.stroke = null; rf.box = null;
  for (const t of ['erase', 'keep']) $('rfTools').querySelector(`[data-tool="${t}"]`).disabled = !state.cutout;
  $('rfTools').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  $('rfTip').textContent = RF_TIPS[tool];
  $('rfBrushLabel').textContent = tool === 'box' ? '（框选不需要笔刷）' : '笔刷大小';
  $('rfBrush').disabled = tool === 'box';
  rfDraw();
}

function openRefine(tool = 'erase') {
  if (!state.anime) return;
  if (!state.cutout && tool !== 'box') tool = 'box'; // 还没有角色时只能框选
  const dlg = $('refineDialog');
  const c = $('rfCanvas');
  c.width = state.anime.width; c.height = state.anime.height;
  dlg.showModal();
  const stage = $('rfStage');
  const fit = Math.min(stage.clientWidth / c.width, stage.clientHeight / c.height);
  rf.base = { w: c.width * fit, h: c.height * fit };
  c.style.width = rf.base.w + 'px'; c.style.height = rf.base.h + 'px';
  rf.view = { s: 1, x: 0, y: 0 };
  rfApplyView();
  $('rfErode').value = state.erode; $('rfErodeVal').textContent = state.erode + 'px';
  rfBuildOverlay();
  rfSetTool(tool);
  $('rfUndo').disabled = !state.maskOps.length;
}

$('rfTools').addEventListener('click', (e) => { const b = e.target.closest('button[data-tool]'); if (b) rfSetTool(b.dataset.tool); });
$('rfBrush').addEventListener('input', (e) => { rf.brush = Number(e.target.value); });
$('rfUndo').addEventListener('click', undoMaskOp);
$('rfDone').addEventListener('click', () => $('refineDialog').close());
$('rfErode').addEventListener('input', (e) => {
  state.erode = Number(e.target.value);
  $('rfErodeVal').textContent = state.erode + 'px';
  applyRefine(false);
  rfRefresh();
});
$('refineDialog').addEventListener('close', () => { rf.stroke = null; rf.box = null; rf.gesture = null; rf.pointers.clear(); });

(function setupRefinePointer() {
  const stage = $('rfStage'), canvas = $('rfCanvas');
  const toImg = (e) => {
    const r = canvas.getBoundingClientRect();
    // 钳在图内：从舞台黑边起拖/拖出去，框坐标也不会越界
    return [clamp((e.clientX - r.left) / r.width * canvas.width, 0, canvas.width), clamp((e.clientY - r.top) / r.height * canvas.height, 0, canvas.height)];
  };
  const stagePt = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // 笔刷以「屏幕像素」计：放大后仍是同样粗细的手指感
  const brushInImage = () => rf.brush * canvas.width / canvas.getBoundingClientRect().width;
  let anchor = null;

  const startGesture = () => {
    const [a, b] = [...rf.pointers.values()];
    rf.stroke = null; rf.box = null; anchor = null;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    rf.gesture = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: rf.view.s, x0: rf.view.x, y0: rf.view.y, m0: m };
  };

  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* 合成事件可能抛，不影响绘制 */ }
    rf.pointers.set(e.pointerId, stagePt(e));
    if (rf.pointers.size === 2) { startGesture(); rfDraw(); return; }
    if (rf.pointers.size > 2) return;
    const p = toImg(e);
    if (rf.tool === 'box') { anchor = p; rf.box = { x: p[0], y: p[1], w: 0, h: 0 }; }
    else rf.stroke = { pts: [p], width: brushInImage() };
    rfDraw();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!rf.pointers.has(e.pointerId)) return;
    rf.pointers.set(e.pointerId, stagePt(e));
    if (rf.pointers.size >= 2 && rf.gesture) {
      const [a, b] = [...rf.pointers.values()], g = rf.gesture;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clamp(g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 1, 8);
      // 让手指起点下的那个图像点跟着两指中点走
      rf.view = { s, x: m.x - (g.m0.x - g.x0) / g.s0 * s, y: m.y - (g.m0.y - g.y0) / g.s0 * s };
      rfApplyView();
      return;
    }
    const p = toImg(e);
    if (rf.stroke) {
      const last = rf.stroke.pts[rf.stroke.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1) { rf.stroke.pts.push(p); rfDraw(); }
    } else if (rf.box && anchor) {
      rf.box = { x: Math.min(anchor[0], p[0]), y: Math.min(anchor[1], p[1]), w: Math.abs(p[0] - anchor[0]), h: Math.abs(p[1] - anchor[1]) };
      rfDraw();
    }
  });

  const end = (e) => {
    const had = rf.pointers.has(e.pointerId);
    rf.pointers.delete(e.pointerId);
    if (!had) return;
    if (rf.gesture) { if (rf.pointers.size < 2) rf.gesture = null; return; } // 手势结束不产生笔画
    const stroke = rf.stroke, box = rf.box;
    rf.stroke = null; rf.box = null; anchor = null;
    if (stroke) {
      if (rf.tool === 'erase') {
        const idx = selectedIndicesInStroke(stroke);
        if (idx.length) pushMaskOp({ type: 'erase', idx });
        else $('rfTip').textContent = '这一笔没有碰到角色。亮的部分才会被擦掉';
      } else {
        pushMaskOp({ type: 'keep', stroke });
      }
    } else if (box) {
      if (box.w >= 12 && box.h >= 12) runRegion(box);
    }
    rfDraw();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // 桌面：滚轮以指针为中心缩放
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = stagePt(e), v = rf.view, s = clamp(v.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 8);
    rf.view = { s, x: p.x - (p.x - v.x) / v.s * s, y: p.y - (p.y - v.y) / v.s * s };
    rfApplyView();
  }, { passive: false });
})();

// 框选：只在框里再找一遍角色，结果作为一个新角色并入
async function runRegion(box) {
  if (state.aiBusy) return;
  if (!(await ensurePack('char'))) return;
  setAIBusy(true);
  const anime = state.anime;
  const tip = (t) => { $('rfTip').textContent = t; };
  tip('AI 识别中…');
  try {
    const centroid = [box.x + box.w / 2, box.y + box.h / 2];
    const result = await runAIInWorker(state.anime.imgData, {
      job: 'region', box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }, samPoints: [centroid],
      onStage: tip, onProgress: (r, t) => tip(`下载模型 ${(r / 1048576).toFixed(0)}/${(t / 1048576).toFixed(0)}MB`),
    });
    if (state.anime !== anime) { $('refineDialog').close(); return; }
    if (!state.charSeg) state.charSeg = { chars: [], included: new Set() };
    const seg = state.charSeg;
    for (const char of result.chars) {
      seg.chars.push(char);
      if (!char.empty) seg.included.add(seg.chars.length - 1);
    }
    setCharSeg(seg);
    const hadCutout = !!state.cutout;
    applyCharSelection(!hadCutout);
    const ok = result.chars.filter((c) => !c.empty).length;
    if (ok) updateCharUI({}); // 手动补上了，之前「太小没抠出」的提示不再适用
    tip(ok ? '找到了。可以用「擦除 / 补回」继续微调' : '框里没找到明显角色：框大一点，或贴近角色');
    if (ok) rfSetTool('erase');
    rfRefresh();
  } catch (e) {
    console.error(e); rememberError('region', e);
    tip('识别失败：' + friendlyError(e));
  } finally {
    setAIBusy(false);
    updateModelStatus();
  }
}

// ---------- 构图对齐（洋葱皮）----------
// 动画截图半透明叠在照片上，拖拽平移 + 双指/滑杆缩放，把照片裁到和动画同构图同宽高比。
// 裁剪框以原图归一化坐标存进 state.photo.align，预览和全分辨率导出共用。
const alignState = {
  active: false,
  bitmap: null,          // 原始照片全画幅的处理分辨率副本（canvas）
  bw: 0, bh: 0,          // bitmap 尺寸
  crop: { cx: 0.5, cy: 0.5, scale: 1 }, // scale = 裁剪宽 / 照片宽
  maxScale: 1,
};

const alignAspect = () => state.anime.width / state.anime.height;

// 当前裁剪框（bitmap 像素坐标）
function alignCropRect() {
  const wc = alignState.crop.scale * alignState.bw;
  const hc = wc / alignAspect();
  let x = alignState.crop.cx * alignState.bw - wc / 2;
  let y = alignState.crop.cy * alignState.bh - hc / 2;
  x = clamp(x, 0, alignState.bw - wc);
  y = clamp(y, 0, alignState.bh - hc);
  // 回写钳位后的中心，避免边缘"卡住"后中心漂移
  alignState.crop.cx = (x + wc / 2) / alignState.bw;
  alignState.crop.cy = (y + hc / 2) / alignState.bh;
  return { x, y, w: wc, h: hc };
}

function drawAlignPreview() {
  const g = $('canvasGraded');
  g.width = state.anime.width; g.height = state.anime.height;
  const ctx = g.getContext('2d');
  const r = alignCropRect();
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, g.width, g.height);
  ctx.drawImage(alignState.bitmap, r.x, r.y, r.w, r.h, 0, 0, g.width, g.height);
  syncCanvasSize();
}

// 把原始照片（可选：按归一化裁剪框）按 MAX_DIM 缩成 canvas。
// 对齐/裁剪/还原都从原图重取，可反复调整、不叠加损耗
async function loadPhotoBitmap(norm = null) {
  const img = new Image();
  img.src = state.photo.srcUrl;
  await imageReady(img);
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const sx = norm ? norm.x * nw : 0, sy = norm ? norm.y * nh : 0;
  const sw = norm ? norm.w * nw : nw, sh = norm ? norm.h * nh : nh;
  const sc = Math.min(1, MAX_DIM / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * sc); c.height = Math.round(sh * sc);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function setAlignZoomUI(zoom) {
  $('alignZoom').value = Math.round(zoom);
  $('alignZoomVal').textContent = Math.round(zoom) + '%';
}

async function enterAlignMode() {
  if (!state.anime || !state.photo?.srcUrl) return;
  setStatus('拖动照片对准虚影；双指缩放', 6000);
  const canvas = await loadPhotoBitmap();
  alignState.bitmap = canvas; alignState.bw = canvas.width; alignState.bh = canvas.height;
  alignState.maxScale = Math.min(1, alignAspect() * canvas.height / canvas.width);
  const al = state.photo.align;
  alignState.crop = al
    ? { cx: al.x + al.w / 2, cy: al.y + al.h / 2, scale: al.w } // 已有裁剪：从上次的框恢复
    : { cx: 0.5, cy: 0.5, scale: alignState.maxScale };
  setAlignZoomUI(alignState.maxScale / alignState.crop.scale * 100);
  alignState.active = true;
  $('compare').classList.add('align-on');
  const ghost = $('alignGhost');
  ghost.crossOrigin = 'anonymous';
  ghost.src = state.anime.srcUrl;
  ghost.hidden = false;
  ghost.style.opacity = String(parseInt($('alignOpacity').value, 10) / 100);
  $('btnAlignReset').hidden = !state.photo.align;
  updateUI();
  drawAlignPreview();
}

function exitAlignMode(redraw = true) {
  if (!alignState.active) return;
  alignState.active = false;
  alignState.bitmap = null;
  $('compare').classList.remove('align-on');
  $('alignGhost').hidden = true;
  updateUI();
  if (redraw && state.gradedData) { redrawComposite(); syncCanvasSize(); }
}

// 应用裁剪：从原始文件按裁剪框重取处理分辨率图，替换 state.photo
async function applyAlignCrop() {
  const r = alignCropRect();
  const norm = { x: r.x / alignState.bw, y: r.y / alignState.bh, w: r.w / alignState.bw, h: r.h / alignState.bh };
  setStatus('应用构图…', 0);
  await replacePhotoPixels(await loadPhotoBitmap(norm), norm);
  setStatus(`构图已对齐 · 保留 ${Math.round(norm.w * 100)}% 画幅，导出仍是全分辨率`);
}

// 恢复整幅照片
async function resetAlignCrop() {
  await replacePhotoPixels(await loadPhotoBitmap(), null);
  setStatus('已恢复整幅照片');
}

async function replacePhotoPixels(canvas, align) {
  state.photo.imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  state.photo.width = canvas.width; state.photo.height = canvas.height;
  state.photo.align = align;
  state.gradeCache = null;
  invalidateHarmonize();
  exitAlignMode(false);
  updateUI();
  recompute();
}

// 对齐要从原图重取像素，可能失败（原图读不出、手机内存不够）：必须给出提示，别让常驻状态条卡在「应用构图…」
const guardAlign = (fn) => async () => {
  try { await fn(); } catch (e) {
    console.error(e); rememberError('align', e);
    setStatus('构图失败：' + friendlyError(e), 8000);
  }
};
$('btnAlign').addEventListener('click', guardAlign(enterAlignMode));
$('btnAlignApply').addEventListener('click', guardAlign(applyAlignCrop));
$('btnAlignCancel').addEventListener('click', () => exitAlignMode());
$('btnAlignReset').addEventListener('click', guardAlign(resetAlignCrop));
$('alignZoom').addEventListener('input', (e) => {
  $('alignZoomVal').textContent = e.target.value + '%';
  if (!alignState.active) return;
  alignState.crop.scale = alignState.maxScale / (parseInt(e.target.value, 10) / 100);
  drawAlignPreview();
});
$('alignOpacity').addEventListener('input', (e) => {
  $('alignOpacityVal').textContent = e.target.value + '%';
  $('alignGhost').style.opacity = String(parseInt(e.target.value, 10) / 100);
});

// ---------- 预览手势：对比滑块 / 拖动角色 / 对齐平移 / 双指缩放 ----------
(function setupInteract() {
  const compare = $('compare'), clip = $('clip'), handle = $('handle');
  const gradedCanvas = $('canvasGraded');
  let sliderDrag = false, charDrag = false, grabDX = 0, grabDY = 0;
  let alignDrag = false, alignStart = null;

  const moveSlider = (clientX) => {
    const rect = compare.getBoundingClientRect();
    const pct = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
    clip.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    handle.style.left = pct + '%';
  };

  // 屏幕坐标 -> 调色 canvas 内部坐标
  const toCanvas = (clientX, clientY) => {
    const r = gradedCanvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width * gradedCanvas.width,
      y: (clientY - r.top) / r.height * gradedCanvas.height,
      k: gradedCanvas.width / r.width, // 1 屏幕像素 = k 个 canvas 像素
      inDisplay: clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom,
    };
  };
  // 手指比鼠标粗：命中范围向外扩 24 屏幕像素，小角色也抓得住
  const hitChar = (p) => {
    const d = state.charDraw, pad = 24 * p.k;
    return d && p.x >= d.dx - pad && p.x <= d.dx + d.dw + pad && p.y >= d.dy - pad && p.y <= d.dy + d.dh + pad;
  };

  handle.addEventListener('pointerdown', (e) => { sliderDrag = true; e.stopPropagation(); });

  // 双指捏合：有角色时缩放角色，对齐模式下缩放照片
  const pointers = new Map();
  const pinch = { active: false, startDist: 0, startValue: 100 };
  const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const pinchTarget = () => (alignState.active ? 'align' : state.cutout ? 'char' : '');

  compare.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.badge')) return; // 标签是按钮，别被当成拖滑块
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchTarget()) {
      pinch.active = true;
      charDrag = sliderDrag = alignDrag = false;
      pinch.startDist = pinchDist() || 1;
      pinch.startValue = parseInt(pinchTarget() === 'align' ? $('alignZoom').value : $('charScale').value, 10);
      compare.classList.remove('grabbing');
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    if (alignState.active) {
      alignDrag = true;
      alignStart = { x: p.x, y: p.y, cx: alignState.crop.cx, cy: alignState.crop.cy };
      compare.classList.add('grabbing');
      return;
    }
    if (state.cutout && p.inDisplay && hitChar(p)) {
      charDrag = true;
      grabDX = p.x - (state.charPos.cx * gradedCanvas.width);
      grabDY = p.y - (state.charPos.cy * gradedCanvas.height);
      compare.classList.add('grabbing');
    } else if (state.gradedData) {
      moveSlider(e.clientX); sliderDrag = true;
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.active) {
      if (pointers.size >= 2) {
        const value = pinch.startValue * (pinchDist() / pinch.startDist);
        if (alignState.active) {
          const zoom = clamp(value, 100, 300);
          setAlignZoomUI(zoom);
          alignState.crop.scale = alignState.maxScale / (zoom / 100);
          drawAlignPreview();
        } else setCharScale(value);
      }
      return;
    }
    if (alignDrag) {
      const p = toCanvas(e.clientX, e.clientY);
      // 画布 1px = 裁剪框宽/画布宽 的照片像素；拖照片方向与拖裁剪框相反
      const r = alignState.crop.scale * alignState.bw / gradedCanvas.width;
      alignState.crop.cx = alignStart.cx - (p.x - alignStart.x) * r / alignState.bw;
      alignState.crop.cy = alignStart.cy - (p.y - alignStart.y) * r / alignState.bh;
      drawAlignPreview();
      return;
    }
    if (charDrag) {
      const p = toCanvas(e.clientX, e.clientY);
      state.charPos.cx = clamp((p.x - grabDX) / gradedCanvas.width, 0, 1);
      state.charPos.cy = clamp((p.y - grabDY) / gradedCanvas.height, 0, 1);
      redrawComposite();
    } else if (sliderDrag) {
      moveSlider(e.clientX);
    }
  });
  const releasePointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch.active = false;
    sliderDrag = false; charDrag = false; alignDrag = false; compare.classList.remove('grabbing');
  };
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);

  // 桌面：滚轮缩放（对齐模式缩照片；悬停在角色上缩角色）
  compare.addEventListener('wheel', (e) => {
    const up = e.deltaY < 0;
    if (alignState.active) {
      e.preventDefault();
      const zoom = clamp(parseInt($('alignZoom').value, 10) * (up ? 1.06 : 1 / 1.06), 100, 300);
      setAlignZoomUI(zoom);
      alignState.crop.scale = alignState.maxScale / (zoom / 100);
      drawAlignPreview();
      return;
    }
    if (!state.cutout) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (!p.inDisplay || !hitChar(p)) return;
    e.preventDefault();
    setCharScale(parseInt($('charScale').value, 10) * (up ? 1.06 : 1 / 1.06));
  }, { passive: false });
})();

// ---------- 现场取景拍摄 ----------
async function shoot() {
  if (!state.anime) { setStatus('先选一张动画截图，取景时会叠加它做参考'); return; }
  try {
    const canvas = await launchViewfinder(state.anime.imgData, {
      onReferenceChange: async (file) => {
        const data = await fileToImageData(file);
        await handleAnimeData(data);
        return state.anime.imgData;
      },
    });
    if (canvas) await handlePhotoData(await canvasToPhotoData(canvas));
  } catch (e) {
    console.error(e); rememberError('viewfinder', e);
    setStatus('取景失败：' + (e.message || e), 8000);
  }
}
$('btnShoot').addEventListener('click', shoot);
$('btnRetake').addEventListener('click', shoot);

// ---------- 导出 ----------
function download(blobOrUrl, name) {
  const a = document.createElement('a');
  a.href = blobOrUrl; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// 分块导出用它让出主线程。只用 requestAnimationFrame 的话，标签页转入后台后
// rAF 不再触发，整个导出会冻在某一块上——手机上切去别的 App 就会遇到。
// 这里让 rAF 和定时器赛跑：前台 rAF 先到，进度文字每块照常刷新；后台由定时器兜底跑完。
const nextPaint = () => new Promise((resolve) => {
  let timer = 0, frame = 0;
  const settle = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
  timer = setTimeout(settle, 32);
  frame = requestAnimationFrame(settle);
});

const canvasToBlob = (canvas, type = 'image/png', quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('浏览器无法编码此尺寸的图片'))), type, quality);
});

// 全分辨率导出：最终画布保持原始像素，逐块重放调色，避免同时持有整张照片的
// 多份 ImageData/Float32Array。48MP 桌面照片可保持 8000×6000；低内存手机会
// 明确降级而不是直接 OOM。Bloom 在 1/4 全画幅上统一生成，分块之间没有接缝。
function maskCanvasFromWeight(weight, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const d = new ImageData(w, h);
  for (let p = 0, i = 0; p < weight.length; p++, i += 4) {
    const v = Math.round(weight[p] * 255);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
  }
  c.getContext('2d').putImageData(d, 0, 0); return c;
}

function weightForTile(maskCanvas, x, y, w, h, fullW, fullH) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const sx = x / fullW * maskCanvas.width, sy = y / fullH * maskCanvas.height;
  const sw = w / fullW * maskCanvas.width, sh = h / fullH * maskCanvas.height;
  ctx.drawImage(maskCanvas, sx, sy, sw, sh, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = rgba[i] / 255;
  return out;
}

function applyBloomToCanvas(canvas, gain) {
  if (!(gain > 0)) return;
  const bw = Math.max(1, Math.round(canvas.width / 4)), bh = Math.max(1, Math.round(canvas.height / 4));
  const small = document.createElement('canvas'); small.width = bw; small.height = bh;
  const sctx = small.getContext('2d'); sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, bw, bh);
  const layer = makeBloomLayer(sctx.getImageData(0, 0, bw, bh));
  sctx.putImageData(layer, 0, 0);
  const ctx = canvas.getContext('2d'); ctx.save();
  ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = gain;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

async function renderFullRes(onStage, maxPixels = EXPORT_MAX_PIXELS) {
  const img = new Image();
  img.src = state.photo.srcUrl;
  await imageReady(img);
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  const al = state.photo.align;
  if (al) { sx = al.x * sw; sy = al.y * sh; sw *= al.w; sh *= al.h; }
  const scale = Math.min(1, EXPORT_MAX_SIDE / Math.max(sw, sh), Math.sqrt(maxPixels / (sw * sh)));
  const W = Math.round(sw * scale), H = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建该尺寸画布，请改用桌面 Chrome 或减小照片');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  const cache = getGradeCache();
  const t = buildTransforms(cache);
  const useRegion = $('skyRegion').checked && cache.region;
  const maskCanvas = useRegion ? maskCanvasFromWeight(cache.photoSky.weight, state.photo.width, state.photo.height) : null;
  const tilesX = Math.ceil(W / EXPORT_TILE), tilesY = Math.ceil(H / EXPORT_TILE), total = tilesX * tilesY;
  let done = 0;
  if (scale < .999) onStage(`设备内存保护：将 ${Math.round(sw)}×${Math.round(sh)} 降为 ${W}×${H}`);
  else onStage(`全分辨率调色 ${W}×${H}…`);
  await new Promise((r) => setTimeout(r, 30));
  for (let y = 0; y < H; y += EXPORT_TILE) {
    const th = Math.min(EXPORT_TILE, H - y);
    for (let x = 0; x < W; x += EXPORT_TILE) {
      const tw = Math.min(EXPORT_TILE, W - x), tile = ctx.getImageData(x, y, tw, th);
      const out = useRegion
        ? applyTransferRegioned(tile, t.tSky, t.tLand, weightForTile(maskCanvas, x, y, tw, th, W, H))
        : applyTransfer(tile, t.global);
      ctx.putImageData(out, x, y); done++;
    }
    onStage(`全分辨率调色 ${done}/${total} · ${W}×${H}`);
    await nextPaint();
  }
  onStage('生成辉光…');
  await nextPaint();
  applyBloomToCanvas(c, parseInt($('bloom').value, 10) / 100);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (state.cutout) compositeCharacter(c, false);
  c.dataset.originalWidth = Math.round(sw); c.dataset.originalHeight = Math.round(sh);
  c.dataset.wasDownscaled = scale < .999 ? '1' : '0';
  return c;
}

async function produceGradedJpeg(onStage) {
  if (DEVICE.isAppleMobile) {
    onStage('释放 AI 模型内存，为导出腾出空间…');
    await releaseAllSessions();
  }
  let maxPixels = EXPORT_MAX_PIXELS, c = null, blob = null, lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onStage(attempt ? `降低导出尺寸后重试（${attempt}/2）…` : '读取原始分辨率…');
      c = await renderFullRes(onStage, maxPixels);
      blob = await canvasToBlob(c, 'image/jpeg', 0.92);
      break;
    } catch (e) {
      lastError = e; c = null; blob = null;
      if (!IS_MOBILE || attempt === 2) throw e;
      maxPixels = Math.max(2_000_000, Math.floor(maxPixels * 0.62)); // 低内存手机：降尺寸再来，而不是直接失败
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  if (!blob || !c) throw lastError || new Error('导出失败');
  const info = c.dataset.wasDownscaled === '1'
    ? `手机内存有限：原图 ${c.dataset.originalWidth}×${c.dataset.originalHeight}，已生成 ${c.width}×${c.height}`
    : `${c.width}×${c.height} 原始分辨率`;
  return { blob, name: 'seichi-graded.jpg', info };
}

function makeCompareCanvas(maxWidth, layout) {
  const anime = state.anime, gw = state.gradedData.width, gh = state.gradedData.height;
  const tmpGraded = document.createElement('canvas');
  tmpGraded.width = gw; tmpGraded.height = gh;
  tmpGraded.getContext('2d').drawImage($('canvasGraded'), 0, 0); // 含已摆好的角色
  const tmpOrig = document.createElement('canvas');
  tmpOrig.width = state.photo.width; tmpOrig.height = state.photo.height;
  tmpOrig.getContext('2d').putImageData(state.photo.imgData, 0, 0);

  // 普通“上下对比”不留装饰缝，两张图片逐像素紧贴；卡片、三联和左右布局仍保留分隔。
  const gap = layout === 'updown' ? 0 : 8;
  const out = document.createElement('canvas');
  const ctx = out.getContext('2d');
  const W = maxWidth ? Math.min(gw, maxWidth) : gw; // 以调色图宽度为基准统一缩放
  const fit = (cv) => ({ cv, h: Math.round(cv.height * (W / cv.width)) });
  const panels = layout === 'triple' ? [fit(anime.canvas), fit(tmpOrig), fit(tmpGraded)] : [fit(anime.canvas), fit(tmpGraded)];

  if (layout === 'postcard') {
    const title = $('compareTitle').value.trim() || '聖地巡礼 · 此处与彼处';
    const manualPlace = $('comparePlace').value.trim();
    const gps = state.photo.gps;
    const gpsText = gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` : '';
    const place = [manualPlace, gpsText].filter(Boolean).join(' · ');
    const header = Math.round(W * .20), footer = place ? Math.round(W * .10) : Math.round(W * .045);
    out.width = W;
    out.height = header + panels.reduce((s, p) => s + p.h, 0) + gap + footer;
    ctx.fillStyle = '#10130c'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#007ea7'; ctx.fillRect(0, 0, W, Math.max(4, Math.round(W / 100)));
    ctx.fillStyle = '#f2f4ea'; ctx.font = `600 ${Math.round(W / 19)}px sans-serif`; ctx.textBaseline = 'top';
    ctx.fillText(title, Math.round(W * .06), Math.round(W * .055), Math.round(W * .88));
    let y = header;
    panels.forEach((p, i) => {
      ctx.drawImage(p.cv, 0, y, W, p.h);
      ctx.fillStyle = 'rgba(0,0,0,.58)'; ctx.fillRect(12, y + 12, Math.round(W * .19), Math.round(W * .07));
      ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(W / 28)}px sans-serif`;
      ctx.fillText(i ? '此处 · 调色后' : '彼处 · 动画', 20, y + 20);
      y += p.h + gap;
    });
    if (place) {
      ctx.fillStyle = '#b3bca4'; ctx.font = `${Math.round(W / 34)}px sans-serif`;
      ctx.fillText(place, Math.round(W * .06), y + Math.round(W * .025), Math.round(W * .88));
    }
  } else if (layout === 'leftright') {
    const H = Math.max(...panels.map((p) => p.h));
    out.width = W * panels.length + gap * (panels.length - 1);
    out.height = H;
    ctx.fillStyle = '#10130c'; ctx.fillRect(0, 0, out.width, out.height);
    panels.forEach((p, i) => ctx.drawImage(p.cv, i * (W + gap), 0, W, p.h));
  } else { // updown / triple 纵向
    out.width = W;
    out.height = panels.reduce((s, p) => s + p.h, 0) + gap * (panels.length - 1);
    ctx.fillStyle = '#10130c'; ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    panels.forEach((p) => { ctx.drawImage(p.cv, 0, y, W, p.h); y += p.h + gap; });
  }
  return out;
}

// 动画→实景渐变 GIF：约 2 秒，播完停在实景。1080 边长内，避免手机上占用过多内存。
async function makeAnimeToSceneGif(onStage) {
  const source = $('canvasGraded'), scale = Math.min(1, 1080 / Math.max(source.width, source.height));
  const w = Math.max(2, Math.round(source.width * scale)), h = Math.max(2, Math.round(source.height * scale));
  const anime = animeCover(w, h);
  const scene = document.createElement('canvas'); scene.width = w; scene.height = h;
  scene.getContext('2d').drawImage(source, 0, 0, w, h);
  const frames = 12;
  const blob = await encodeGif({
    width: w, height: h, frames, delayCs: Math.round(200 / frames),
    draw: (ctx, i) => {
      ctx.globalAlpha = 1; ctx.drawImage(anime, 0, 0);
      ctx.globalAlpha = i / (frames - 1); ctx.drawImage(scene, 0, 0); ctx.globalAlpha = 1;
    },
    yieldFrame: async (i) => { onStage(`生成 GIF ${i + 1}/${frames}`); await nextPaint(); },
  });
  return { blob, name: 'seichi-anime-to-scene.gif', info: `${w}×${h} · 约 2 秒 · 动画渐变成实景` };
}

// ---- 结果页：生成完先给你看，再分享 / 下载。手机上「分享」自带新的用户手势，
// 不会因为全分辨率渲染太久而被系统拒绝，也能直接存进相册。
let lastResult = null;

function openResult(title) {
  const dlg = $('resultSheet');
  $('resultTitle').textContent = title;
  $('resultWait').hidden = false; $('resultWait').textContent = '准备中…';
  $('resultImg').hidden = true; $('resultImg').removeAttribute('src');
  $('resultInfo').textContent = '';
  $('resultActions').hidden = true; $('resultHint').hidden = true;
  if (!dlg.open) dlg.showModal();
}

$('resultSheet').addEventListener('close', () => {
  if (lastResult?.url) URL.revokeObjectURL(lastResult.url);
  lastResult = null;
  $('resultImg').removeAttribute('src');
});

function showResult({ blob, name, info }) {
  if (lastResult?.url) URL.revokeObjectURL(lastResult.url);
  const url = URL.createObjectURL(blob);
  lastResult = { blob, name, url };
  const isImage = blob.type.startsWith('image/');
  $('resultTitle').textContent = '已生成';
  $('resultWait').hidden = isImage;
  if (!isImage) $('resultWait').textContent = name;
  if (isImage) { $('resultImg').src = url; $('resultImg').hidden = false; }
  $('resultInfo').textContent = info || '';
  const file = new File([blob], name, { type: blob.type });
  $('btnShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('btnShare').textContent = DEVICE.isAppleMobile ? '存到相册 / 分享' : '分享';
  $('resultActions').hidden = false;
  $('resultHint').hidden = !(DEVICE.isAppleMobile && isImage);
}

$('btnShare').addEventListener('click', async () => {
  if (!lastResult) return;
  const file = new File([lastResult.blob], lastResult.name, { type: lastResult.blob.type });
  try { await navigator.share({ files: [file], title: '圣地巡礼' }); }
  catch (e) { if (e?.name !== 'AbortError') $('resultInfo').textContent = '分享失败：' + (e.message || e); }
});
$('btnDownload').addEventListener('click', () => { if (lastResult) download(lastResult.url, lastResult.name); });

let exportSeq = 0;
async function runExport(title, produce) {
  $('exportSheet').close(); $('layoutSheet').close();
  const mine = ++exportSeq; // 只认最新一次导出：上一个没做完就关掉弹层再点别的，旧结果不能串进新弹层
  openResult(title);
  try {
    const result = await produce((text) => { if (mine === exportSeq) $('resultWait').textContent = text; });
    if (mine === exportSeq && $('resultSheet').open) showResult(result); // 生成途中被关掉就不用再展示了
  } catch (e) {
    if (mine !== exportSeq) return;
    console.error(e); rememberError('export', e);
    $('resultTitle').textContent = '生成失败';
    $('resultWait').hidden = false; $('resultWait').textContent = String(e.message || e);
  }
}

function drawPreview(canvasId, source, maxW = 300, maxH = 200) {
  const canvas = $(canvasId), scale = Math.min(maxW / source.width, maxH / source.height);
  canvas.width = Math.max(2, Math.round(source.width * scale));
  canvas.height = Math.max(2, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function openExportSheet() {
  if (!state.gradedData) return;
  drawPreview('pvImage', $('canvasGraded'));
  drawPreview('pvCompare', makeCompareCanvas(300, 'updown'));
  const g = $('canvasGraded'), half = document.createElement('canvas');
  half.width = g.width; half.height = g.height;
  const hctx = half.getContext('2d');
  hctx.drawImage(animeCover(g.width, g.height), 0, 0);
  hctx.globalAlpha = .5; hctx.drawImage(g, 0, 0);
  drawPreview('pvGif', half);
  $('cardCharacter').hidden = !state.cutout;
  if (state.cutout) drawPreview('pvCharacter', state.cutout);
  $('exportSheet').showModal();
}

let compareLayout = 'updown';
function openLayoutSheet() {
  for (const layout of ['updown', 'leftright', 'triple', 'postcard']) {
    drawPreview('pv' + layout[0].toUpperCase() + layout.slice(1), makeCompareCanvas(300, layout), 300, 130);
  }
  if (!$('compareTitle').value && state.fromMap?.name) $('compareTitle').value = state.fromMap.name; // 从地图来的，标题现成
  setLayout(compareLayout);
  $('exportSheet').close();
  $('layoutSheet').showModal();
}

function setLayout(layout) {
  compareLayout = layout;
  $('layoutGrid').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));
  $('cardText').hidden = layout !== 'postcard';
}

$('layoutGrid').addEventListener('click', (e) => { const b = e.target.closest('button[data-layout]'); if (b) setLayout(b.dataset.layout); });
$('btnMakeCompare').addEventListener('click', () => runExport('对照图', async () => {
  const out = makeCompareCanvas(0, compareLayout);
  return { blob: await canvasToBlob(out), name: `seichi-compare-${compareLayout}.png`, info: `${out.width}×${out.height} PNG` };
}));

$('btnSave').addEventListener('click', openExportSheet);

$('exportSheet').addEventListener('click', (e) => {
  const card = e.target.closest('[data-export]');
  if (!card) return;
  const kind = card.dataset.export;
  if (kind === 'compare') { openLayoutSheet(); return; }
  if (kind === 'image') runExport('调色图', produceGradedJpeg);
  else if (kind === 'gif') runExport('动图 GIF', makeAnimeToSceneGif);
  else if (kind === 'character') {
    runExport('角色透明 PNG', async () => ({ blob: await canvasToBlob(state.cutout), name: 'seichi-character.png', info: `${state.cutout.width}×${state.cutout.height} 透明 PNG` }));
  } else if (kind === 'lut') {
    runExport('调色 LUT', async (onStage) => {
      onStage('正在生成 65³ 高精度 LUT…');
      await nextPaint(); // 先让文字绘制出来，再执行数十万采样点的同步烘焙
      const cube = generateCubeLUT(state.transform, 65, 'Seichi Grade');
      return { blob: new Blob([cube], { type: 'text/plain' }), name: 'seichi-grade.cube', info: '65³ .cube · 含影调、色彩、饱和度；不含天空分区与辉光' };
    });
  }
});

// ---------- 找最像的照片（动画→多张实景 / 实景→多张动画，场景嵌入见 embed.js）----------
// 逐张「解码→编码→释放」，保留轻量缩略图与 File 引用供横向比较；受 60 张上限保护手机内存。
const MATCH_MAX_FILES = 60;
let matchReverse = false, matchAbort = false;

function makeMatchThumb(imgData, maxSide = 220) {
  const scale = Math.min(1, maxSide / Math.max(imgData.width, imgData.height));
  const src = document.createElement('canvas');
  src.width = imgData.width; src.height = imgData.height;
  src.getContext('2d').putImageData(imgData, 0, 0);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(imgData.width * scale)); c.height = Math.max(1, Math.round(imgData.height * scale));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// 点选某张推荐结果：走与手动选择完全相同的读取路径
async function useMatched(entry, reverse) {
  $('matchSheet').close();
  const data = await readImageFile(entry.file);
  if (!data) return;
  if (reverse) await handleAnimeData(data); else await handlePhotoData(data);
}

function renderMatchResults(ranked, reverse) {
  const grid = $('matchGrid');
  grid.textContent = '';
  ranked.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'match-item' + (index === 0 ? ' top' : '');
    item.title = entry.file.name || '';
    item.appendChild(entry.thumb);
    const label = document.createElement('span');
    label.textContent = `#${index + 1} · ${Math.max(0, Math.round(entry.sim * 100))}%`;
    item.appendChild(label);
    item.addEventListener('click', () => useMatched(entry, reverse));
    grid.appendChild(item);
  });
}

// 常规：动画 → 多张实景；只放了实景时反向：实景 → 多张动画
function startMatch(reverse) {
  if (state.aiBusy) { setStatus('AI 任务进行中，请稍候…'); return; }
  matchReverse = reverse;
  $('matchFiles').click();
}
$('btnMatchPhotos').addEventListener('click', () => startMatch(false));
$('btnMatchAnimes').addEventListener('click', () => startMatch(true));

$('matchSheet').addEventListener('close', () => { matchAbort = true; });

$('matchFiles').addEventListener('change', async (event) => {
  const picked = [...event.target.files];
  event.target.value = '';
  const files = picked.slice(0, MATCH_MAX_FILES);
  const reverse = matchReverse;
  const queryImage = reverse ? state.photo?.imgData : state.anime?.imgData;
  if (!files.length || !queryImage || state.aiBusy) return;
  if (!(await ensurePack('match'))) return;
  setAIBusy(true);
  matchAbort = false;
  $('matchTitle').textContent = reverse ? '找最像的动画截图' : '找最像的照片';
  $('matchGrid').textContent = '';
  const info = (t) => { $('matchInfo').textContent = t; };
  info('准备模型…');
  $('matchSheet').showModal();
  try {
    const mb = (n) => (n / 1048576).toFixed(1);
    const query = await embedImage(queryImage, { onProgress: (r, t) => info(`下载模型 ${mb(r)}/${mb(t)}MB`) });
    const ranked = [];
    let failed = 0, failReason = '';
    for (let i = 0; i < files.length && !matchAbort; i++) {
      try {
        info(`比对 ${i + 1}/${files.length}…`);
        const data = await fileToImageData(files[i]);
        const sim = cosineSimilarity(query, await embedImage(data.imgData));
        const thumb = makeMatchThumb(data.imgData);
        URL.revokeObjectURL(data.url);
        ranked.push({ file: files[i], sim, thumb });
      } catch (e) {
        console.warn('找图比对失败', files[i]?.name, e);
        failed++;
        if (!failReason) failReason = e.message || String(e); // 把第一条失败原因带给用户（如 HEIC/RAW 指引）
      }
    }
    if (matchAbort) return;
    ranked.sort((a, b) => b.sim - a.sim);
    renderMatchResults(ranked, reverse);
    info(ranked.length
      ? `比对了 ${ranked.length} 张，按相似度从高到低排列，点选最像的一张。${failed ? `（${failed} 张读取失败：${failReason}）` : ''}${picked.length > MATCH_MAX_FILES ? `（一次最多比对 ${MATCH_MAX_FILES} 张，多出的没参加）` : ''}`
      : `所选图片都无法读取：${failReason}`);
  } catch (e) {
    console.error(e); rememberError('scene-match', e);
    info('找图失败：' + friendlyError(e));
  } finally { setAIBusy(false); updateModelStatus(); }
});

// ---------- 参数自动恢复 ----------
const SETTINGS_KEY = 'seichi-current-settings-v1';
const SETTING_IDS = ['mode', 'skyRegion', 'strength', 'satBoost', 'bloom'];

function captureSettings() {
  const values = {};
  for (const id of SETTING_IDS) values[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  return { version: 3, values };
}

function applySettings(saved) {
  if (!saved?.values) return;
  for (const id of SETTING_IDS) {
    if (!(id in saved.values)) continue;
    if ($(id).type === 'checkbox') $(id).checked = Boolean(saved.values[id]);
    else $(id).value = String(saved.values[id]);
  }
  for (const [id, label] of Object.entries(GRADE_LABELS)) $(label).textContent = $(id).value + '%';
  if (state.anime && state.photo) recompute();
}

let saveSettingsTimer = 0;
function queueSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(captureSettings())); } catch { /* 隐私模式可禁用 */ }
  }, 180);
}
for (const id of SETTING_IDS) { $(id).addEventListener('input', queueSettingsSave); $(id).addEventListener('change', queueSettingsSave); }
window.addEventListener('pagehide', () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(captureSettings())); } catch { /* 忽略 */ }
  releaseAllSessions();
});
try { applySettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')); } catch { /* 忽略损坏的旧状态 */ }

// ---------- 离线模型 ----------
// 首次点「加角色」「找最像」时才下载，并先说清楚多大、要不要连 Wi‑Fi；
// 出门前也可以在「更多」里一次性提前下载，现场就能离线用。
const MODEL_CACHE = 'seichi-models-v8'; // v8: 模型改同源加载（整站迁 GitHub Pages / compose.anitabi.cn），旧 github.io 缓存键作废
// 运行时实际读取 ISNet 的两个分块（见 ort-env.js），不是同名的整文件，离线包也只缓存分块。
// Apple 移动端用 512 输入版（见 ai-worker.js），其余用 1024 版，两处必须指向同一组文件。
const ISNET_URL = DEVICE.isAppleMobile ? `${MODEL_BASE}/models/isnet-anime-512-w8.onnx` : `${MODEL_BASE}/models/isnet-anime-w8.onnx`;
const ISNET_PARTS = Array.from({ length: 2 }, (_, i) => `${ISNET_URL}.part${String(i).padStart(2, '0')}`);
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
// ort.webgpu.mjs 只会用到 jsep 那一组；非 jsep 的两个仅在回退时才可能用到，只随「提前下载」一起取。
const RUNTIME_CORE = ['ort.webgpu.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'].map((n) => ORT_BASE + n);
const RUNTIME_EXTRA = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map((n) => ORT_BASE + n);
const SAM_URLS = [`${MODEL_BASE}/models/sam-encoder.onnx`, `${MODEL_BASE}/models/sam-decoder.onnx`];
// 是否「已下载」只看模型文件本身：运行时（ort）在联网用过一次后由 SW 自动缓存，
// 若把它也算进去，用户联网用完之后仍会被反复提示「需要下载」。「提前下载」则连运行时一起取，保证离线可用。
const PACKS = {
  char: { name: '角色抠图', mb: 60, urls: [`${MODEL_BASE}/models/person-detect.onnx`, ...ISNET_PARTS] },
  match: { name: '找最像的照片', mb: 28, urls: [SCENE_EMBED_MODEL_URL] },
};
// SAM 只是小角色的兜底（iPhone/iPad 上不启用），需要时才下载；「提前下载」里带上它
const ALL_URLS = [...new Set([...PACKS.char.urls, ...PACKS.match.urls, ...RUNTIME_CORE, ...RUNTIME_EXTRA, ...(DEVICE.isAppleMobile ? [] : SAM_URLS)])];

const cacheKey = (url) => new URL(url, location.href).href;
const cacheHas = async (cache, url) => !!(await cache.match(cacheKey(url), { ignoreVary: true }));
const countCached = async (cache, urls) => (await Promise.all(urls.map((u) => cacheHas(cache, u)))).filter(Boolean).length;
const fmtMB = (bytes) => (bytes / 1048576).toFixed(1);
const fmtSpeed = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`);

// 用之前先确认：没下载过就说清楚大小再问；已经在缓存里就直接放行
async function ensurePack(kind) {
  const pack = PACKS[kind];
  if (!('caches' in window)) return true;
  try {
    const cache = await caches.open(MODEL_CACHE);
    if (await countCached(cache, pack.urls) === pack.urls.length) return true;
  } catch { return true; }
  if (navigator.onLine === false) {
    setStatus(`「${pack.name}」的模型还没下载，需要联网（建议 Wi‑Fi）`, 8000);
    return false;
  }
  return ask({
    title: `首次使用需要下载「${pack.name}」模型`,
    body: `约 ${pack.mb}MB，只下载一次，之后可以离线使用。\n建议在 Wi‑Fi 下进行；内地网络下载可能较慢，可以先连接代理（日本节点为佳）。`,
    ok: '下载并继续',
  });
}

async function updateModelStatus() {
  const label = $('modelStatus');
  if (!('caches' in window) || !('serviceWorker' in navigator)) {
    label.textContent = '此浏览器不支持模型持久缓存，每次使用都需要联网下载。';
    $('btnCacheAll').disabled = $('btnClearModels').disabled = true;
    return;
  }
  try {
    const cache = await caches.open(MODEL_CACHE);
    const have = await countCached(cache, ALL_URLS);
    const allReady = have === ALL_URLS.length;
    const charReady = await countCached(cache, PACKS.char.urls) === PACKS.char.urls.length;
    const matchReady = await countCached(cache, PACKS.match.urls) === PACKS.match.urls.length;
    label.textContent = `加角色：${charReady ? '已就绪 ✓' : '未下载'} · 找最像：${matchReady ? '已就绪 ✓' : '未下载'}`;
    $('btnCacheAll').textContent = allReady ? '全部模型已就绪 ✓' : have ? '继续下载（已完成一部分）' : '提前下载（约 130MB）';
  } catch (e) { label.textContent = '无法读取模型缓存：' + (e.message || e); }
}

async function downloadAll() {
  const label = $('modelStatus'), button = $('btnCacheAll');
  button.disabled = true;
  try {
    await navigator.serviceWorker.ready;
    if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
    const cache = await caches.open(MODEL_CACHE);
    let done = await countCached(cache, ALL_URLS);
    for (const url of ALL_URLS) {
      if (await cacheHas(cache, url)) continue;
      const key = cacheKey(url), shortName = key.slice(key.lastIndexOf('/') + 1).split('?')[0];
      // 手动流式下载以显示实时进度与速度。读完整流后才 cache.put，故中断时不写入半个文件，可续传。
      const resp = await fetch(key);
      if (!resp.ok) throw new Error(`${shortName} ${resp.status}`);
      const forCache = resp.clone();
      const total = +resp.headers.get('content-length') || 0;
      const start = performance.now();
      let received = 0, lastPaint = 0;
      if (resp.body) {
        const reader = resp.body.getReader();
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          received += value.length;
          const now = performance.now();
          if (now - lastPaint > 250) {
            lastPaint = now;
            label.textContent = `下载 ${done + 1}/${ALL_URLS.length} · ${shortName} ${total ? `${fmtMB(received)}/${fmtMB(total)}` : fmtMB(received)}MB · ${fmtSpeed(received / ((now - start) / 1000 || 1))}`;
          }
        }
      } else { await resp.arrayBuffer(); }
      await cache.put(key, forCache);
      done++;
    }
  } catch (e) {
    label.textContent = `下载中断：${e.message || e}。网络恢复后再点一次「继续下载」，已下载的不会重来。`;
    button.disabled = false;
    return;
  }
  button.disabled = false;
  updateModelStatus();
}
$('btnCacheAll').addEventListener('click', downloadAll);

$('btnClearModels').addEventListener('click', async () => {
  $('btnClearModels').disabled = true;
  try {
    await releaseAllSessions();
    await caches.delete(MODEL_CACHE);
  } finally { $('btnClearModels').disabled = false; }
  updateModelStatus();
});

$('btnMenu').addEventListener('click', () => { $('menuSheet').showModal(); updateModelStatus(); });

$('btnDiagnostics').addEventListener('click', async () => {
  const info = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    crossOriginIsolated: self.crossOriginIsolated,
    device: DEVICE,
    image: {
      anime: state.anime ? `${state.anime.width}×${state.anime.height}` : null,
      photo: state.photo ? `${state.photo.originalWidth}×${state.photo.originalHeight}` : null,
      preview: state.photo ? `${state.photo.width}×${state.photo.height}` : null,
      hasCharacter: !!state.cutout,
    },
    storage: null,
    recentErrors,
  };
  try { info.storage = await navigator.storage?.estimate?.() || null; } catch { /* 不支持时省略 */ }
  const url = URL.createObjectURL(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }));
  download(url, 'seichi-diagnostics.json');
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------- PWA 安装引导 ----------
// 安装成 PWA 后浏览器不再随意清站点数据（iOS 尤其：普通网页 7 天不访问即清空，
// 已安装的主屏幕应用豁免），是保住上百 MB 离线模型最有效的手段。
(() => {
  const tip = $('pwaTip'), btn = $('btnPwaInstall');
  const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 仅 Android/桌面 Chromium 会拿到；拦下默认横幅，改为在「更多」里按需展示
    deferredPrompt = e;
    if (!isInstalled()) btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'accepted') btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; tip.hidden = true; });
  if (DEVICE.isAppleMobile && !isInstalled()) {
    tip.textContent = '建议安装：Safari 底部「分享」→「添加到主屏幕」。否则 iOS 会在 7 天不访问后清空已下载的离线模型。';
    tip.hidden = false;
  }
})();

// ---------- 启动 ----------
updateUI();
recompute(); // 没有图片时：隐藏对比滑块等控件，只留空状态说明
loadFromQuery();

// Service Worker：把 ONNX 模型钉进 Cache Storage，二次访问/离线可用。
// file:// 或不支持时静默跳过，不影响功能。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      // GitHub Pages 无法设 COOP/COEP，改由 SW 合成（见 sw.js withCOI）。首次访问时当前
      // 文档在 SW 接管前已加载、未带隔离头，需重载一次让文档重新经 SW 取回，才能
      // crossOriginIsolated → ONNX 多线程。sessionStorage 保证最多重载一次，隔离失败也不死循环。
      if (self.crossOriginIsolated || sessionStorage.getItem('coiReloaded')) return;
      const reloadOnce = () => { sessionStorage.setItem('coiReloaded', '1'); location.reload(); };
      // controller 已就绪则立即重载；否则等 SW 接管（controllerchange）后再重载
      if (navigator.serviceWorker.controller) reloadOnce();
      else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    })
    .catch(() => {});
}

// 开发验收钩子：仅供脚本化验收调用内部函数，不出现在界面
window.__qa = { state, renderFullRes, enterAlignMode, applyAlignCrop, alignState, recompute, launchViewfinder, makeAnimeToSceneGif, openRefine, addCharacter };

// 隐藏的开发验收入口：http://localhost:8126/?qa-demo=1
if (new URLSearchParams(location.search).has('qa-demo')) {
  setStatus('正在载入演示素材…', 0);
  Promise.all([urlToImageData('./test-izu-far.jpg'), urlToImageData('./test-izu-scenery.jpg')])
    .then(([anime, photo]) => handleAnimeData(anime).then(() => handlePhotoData(photo)))
    .then(() => setStatus(''))
    .catch((e) => setStatus(`演示素材加载失败：${e.message || e}`));
}
