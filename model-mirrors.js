// model-mirrors.js — AI 模型下载线路。页面（app.js 以模块引入）与 sw.js（importScripts）共用这一份。
//
// 模型与 onnxruntime-web 运行时的实际下载由 sw.js 改道：缓存未命中时按页面测速得出的顺序
// 依次尝试各线路，前一条失败自动换下一条；缓存键始终是原地址，所以从哪条线路下的都算“已离线”。
//
//   base：'.'           与页面同源（当前站点）
//         'https://…'   独立的模型服务器，需按 deploy/aliyun/README.md 配好 HTTPS 与跨域响应头
//         null          未启用
//   ort： 该线路是否也托管了运行时（<base>/ort/<版本>/…）。不托管的线路，运行时仍走 jsDelivr。
self.SEICHI_MODEL_MIRRORS = [
  { id: 'cf', name: '日本 CF', base: '.', ort: false },
  // 阿里云武汉：服务器配好后把 base 改成模型域名，例如 'https://models.anitabi.cn'（末尾不要斜杠）
  { id: 'aliyun', name: '阿里云武汉', base: null, ort: true },
];
