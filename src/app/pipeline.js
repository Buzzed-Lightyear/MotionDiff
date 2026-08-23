import PipelineWorker from './pipeline.worker.js?worker';
import { WebGLRenderer } from './renderer.webgl.js';
import { buildSourceProfile } from './source-profile.js';
import { posyBlend } from '../core/diff.js';
import { cellEnergies } from '../core/energy.js';

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

    this._currentFrame = null;
    this._sourceProfile = buildSourceProfile('file', HAS_RVFC);

    // ── Sonification energy grid (see core/energy.js) ──
    // Size 0 means "nobody is listening" — neither path computes a grid.
    this._energyCols = 0;
    this._energyRows = 0;
    this._energyGrid = null;
    this._energyGridCols = 0;
    this._energyGridRows = 0;

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

      if (msg.energyBuffer) {
        this._energyGrid = new Float32Array(msg.energyBuffer);
        this._energyGridCols = msg.energyCols;
        this._energyGridRows = msg.energyRows;
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
    this._energyGrid = null;

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

  setSourceProfile(profile) {
    this._sourceProfile = profile;
  }

  logProcessingConfig() {
    const capLabel = this.params.fpsCap ? `${this.params.fpsCap}fps` : 'uncapped';
    console.log(`Pipeline: processing at ${this._processWidth}px, cap ${capLabel}`);
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
    if (params.fpsCap !== undefined && params.fpsCap !== this.params.fpsCap) {
      this.params.fpsCap = params.fpsCap;
      this.logProcessingConfig();
    }
  }

  /**
   * Latest motion-energy grid for whichever render path is active, or null
   * before the first processed frame. Asking for a size is also what turns the
   * grid on: the worker path computes at the requested size from the next frame
   * onward, and cols/rows below 1 switch the readback off entirely.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Float32Array|null} cols*rows energies in 0..1, row-major
   */
  getEnergyGrid(cols, rows) {
    const nextCols = Number.isFinite(cols) ? Math.floor(cols) : 0;
    const nextRows = Number.isFinite(rows) ? Math.floor(rows) : 0;

    if (nextCols !== this._energyCols || nextRows !== this._energyRows) {
      this._energyCols = nextCols;
      this._energyRows = nextRows;
      this._energyGrid = null;
    }

    if (nextCols < 1 || nextRows < 1) return null;

    if (this._useWebGL) {
      if (!this._glRenderer || this._storeSize < 2) return null;
      return this._glRenderer.readEnergyGrid(nextCols, nextRows);
    }

    // Worker results lag the request by a frame; ignore stale grid sizes.
    if (this._energyGridCols !== nextCols || this._energyGridRows !== nextRows) return null;
    return this._energyGrid;
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
    this.logProcessingConfig();
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
    const w = this.width;
    const h = this.height;
    if (!w || !h) return null;

    const mode = this._sourceProfile?.frameCapture ?? 'draw-image';
    try {
      if (mode === 'video-frame') {
        this._currentFrame = new VideoFrame(video);
      }
      if (mode === 'video-frame' && this._currentFrame) {
        this._capCtx.drawImage(this._currentFrame, 0, 0, w, h);
      } else {
        this._capCtx.drawImage(video, 0, 0, w, h);
      }
      return this._capCtx.getImageData(0, 0, w, h);
    } catch {
      return null;
    } finally {
      this._currentFrame?.close();
      this._currentFrame = null;
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
      energyCols: this._energyCols,
      energyRows: this._energyRows,
    }, [currentFrameBuffer]);
  }
}

/**
 * Dev-only parity probe for SPEC-sonification A6.
 *
 * Feeds the same two synthetic frames through the CPU core math and the WebGL
 * readback and returns both grids so their cells can be compared. Only ever
 * called behind `import.meta.env.DEV`, so production builds tree-shake it away.
 *
 * It resizes the renderer to the synthetic frame size and clears the pipeline
 * afterwards — run it on an idle page, not mid-playback.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {{cols: number, rows: number, core: number[], webgl: number[]}|null}
 */
export function debugEnergyParity(pipeline, cols = 8, rows = 4) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 128;
  const height = 64;
  const prev = new Uint8ClampedArray(width * height * 4);
  const next = new Uint8ClampedArray(width * height * 4);
  const base = 96;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      prev[i] = prev[i + 1] = prev[i + 2] = base;
      prev[i + 3] = 255;
      // Only the second frame carries the wedge: motion grows to the right and
      // is strongest at the top, so every cell lands on a different energy.
      const wedge = Math.round((x / (width - 1)) * 120 * (1 - y / (height - 1)));
      next[i] = next[i + 1] = next[i + 2] = base + wedge;
      next[i + 3] = 255;
    }
  }

  const diff = new Uint8ClampedArray(width * height * 4);
  posyBlend(next, prev, diff, 0);
  const core = cellEnergies(diff, width, height, cols, rows, true);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  gl.setSize(width, height);
  const prevImage = new ImageData(prev, width, height);
  const nextImage = new ImageData(next, width, height);
  gl.uploadImageData(nextImage, 'current');
  gl.uploadImageData(prevImage, 'oldR');
  gl.uploadImageData(prevImage, 'oldG');
  gl.uploadImageData(prevImage, 'oldB');
  gl.renderDiff({
    threshold: 0,
    algorithm: 'posy',
    rgbTintR: '#ff0000',
    rgbTintG: '#00ff00',
    rgbTintB: '#0000ff',
  });
  const webgl = Array.from(gl.readEnergyGrid(cols, rows));

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight);
  pipeline.clearState();

  return { cols, rows, core: Array.from(core), webgl };
}
