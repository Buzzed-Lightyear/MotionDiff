import PipelineWorker from './pipeline.worker.js?worker';
import { WebGLRenderer } from './renderer.webgl.js';

const DEFAULT_PROCESS_WIDTH = 640;
const FRAME_STORE_CAP = 120;

/**
 * Whether the browser supports requestVideoFrameCallback on HTMLVideoElement.
 */
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export class Pipeline {
  constructor() {
    this._capCanvas = null;
    this._capCtx = null;
    this._videoEl = null;
    this.width = 0;
    this.height = 0;
    this._processWidth = DEFAULT_PROCESS_WIDTH;
    this._lastFrameTime = 0;

    // ── Frame store (circular buffer of ImageData for Worker fallback
    //    or ArrayBuffer references for WebGL texture uploads) ──
    this._frameStore = new Array(FRAME_STORE_CAP);
    this._storeHead = -1;
    this._storeSize = 0;

    // ── Worker path (fallback) ──
    this._worker = null;
    this._workerBusy = false;
    this._pendingFrame = null;

    /** @type {boolean} Whether VideoFrame bridge is used for capture */
    this._useVideoFrame = HAS_RVFC;

    /** @type {boolean} Whether WebGL is active */
    this._useWebGL = false;

    /** @type {WebGLRenderer|null} */
    this._glRenderer = null;

    /** @type {HTMLCanvasElement|null} The output canvas element */
    this._outputCanvas = null;

    this.hls = null;

    this.params = {
      frameOffset: 5,
      threshold: 10,
      trailLength: 5,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
      ageColorEnabled: false,
      rgbTintR: '#ff0000',
      rgbTintG: '#00ff00',
      rgbTintB: '#0000ff',
      ageColorNew: '#ff4400',
      ageColorOld: '#0044ff',
      fpsCap: null,
    };

    this.onResult = null;
  }

  init(videoEl, outputCanvasEl) {
    this._videoEl = videoEl;
    this._outputCanvas = outputCanvasEl;
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });

    // Try WebGL2 first
    try {
      this._glRenderer = new WebGLRenderer(outputCanvasEl);
      this._useWebGL = true;
      console.log('Renderer: WebGL2');
    } catch (e) {
      console.log('WebGL2 init failed:', e.message);
      console.log('Renderer: Canvas 2D (fallback)');
      this._useWebGL = false;
      this._glRenderer = null;
      this._initWorker();
    }
  }

  _initWorker() {
    if (this._worker) this._worker.terminate();
    this._worker = new PipelineWorker();
    this._workerBusy = false;

    this._worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type !== 'result') return;

      this._workerBusy = false;

      let accumulated = null;
      let currentFrame = null;

      if (msg.accumulatedBuffer) {
        const accArr = new Uint8ClampedArray(msg.accumulatedBuffer);
        accumulated = new ImageData(accArr, this.width, this.height);
      }

      if (msg.currentFrameBuffer) {
        const curArr = new Uint8ClampedArray(msg.currentFrameBuffer);
        currentFrame = new ImageData(curArr, this.width, this.height);
      }

      if (this.onResult) {
        this.onResult({ currentFrame, accumulated });
      }
    };
  }

  start() {
    this.clearState();
  }

  stop() {
    this._workerBusy = false;
    this._lastFrameTime = 0;
  }

  clearState() {
    this._frameStore = new Array(FRAME_STORE_CAP);
    this._storeHead = -1;
    this._storeSize = 0;

    if (this._useWebGL && this._glRenderer) {
      this._glRenderer.clearTrails();
    }

    if (this._worker) {
      this._worker.postMessage({ type: 'clear' });
    }
    this._workerBusy = false;
    this._lastFrameTime = 0;
  }

  setHlsInstance(hls) {
    if (this.hls) {
      this.hls.destroy();
    }
    this.hls = hls;
  }

  clearExternalResources() {
    this.setHlsInstance(null);
  }

  setParams(params) {
    if (params.frameOffset !== undefined) this.params.frameOffset = params.frameOffset;
    if (params.threshold !== undefined) this.params.threshold = params.threshold;
    if (params.trailLength !== undefined) this.params.trailLength = params.trailLength;
    if (params.channelSpread !== undefined) this.params.channelSpread = params.channelSpread;
    if (params.algorithm !== undefined) this.params.algorithm = params.algorithm;
    if (params.blurEnabled !== undefined) this.params.blurEnabled = params.blurEnabled;
    if (params.ageColorEnabled !== undefined) this.params.ageColorEnabled = params.ageColorEnabled;
    if (params.rgbTintR !== undefined) this.params.rgbTintR = params.rgbTintR;
    if (params.rgbTintG !== undefined) this.params.rgbTintG = params.rgbTintG;
    if (params.rgbTintB !== undefined) this.params.rgbTintB = params.rgbTintB;
    if (params.ageColorNew !== undefined) this.params.ageColorNew = params.ageColorNew;
    if (params.ageColorOld !== undefined) this.params.ageColorOld = params.ageColorOld;
    if (params.fpsCap !== undefined) this.params.fpsCap = params.fpsCap;
  }

  setProcessingWidth(width) {
    const nextWidth = Number.parseInt(width, 10);
    if (!Number.isFinite(nextWidth) || nextWidth <= 0 || nextWidth === this._processWidth) return;
    this._processWidth = nextWidth;

    if (!this._useWebGL && nextWidth > 640) {
      console.warn(`Processing width ${nextWidth}px may be slow on Canvas 2D fallback.`);
    }

    if (this._videoEl) {
      this.updateDimensions(this._videoEl);
    }
  }

  updateDimensions(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = this._processWidth / vw;
    this.width = this._processWidth;
    this.height = Math.round(vh * scale);
    this._capCanvas.width = this.width;
    this._capCanvas.height = this.height;

    if (this._useWebGL && this._glRenderer) {
      this._glRenderer.setSize(this.width, this.height);
    }

    this.start();
  }

  /**
   * Capture current video frame as ImageData.
   * Uses VideoFrame bridge when available.
   */
  captureFrame(video) {
    if (!this.width || !this.height) return null;
    try {
      if (this._useVideoFrame) {
        const vf = new VideoFrame(video);
        this._capCtx.drawImage(vf, 0, 0, this.width, this.height);
        vf.close();
        return this._capCtx.getImageData(0, 0, this.width, this.height);
      } else {
        this._capCtx.drawImage(video, 0, 0, this.width, this.height);
        return this._capCtx.getImageData(0, 0, this.width, this.height);
      }
    } catch {
      return null;
    }
  }

  _storePush(value) {
    this._storeHead = (this._storeHead + 1) % FRAME_STORE_CAP;
    this._frameStore[this._storeHead] = value;
    if (this._storeSize < FRAME_STORE_CAP) this._storeSize++;
  }

  _storeGet(offset) {
    if (offset < 0 || offset >= this._storeSize) return null;
    const idx = (this._storeHead - offset + FRAME_STORE_CAP) % FRAME_STORE_CAP;
    return this._frameStore[idx];
  }

  async sampleFrames(video, sampleCount = 30) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !this.width || !this.height) return [];

    const frames = [];
    const totalSamples = Math.max(2, sampleCount);
    const finalTime = Math.max(duration - 0.05, 0);
    const originalTime = video.currentTime;

    for (let index = 0; index < totalSamples; index++) {
      const ratio = totalSamples === 1 ? 0 : index / (totalSamples - 1);
      const targetTime = finalTime * ratio;
      await this._seekVideo(video, targetTime);
      const frame = this.captureFrame(video);
      if (frame) {
        frames.push(new Uint8ClampedArray(frame.data));
      }
    }

    await this._seekVideo(video, originalTime);
    return frames;
  }

  _seekVideo(video, targetTime) {
    return new Promise((resolve, reject) => {
      const clampedTime = Math.min(Math.max(targetTime, 0), Number.isFinite(video.duration) ? video.duration : targetTime);
      if (Math.abs(video.currentTime - clampedTime) < 0.0005) {
        resolve();
        return;
      }

      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Seek failed while sampling frames.'));
      };
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = clampedTime;
    });
  }

  /**
   * Main processing entry point.
   * Routes to either WebGL or Worker path.
   */
  process(video) {
    if (this._useWebGL) {
      this._processWebGL(video);
    } else {
      this._processWorker(video);
    }
  }

  // ── WebGL Path ──────────────────────────────────────────────

  _processWebGL(video) {
    const frame = this.captureFrame(video);
    if (!frame) return;

    // Store the ImageData for later lookback
    this._storePush(frame);

    if (this._storeSize < 2) {
      // Not enough frames yet — show blank
      this._glRenderer.renderBlank(this.params.algorithm, this.params.ageColorEnabled);
      return;
    }

    const gl = this._glRenderer;
    const {
      frameOffset,
      threshold,
      channelSpread,
      trailLength,
      algorithm,
      blurEnabled,
      ageColorEnabled,
      rgbTintR,
      rgbTintG,
      rgbTintB,
      ageColorNew,
      ageColorOld,
    } = this.params;
    const k = frameOffset;
    const spread = channelSpread;

    // Calculate clamped offsets for RGB channel spread
    const clamp = (off) => Math.min(off, this._storeSize - 1);
    const offR = clamp(k);
    const offG = clamp(k + spread);
    const offB = clamp(k + spread * 2);

    const oldR = this._storeGet(offR);
    const oldG = this._storeGet(offG);
    const oldB = this._storeGet(offB);

    if (!oldR || !oldG || !oldB) {
      gl.renderBlank(algorithm, ageColorEnabled);
      return;
    }

    // Upload textures
    gl.uploadImageData(frame, 'current');
    gl.uploadImageData(oldR, 'oldR');
    gl.uploadImageData(oldG, 'oldG');
    gl.uploadImageData(oldB, 'oldB');

    // Run diff shader → _diffFB
    gl.renderDiff({ threshold, algorithm, rgbTintR, rgbTintG, rgbTintB });

    // Optional blur
    if (blurEnabled) {
      gl.renderBlur();
    }

    // Push diff result into trail ring
    gl.pushTrail();

    // Accumulate trails → _accumFB
    const isPosy = algorithm === 'posy';
    gl.renderAccumulate(trailLength, isPosy, threshold, ageColorEnabled, ageColorNew, ageColorOld);

    // Composite to canvas
    gl.renderComposite(this._currentMode || 'diff', algorithm, ageColorEnabled);
  }

  /**
   * Set the current display mode for WebGL composite.
   * Called from main.js to keep the mode in sync.
   * @param {string} mode - 'diff' | 'overlay' | 'glow'
   */
  setMode(mode) {
    this._currentMode = mode;
  }

  // ── Worker Path (fallback) ──────────────────────────────────

  _processWorker(video) {
    const frame = this.captureFrame(video);
    if (!frame) return;

    const pixelBytes = frame.data.buffer.byteLength;
    const storeCopy = new ArrayBuffer(pixelBytes);
    new Uint8ClampedArray(storeCopy).set(frame.data);
    this._storePush(storeCopy);

    if (this._workerBusy) return;
    this._workerBusy = true;

    const currentFrameBuffer = frame.data.buffer;

    const frameStoreBuffers = new Array(FRAME_STORE_CAP);
    for (let i = 0; i < FRAME_STORE_CAP; i++) {
      const buf = this._frameStore[i];
      if (buf) {
        frameStoreBuffers[i] = buf.slice(0);
      } else {
        frameStoreBuffers[i] = null;
      }
    }

    this._worker.postMessage({
      type: 'process',
      currentFrameBuffer,
      frameStoreBuffers,
      frameStoreSize: this._storeSize,
      frameStoreHead: this._storeHead,
      params: { ...this.params },
      width: this.width,
      height: this.height,
    }, [currentFrameBuffer]);
  }
}
