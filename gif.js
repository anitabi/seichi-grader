// gif.js — 零依赖 GIF89a 编码。GIF 最多 256 色：用 6×6×6 色立方（216 色）+ 40 阶灰度，
// 再加 4×4 Bayer 有序抖动，动画天空/阴影的渐变不会一圈圈色带。
// draw(ctx, i) 把第 i 帧画进 ctx；每帧后 await yieldFrame(i) 让出主线程（界面才能刷新进度）。

function colorTable() {
  const table = new Uint8Array(256 * 3);
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    const i = r * 36 + g * 6 + b;
    table[i * 3] = r * 51; table[i * 3 + 1] = g * 51; table[i * 3 + 2] = b * 51;
  }
  for (let i = 0; i < 40; i++) {
    const v = Math.round(i * 255 / 39), p = (216 + i) * 3;
    table[p] = table[p + 1] = table[p + 2] = v;
  }
  return table;
}

function lzw(indices) {
  const clear = 256, end = 257;
  let codeSize = 9, nextCode = 258, bitBuffer = 0, bitCount = 0;
  const out = [], dict = new Map();
  const write = (code) => {
    bitBuffer |= code << bitCount; bitCount += codeSize;
    while (bitCount >= 8) { out.push(bitBuffer & 255); bitBuffer >>>= 8; bitCount -= 8; }
  };
  const reset = () => { dict.clear(); codeSize = 9; nextCode = 258; };
  reset(); write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    // 数字键（prefix≤4095, value≤255）：比字符串拼接键少一次分配和哈希，1080p 帧提速明显
    const value = indices[i], key = prefix * 256 + value;
    const known = dict.get(key);
    if (known != null) { prefix = known; continue; }
    write(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode++);
      // GIF 解码器在读到“下一条”码时才把同一条词典项加入表；
      // 编码端已提前一步加入，所以位宽也必须晚一项升级（> 而非 ===），
      // 否则从 9 位切到 10 位时比特流会错位，生成损坏的 GIF。
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else { write(clear); reset(); }
    prefix = value;
  }
  write(prefix); write(end);
  if (bitCount) out.push(bitBuffer & 255);
  return new Uint8Array(out);
}

function subBlocks(bytes) {
  const blocks = [];
  for (let pos = 0; pos < bytes.length; pos += 255) {
    const part = bytes.subarray(pos, pos + 255);
    blocks.push(Uint8Array.of(part.length), part);
  }
  blocks.push(Uint8Array.of(0));
  return blocks;
}

const word = (n) => Uint8Array.of(n & 255, (n >> 8) & 255);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// delayCs：每帧时长，单位 1/100 秒。不写循环扩展：播放一遍，停在最后一帧。
async function encodeGif({ width: w, height: h, frames, delayCs, draw, yieldFrame }) {
  const frame = document.createElement('canvas'); frame.width = w; frame.height = h;
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  const pieces = [new TextEncoder().encode('GIF89a'), word(w), word(h), Uint8Array.of(0xf7, 0, 0), colorTable()];
  for (let index = 0; index < frames; index++) {
    draw(ctx, index);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const indexed = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < indexed.length; p++, i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
      const dith = BAYER[((p / w) & 3) * 4 + (p % w & 3)] / 16 - 0.5;
      if (hi - lo < 18) {
        indexed[p] = 216 + Math.max(0, Math.min(39, Math.round(((r + g + b) / 3) * 39 / 255 + dith)));
      } else {
        const qr = Math.max(0, Math.min(5, Math.round(r / 51 + dith)));
        const qg = Math.max(0, Math.min(5, Math.round(g / 51 + dith)));
        const qb = Math.max(0, Math.min(5, Math.round(b / 51 + dith)));
        indexed[p] = qr * 36 + qg * 6 + qb;
      }
    }
    // disposal=1：下一帧直接盖上上一帧
    pieces.push(Uint8Array.of(0x21, 0xf9, 4, 0x04, delayCs & 255, (delayCs >> 8) & 255, 0, 0));
    pieces.push(Uint8Array.of(0x2c), word(0), word(0), word(w), word(h), Uint8Array.of(0, 8), ...subBlocks(lzw(indexed)));
    if (yieldFrame) await yieldFrame(index);
  }
  pieces.push(Uint8Array.of(0x3b));
  return new Blob(pieces, { type: 'image/gif' });
}

export { encodeGif };
