// One-shot AI worker. Terminating it after each job returns the whole WASM heap to WebKit,
// which Tensor.dispose()/Session.release() alone cannot guarantee on iOS.
import { extractCharactersAI, extractCharactersInRegion } from './ai-segment.js?v=20260929-fallback3';
import { releaseAllSessions } from './ort-env.js';

self.onmessage = async (event) => {
  const { imageData, job, box, samPoints, hires, samFallback, mobileModel } = event.data;
  const onProgress = (received, total) => self.postMessage({ type: 'progress', received, total });
  const onStage = (text) => self.postMessage({ type: 'stage', text });
  try {
    // iPhone/iPad 用 512 输入的 w8 版。路径必须与 ort-env.js 的 CHUNKED_MODELS 和 app.js 的 ISNET_URL 一致：
    // 之前这里写死了已不在线上的 512-fp16 整文件，苹果设备上 AI 抠图会 404。
    const mobileOpts = mobileModel ? { isnetModelUrl: './models/isnet-anime-512-w8.onnx', isnetSize: 512 } : {};
    let result;
    if (job === 'region') {
      const chars = await extractCharactersInRegion(imageData, box, {
        samPoints, samFallback, ...mobileOpts, onProgress, onStage,
      });
      result = { chars };
    } else {
      let seg = await extractCharactersAI(imageData, { hires, samFallback, ...mobileOpts, onProgress, onStage });
      // 一个人都没检测到：自动用「加强搜索」（更大分辨率 + 更低阈值）再找一遍，省得用户自己点。
      // 不再退化成「整图直抠」——实测 74 张真实动画帧里，整图兜底 7 次抠出杂物
      // （字幕、出租车、整碗饭，最大占画面 81%），只有 1 次碰巧是对的；找不到就老实说找不到，交给手动框选。
      let escalated = false;
      if (!seg.chars.length && !hires) {
        onStage('没找到，加强搜索小角色…');
        seg = await extractCharactersAI(imageData, { hires: true, samFallback, ...mobileOpts, onProgress, onStage });
        escalated = true;
      }
      result = { seg, escalated };
    }
    await releaseAllSessions();
    const buffers = [];
    const chars = result.seg?.chars || result.chars || [];
    for (const char of chars) if (char.alpha?.buffer) buffers.push(char.alpha.buffer);
    self.postMessage({ type: 'done', result }, [...new Set(buffers)]);
  } catch (error) {
    await releaseAllSessions();
    self.postMessage({ type: 'error', error: { name: error?.name || 'Error', message: String(error?.message || error), stack: error?.stack || '' } });
  } finally {
    self.close();
  }
};
