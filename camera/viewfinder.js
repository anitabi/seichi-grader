// viewfinder.js — 现场取景编排。自建全屏 UI（不进 index.html），把会话/叠加/拍照接到一起。
// 入口：launchViewfinder(animeSource, options) → Promise<HTMLCanvasElement|null>
//   animeSource: 动画参考图（ImageData / Image / Canvas）
//   resolve(canvas) = 用户拍下并确认使用的照片（已裁成参考图比例）；resolve(null) = 用户取消。
// 户外用的取舍：默认就是「强光可读」的叠加（提高对比 + 更实的虚影），不再有单独的强光开关；
// 叠加只保留「半透明」与「轮廓」两种——阳光下半透明会发白，切到轮廓就能看清；
// 拍完先给你看一眼（重拍 / 使用），而不是拍完立刻退出去才发现糊了。
import { CameraSession, checkSupport } from './camera-session.js';
import { OverlayRenderer } from './overlay-renderer.js?v=20260929-redesign';
import { capturePhoto, cropToAspect } from './capture-adapter.js';
import { rotateCanvas } from '../canvas-util.js';

const STYLE_ID = 'vf-style';
const CSS = `
.vf-root{position:fixed;inset:0;z-index:1000;background:#000;display:flex;flex-direction:column;
  touch-action:none;color:#fff;font:15px/1.5 -apple-system,"PingFang SC",sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
.vf-stage{position:relative;flex:1;overflow:hidden;background:#000;}
.vf-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;}
.vf-stage canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.vf-overlay{filter:contrast(1.35) brightness(1.18) saturate(1.1);}
.vf-frozen{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;background:#000;}
.vf-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#e2e8dc;z-index:2;}
.vf-root button{font:inherit;font-weight:600;color:#fff;min-height:48px;border-radius:24px;padding:0 18px;border:0;background:rgba(20,30,40,.55);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 0 0 1px rgba(255,255,255,.22) inset;}
.vf-root button:active{background:rgba(20,30,40,.78);}
.vf-top{position:absolute;top:0;left:0;right:0;display:flex;gap:8px;align-items:center;padding:10px 12px;
  background:linear-gradient(#000b,#0000);z-index:3;}
.vf-top [data-act="close"]{margin-right:auto;}
.vf-dock{position:absolute;left:0;right:0;bottom:0;z-index:3;padding:0 16px 14px;background:linear-gradient(#0000,#000c 50%);}
.vf-tune{display:flex;align-items:center;gap:12px;padding:26px 0 8px;}
.vf-seg{display:flex;flex:none;}
.vf-seg button{min-height:44px;padding:0 16px;border-radius:0;}
.vf-seg button:first-child{border-radius:22px 0 0 22px;}
.vf-seg button:last-child{border-radius:0 22px 22px 0;}
.vf-seg button.on{background:linear-gradient(135deg,#0a67b8,#1f97ea);box-shadow:none;}
.vf-tune input{flex:1;min-width:0;height:44px;accent-color:#1f97ea;}
.vf-tune span{font-size:13px;min-width:48px;text-align:right;color:#e2e8dc;font-variant-numeric:tabular-nums;}
.vf-bar{display:flex;align-items:center;justify-content:space-between;}
.vf-bar>*{flex:0 0 76px;}
.vf-bar button.side{padding:0;width:76px;font-size:14px;}
.vf-bar button.on{background:linear-gradient(135deg,#0a67b8,#1f97ea);box-shadow:none;}
.vf-shutter{width:76px;height:76px;min-height:76px!important;border-radius:50%!important;background:#fff!important;border:5px solid #fff6!important;padding:0!important;}
.vf-shutter:active{transform:scale(.93);}
.vf-review{display:none;gap:12px;padding-top:8px;}
.vf-review button{flex:1;min-height:56px;font-size:16px;}
.vf-review [data-act="use"]{background:linear-gradient(135deg,#0a67b8,#1f97ea);box-shadow:none;}
.vf-root.reviewing .vf-tune,.vf-root.reviewing .vf-bar,.vf-root.reviewing .vf-overlay,.vf-root.reviewing [data-act="changeReference"],.vf-root.reviewing [data-act="rotate"]{display:none;}
.vf-root.reviewing .vf-review{display:flex;}
.vf-toast{position:absolute;top:66px;left:50%;transform:translateX(-50%);max-width:88%;text-align:center;background:#000d;border:1px solid #fff4;
  border-radius:16px;padding:7px 14px;font-size:14px;z-index:4;opacity:0;transition:opacity .2s;pointer-events:none;}
.vf-toast.show{opacity:1;}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
  document.head.appendChild(s);
}

function launchViewfinder(animeSource, options = {}) {
  injectStyle();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'vf-root';
    root.innerHTML = `
      <div class="vf-stage">
        <video playsinline muted></video>
        <canvas class="vf-overlay"></canvas>
        <img class="vf-frozen" alt="" />
        <div class="vf-msg" hidden></div>
        <div class="vf-top">
          <button data-act="close">✕ 关闭</button>
          <button data-act="changeReference">换动画</button>
          <button data-act="rotate" aria-label="将动画参考图顺时针旋转 90 度">↻ 旋转</button>
        </div>
        <input type="file" data-ctl="referenceFile" accept="image/jpeg,image/png,image/webp,.heic,.heif" hidden />
        <div class="vf-dock">
          <div class="vf-tune">
            <div class="vf-seg" data-ctl="mode">
              <button data-mode="transparent" class="on">半透明</button>
              <button data-mode="outline">轮廓</button>
            </div>
            <input type="range" min="15" max="100" value="60" data-ctl="opacity" aria-label="虚影浓度">
            <span data-label="opacity">60%</span>
          </div>
          <div class="vf-bar">
            <button class="side" data-act="lens">切镜头</button>
            <button class="vf-shutter" data-act="shoot" aria-label="拍照"></button>
            <button class="side" data-act="torch">手电</button>
          </div>
          <div class="vf-review">
            <button data-act="retake">重拍</button>
            <button data-act="use">✓ 使用这张</button>
          </div>
        </div>
        <div class="vf-toast"></div>
      </div>`;
    document.body.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    const video = $('video'), overlay = $('.vf-overlay'), frozen = $('.vf-frozen'), msg = $('.vf-msg');
    const toast = $('.vf-toast');
    const octx = overlay.getContext('2d');
    const session = new CameraSession();
    const renderer = new OverlayRenderer(animeSource);
    let raf = 0, closed = false, shot = null, shotUrl = '';
    renderer.setOpacity(0.6);

    const showToast = (t, ms = 1800) => { toast.textContent = t; toast.classList.add('show'); clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.remove('show'), ms); };

    $('[data-ctl="referenceFile"]').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        showToast('正在更换动画截图…');
        let nextSource;
        if (options.onReferenceChange) nextSource = await options.onReferenceChange(file);
        else {
          const bitmap = await createImageBitmap(file);
          renderer.setSource(bitmap); bitmap.close?.();
          nextSource = null;
        }
        if (nextSource) renderer.setSource(nextSource);
        showToast('动画截图已更换');
      } catch (error) {
        console.error(error);
        showToast('更换失败：' + (error.message || error), 3200);
      } finally {
        event.target.value = '';
      }
    });

    // CSS 中 video 用 object-fit: contain；叠加图必须只画在视频实际可见的区域，
    // 否则竖屏下上下的黑边会让参考构图与拍出的画面错位。
    function visibleVideoRect() {
      const w = overlay.width, h = overlay.height;
      if (!video.videoWidth || !video.videoHeight) return { x: 0, y: 0, width: w, height: h };
      const videoAspect = video.videoWidth / video.videoHeight;
      const stageAspect = w / h;
      if (videoAspect > stageAspect) {
        const height = w / videoAspect;
        return { x: 0, y: (h - height) / 2, width: w, height };
      }
      const width = h * videoAspect;
      return { x: (w - width) / 2, y: 0, width, height: h };
    }

    function rotateReference(deg, notify = true) {
      renderer.setRotation(deg);
      const btn = $('[data-act="rotate"]');
      if (btn) btn.textContent = renderer.rotation ? `↻ 已转 ${renderer.rotation}°` : '↻ 旋转';
      if (notify) {
        showToast(renderer.rotation
          ? `虚影已转 ${renderer.rotation}°；拍出的照片会自动转回横构图`
          : '虚影已恢复原方向');
      }
    }

    $('[data-ctl="mode"]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      renderer.setMode(b.dataset.mode);
    });

    $('[data-ctl="opacity"]').addEventListener('input', (e) => {
      renderer.setOpacity(+e.target.value / 100);
      $('[data-label="opacity"]').textContent = e.target.value + '%';
    });

    // 覆盖层每帧重绘（叠加层与实时画面同步）
    function frameLoop() {
      if (closed) return;
      const rect = overlay.getBoundingClientRect();
      if (overlay.width !== rect.width || overlay.height !== rect.height) {
        overlay.width = Math.round(rect.width); overlay.height = Math.round(rect.height);
      }
      renderer.render(octx, overlay.width, overlay.height, visibleVideoRect());
      raf = requestAnimationFrame(frameLoop);
    }

    function cleanup(result) {
      if (closed) return; closed = true;
      cancelAnimationFrame(raf);
      renderer.destroy();
      session.stop();
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      root.remove();
      resolve(result);
    }

    // 拍完先看一眼：显示成片，确认再交回主界面
    async function review(canvas) {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      if (closed) return; // 点快门后立刻点了 ✕：不再创建 URL（没人会回收它）
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      shotUrl = URL.createObjectURL(blob);
      frozen.src = shotUrl; frozen.style.display = 'block'; video.style.display = 'none';
      root.classList.add('reviewing');
      shot = canvas;
    }

    function backToLive() {
      root.classList.remove('reviewing');
      frozen.style.display = 'none'; video.style.display = '';
      shot = null;
    }

    async function doShoot() {
      try {
        showToast('拍摄中…');
        const result = await capturePhoto(session, { level: 'wysiwyg' });
        // 裁到（旋转后）参考图比例，保证成图画框与取景对齐一致；
        // 参考图转过角度时，成片反向转回，导出即为与动画同向的正图
        const cropped = cropToAspect(result.canvas, renderer.aspect);
        const upright = rotateCanvas(cropped, -renderer.rotation);
        await review(upright);
        showToast(`已拍 ${upright.width}×${upright.height} · 检查一下是否清晰`, 2600);
      } catch (e) {
        console.error(e); showToast('拍摄失败：' + (e.message || e));
      }
    }

    // 顶栏 / 底栏动作
    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') return cleanup(null);
      if (act === 'changeReference') { $('[data-ctl="referenceFile"]').click(); return; }
      if (act === 'rotate') { rotateReference(renderer.rotation + 90); return; }
      if (act === 'retake') { backToLive(); return; }
      if (act === 'use') { if (shot) cleanup(shot); return; }
      if (act === 'lens') {
        const label = await session.cycleLens().catch(() => false);
        showToast(label ? ('镜头：' + label) : '只有一个可用镜头');
      }
      if (act === 'torch') {
        const btn = e.target.closest('[data-act="torch"]');
        const on = !btn.classList.contains('on');
        const ok = await session.setTorch(on);
        if (ok) btn.classList.toggle('on', on); else showToast('此镜头不支持手电筒');
      }
      if (act === 'shoot') return doShoot();
    });

    // 启动
    (async () => {
      const support = checkSupport();
      if (!support.ok) { showError(support.reason, true); return; }
      try {
        await session.start({ facing: 'environment', video });
        const info = session.getInfo();
        $('[data-act="torch"]').style.visibility = info.hasTorch ? '' : 'hidden';
        session.listRearCameras().then((cams) => { if (cams.length < 2) $('[data-act="lens"]').style.visibility = 'hidden'; });
        frameLoop();
        // 大多数动画截图是横构图；竖持手机时先自动转成竖向参考，
        // 用户仍可用按钮每次再转 90°，拍照时会转回原动画方向。
        if (renderer.aspect > 1 && root.clientHeight > root.clientWidth) {
          rotateReference(90, false);
          showToast('已把横版动画虚影转成竖向；点「↻」可继续旋转', 4500);
        }
      } catch (e) {
        showError(e.message || String(e), true);
      }
    })();

    session.addEventListener('suspended', () => showToast('已暂停（切到后台）'));
    session.addEventListener('resumed', () => showToast('已恢复'));
    session.addEventListener('error', (e) => showError(e.detail?.message || '摄像头错误', false));

    function showError(text, fatal) {
      msg.hidden = false;
      msg.innerHTML = `<div>${text}${fatal ? '<br><br>你也可以关闭取景，用「选择已有照片」照常修图。' : ''}</div>`;
    }
  });
}

export { launchViewfinder };
