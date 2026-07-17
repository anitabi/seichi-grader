// viewfinder.js — 现场取景编排。自建全屏 UI（不进 index.html），把会话/叠加/拍照接到一起。
// 入口：launchViewfinder(animeSource) → Promise<HTMLCanvasElement|null>
//   animeSource: 动画参考图（ImageData / Image / Canvas）
//   resolve(canvas) = 用户拍下的照片（已裁成参考图比例）；resolve(null) = 用户取消。
// MVP 范围：摄像头 + 四叠加模式 + 透明度 + 冻结 + 拍照 + 手电筒/镜头切换。不含锚点指导。
import { CameraSession, checkSupport } from './camera-session.js';
import { OverlayRenderer } from './overlay-renderer.js';
import { capturePhoto, cropToAspect } from './capture-adapter.js';
import { rotateCanvas } from '../canvas-util.js';

const STYLE_ID = 'vf-style';
const CSS = `
.vf-root{position:fixed;inset:0;z-index:1000;background:#000;display:flex;flex-direction:column;
  touch-action:none;color:#fff;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
.vf-stage{position:relative;flex:1;overflow:hidden;background:#000;}
.vf-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;}
.vf-stage canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.vf-frozen{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;}
.vf-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#cdd3dd;}
.vf-topbar{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;
  padding:10px 12px;background:linear-gradient(#000a,#0000);z-index:3;}
.vf-topbar button{background:#0006;border:1px solid #fff4;color:#fff;border-radius:20px;padding:7px 14px;font-size:13px;}
.vf-modes{position:absolute;bottom:96px;left:0;right:0;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;padding:0 10px;z-index:3;}
.vf-modes button{background:#0007;border:1px solid #fff3;color:#fff;border-radius:18px;padding:7px 12px;font-size:12.5px;}
.vf-modes button.on{background:#2f6df0;border-color:#2f6df0;}
.vf-modes.compact button:not(.on):not(.vf-more){display:none;}
.vf-modes .vf-more{border-style:dashed;color:#cdd3dd;}
.vf-bottom{position:absolute;bottom:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:14px 22px calc(14px + env(safe-area-inset-bottom));background:linear-gradient(#0000,#000a);z-index:3;}
.vf-shutter{width:70px;height:70px;border-radius:50%;background:#fff;border:4px solid #fff6;flex:0 0 auto;}
.vf-shutter:active{transform:scale(.94);}
.vf-side{display:flex;flex-direction:column;gap:6px;align-items:center;width:64px;}
.vf-side button{background:#0007;border:1px solid #fff3;color:#fff;border-radius:16px;padding:6px 8px;font-size:11.5px;width:100%;}
.vf-side button.on{background:#c98a2f;border-color:#c98a2f;}
.vf-slider{position:absolute;bottom:150px;left:0;right:0;padding:0 24px;z-index:3;display:flex;align-items:center;gap:10px;}
.vf-slider input{flex:1;}
.vf-slider span{font-size:12px;color:#cdd3dd;min-width:70px;}
.vf-toast{position:absolute;top:56px;left:50%;transform:translateX(-50%);background:#000b;border:1px solid #fff3;
  border-radius:16px;padding:6px 14px;font-size:12.5px;z-index:4;opacity:0;transition:opacity .2s;}
.vf-toast.show{opacity:1;}
/* 户外强光模式：叠加层加对比，控件描边更亮，阳光下看得清 */
.vf-root.sunlight .vf-overlay{filter:contrast(1.35) brightness(1.18) saturate(1.1);}
.vf-root.sunlight .vf-topbar button,.vf-root.sunlight .vf-side button,.vf-root.sunlight .vf-modes button{border-color:#fff8;background:#000a;}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
  document.head.appendChild(s);
}

const MODE_LABELS = [
  ['transparent', '半透明'], ['outline', '轮廓'], ['blink', '闪烁'], ['split', '分割'],
];

function launchViewfinder(animeSource) {
  injectStyle();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'vf-root';
    // 继承主界面的户外强光模式：叠加层加对比、控件描边更亮
    const sunlight = document.documentElement.classList.contains('sunlight');
    if (sunlight) root.classList.add('sunlight');
    root.innerHTML = `
      <div class="vf-stage">
        <video playsinline muted></video>
        <canvas class="vf-overlay"></canvas>
        <img class="vf-frozen" alt="" />
        <div class="vf-msg" hidden></div>
        <div class="vf-topbar">
          <button data-act="close">✕ 关闭</button>
          <button data-act="rotate" aria-label="将动画参考图顺时针旋转 90 度">↻ 旋转 90°</button>
          <button data-act="freeze">❄️ 冻结</button>
        </div>
        <div class="vf-slider"><span data-label="opacity">透明 50%</span><input type="range" min="15" max="100" value="50" data-ctl="opacity"></div>
        <div class="vf-modes"></div>
        <div class="vf-bottom">
          <div class="vf-side">
            <button data-act="lens">切镜头</button>
            <button data-act="torch">手电</button>
          </div>
          <button class="vf-shutter" data-act="shoot" aria-label="拍照"></button>
          <div class="vf-side">
            <button data-act="quality" class="">高清</button>
            <button data-act="cancelShoot" style="visibility:hidden">重拍</button>
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
    let raf = 0, frozenState = false, qualityMode = false, closed = false;
    // 强光下默认叠加更实，阳光反光里也看得见参考轮廓
    if (sunlight) {
      renderer.setOpacity(0.72);
      const s = $('[data-ctl="opacity"]'); if (s) s.value = 72;
      const lbl = $('[data-label="opacity"]'); if (lbl) lbl.textContent = '透明 72%';
    }

    const showToast = (t, ms = 1800) => { toast.textContent = t; toast.classList.add('show'); clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.remove('show'), ms); };

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
      if (btn) btn.textContent = renderer.rotation ? `↻ 已转 ${renderer.rotation}°` : '↻ 旋转 90°';
      if (notify) {
        showToast(renderer.rotation
          ? `参考图已转 ${renderer.rotation}°；拍出的照片会自动转回横构图`
          : '参考图已恢复原方向');
      }
    }

    // 模式按钮
    const modesBox = $('.vf-modes');
    modesBox.classList.add('compact');
    MODE_LABELS.forEach(([mode, label], i) => {
      const b = document.createElement('button'); b.textContent = label; b.dataset.mode = mode;
      if (i === 0) b.classList.add('on');
      b.addEventListener('click', () => {
        modesBox.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on'); renderer.setMode(mode);
        $('[data-ctl="opacity"]').parentElement.style.display = (mode === 'split') ? 'none' : 'flex';
      });
      modesBox.appendChild(b);
    });
    // 户外拍摄绝大多数时候只要半透明。其余模式保留，但不抢占首屏空间。
    const moreModes = document.createElement('button');
    moreModes.className = 'vf-more'; moreModes.textContent = '更多叠加';
    moreModes.addEventListener('click', () => {
      const expanded = modesBox.classList.toggle('compact');
      moreModes.textContent = expanded ? '更多叠加' : '收起模式';
    });
    modesBox.appendChild(moreModes);

    $('[data-ctl="opacity"]').addEventListener('input', (e) => {
      renderer.setOpacity(+e.target.value / 100);
      $('[data-label="opacity"]').textContent = '透明 ' + e.target.value + '%';
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

    // split 模式：横向拖动移动分割线
    root.querySelector('.vf-stage').addEventListener('pointerdown', (e) => {
      if (renderer.mode !== 'split' || frozenState) return;
      const move = (ev) => {
        const r = overlay.getBoundingClientRect();
        const visible = visibleVideoRect();
        renderer.setSplit((ev.clientX - r.left - visible.x) / visible.width);
      };
      move(e);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });

    function cleanup(result) {
      if (closed) return; closed = true;
      cancelAnimationFrame(raf);
      renderer.destroy();
      session.stop();
      root.remove();
      resolve(result);
    }

    // 顶栏 / 底栏动作
    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') return cleanup(null);
      if (act === 'rotate') {
        rotateReference(renderer.rotation + 90);
        return;
      }
      if (act === 'freeze') return toggleFreeze();
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
      if (act === 'quality') {
        qualityMode = !qualityMode;
        e.target.classList.toggle('on', qualityMode);
        showToast(qualityMode ? '高清模式：更高像素，视野略宽于取景框' : '同框模式：所见即所得');
      }
      if (act === 'shoot') return doShoot();
    });

    function toggleFreeze() {
      if (frozenState) {
        frozen.style.display = 'none'; video.style.display = '';
        frozenState = false; $('[data-act="freeze"]').textContent = '❄️ 冻结';
      } else {
        // 用当前帧填充 frozen img
        try {
          const v = session.video;
          if (v && v.videoWidth) {
            const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0);
            frozen.src = c.toDataURL('image/jpeg', 0.9);
            frozen.style.display = 'block'; video.style.display = 'none';
            frozenState = true; $('[data-act="freeze"]').textContent = '▶️ 解冻';
          }
        } catch { showToast('冻结失败'); }
      }
    }

    async function doShoot() {
      try {
        showToast('拍摄中…');
        const shot = await capturePhoto(session, { level: qualityMode ? 'quality' : 'wysiwyg' });
        // 裁到（旋转后）参考图比例，保证成图画框与取景对齐一致；
        // 参考图转过角度时，成片反向转回，导出即为与动画同向的正图
        const cropped = cropToAspect(shot.canvas, renderer.aspect);
        const upright = rotateCanvas(cropped, -renderer.rotation);
        showToast(`已拍 ${upright.width}×${upright.height}（${shot.via}）`);
        cleanup(upright);
      } catch (e) {
        console.error(e); showToast('拍摄失败：' + (e.message || e));
      }
    }

    // 启动
    (async () => {
      const support = checkSupport();
      if (!support.ok) { showError(support.reason, true); return; }
      try {
        await session.start({ facing: 'environment', video });
        const info = session.getInfo();
        $('[data-act="torch"]').style.display = info.hasTorch ? '' : 'none';
        session.listRearCameras().then((cams) => { if (cams.length < 2) $('[data-act="lens"]').style.display = 'none'; });
        frameLoop();
        // 横版动画 + 竖持手机：提示两种正确姿势，避免对着被裁成竖条的虚影硬拍
        if (renderer.aspect > 1 && root.clientHeight > root.clientWidth) {
          // 大多数动画截图是横构图；竖持手机时先自动转成竖向参考，
          // 用户仍可用按钮每次再转 90°，拍照时会转回原动画方向。
          rotateReference(90, false);
          showToast('已将横版动画参考图转为竖向叠加；点「↻ 已转 90°」可继续旋转', 4500);
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
      msg.innerHTML = `<div>${text}${fatal ? '<br><br>你也可以关闭取景，用「上传实景照片」照常修图。' : ''}</div>`;
    }
  });
}

export { launchViewfinder };
