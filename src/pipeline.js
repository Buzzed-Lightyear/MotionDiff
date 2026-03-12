import { CircularBuffer } from './buffer.js';

/**
 * Processing pipeline: frame capture, temporal differencing (two algorithms),
 * RGB channel time-shift, box blur, and trail accumulation.
 */

const PROCESS_WIDTH = 640;

/** @enum {string} */
export const Algorithm = { RAW_DIFF: 'raw', POSY: 'posy' };

export class Pipeline {
  constructor() {
    /** Raw frame buffer — stores last 120 frames for large offsets + channel spread */
    this.frameBuffer = new CircularBuffer(120);
    /** Trail buffer — stores last T diff ImageData results */
    this.trailBuffer = new CircularBuffer(20);

    /** Offscreen capture canvas */
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });

    /** Processing dimensions */
    this.width = 0;
    this.height = 0;

    /* ─── Parameters (synced from UI each tick) ─── */
    this.frameOffset = 5;
    this.threshold = 10;
    this.trailLength = 5;
    this.channelSpread = 0;
    this.algorithm = Algorithm.POSY;
    this.blurEnabled = false;
  }

  /**
   * Recalculate processing dimensions from a video element.
   * @param {HTMLVideoElement} video
   */
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

  /**
   * Capture one frame from the video element.
   * @param {HTMLVideoElement} video
   * @returns {ImageData|null}
   */
  captureFrame(video) {
    if (!this.width || !this.height) return null;
    try {
      this._capCtx.drawImage(video, 0, 0, this.width, this.height);
      const frame = this._capCtx.getImageData(0, 0, this.width, this.height);
      this.frameBuffer.push(frame);
      return frame;
    } catch {
      return null; // canvas tainted by cross-origin video
    }
  }

  /**
   * Clamp an offset to the available buffer range.
   * @param {number} offset
   * @returns {number}
   */
  _clamp(offset) {
    return Math.min(offset, this.frameBuffer.size - 1);
  }

  /**
   * Compute the diff image using the currently selected algorithm
   * with optional RGB channel time-shifting.
   * @returns {ImageData|null}
   */
  computeDiff() {
    const cur = this.frameBuffer.get(0);
    if (!cur) return null;

    const k = this.frameOffset;
    const spread = this.channelSpread;

    // Offsets for each channel
    const offR = this._clamp(k);
    const offG = this._clamp(k + spread);
    const offB = this._clamp(k + spread * 2);

    const oldR = this.frameBuffer.get(offR);
    const oldG = this.frameBuffer.get(offG);
    const oldB = this.frameBuffer.get(offB);

    if (!oldR || !oldG || !oldB) return null;

    const curD = cur.data;
    const oR = oldR.data;
    const oG = oldG.data;
    const oB = oldB.data;
    const len = curD.length;
    const diff = new ImageData(this.width, this.height);
    const out = diff.data;
    const thresh = this.threshold;

    if (this.algorithm === Algorithm.POSY) {
      // ─── MODE B: Invert-Blend (Posy method) ───
      // blend = (current + invert(old)) / 2
      // Static pixels → 128,128,128; motion deviates from gray.
      for (let i = 0; i < len; i += 4) {
        let bR = ((curD[i]     + (255 - oR[i]))     + 1) >> 1;
        let bG = ((curD[i + 1] + (255 - oG[i + 1])) + 1) >> 1;
        let bB = ((curD[i + 2] + (255 - oB[i + 2])) + 1) >> 1;

        // Threshold: deviation from 128 must exceed threshold
        const devR = Math.abs(bR - 128);
        const devG = Math.abs(bG - 128);
        const devB = Math.abs(bB - 128);
        const mag = (devR + devG + devB) / 3;

        if (mag < thresh) {
          out[i]     = 128;
          out[i + 1] = 128;
          out[i + 2] = 128;
        } else {
          out[i]     = bR;
          out[i + 1] = bG;
          out[i + 2] = bB;
        }
        out[i + 3] = 255;
      }
    } else {
      // ─── MODE A: Raw Diff ───
      for (let i = 0; i < len; i += 4) {
        let dR = Math.abs(curD[i]     - oR[i]);
        let dG = Math.abs(curD[i + 1] - oG[i + 1]);
        let dB = Math.abs(curD[i + 2] - oB[i + 2]);
        const mag = (dR + dG + dB) / 3;

        if (mag < thresh) {
          out[i] = 0;
          out[i + 1] = 0;
          out[i + 2] = 0;
        } else {
          out[i]     = dR;
          out[i + 1] = dG;
          out[i + 2] = dB;
        }
        out[i + 3] = 255;
      }
    }

    return diff;
  }

  /**
   * Apply a 3×3 box blur in-place on an ImageData.
   * @param {ImageData} img
   * @returns {ImageData}
   */
  boxBlur(img) {
    const w = img.width;
    const h = img.height;
    const src = img.data;
    const dst = new Uint8ClampedArray(src.length);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const idx = (ny * w + nx) * 4;
              rSum += src[idx];
              gSum += src[idx + 1];
              bSum += src[idx + 2];
              count++;
            }
          }
        }
        const idx = (y * w + x) * 4;
        dst[idx]     = (rSum / count + 0.5) | 0;
        dst[idx + 1] = (gSum / count + 0.5) | 0;
        dst[idx + 2] = (bSum / count + 0.5) | 0;
        dst[idx + 3] = 255;
      }
    }

    return new ImageData(dst, w, h);
  }

  /**
   * Accumulate diff into the trail buffer and compute the
   * max-across-T-frames result.
   * For Posy mode, "max" means max deviation from 128.
   * @param {ImageData} diff
   * @returns {ImageData}
   */
  accumulate(diff) {
    this.trailBuffer.push(diff);

    const w = this.width;
    const h = this.height;
    const accumulated = new ImageData(w, h);
    const out = accumulated.data;
    const len = out.length;
    const isPosy = this.algorithm === Algorithm.POSY;

    // Initialize: gray for Posy, black for raw
    const base = isPosy ? 128 : 0;
    for (let i = 0; i < len; i += 4) {
      out[i]     = base;
      out[i + 1] = base;
      out[i + 2] = base;
      out[i + 3] = 255;
    }

    const T = Math.min(this.trailLength, this.trailBuffer.size);

    if (isPosy) {
      // For Posy: keep pixel with greatest deviation from 128
      for (let t = 0; t < T; t++) {
        const frame = this.trailBuffer.get(t);
        if (!frame) continue;
        const src = frame.data;
        for (let i = 0; i < len; i += 4) {
          const curDevR = Math.abs(out[i]     - 128);
          const curDevG = Math.abs(out[i + 1] - 128);
          const curDevB = Math.abs(out[i + 2] - 128);
          const srcDevR = Math.abs(src[i]     - 128);
          const srcDevG = Math.abs(src[i + 1] - 128);
          const srcDevB = Math.abs(src[i + 2] - 128);
          if (srcDevR > curDevR) out[i]     = src[i];
          if (srcDevG > curDevG) out[i + 1] = src[i + 1];
          if (srcDevB > curDevB) out[i + 2] = src[i + 2];
        }
      }
    } else {
      // For raw diff: max per channel
      for (let t = 0; t < T; t++) {
        const frame = this.trailBuffer.get(t);
        if (!frame) continue;
        const src = frame.data;
        for (let i = 0; i < len; i += 4) {
          if (src[i]     > out[i])     out[i]     = src[i];
          if (src[i + 1] > out[i + 1]) out[i + 1] = src[i + 1];
          if (src[i + 2] > out[i + 2]) out[i + 2] = src[i + 2];
        }
      }
    }

    return accumulated;
  }

  /**
   * Run the full pipeline for one tick.
   * @param {HTMLVideoElement} video
   * @returns {{ currentFrame: ImageData, accumulated: ImageData }|null}
   */
  process(video) {
    const currentFrame = this.captureFrame(video);
    if (!currentFrame) return null;

    let diff = this.computeDiff();
    if (!diff) return { currentFrame, accumulated: null };

    if (this.blurEnabled) {
      diff = this.boxBlur(diff);
    }

    const accumulated = this.accumulate(diff);
    return { currentFrame, accumulated };
  }
}
