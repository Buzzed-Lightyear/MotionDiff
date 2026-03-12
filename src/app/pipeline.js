import PipelineWorker from './pipeline.worker.js?worker';

const PROCESS_WIDTH = 640;
const FRAME_STORE_CAP = 120;

export class Pipeline {
  constructor() {
    this._capCanvas = null;
    this._capCtx = null;
    this.width = 0;
    this.height = 0;

    this._frameStore = new Array(FRAME_STORE_CAP);
    this._storeHead = -1;
    this._storeSize = 0;

    this._worker = null;
    this._workerBusy = false;
    this._pendingFrame = null;

    this.params = {
      frameOffset: 5,
      threshold: 10,
      trailLength: 5,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
    };

    this.onResult = null;
  }

  init(videoEl, outputCanvasEl) {
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });
    this._initWorker();
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
    this._frameStore = new Array(FRAME_STORE_CAP);
    this._storeHead = -1;
    this._storeSize = 0;
    if (this._worker) {
      this._worker.postMessage({ type: 'clear' });
    }
    this._workerBusy = false;
  }

  stop() {
    this._workerBusy = false;
  }

  setParams(params) {
    if (params.frameOffset !== undefined) this.params.frameOffset = params.frameOffset;
    if (params.threshold !== undefined) this.params.threshold = params.threshold;
    if (params.trailLength !== undefined) this.params.trailLength = params.trailLength;
    if (params.channelSpread !== undefined) this.params.channelSpread = params.channelSpread;
    if (params.algorithm !== undefined) this.params.algorithm = params.algorithm;
    if (params.blurEnabled !== undefined) this.params.blurEnabled = params.blurEnabled;
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
    this.start();
  }

  captureFrame(video) {
    if (!this.width || !this.height) return null;
    try {
      this._capCtx.drawImage(video, 0, 0, this.width, this.height);
      return this._capCtx.getImageData(0, 0, this.width, this.height);
    } catch {
      return null;
    }
  }

  _storePush(buffer) {
    this._storeHead = (this._storeHead + 1) % FRAME_STORE_CAP;
    this._frameStore[this._storeHead] = buffer;
    if (this._storeSize < FRAME_STORE_CAP) this._storeSize++;
  }

  process(video) {
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
