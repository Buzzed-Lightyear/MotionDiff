import { posyBlend, rawDiff } from '../core/diff.js';
import { boxBlur } from '../core/blur.js';
import { accumulate } from '../core/trails.js';

const TRAIL_CAP = 20;
const trailStore = [];
let trailHead = -1;
let trailSize = 0;

function trailPush(data) {
  trailHead = (trailHead + 1) % TRAIL_CAP;
  trailStore[trailHead] = data;
  if (trailSize < TRAIL_CAP) trailSize++;
}

function trailGet(offset) {
  if (offset < 0 || offset >= trailSize) return null;
  const idx = (trailHead - offset + TRAIL_CAP) % TRAIL_CAP;
  return trailStore[idx];
}

function trailClear() {
  trailStore.length = 0;
  trailHead = -1;
  trailSize = 0;
}

function hexToRgb(hex, fallback) {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function normalizeTint([r, g, b]) {
  const sum = r + g + b;
  if (sum <= 0) return [0, 0, 0];
  return [r / sum, g / sum, b / sum];
}

function tintChannel(frame, index, tint) {
  return Math.round(
    frame[index] * tint[0] +
    frame[index + 1] * tint[1] +
    frame[index + 2] * tint[2]
  );
}

function tintAgeFrame(frame, age, threshold, newestColor, oldestColor) {
  const out = new Uint8ClampedArray(frame.length);
  const thresholdNorm = threshold / 255;
  const rFactor = newestColor[0] + ((oldestColor[0] - newestColor[0]) * age);
  const gFactor = newestColor[1] + ((oldestColor[1] - newestColor[1]) * age);
  const bFactor = newestColor[2] + ((oldestColor[2] - newestColor[2]) * age);

  for (let i = 0; i < frame.length; i += 4) {
    const motion = (
      Math.abs(frame[i] - 128) +
      Math.abs(frame[i + 1] - 128) +
      Math.abs(frame[i + 2] - 128)
    ) / (3 * 127);

    if (motion > thresholdNorm) {
      out[i] = Math.round(rFactor * motion * 255);
      out[i + 1] = Math.round(gFactor * motion * 255);
      out[i + 2] = Math.round(bFactor * motion * 255);
    }

    out[i + 3] = 255;
  }

  return out;
}

function clamp(offset, storeSize) {
  return Math.min(offset, storeSize - 1);
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'clear') {
    trailClear();
    return;
  }

  if (msg.type !== 'process') return;

  const {
    currentFrameBuffer,
    frameStoreBuffers,
    frameStoreSize,
    frameStoreHead,
    params,
    width,
    height
  } = msg;

  const {
    frameOffset,
    threshold,
    trailLength,
    channelSpread,
    algorithm,
    blurEnabled,
    ageColorEnabled,
    rgbTintR,
    rgbTintG,
    rgbTintB,
    ageColorNew,
    ageColorOld,
  } = params;

  const storeCap = frameStoreBuffers.length;
  const curData = new Uint8ClampedArray(currentFrameBuffer);

  if (frameStoreSize < 2) {
    self.postMessage(
      { type: 'result', accumulatedBuffer: null, currentFrameBuffer },
      [currentFrameBuffer]
    );
    return;
  }

  function storeGet(offset) {
    if (offset < 0 || offset >= frameStoreSize) return null;
    const idx = (frameStoreHead - offset + storeCap) % storeCap;
    const buf = frameStoreBuffers[idx];
    if (!buf) return null;
    return new Uint8ClampedArray(buf);
  }

  const k = frameOffset;
  const spread = channelSpread;
  const tintR = normalizeTint(hexToRgb(rgbTintR, '#ff0000'));
  const tintG = normalizeTint(hexToRgb(rgbTintG, '#00ff00'));
  const tintB = normalizeTint(hexToRgb(rgbTintB, '#0000ff'));
  const ageNewest = hexToRgb(ageColorNew, '#ff4400').map((channel) => channel / 255);
  const ageOldest = hexToRgb(ageColorOld, '#0044ff').map((channel) => channel / 255);

  const offR = clamp(k, frameStoreSize);
  const offG = clamp(k + spread, frameStoreSize);
  const offB = clamp(k + spread * 2, frameStoreSize);

  const oldR = storeGet(offR);
  const oldG = storeGet(offG);
  const oldB = storeGet(offB);

  if (!oldR || !oldG || !oldB) {
    self.postMessage(
      { type: 'result', accumulatedBuffer: null, currentFrameBuffer },
      [currentFrameBuffer]
    );
    return;
  }

  const len = curData.length;
  const compositeOld = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i += 4) {
    compositeOld[i]     = tintChannel(oldR, i, tintR);
    compositeOld[i + 1] = tintChannel(oldG, i, tintG);
    compositeOld[i + 2] = tintChannel(oldB, i, tintB);
    compositeOld[i + 3] = 255;
  }

  const diffData = new Uint8ClampedArray(len);

  if (algorithm === 'posy') {
    posyBlend(curData, compositeOld, diffData, threshold);
  } else {
    rawDiff(curData, compositeOld, diffData, threshold);
  }

  if (blurEnabled) {
    boxBlur(diffData, width, height);
  }

  trailPush(diffData);

  const T = Math.min(trailLength, trailSize);
  const frames = [];
  for (let t = 0; t < T; t++) {
    const frame = trailGet(t);
    if (!frame) continue;

    if (ageColorEnabled && algorithm === 'posy') {
      const age = T <= 1 ? 0 : t / (T - 1);
      frames.push(tintAgeFrame(frame, age, threshold, ageNewest, ageOldest));
    } else {
      frames.push(frame);
    }
  }

  const isPosy = algorithm === 'posy' && !ageColorEnabled;
  const accResult = accumulate(frames, isPosy);

  if (!accResult) {
    self.postMessage(
      { type: 'result', accumulatedBuffer: null, currentFrameBuffer },
      [currentFrameBuffer]
    );
    return;
  }

  const accBuffer = accResult.buffer;

  self.postMessage(
    { type: 'result', accumulatedBuffer: accBuffer, currentFrameBuffer },
    [accBuffer, currentFrameBuffer]
  );
};
