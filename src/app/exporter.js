function chooseMimeType() {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
    return 'video/webm;codecs=vp9';
  }

  if (MediaRecorder.isTypeSupported('video/webm')) {
    return 'video/webm';
  }

  return '';
}

function buildFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `motiondiff-${stamp}.webm`;
}

export class CanvasRecorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this._stopPromise = null;
    this._stopResolve = null;
  }

  static isSupported(canvas) {
    return Boolean(canvas?.captureStream && window.MediaRecorder);
  }

  isRecording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  start() {
    if (!CanvasRecorder.isSupported(this.canvas)) {
      throw new Error('Recording is not supported in this browser.');
    }

    if (this.isRecording()) {
      return;
    }

    // The output canvas already contains the composited result, so captureStream
    // records exactly what the user sees without reading processed pixels back.
    this.stream = this.canvas.captureStream(30);
    this.chunks = [];

    const mimeType = chooseMimeType();
    this.recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this._stopPromise = new Promise((resolve) => {
      this._stopResolve = resolve;
    });

    this.recorder.onstop = () => {
      const filename = buildFilename();
      const blob = new Blob(this.chunks, { type: this.recorder.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.recorder = null;

      if (this._stopResolve) {
        this._stopResolve({ blob, filename });
        this._stopResolve = null;
      }
      this._stopPromise = null;
    };

    this.recorder.start();
  }

  async stop() {
    if (!this.recorder) {
      return null;
    }

    const resultPromise = this._stopPromise;
    this.recorder.stop();
    return resultPromise;
  }
}
