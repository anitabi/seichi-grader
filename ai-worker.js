// One-shot AI worker. Terminating it after each job returns the whole WASM heap to WebKit,
// which Tensor.dispose()/Session.release() alone cannot guarantee on iOS.
import { extractCharactersAI, extractForegroundAI, extractCharactersInRegion } from './ai-segment.js';
import { releaseAllSessions } from './ort-env.js';

self.onmessage = async (event) => {
  const { imageData, job, box, samPoints, hires, samFallback, mobileModel } = event.data;
  const onProgress = (received, total) => self.postMessage({ type: 'progress', received, total });
  const onStage = (text) => self.postMessage({ type: 'stage', text });
  try {
    const mobileOpts = mobileModel ? { isnetModelUrl: './models/isnet-anime-512-fp16.onnx', isnetSize: 512 } : {};
    let result;
    if (job === 'region') {
      const chars = await extractCharactersInRegion(imageData, box, {
        samPoints, samFallback, ...mobileOpts, onProgress, onStage,
      });
      result = { chars };
    } else {
      const seg = await extractCharactersAI(imageData, { hires, samFallback, ...mobileOpts, onProgress, onStage });
      let whole = null;
      if (!seg.chars.length) {
        onStage('未检测到角色，改用整图抠取…');
        whole = await extractForegroundAI(imageData, {
          modelUrl: mobileOpts.isnetModelUrl, inputSize: mobileOpts.isnetSize, onProgress, onStage,
        });
      }
      result = { seg, whole };
    }
    await releaseAllSessions();
    const buffers = [];
    const chars = result.seg?.chars || result.chars || [];
    for (const char of chars) if (char.alpha?.buffer) buffers.push(char.alpha.buffer);
    if (result.whole?.alpha?.buffer) buffers.push(result.whole.alpha.buffer);
    self.postMessage({ type: 'done', result }, [...new Set(buffers)]);
  } catch (error) {
    await releaseAllSessions();
    self.postMessage({ type: 'error', error: { name: error?.name || 'Error', message: String(error?.message || error), stack: error?.stack || '' } });
  } finally {
    self.close();
  }
};
