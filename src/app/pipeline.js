import { CircularBuffer } from '../core/buffer.js';
import { posyBlend, rawDiff } from '../core/diff.js';
import { boxBlur } from '../core/blur.js';
import { accumulate } from '../core/trails.js';

const PROCESS_WIDTH = 640;

export class Pipeline {
  constructor() {
    this.frameBuffer = new CircularBuffer(120);
    this.trailBuffer = new CircularBuffer(20);
    this._capCanvas = null;
    this._capCtx = null;
    this.width = 0;
    this.height = 0;

    this.frameOffset = 5;
    this.threshold = 10;
    this.trailLength = 5;
    this.channelSpread = 0;
    this.algorithm = 'posy';
    this.blurEnabled = false;
  }

  init(videoEl, outputCanvasEl) {
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });
  }

  start() {
    this.frameBuffer.clear();
    this.trailBuffer.clear();
  }

  stop() {}

  setParams(params) {
    if (params.frameOffset !== undefined) this.frameOffset = params.frameOffset;
    if (params.threshold !== undefined) this.threshold = params.threshold;
    if (params.trailLength !== undefined) this.trailLength = params.trailLength;
    if (params.channelSpread !== undefined) this.channelSpread = params.channelSpread;
    if (params.algorithm !== undefined) this.algorithm = params.algorithm;
    if (params.blurEnabled !== undefined) this.blurEnabled = params.blurEnabled;
  }

  updateDimensions(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = PROCESS_WIDTH / vw;
    this.width = PROCESS_WIDTH;
    this.height = Math.round(vh * scale);
    this._capCanvas.width = this.width;
    this._capCanvas.height = this.height;
    this.frameBuffer.clear();
    this.trailBuffer.clear();
  }

  captureFrame(video) {
    if (!this.width || !this.height) return null;
    try {
      this._capCtx.drawImage(video, 0, 0, this.width, this.height);
      const frame = this._capCtx.getImageData(0, 0, this.width, this.height);
      this.frameBuffer.push(frame);
      return frame;
    } catch {
      return null;
    }
  }

  _clamp(offset) {
    return Math.min(offset, this.frameBuffer.size - 1);
  }

  computeDiff() {
    const cur = this.frameBuffer.get(0);
    if (!cur) return null;

    const k = this.frameOffset;
    const spread = this.channelSpread;

    const offR = this._clamp(k);
    const offG = this._clamp(k + spread);
    const offB = this._clamp(k + spread * 2);

    const oldR = this.frameBuffer.get(offR);
    const oldG = this.frameBuffer.get(offG);
    const oldB = this.frameBuffer.get(offB);

    if (!oldR || !oldG || !oldB) return null;

    const curD = cur.data;
    const len = curD.length;
    const compositeOld = new Uint8ClampedArray(len);
    const oR = oldR.data;
    const oG = oldG.data;
    const oB = oldB.data;
    for (let i = 0; i < len; i += 4) {
      compositeOld[i]     = oR[i];
      compositeOld[i + 1] = oG[i + 1];
      compositeOld[i + 2] = oB[i + 2];
      compositeOld[i + 3] = 255;
    }

    const diff = new ImageData(this.width, this.height);

    if (this.algorithm === 'posy') {
      posyBlend(curD, compositeOld, diff.data, this.threshold);
    } else {
      rawDiff(curD, compositeOld, diff.data, this.threshold);
    }

    return diff;
  }

  accumulateDiff(diff) {
    this.trailBuffer.push(diff);

    const T = Math.min(this.trailLength, this.trailBuffer.size);
    const frames = [];
    for (let t = 0; t < T; t++) {
      const frame = this.trailBuffer.get(t);
      if (frame) frames.push(frame.data);
    }

    const isPosy = this.algorithm === 'posy';
    const result = accumulate(frames, isPosy);
    if (!result) return null;

    return new ImageData(result, this.width, this.height);
  }

  process(video) {
    const currentFrame = this.captureFrame(video);
    if (!currentFrame) return null;

    let diff = this.computeDiff();
    if (!diff) return { currentFrame, accumulated: null };

    if (this.blurEnabled) {
      boxBlur(diff.data, this.width, this.height);
    }

    const accumulated = this.accumulateDiff(diff);
    return { currentFrame, accumulated };
  }
}
