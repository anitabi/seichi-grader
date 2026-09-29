// sw.js — 模型持久缓存与多线路下载。
// ONNX 模型与 onnxruntime-web 运行时采用 cache-first；它们仅在用户按需下载离线包
// 或实际运行 AI 时进入 Cache Storage。其余请求不拦截（开发时改代码即时生效）。
importScripts('./model-mirrors.js');
const CACHE = 'seichi-models-v8'; // v8: 模型改同源加载（整站迁 GitHub Pages），旧 github.io 缓存键作废
const APP_CACHE = 'seichi-app-v38'; // v38: 一屏主线界面重做（合并手机端改版 + 模型多线路）
const ROUTE_CACHE = 'seichi-route'; // 页面测速后写入的线路顺序（__model-route.json）
const APP_SHELL = [
  './', './index.html', './style.css', './app.js', './model-mirrors.js', './color.js', './segment.js',
  './ai-segment.js', './detect.js', './sam-segment.js', './ort-env.js', './platform.js', './canvas-util.js', './ai-worker.js', './embed.js', './image-io.js', './gif.js',
  './camera/camera-session.js', './camera/overlay-renderer.js', './camera/capture-adapter.js', './camera/viewfinder.js',
  './manifest.webmanifest', './icon.svg', './icon-180.png',
];
const SHOULD_CACHE = (url) => /\/models\/.+\.onnx(\.part\d+)?($|\?)|cdn\.jsdelivr\.net\/npm\/onnxruntime-web/.test(url);

// GitHub Pages 无法设置响应头，而 ONNX 多线程 WASM 需要 crossOriginIsolated（即文档带
// COOP:same-origin + COEP:require-corp）。这里由 SW 给同源响应合成这三个头，等效于原来
// Cloudflare 上 _headers 的作用。跨源响应（jsDelivr 运行时，以 CORS 方式加载已满足 COEP）
// 保持原样，绝不改写——改写会破坏它们。
function withCOI(resp) {
  if (!resp) return resp;
  if (resp.type === 'cors' || resp.type === 'opaque' || resp.type === 'opaqueredirect') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// ---------- 多线路下载（线路定义见 model-mirrors.js）----------
const MIRRORS = (self.SEICHI_MODEL_MIRRORS || []).filter((m) => m && m.base);
const ORT_RE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@([^/]+)\/dist\/([^/?#]+)/;

async function routeOrder() {
  try {
    const cache = await caches.open(ROUTE_CACHE);
    const hit = await cache.match(new URL('./__model-route.json', self.registration.scope).href);
    const order = hit && (await hit.json()).order;
    if (Array.isArray(order)) return order;
  } catch { /* 读不到就按配置顺序 */ }
  return [];
}

// 同一个文件在各线路上的地址，按测速顺序排列；原地址永远排在最后兜底。
// 模型：<base>/models/<文件名>；运行时：托管了它的线路走 <base>/ort/<版本>/<文件名>。
async function mirrorSources(url) {
  const order = await routeOrder();
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  const ort = url.match(ORT_RE);
  const model = !ort && new URL(url).pathname.match(/\/models\/([^/]+)$/);
  const sources = [];
  for (const m of [...MIRRORS].sort((a, b) => rank(a.id) - rank(b.id))) {
    let src = url;
    if (m.base !== '.') {
      if (ort && m.ort) src = `${m.base}/ort/${ort[1]}/${ort[2]}`;
      else if (model) src = `${m.base}/models/${model[1]}`;
    }
    if (!sources.includes(src)) sources.push(src);
  }
  if (!sources.includes(url)) sources.push(url);
  return sources;
}

async function fetchViaMirrors(request) {
  if (MIRRORS.length < 2) return fetch(request);
  let lastResp = null, lastError = null;
  for (const src of await mirrorSources(request.url)) {
    try {
      if (src === request.url) {
        const resp = await fetch(request);
        if (resp.ok) return resp;
        lastResp = resp;
        continue;
      }
      const resp = await fetch(src, { mode: 'cors', credentials: 'omit' });
      // 重新包一层：响应地址对页面仍是原地址（模块脚本按它解析相对路径），类型也不再是 cors
      if (resp.ok) return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      lastResp = resp;
    } catch (error) { lastError = error; }
  }
  if (lastResp) return lastResp;
  throw lastError || new Error('所有下载线路都不可用');
}

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(APP_CACHE);
  await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keep = new Set([CACHE, APP_CACHE, ROUTE_CACHE]);
  await Promise.all((await caches.keys()).filter((name) => name.startsWith('seichi-') && !keep.has(name)).map((name) => caches.delete(name)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 线路测速必须直连网络：命中缓存或被改道，测出来的就不是这条线路的速度
  if (url.searchParams.has('__probe')) return;
  if (!SHOULD_CACHE(e.request.url)) {
    if (url.origin !== self.location.origin) return;
    // 程序文件用 network-first：开发时立即看到改动，断网时仍能启动完整页面。
    // 注意：cache.put 必须放进 waitUntil 后台执行，不能 await 在 return resp 之前——
    // 否则图片类请求会在 clone 流的背压上死锁（fetch 能拿到头，<img> 永远等不到体）。
    // 缓存键去掉查询串（?v= ?t= 等），避免同一文件的无限变体撑爆 Cache Storage。
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const key = new Request(url.origin + url.pathname);
      try {
        const resp = await fetch(e.request);
        if (resp.ok && resp.status === 200) e.waitUntil(cache.put(key, resp.clone()).catch(() => {}));
        return withCOI(resp);
      } catch {
        return withCOI((await cache.match(key)) || (await cache.match('./index.html')));
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreVary: true });
    if (hit) return withCOI(hit);
    const resp = await fetchViaMirrors(e.request);
    // 只缓存完整 200 响应（Range/206 不能存）；同样后台写入，失败时透传
    if (resp.ok && resp.status === 200) e.waitUntil(cache.put(e.request, resp.clone()).catch(() => {}));
    return withCOI(resp);
  })());
});
