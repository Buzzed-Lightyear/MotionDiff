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
    blurEnabled
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
    compositeOld[i]     = oldR[i];
    compositeOld[i + 1] = oldG[i + 1];
    compositeOld[i + 2] = oldB[i + 2];
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
    if (frame) frames.push(frame);
  }

  const isPosy = algorithm === 'posy';
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
