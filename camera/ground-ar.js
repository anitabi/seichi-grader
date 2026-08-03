// ground-ar.js — 真正使用系统地面追踪的 2D 角色 AR。
//
// 角色素材仍然是透明 PNG；这里只把它包装成一个四顶点的竖直 GLB 平面，用来触发：
//   Android Chrome → WebXR Hit Test / ARCore
//   iPhone Safari   → AR Quick Look（model-viewer 在本机临时生成 USDZ）
// 因此放置点属于现实世界坐标，走近/走远的透视缩放由系统 AR 完成。

const MODEL_VIEWER_URL = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js';
const STYLE_ID = 'ground-ar-style';
let modelViewerPromise = null;

const CSS = [
  '.gar-root{position:fixed;inset:0;z-index:1200;background:#080b10;color:#fff;display:flex;flex-direction:column;',
  'font:14px/1.5 -apple-system,"PingFang SC",sans-serif;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}',
  '.gar-head{height:54px;flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #ffffff1f;background:#0e131b;}',
  '.gar-head strong{font-size:15px}.gar-head span{font-size:11px;color:#9fb0bf}.gar-head button{margin-left:auto;}',
  '.gar-main{position:relative;flex:1;min-height:0;overflow:hidden;}',
  '.gar-main model-viewer{width:100%;height:100%;background:radial-gradient(circle at 50% 45%,#27313d,#090c11 72%);}',
  '.gar-close,.gar-size button{appearance:none;border:1px solid #ffffff4d;background:#0009;color:#fff;border-radius:18px;padding:7px 13px;}',
  '.gar-panel{position:absolute;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:4;display:flex;flex-direction:column;gap:9px;',
  'padding:12px;border:1px solid #ffffff35;border-radius:16px;background:#05080dcc;backdrop-filter:blur(8px);}',
  '.gar-status{text-align:center;color:#d9edf5;font-size:12px;min-height:18px;}',
  '.gar-size{display:flex;align-items:center;gap:9px}.gar-size label{white-space:nowrap;font-size:12px;color:#c5d3dc}.gar-size input{flex:1;accent-color:#35c4ef;}',
  '.gar-launch{appearance:none;width:100%;border:0;border-radius:14px;background:#00a7e1;color:#fff;font-size:16px;font-weight:700;padding:13px 18px;',
  'box-shadow:0 5px 20px #007ea755;touch-action:manipulation;}',
  '.gar-launch:active{transform:scale(.985)}.gar-launch[disabled]{opacity:.48;box-shadow:none;}',
  '.gar-note{text-align:center;color:#8fa0ad;font-size:10.5px;}',
  '.gar-error{color:#ffb8b8;}',
  '.gar-root.sunlight .gar-panel{background:#000e;border-color:#fff9}.gar-root.sunlight .gar-launch{background:#007ea7;}',
].join('');

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function ensureModelViewer() {
  if (customElements.get('model-viewer')) return Promise.resolve();
  if (!modelViewerPromise) {
    modelViewerPromise = import(MODEL_VIEWER_URL).then(() => customElements.whenDefined('model-viewer'));
  }
  return modelViewerPromise;
}

function align4(value) { return (value + 3) & ~3; }

function bytesOf(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// 生成一个只有 4 个顶点、2 个三角形的竖直透明角色立牌。
// GLB 使用米作为单位，底边 y=0，系统 AR 会把它落到检测出的水平面上。
function buildBillboardGLB(pngBytes, pixelWidth, pixelHeight, heightMeters = 1.65) {
  const h = Math.max(.2, Math.min(4, Number(heightMeters) || 1.65));
  const w = h * Math.max(.08, pixelWidth / Math.max(1, pixelHeight));
  const hw = w / 2;
  const positions = new Float32Array([
    -hw, 0, 0,  hw, 0, 0,  hw, h, 0,  -hw, h, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
  const uvs = new Float32Array([
    0, 1,  1, 1,  1, 0,  0, 0,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const sources = [bytesOf(positions), bytesOf(normals), bytesOf(uvs), bytesOf(indices), pngBytes];
  const offsets = [];
  let total = 0;
  for (const source of sources) {
    total = align4(total);
    offsets.push(total);
    total += source.byteLength;
  }
  total = align4(total);
  const bin = new Uint8Array(total);
  sources.forEach((source, index) => bin.set(source, offsets[index]));

  const gltf = {
    asset: { version: '2.0', generator: 'seichi-grader-ground-ar' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
      }],
    }],
    materials: [{
      name: 'Anime character',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      alphaMode: 'BLEND',
      doubleSided: true,
      extensions: { KHR_materials_unlit: {} },
    }],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-hw, 0, 0], max: [hw, h, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: sources[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: sources[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: sources[2].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: sources[3].byteLength, target: 34963 },
      { buffer: 0, byteOffset: offsets[4], byteLength: sources[4].byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  let jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const paddedJSON = new Uint8Array(align4(jsonBytes.byteLength));
  paddedJSON.fill(0x20);
  paddedJSON.set(jsonBytes);
  const paddedBIN = new Uint8Array(align4(bin.byteLength));
  paddedBIN.set(bin);
  const length = 12 + 8 + paddedJSON.byteLength + 8 + paddedBIN.byteLength;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  view.setUint32(12, paddedJSON.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, paddedJSON.byteLength).set(paddedJSON);
  const binHeader = 20 + paddedJSON.byteLength;
  view.setUint32(binHeader, paddedBIN.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  new Uint8Array(out, binHeader + 8, paddedBIN.byteLength).set(paddedBIN);
  return out;
}

function sourceToPreviewCanvas(source, maxSide = 1536) {
  const srcW = source.naturalWidth || source.width || 1;
  const srcH = source.naturalHeight || source.height || 1;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (source instanceof ImageData) {
    const fullSize = document.createElement('canvas');
    fullSize.width = srcW;
    fullSize.height = srcH;
    fullSize.getContext('2d').putImageData(source, 0, 0);
    ctx.drawImage(fullSize, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

async function canvasPNG(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法生成角色透明纹理');
  return blob;
}

async function launchGroundAR(characterSource, options = {}) {
  injectStyle();
  const preview = sourceToPreviewCanvas(characterSource);
  const pngBlob = await canvasPNG(preview);
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const heightMeters = Math.max(.8, Math.min(2.2, Number(options.heightMeters) || 1.65));
  const glb = buildBillboardGLB(pngBytes, preview.width, preview.height, heightMeters);
  const glbURL = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const posterURL = URL.createObjectURL(pngBlob);

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'gar-root';
    if (document.documentElement.classList.contains('sunlight')) root.classList.add('sunlight');
    root.innerHTML =
      '<div class="gar-head"><div><strong>地面 AR 角色</strong><br><span>系统空间追踪 · 不是屏幕贴图</span></div>' +
      '<button class="gar-close" type="button">关闭</button></div>' +
      '<div class="gar-main">' +
      '<model-viewer ar ar-modes="webxr quick-look" ar-placement="floor" ar-scale="fixed" xr-environment ' +
      'camera-controls interaction-prompt="none" loading="eager" reveal="auto" shadow-intensity="1.2" shadow-softness=".8" ' +
      'alt="抠出的动画角色透明立牌"></model-viewer>' +
      '<div class="gar-panel">' +
      '<div class="gar-status">正在准备地面 AR…</div>' +
      '<div class="gar-size"><label>角色身高 <b>165cm</b></label><input type="range" min="80" max="220" value="165" step="5"></div>' +
      '<button class="gar-launch" type="button" disabled>扫描地面并放置角色</button>' +
      '<div class="gar-note">缓慢移动手机扫描地面；出现放置标记后点一下。放下后走近/走远会自然变化。</div>' +
      '</div></div>';
    document.body.appendChild(root);

    const viewer = root.querySelector('model-viewer');
    const status = root.querySelector('.gar-status');
    const launch = root.querySelector('.gar-launch');
    const range = root.querySelector('.gar-size input');
    const heightLabel = root.querySelector('.gar-size b');
    let closed = false;

    function cleanup(result) {
      if (closed) return;
      closed = true;
      root.remove();
      setTimeout(() => {
        URL.revokeObjectURL(glbURL);
        URL.revokeObjectURL(posterURL);
      }, 1500);
      resolve(result);
    }

    root.querySelector('.gar-close').addEventListener('click', () => cleanup(null));
    range.value = String(Math.round(heightMeters * 100 / 5) * 5);
    heightLabel.textContent = range.value + 'cm';
    range.addEventListener('input', () => {
      const factor = Number(range.value) / (heightMeters * 100);
      viewer.setAttribute('scale', factor + ' ' + factor + ' ' + factor);
      heightLabel.textContent = range.value + 'cm';
    });

    launch.addEventListener('click', () => {
      // activateAR 必须直接发生在用户点击回调里，不能隔一层 await。
      const attempt = viewer.activateAR();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch((error) => {
          console.error(error);
          status.classList.add('gar-error');
          status.textContent = '此浏览器无法启动系统 AR；iPhone 请使用 Safari，Android 请使用 Chrome。';
        });
      }
    });

    viewer.addEventListener('ar-status', (event) => {
      const state = event.detail && event.detail.status;
      if (state === 'session-started') status.textContent = '正在扫描地面，请缓慢左右移动手机…';
      else if (state === 'object-placed') status.textContent = '角色已固定在地面，可以绕着它移动';
      else if (state === 'failed') {
        status.classList.add('gar-error');
        status.textContent = '系统 AR 启动失败；iPhone 请用 Safari，Android 请用 Chrome。';
      }
    });
    viewer.addEventListener('ar-tracking', (event) => {
      if (event.detail && event.detail.status === 'not-tracking') status.textContent = '暂时失去地面，请对准有纹理、光线充足的位置';
    });
    viewer.addEventListener('error', (event) => {
      console.error('地面 AR 模型加载失败', event);
      status.classList.add('gar-error');
      status.textContent = '角色 AR 载体生成失败，请关闭后重试';
    });

    ensureModelViewer().then(() => {
      viewer.src = glbURL;
      viewer.poster = posterURL;
      viewer.addEventListener('load', () => {
        launch.disabled = false;
        status.textContent = viewer.canActivateAR
          ? '角色已准备好，点击下方按钮开始扫描地面'
          : '设备支持情况将在点击后由系统确认';
      }, { once: true });
    }).catch((error) => {
      console.error(error);
      status.classList.add('gar-error');
      status.textContent = '地面 AR 组件加载失败，请检查网络后重试';
    });
  });
}

export { buildBillboardGLB, launchGroundAR };
