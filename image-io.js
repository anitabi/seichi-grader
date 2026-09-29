// image-io.js — 把 File / URL / 相机 canvas 读成「按预览尺寸缩放后的 ImageData」，并读 EXIF GPS。
// 纯读取，不碰界面。app.js 的上传、找图、现场拍摄都走这里，保证同一条读取路径。
import { profile as DEVICE } from './platform.js';

const MAX_DIM = DEVICE.previewMax;

function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name || '') || /image\/(heic|heif)/i.test(file.type || '');
}

function isRawFile(file) {
  return /\.(cr2|cr3|nef|arw|dng|orf|rw2|raf|pef|srw)$/i.test(file.name || '');
}

function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '') || isRawFile(file);
}

// 把 File 读成按 MAX_DIM 缩放后的 ImageData。RAW 先抽内嵌 JPEG 预览再解码。
async function fileToImageData(file) {
  if (isRawFile(file)) return decodeRawViaPreview(file);
  return decodeBlobToImageData(file, file);
}

function decodeBlobToImageData(blob, file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, MAX_DIM / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve({ imgData: ctx.getImageData(0, 0, width, height), width, height, url: img.src, originalWidth: img.naturalWidth, originalHeight: img.naturalHeight, fileName: file.name });
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      // iOS 上所有浏览器都是 WebKit 内核，解不了 HEIC 只可能是系统版本老（iOS 17 起才支持网页解码）
      reject(new Error(isHeicFile(file)
        ? (DEVICE.isAppleMobile
          ? '系统版本较旧无法解码 HEIC：请升级 iOS，或在相册用「导出为 JPEG」后再传（拍摄端可在 设置→相机→格式 选「兼容性最佳」）'
          : '此浏览器无法解码 HEIC：请先转成 JPEG 再传（iPhone 相册可直接「导出为 JPEG」；Windows 双击照片用「照片」应用另存为 JPEG），Mac 用户可改用 Safari 打开本站')
        : '浏览器无法解码这张图片，请转换为 JPEG 或 PNG 后重试'));
    };
    img.src = URL.createObjectURL(blob);
  });
}

// RAW 兜底：浏览器解不了 RAW 原始数据，但主流相机 RAW 都内嵌完整 JPEG 预览
// （多为全尺寸）。在字节流里定位所有 JPEG 段、从大到小试解码，零依赖零许可负担。
async function decodeRawViaPreview(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const starts = [], ends = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] !== 0xff) continue;
    if (bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) starts.push(i);
    else if (bytes[i + 1] === 0xd9) ends.push(i);
  }
  const candidates = [];
  let e = 0;
  for (const s of starts) {
    while (e < ends.length && ends[e] < s) e++;
    if (e < ends.length) candidates.push({ start: s, len: ends[e] + 2 - s });
  }
  candidates.sort((a, b) => b.len - a.len);
  for (const c of candidates.slice(0, 3)) {
    try {
      const blob = new Blob([bytes.subarray(c.start, c.start + c.len)], { type: 'image/jpeg' });
      const data = await decodeBlobToImageData(blob, file);
      data.fromRawPreview = true;
      return data;
    } catch { /* 段不完整（如嵌套缩略图截断），试下一个 */ }
  }
  throw new Error('无法从这张 RAW 提取内嵌预览，请先用相机厂商软件或系统相册导出为 JPEG 再上传');
}

// 只读取 JPEG EXIF 的 GPS；没有坐标或解析失败不会影响上传与调色。
async function readExifGPS(file) {
  if (!/image\/jpe?g/i.test(file.type || '') && !/\.jpe?g$/i.test(file.name || '')) return null;
  try {
    const view = new DataView(await file.arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;
    let pos = 2;
    while (pos + 4 < view.byteLength) {
      if (view.getUint8(pos) !== 0xff) break;
      const marker = view.getUint8(pos + 1), len = view.getUint16(pos + 2);
      if (marker === 0xe1 && len >= 10 && view.getUint32(pos + 4) === 0x45786966) {
        const base = pos + 10, little = view.getUint16(base) === 0x4949;
        const u16 = (at) => view.getUint16(at, little), u32 = (at) => view.getUint32(at, little);
        const ifd = base + u32(base + 4), count = u16(ifd);
        let gpsOffset = 0;
        for (let i = 0; i < count; i++) {
          const at = ifd + 2 + i * 12;
          if (u16(at) === 0x8825) { gpsOffset = u32(at + 8); break; }
        }
        if (!gpsOffset) return null;
        const gps = base + gpsOffset, gpsCount = u16(gps), values = new Map();
        for (let i = 0; i < gpsCount; i++) {
          const at = gps + 2 + i * 12, tag = u16(at);
          values.set(tag, { type: u16(at + 2), n: u32(at + 4), value: u32(at + 8), at });
        }
        const ascii = (entry) => entry ? String.fromCharCode(view.getUint8(entry.at + 8)) : '';
        const rational3 = (entry) => {
          if (!entry || entry.type !== 5 || entry.n < 3) return null;
          const at = base + entry.value;
          const r = (i) => { const d = u32(at + i * 8 + 4); return d ? u32(at + i * 8) / d : 0; };
          return r(0) + r(1) / 60 + r(2) / 3600;
        };
        let lat = rational3(values.get(2)), lon = rational3(values.get(4));
        if (lat == null || lon == null) return null;
        if (ascii(values.get(1)) === 'S') lat = -lat;
        if (ascii(values.get(3)) === 'W') lon = -lon;
        return { lat, lon };
      }
      if (len < 2) break;
      pos += len + 2;
    }
  } catch { /* 无 EXIF、损坏文件或浏览器拒绝读取时忽略 */ }
  return null;
}

// 地图跳转 / 演示素材：跨域图（如 anitabi CDN）需带 CORS 才能读像素；同源无副作用
function urlToImageData(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, MAX_DIM / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
      resolve({
        imgData: ctx.getImageData(0, 0, width, height), width, height, url,
        originalWidth: img.naturalWidth, originalHeight: img.naturalHeight,
      });
    };
    img.onerror = reject; img.src = url;
  });
}

// 摄像头拍出的 canvas 是全分辨率（grabFrame ~8.7MP / takePhoto 12MP）。
// 转成与 fileToImageData 同构的数据：全图 blob 作 srcUrl（全分辨率导出重放用），
// 另降到 MAX_DIM 作预览 imgData。
async function canvasToPhotoData(canvas) {
  const ow = canvas.width, oh = canvas.height;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
  const url = URL.createObjectURL(blob);
  const scale = Math.min(1, MAX_DIM / Math.max(ow, oh));
  const w = Math.round(ow * scale), h = Math.round(oh * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return {
    imgData: c.getContext('2d').getImageData(0, 0, w, h), width: w, height: h, url,
    originalWidth: ow, originalHeight: oh, fileName: 'seichi-shot.jpg',
  };
}

// 隐藏文档里 img.decode() 的 Promise 也不会兑现（浏览器推迟解码），导出会卡在读图这步。
// load 事件不受前后台影响，而 drawImage 只要求图片已加载，所以让两者赛跑：
// 前台走 decode（解码完再画，不掉帧），后台由 load 兜底。
function imageReady(img) {
  const loaded = img.complete && img.naturalWidth
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => reject(new Error('无法读取原始照片')), { once: true });
      });
  return Promise.race([loaded, img.decode().then(() => undefined, () => loaded)]);
}

export {
  MAX_DIM, isHeicFile, isRawFile, isImageFile, fileToImageData, readExifGPS,
  urlToImageData, canvasToPhotoData, imageReady,
};
