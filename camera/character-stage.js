// character-stage.js — 轻量 2D 角色摆拍取景器。
//
// 设计目标：复用现有 CameraSession/capturePhoto，不引入 WebXR、Three.js 或
// 任何 3D 模型。角色只是一张带 alpha 的 Canvas，在低清背景运动估计的帮助下
// 做“靠近变大、远离变小”的相对跟随；跟踪不可靠时始终可以手动拖动/捏合。
import { CameraSession, checkSupport } from './camera-session.js';
import { capturePhoto } from './capture-adapter.js';

const STYLE_ID = 'ar-character-stage-style';
const TRACK_W = 192;
const TRACK_H = 128;

const CSS = `
.ar-root{position:fixed;inset:0;z-index:1100;background:#000;color:#fff;display:flex;flex-direction:column;
  touch-action:none;overscroll-behavior:none;font:14px/1.45 -apple-system,"PingFang SC",sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
.ar-stage{position:relative;flex:1;min-height:0;overflow:hidden;background:#000;}
.ar-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;}
.ar-stage canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.ar-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;color:#d0d5c4;z-index:5;}
.ar-top{position:absolute;top:0;left:0;right:0;z-index:4;display:flex;align-items:center;gap:6px;padding:10px 12px;
  background:linear-gradient(#000b,#0000);}
.ar-top button,.ar-side button,.ar-bottom button{appearance:none;background:#0008;border:1px solid #fff5;color:#fff;
  border-radius:18px;padding:7px 11px;font-size:12px;touch-action:manipulation;}
.ar-top button:active,.ar-side button:active,.ar-bottom button:active{transform:scale(.96);}
.ar-top [data-ar-act="close"]{margin-right:auto;}
.ar-top .on,.ar-side .on{background:#007ea7;border-color:#35c4ef;color:#fff;}
.ar-hint{position:absolute;top:54px;left:50%;z-index:3;transform:translateX(-50%);white-space:nowrap;
  max-width:calc(100% - 34px);overflow:hidden;text-overflow:ellipsis;color:#e9f7fb;background:#0009;border:1px solid #fff3;
  border-radius:15px;padding:5px 11px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;}
.ar-hint.show{opacity:1;}
.ar-side{position:absolute;right:10px;top:50%;z-index:4;display:flex;flex-direction:column;gap:6px;transform:translateY(-50%);}
.ar-side button{min-width:74px;box-shadow:0 2px 8px #0006;}
.ar-distance{position:absolute;left:10px;top:50%;z-index:4;display:flex;flex-direction:column;align-items:center;gap:5px;
  transform:translateY(-50%);padding:8px 6px;border:1px solid #fff3;border-radius:14px;background:#0007;}
.ar-distance input{height:150px;width:24px;writing-mode:vertical-lr;direction:rtl;accent-color:#35c4ef;touch-action:none;}
.ar-distance span{font-size:10px;color:#e5f7fc;writing-mode:vertical-rl;letter-spacing:.08em;}
.ar-bottom{position:absolute;left:0;right:0;bottom:0;z-index:4;display:flex;align-items:center;justify-content:center;gap:18px;
  padding:12px 18px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(#0000,#000c);}
.ar-shutter{width:68px!important;height:68px;padding:0!important;border:4px solid #fff!important;border-radius:50%!important;
  background:#fff!important;box-shadow:0 0 0 2px #fff5,0 2px 12px #0008;}
.ar-shutter:active{transform:scale(.92)!important;}
.ar-bottom .ar-label{min-width:74px;text-align:center;color:#d0d5c4;font-size:11px;}
.ar-root.sunlight .ar-stage canvas{filter:contrast(1.18) brightness(1.12) saturate(1.04);}
.ar-root.sunlight .ar-top button,.ar-root.sunlight .ar-side button,.ar-root.sunlight .ar-distance{border-color:#fff8;background:#000b;}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function toCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source?.naturalWidth || source?.videoWidth || source?.width || 1;
  canvas.height = source?.naturalHeight || source?.videoHeight || source?.height || 1;
  const ctx = canvas.getContext('2d');
  if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
  else ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // AR 的实时绘制不需要保留超大原图；抠图结果只在预览中使用，拍照时仍由
  // app.js 的高分辨率合成链路重新绘制原始 cutout。
  const maxSide = 1536;
  const side = Math.max(canvas.width, canvas.height);
  if (side > maxSide) {
    const scale = maxSide / side;
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(canvas.width * scale));
    small.height = Math.max(1, Math.round(canvas.height * scale));
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    return small;
  }
  return canvas;
}

function visibleVideoRect(video, width, height) {
  if (!video.videoWidth || !video.videoHeight) return { x: 0, y: 0, width, height };
  const videoAspect = video.videoWidth / video.videoHeight;
  const stageAspect = width / height;
  if (videoAspect > stageAspect) {
    const h = width / videoAspect;
    return { x: 0, y: (height - h) / 2, width, height: h };
  }
  const w = height * videoAspect;
  return { x: (width - w) / 2, y: 0, width: w, height };
}

function eventPoint(event, rect) {
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) || 1; }

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// 极小的稀疏块匹配器：在低分辨率灰度帧中跟踪锚点周围纹理，估计背景的
// 平移和相对缩放。它不是 SLAM，不输出米数，只有在置信度足够时才影响角色。
class MotionTracker {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.width = TRACK_W; this.canvas.height = TRACK_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.points = [];
    this.lastTime = 0;
    this.failures = 0;
  }

  _frame() {
    if (!this.video.videoWidth || !this.video.videoHeight) return null;
    this.ctx.drawImage(this.video, 0, 0, TRACK_W, TRACK_H);
    const rgba = this.ctx.getImageData(0, 0, TRACK_W, TRACK_H).data;
    const gray = new Uint8Array(TRACK_W * TRACK_H);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return gray;
  }

  _at(frame, x, y) { return frame[(y | 0) * TRACK_W + (x | 0)] || 0; }

  _texture(frame, x, y) {
    const c = this._at(frame, x, y);
    return Math.abs(c - this._at(frame, x + 2, y)) + Math.abs(c - this._at(frame, x, y + 2));
  }

  _pickPoints(frame, anchor) {
    const out = [];
    const ax = anchor.x * TRACK_W, ay = anchor.y * TRACK_H;
    // 锚点周围取环形点，避开角色本身的中心区域；户外天空等低纹理区会被过滤。
    for (let gy = -3; gy <= 3; gy++) for (let gx = -4; gx <= 4; gx++) {
      const x = ax + gx * 12, y = ay + gy * 10;
      if (x < 8 || y < 8 || x >= TRACK_W - 8 || y >= TRACK_H - 8) continue;
      if (Math.hypot(gx / 4, gy / 3) < .42) continue;
      const score = this._texture(frame, x, y);
      if (score < 22) continue;
      out.push({ x, y, score });
    }
    out.sort((a, b) => b.score - a.score);
    const chosen = [];
    for (const p of out) {
      if (chosen.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 10)) chosen.push(p);
      if (chosen.length >= 16) break;
    }
    return chosen;
  }

  _match(frame, p) {
    const radius = 7, search = 10;
    let best = null;
    for (let dy = -search; dy <= search; dy += 2) for (let dx = -search; dx <= search; dx += 2) {
      const x = p.x + dx, y = p.y + dy;
      if (x < radius + 1 || y < radius + 1 || x >= TRACK_W - radius - 1 || y >= TRACK_H - radius - 1) continue;
      let sad = 0;
      for (let yy = -radius; yy <= radius; yy += 2) for (let xx = -radius; xx <= radius; xx += 2) {
        sad += Math.abs(this._at(this.prev, p.x + xx, p.y + yy) - this._at(frame, x + xx, y + yy));
      }
      if (!best || sad < best.sad) best = { x, y, sad };
    }
    return best;
  }

  reset(anchor, frame = null) {
    const next = frame || this._frame();
    if (!next) return false;
    this.prev = next;
    this.points = this._pickPoints(next, anchor);
    this.failures = 0;
    return this.points.length >= 5;
  }

  update(anchor, now = performance.now()) {
    if (now - this.lastTime < 90) return null;
    this.lastTime = now;
    const frame = this._frame();
    if (!frame) return null;
    if (!this.prev || this.points.length < 5) {
      this.reset(anchor, frame);
      return null;
    }
    const matched = [];
    for (const p of this.points) {
      const m = this._match(frame, p);
      if (m && m.sad < 2600) matched.push({ old: p, next: m });
    }
    if (matched.length < 5) {
      this.failures++;
      if (this.failures > 2) this.reset(anchor, frame);
      return { confidence: matched.length / Math.max(1, this.points.length), dx: 0, dy: 0, scale: 1 };
    }
    const oldC = matched.reduce((p, x) => ({ x: p.x + x.old.x, y: p.y + x.old.y }), { x: 0, y: 0 });
    const newC = matched.reduce((p, x) => ({ x: p.x + x.next.x, y: p.y + x.next.y }), { x: 0, y: 0 });
    oldC.x /= matched.length; oldC.y /= matched.length;
    newC.x /= matched.length; newC.y /= matched.length;
    const ratios = [];
    for (const x of matched) {
      const od = Math.hypot(x.old.x - oldC.x, x.old.y - oldC.y);
      const nd = Math.hypot(x.next.x - newC.x, x.next.y - newC.y);
      if (od > 5 && nd > .5) ratios.push(nd / od);
    }
    ratios.sort((a, b) => a - b);
    const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
    const result = {
      confidence: clamp(matched.length / Math.max(1, this.points.length), 0, 1),
      dx: clamp((newC.x - oldC.x) / TRACK_W, -.08, .08),
      dy: clamp((newC.y - oldC.y) / TRACK_H, -.08, .08),
      scale: clamp(ratio, .94, 1.06),
    };
    this.points = matched.map((x) => ({ x: x.next.x, y: x.next.y, score: x.old.score }));
    this.prev = frame;
    this.failures = 0;
    return result;
  }

  destroy() { this.prev = null; this.points = []; this.ctx.clearRect(0, 0, TRACK_W, TRACK_H); }
}

function drawCharacter(ctx, source, frame, state) {
  const dh = frame.height * state.relH;
  const scale = dh / source.height;
  const dw = source.width * scale;
  const cx = frame.x + frame.width * state.cx;
  const cy = frame.y + frame.height * state.cy;
  const dx = cx - dw / 2, dy = cy - dh / 2;
  const shadow = state.shadow;
  if (shadow > 0) {
    const rx = Math.max(5, dw * .42), ry = Math.max(3, dw * .095);
    ctx.save();
    ctx.translate(cx + dw * .03, dy + dh - ry * .35);
    ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    gradient.addColorStop(0, `rgba(0,0,0,${(.5 * shadow).toFixed(3)})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = state.opacity;
  if (state.flip) {
    ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0);
  }
  ctx.drawImage(source, dx, dy, dw, dh);
  ctx.restore();
  return { dx, dy, dw, dh };
}

function launchCharacterViewfinder(characterSource, options = {}) {
  injectStyle();
  return new Promise((resolve) => {
    const source = toCanvas(characterSource);
    const root = document.createElement('div');
    root.className = 'ar-root';
    if (document.documentElement.classList.contains('sunlight')) root.classList.add('sunlight');
    root.innerHTML = `
      <div class="ar-stage">
        <video playsinline muted></video>
        <canvas class="ar-overlay"></canvas>
        <div class="ar-msg" hidden></div>
        <div class="ar-top">
          <button data-ar-act="close">✕ 关闭</button>
          <button data-ar-act="auto">自动近远</button>
          <button data-ar-act="flip">左右翻转</button>
          <button data-ar-act="lock">锁定</button>
        </div>
        <div class="ar-hint" aria-live="polite"></div>
        <div class="ar-distance"><span>近</span><input type="range" min="45" max="210" step="1" value="100" aria-label="角色距离"/><span>远</span></div>
        <div class="ar-side">
          <button data-ar-act="reset">还原</button>
          <button data-ar-act="torch">手电</button>
          <button data-ar-act="lens">切镜头</button>
        </div>
        <div class="ar-bottom">
          <span class="ar-label">拖动角色<br/>双指缩放</span>
          <button class="ar-shutter" data-ar-act="shoot" aria-label="拍照"></button>
          <span class="ar-label" data-ar-status>手动距离</span>
        </div>
      </div>`;
    document.body.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    const stage = $('.ar-stage'), video = $('video'), overlay = $('.ar-overlay');
    const octx = overlay.getContext('2d');
    const msg = $('.ar-msg'), hint = $('.ar-hint'), distanceControl = $('.ar-distance input');
    const autoButton = $('[data-ar-act="auto"]'), lockButton = $('[data-ar-act="lock"]');
    const status = $('[data-ar-status]');
    const session = new CameraSession();
    const tracker = new MotionTracker(video);
    const initial = options.initial || {};
    const state = {
      cx: clamp(Number(initial.cx ?? .5), .05, .95),
      cy: clamp(Number(initial.cy ?? .64), .08, .95),
      relH: clamp(Number(initial.relH ?? .42), .08, 1.45),
      baseRelH: clamp(Number(initial.relH ?? .42), .08, 1.45),
      opacity: 1,
      shadow: .72,
      flip: !!initial.flip,
      locked: false,
      auto: false,
      lastPlacement: null,
    };
    let raf = 0, closed = false, frozen = false, motionFrame = 0;
    const pointers = new Map();
    let gesture = null;

    function showHint(text, ms = 1800) {
      hint.textContent = text; hint.classList.add('show');
      clearTimeout(showHint.timer); showHint.timer = setTimeout(() => hint.classList.remove('show'), ms);
    }

    function frameRect() {
      const r = overlay.getBoundingClientRect();
      if (overlay.width !== Math.round(r.width) || overlay.height !== Math.round(r.height)) {
        overlay.width = Math.max(1, Math.round(r.width)); overlay.height = Math.max(1, Math.round(r.height));
      }
      return visibleVideoRect(video, overlay.width, overlay.height);
    }

    function draw() {
      if (closed) return;
      const frame = frameRect();
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!frozen) {
        const box = drawCharacter(octx, source, frame, state);
        state.lastPlacement = { ...box, frame: { ...frame }, cx: state.cx, cy: state.cy, relH: state.relH, flip: state.flip };
      }
      raf = requestAnimationFrame(draw);
    }

    function resetTracker() {
      if (!state.auto) return;
      const frame = frameRect();
      tracker.reset({ x: (frame.x + frame.width * state.cx) / overlay.width, y: (frame.y + frame.height * state.cy) / overlay.height });
    }

    function setAuto(on, notify = true) {
      state.auto = !!on;
      autoButton.classList.toggle('on', state.auto);
      status.textContent = state.auto ? '自动近远' : '手动距离';
      clearTimeout(motionFrame);
      if (state.auto) {
        resetTracker();
        if (notify) showHint('已开启自动近远：走近放大，走远缩小');
        animateMotion();
      } else if (notify) showHint('已切回手动距离');
    }

    function setScaleFromControl(value) {
      const factor = clamp(Number(value) / 100, .45, 2.1);
      state.relH = clamp(state.baseRelH * factor, .08, 1.45);
      distanceControl.value = String(Math.round(factor * 100));
      if (state.auto) resetTracker();
    }

    function stagePoint(event) { return eventPoint(event, overlay.getBoundingClientRect()); }

    function applySingleDrag(p) {
      if (!gesture || state.locked) return;
      const frame = frameRect();
      state.cx = clamp(gesture.cx + (p.x - gesture.x) / frame.width, .02, .98);
      state.cy = clamp(gesture.cy + (p.y - gesture.y) / frame.height, .04, .98);
    }

    stage.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button,input')) return;
      event.preventDefault();
      const p = stagePoint(event);
      pointers.set(event.pointerId, p);
      stage.setPointerCapture?.(event.pointerId);
      if (pointers.size === 1 && !state.locked) {
        if (state.auto) setAuto(false, false);
        gesture = { type: 'drag', x: p.x, y: p.y, cx: state.cx, cy: state.cy };
      } else if (pointers.size === 2 && !state.locked) {
        const [a, b] = [...pointers.values()];
        gesture = { type: 'pinch', distance: distance(a, b), midpoint: midpoint(a, b), relH: state.relH, cx: state.cx, cy: state.cy };
        if (state.auto) setAuto(false, false);
      }
    });

    stage.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, stagePoint(event));
      if (pointers.size === 1 && gesture?.type === 'drag') applySingleDrag([...pointers.values()][0]);
      if (pointers.size >= 2 && gesture?.type === 'pinch') {
        const [a, b] = [...pointers.values()];
        const nowMid = midpoint(a, b);
        const frame = frameRect();
        const ratio = distance(a, b) / gesture.distance;
        state.relH = clamp(gesture.relH * ratio, .08, 1.45);
        state.cx = clamp(gesture.cx + (nowMid.x - gesture.midpoint.x) / frame.width, .02, .98);
        state.cy = clamp(gesture.cy + (nowMid.y - gesture.midpoint.y) / frame.height, .04, .98);
        distanceControl.value = String(Math.round(state.relH / state.baseRelH * 100));
      }
    });

    function release(event) {
      pointers.delete(event.pointerId);
      if (!pointers.size) gesture = null;
      else if (pointers.size === 1 && !state.locked) {
        const p = [...pointers.values()][0];
        gesture = { type: 'drag', x: p.x, y: p.y, cx: state.cx, cy: state.cy };
      }
    }
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    distanceControl.addEventListener('input', (event) => {
      if (state.locked) return;
      if (state.auto) setAuto(false, false);
      setScaleFromControl(event.target.value);
      status.textContent = '手动距离';
    });

    root.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-ar-act]')?.dataset.arAct;
      if (!action) return;
      if (action === 'close') return cleanup(null);
      if (action === 'auto') return setAuto(!state.auto);
      if (action === 'flip') { state.flip = !state.flip; showHint(state.flip ? '已左右翻转角色' : '已恢复原方向'); return; }
      if (action === 'lock') {
        state.locked = !state.locked;
        lockButton.classList.toggle('on', state.locked);
        lockButton.textContent = state.locked ? '已锁定 🔒' : '锁定';
        showHint(state.locked ? '角色已锁定' : '角色可继续调整');
        return;
      }
      if (action === 'reset') {
        state.cx = clamp(Number(initial.cx ?? .5), .05, .95);
        state.cy = clamp(Number(initial.cy ?? .64), .08, .95);
        state.relH = state.baseRelH; state.flip = !!initial.flip;
        distanceControl.value = '100'; resetTracker(); showHint('角色已还原'); return;
      }
      if (action === 'torch') {
        const button = event.target.closest('[data-ar-act="torch"]');
        const on = !button.classList.contains('on');
        const ok = await session.setTorch(on);
        if (ok) button.classList.toggle('on', on); else showHint('此镜头不支持手电筒');
        return;
      }
      if (action === 'lens') {
        const label = await session.cycleLens().catch(() => false);
        showHint(label ? ('镜头：' + label) : '只有一个可用镜头'); return;
      }
      if (action === 'shoot') return shoot();
    });

    function animateMotion() {
      if (closed || !state.auto || frozen || state.locked) return;
      const frame = frameRect();
      const anchor = { x: (frame.x + frame.width * state.cx) / overlay.width, y: (frame.y + frame.height * state.cy) / overlay.height };
      const result = tracker.update(anchor);
      if (result && result.confidence >= .42) {
        state.cx = clamp(state.cx + result.dx, .02, .98);
        state.cy = clamp(state.cy + result.dy, .04, .98);
        // 背景纹理扩张意味着镜头接近，角色随之变大。
        state.relH = clamp(state.relH * (1 + (result.scale - 1) * .72), .08, 1.45);
        distanceControl.value = String(Math.round(state.relH / state.baseRelH * 100));
      }
      motionFrame = setTimeout(animateMotion, 100);
    }

    function cleanup(result) {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(raf); clearTimeout(motionFrame);
      tracker.destroy(); session.stop(); root.remove(); resolve(result);
    }

    async function shoot() {
      if (state.locked) { /* 锁定只防误触，不妨碍拍照 */ }
      try {
        showHint('拍摄中…', 6000);
        // AR 取景必须与用户所见一致，暂时固定 WYSIWYG/grabFrame。
        const shot = await capturePhoto(session, { level: 'wysiwyg' });
        const placement = {
          cx: state.cx, cy: state.cy, relH: state.relH, baseRelH: state.baseRelH,
          flip: state.flip, sourceWidth: source.width, sourceHeight: source.height,
        };
        cleanup({ canvas: shot.canvas, placement, via: shot.via });
      } catch (error) {
        console.error(error); showHint('拍摄失败：' + (error.message || error), 3500);
      }
    }

    (async () => {
      const support = checkSupport();
      if (!support.ok) { showError(support.reason); return; }
      try {
        await session.start({ facing: 'environment', video });
        const info = session.getInfo();
        $('[data-ar-act="torch"]').style.display = info.hasTorch ? '' : 'none';
        session.listRearCameras().then((cams) => { if (cams.length < 2) $('[data-ar-act="lens"]').style.display = 'none'; });
        draw();
        setAuto(true, false);
        showHint('自动近远已开启；拖动放置，双指捏合可手动调整', 3200);
      } catch (error) { showError(error.message || String(error)); }
    })();

    function showError(text) {
      msg.hidden = false;
      msg.innerHTML = `<div>${text}<br><br>你可以关闭取景，继续使用普通上传流程。</div>`;
    }

    // 自动模式在相机准备好后启动；用户一旦拖动或捏合，立即回到手动控制。
  });
}

export { launchCharacterViewfinder };
