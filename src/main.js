import { Pipeline } from './app/pipeline.js';
import { attachHlsSource, isDashUrl, isHlsUrl, isYouTubeUrl } from './app/loader.js';
import { CanvasRecorder } from './app/exporter.js';
import { render, renderBlank } from './app/renderer.js';
import { analyzeSample } from './core/analyze.js';
import { initControls } from './ui/controls.js';
import { initPresets } from './ui/presets.js';
import { initTimeline } from './ui/timeline.js';
import { setStatus } from './ui/status.js';

const MODE_ORDER = ['diff', 'overlay', 'glow'];
const MODE_LABELS = { diff: 'Diff', overlay: 'Overlay', glow: 'Glow' };

const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const pipeline = new Pipeline();
const videoEl = document.getElementById('videoEl');
const canvas = document.getElementById('outputCanvas');

/**
 * In WebGL mode the pipeline owns the canvas context (WebGL2).
 * In Canvas2D fallback mode, we get a 2D context for renderer.js.
 * We defer context creation until after pipeline.init() decides the path.
 */
let outputCtx = null;

let loopRunning = false;
let animFrameId = null;
let rvfcId = null;
let videoLoaded = false;
let currentMode = 'overlay';
let activeStream = null;
let activeObjectUrl = null;
let processedFrameCount = 0;
let fpsWindowStart = 0;
let skippedFrameCount = 0;
const recorder = new CanvasRecorder(canvas);

function cycleMode() {
  const idx = MODE_ORDER.indexOf(currentMode);
  currentMode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
  // Sync mode to pipeline for WebGL composite
  pipeline.setMode(currentMode);
  return MODE_LABELS[currentMode];
}

const controls = initControls({
  onParams: { onRecordToggle: handleRecordToggle },
  onParamChange: handleParamChange,
  onFileLoad: handleFileLoad,
  onUrlLoad: handleUrlLoad,
  onDisplayCycle: () => cycleMode(),
  onAlgorithmToggle: () => {},
  onBlurToggle: () => {},
  onAutoConfigure: handleAutoConfigure,
  onWebcamLoad: handleWebcamLoad,
  onScreenLoad: handleScreenLoad,
  onProcessingWidthChange: handleProcessingWidthChange,
});
const timeline = initTimeline({
  videoEl,
  onPlayPause: handlePlayPause,
  onStep: handleStepFrame,
});
initPresets({
  getCurrentParams: () => ({
    frameOffset: controls.state.frameOffset,
    threshold: controls.state.threshold,
    trailLength: controls.state.trailLength,
    channelSpread: controls.state.channelSpread,
    algorithm: controls.state.algorithm,
    blurEnabled: controls.state.blurEnabled,
    ageColorEnabled: controls.state.ageColorEnabled,
    rgbTintR: controls.state.rgbTintR,
    rgbTintG: controls.state.rgbTintG,
    rgbTintB: controls.state.rgbTintB,
    ageColorNew: controls.state.ageColorNew,
    ageColorOld: controls.state.ageColorOld,
    processingWidth: controls.state.processingWidth,
    fpsCap: controls.state.fpsCap,
  }),
  onPresetLoad: applyParameterPreset,
  onStatus: setStatus,
});

pipeline.init(videoEl, canvas);
pipeline.setParams({
  rgbTintR: controls.state.rgbTintR,
  rgbTintG: controls.state.rgbTintG,
  rgbTintB: controls.state.rgbTintB,
  ageColorNew: controls.state.ageColorNew,
  ageColorOld: controls.state.ageColorOld,
  fpsCap: controls.state.fpsCap,
});
controls.setRecordEnabled(CanvasRecorder.isSupported(canvas));
controls.setRecording(false);

// Set initial mode on pipeline
pipeline.setMode(currentMode);

// Log frame source
console.log(`Frame source: ${HAS_RVFC ? 'requestVideoFrameCallback + VideoFrame' : 'requestAnimationFrame (fallback)'}`);

// In Canvas2D fallback mode, get the 2D context
if (!pipeline._useWebGL) {
  outputCtx = canvas.getContext('2d', { willReadFrequently: true });
}

function syncCanvasSize() {
  if (!pipeline._useWebGL) {
    canvas.width = pipeline.width;
    canvas.height = pipeline.height;
  }
}

function handleParamChange(params) {
  pipeline.setParams(params);
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
}

function handleProcessingWidthChange(width) {
  pipeline.setProcessingWidth(width);
  syncCanvasSize();
  setStatus(`Resolution: ${width}px — higher values may affect performance`, 'info');
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
}

function clearDiffOutput() {
  if (pipeline._useWebGL && pipeline._glRenderer) {
    pipeline._glRenderer.renderBlank(controls.state.algorithm, controls.state.ageColorEnabled);
    return;
  }
  if (!outputCtx) {
    outputCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const width = canvas.width || pipeline.width || 1;
  const height = canvas.height || pipeline.height || 1;
  renderBlank(outputCtx, width, height, controls.state.algorithm, controls.state.ageColorEnabled);
}

function handleLoadFailure(message) {
  stopLoop();
  pipeline.stop();
  pipeline.clearState();
  clearActiveSource();
  clearDiffOutput();
  videoLoaded = false;
  timeline.setEnabled(false);
  timeline.setPaused();
  timeline.syncNow();
  controls.setPaused();
  controls.showPlaceholders();
  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
  videoEl.load();
  setStatus(message, 'error');
}

function handleFileLoad(file) {
  beginSourceLoad();
  const url = URL.createObjectURL(file);
  activeObjectUrl = url;
  setStatus('Loading...', 'info');
  loadVideo(url, true);
}

function handleUrlLoad(url) {
  beginSourceLoad();
  setStatus('Loading...', 'info');
  loadVideo(url, false);
}

async function handleWebcamLoad() {
  if (!navigator.mediaDevices?.getUserMedia) return;

  try {
    setStatus('Requesting camera...', 'info');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    beginSourceLoad();
    activeStream = stream;
    loadStream(stream, 'camera');
  } catch {
    setStatus('Camera access denied', 'error');
  }
}

async function handleScreenLoad() {
  if (!navigator.mediaDevices?.getDisplayMedia) return;

  try {
    setStatus('Requesting screen...', 'info');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    beginSourceLoad();
    activeStream = stream;
    loadStream(stream, 'screen');
  } catch {
    setStatus('Screen capture cancelled', 'error');
  }
}

function beginSourceLoad() {
  if (recorder.isRecording()) {
    void stopRecording();
  }

  stopLoop();
  videoLoaded = false;
  timeline.setEnabled(false);
  timeline.setPaused();
  timeline.syncNow();
  controls.setPaused();
  clearActiveSource();

  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
  videoEl.load();
}

function clearActiveSource() {
  pipeline.clearExternalResources();

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

function loadVideo(src, isLocal) {
  if (!isLocal && isYouTubeUrl(src)) {
    handleLoadFailure('YouTube URLs are not supported directly — use yt-dlp to download or extract a direct media URL');
    return;
  }

  if (!isLocal && isDashUrl(src)) {
    handleLoadFailure('DASH not supported in this build');
    return;
  }

  if (!isLocal && isHlsUrl(src)) {
    loadHlsVideo(src);
    return;
  }

  if (isLocal) {
    videoEl.removeAttribute('crossOrigin');
  } else {
    videoEl.crossOrigin = 'anonymous';
  }

  videoEl.src = src;
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;

  const onCanPlay = () => {
    cleanup();
    onVideoReady();
  };

  const onError = () => {
    cleanup();
    if (!isLocal) {
      const proxied = `https://corsproxy.io/?${encodeURIComponent(src)}`;
      setStatus('Retrying via CORS proxy...', 'info');
      videoEl.crossOrigin = 'anonymous';
      videoEl.src = proxied;

      const onCanPlayProxy = () => { cleanupProxy(); onVideoReady(); };
      const onErrorProxy = () => {
        cleanupProxy();
        handleLoadFailure('\u2717 Failed \u2014 check URL');
      };
      const cleanupProxy = () => {
        videoEl.removeEventListener('canplay', onCanPlayProxy);
        videoEl.removeEventListener('error', onErrorProxy);
      };
      videoEl.addEventListener('canplay', onCanPlayProxy);
      videoEl.addEventListener('error', onErrorProxy);
      videoEl.load();
    } else {
      handleLoadFailure('\u2717 Failed to load file');
    }
  };

  const cleanup = () => {
    videoEl.removeEventListener('canplay', onCanPlay);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('canplay', onCanPlay);
  videoEl.addEventListener('error', onError);
  videoEl.load();
}

async function loadHlsVideo(src) {
  videoEl.crossOrigin = 'anonymous';
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;

  const onCanPlay = () => {
    cleanup();
    onVideoReady('\u2713 Loaded [HLS]');
  };

  const onError = () => {
    cleanup();
    pipeline.clearExternalResources();
    handleLoadFailure('\u2717 Failed to load HLS stream');
  };

  const cleanup = () => {
    videoEl.removeEventListener('canplay', onCanPlay);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('canplay', onCanPlay);
  videoEl.addEventListener('error', onError);

  try {
    await attachHlsSource(src, videoEl, pipeline);
  } catch (error) {
    cleanup();
    pipeline.clearExternalResources();
    handleLoadFailure(`\u2717 ${error.message}`);
  }
}

function loadStream(stream, sourceKind) {
  videoEl.removeAttribute('crossOrigin');
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.loop = false;
  videoEl.playsInline = true;

  const onCanPlay = () => {
    cleanup();
    onVideoReady();
  };

  const onError = () => {
    cleanup();
    const message = sourceKind === 'screen' ? 'Screen capture cancelled' : 'Camera access denied';
    handleLoadFailure(message);
  };

  const cleanup = () => {
    videoEl.removeEventListener('canplay', onCanPlay);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('canplay', onCanPlay);
  videoEl.addEventListener('error', onError);
  videoEl.load();
}

function onVideoReady(loadedMessage = '\u2713 Loaded') {
  videoLoaded = true;
  pipeline.updateDimensions(videoEl);

  // In Canvas2D fallback, we manually set canvas dimensions
  // (WebGL path sets them inside pipeline.updateDimensions → glRenderer.setSize)
  if (!pipeline._useWebGL) {
    canvas.width = pipeline.width;
    canvas.height = pipeline.height;
  }

  setStatus(loadedMessage, 'success');
  timeline.setEnabled(true);
  timeline.syncNow();

  videoEl.play().then(() => {
    controls.setPlaying();
    timeline.setPlaying();
    startLoop();
  }).catch(() => {
    setStatus(`${loadedMessage} \u2014 press play`, 'success');
    controls.setPaused();
    timeline.setPaused();
    timeline.setEnabled(true);
    if (controls.placeholderOriginal) controls.placeholderOriginal.style.display = 'none';
    if (controls.placeholderDiff)     controls.placeholderDiff.style.display = 'none';
    processCurrentFrame();
  });
}

function handlePlayPause() {
  if (!videoLoaded) return;
  if (videoEl.paused) {
    videoEl.play().then(() => {
      controls.setPlaying();
      timeline.setPlaying();
      startLoop();
    });
  } else {
    videoEl.pause();
    controls.setPaused();
    timeline.setPaused();
    stopLoop();
  }
}

function handleStepFrame(deltaSeconds) {
  if (!videoLoaded) return;

  if (!videoEl.paused) {
    videoEl.pause();
    controls.setPaused();
    timeline.setPaused();
    stopLoop();
  }

  const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const nextTime = Math.min(Math.max(videoEl.currentTime + deltaSeconds, 0), duration || 0);
  if (nextTime === videoEl.currentTime) {
    processCurrentFrame();
    return;
  }

  videoEl.currentTime = nextTime;
}

function applyParameterPreset(params, name, source) {
  controls.applyParams(params);
  if (params.processingWidth !== undefined) {
    pipeline.setProcessingWidth(params.processingWidth);
    syncCanvasSize();
  }
  pipeline.setParams(params);

  if (videoLoaded) {
    processCurrentFrame();
  }

  const prefix = source === 'user' ? 'Loaded saved preset' : 'Preset';
  setStatus(`${prefix}: ${name}`, 'success');
}

async function handleRecordToggle() {
  if (!videoLoaded) {
    setStatus('Load a video first', 'error');
    return;
  }

  if (!CanvasRecorder.isSupported(canvas)) {
    setStatus('Recording is not supported in this browser.', 'error');
    return;
  }

  if (recorder.isRecording()) {
    await stopRecording();
    return;
  }

  try {
    recorder.start();
    controls.setRecording(true);
    setStatus('Recording...', 'success');
  } catch (error) {
    controls.setRecording(false);
    setStatus(error.message, 'error');
  }
}

async function stopRecording() {
  const result = await recorder.stop();
  controls.setRecording(false);
  if (result?.filename) {
    setStatus(`Saved: ${result.filename}`, 'success');
  }
}

async function handleAutoConfigure() {
  if (!videoLoaded) {
    setStatus('Load a video first', 'error');
    return;
  }

  const wasPaused = videoEl.paused;
  const originalRate = videoEl.playbackRate;

  controls.setAutoBusy(true);
  stopLoop();
  if (!videoEl.paused) {
    videoEl.pause();
  }
  controls.setPaused();
  timeline.setPaused();

  try {
    const frames = await pipeline.sampleFrames(videoEl, 30);
    const { frameOffset, threshold } = analyzeSample(frames, timeline.getFPS());

    controls.applyParams({ frameOffset, threshold });
    pipeline.setParams({ frameOffset, threshold });
    processCurrentFrame();

    setStatus(`Auto-configured: offset=${frameOffset} threshold=${threshold}`, 'success');

    if (!wasPaused) {
      videoEl.playbackRate = originalRate;
      await videoEl.play();
      controls.setPlaying();
      timeline.setPlaying();
      startLoop();
    }
  } catch (error) {
    setStatus(`Auto-config failed: ${error.message}`, 'error');
  } finally {
    controls.setAutoBusy(false);
    timeline.syncNow();
  }
}

// Canvas 2D fallback: Worker sends results via callback
pipeline.onResult = (result) => {
  if (!loopRunning || !videoLoaded) return;
  if (pipeline._useWebGL) return; // WebGL renders directly in process()

  if (result && result.accumulated) {
    render(currentMode, result.accumulated, result.currentFrame, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm, controls.state.ageColorEnabled);
  } else if (result && result.currentFrame) {
    render(currentMode, null, result.currentFrame, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm, controls.state.ageColorEnabled);
  }
};

function processCurrentFrame() {
  pipeline.setParams({
    frameOffset: controls.state.frameOffset,
    threshold: controls.state.threshold,
    trailLength: controls.state.trailLength,
    channelSpread: controls.state.channelSpread,
    algorithm: controls.state.algorithm,
    blurEnabled: controls.state.blurEnabled,
    ageColorEnabled: controls.state.ageColorEnabled,
    rgbTintR: controls.state.rgbTintR,
    rgbTintG: controls.state.rgbTintG,
    rgbTintB: controls.state.rgbTintB,
    ageColorNew: controls.state.ageColorNew,
    ageColorOld: controls.state.ageColorOld,
    fpsCap: controls.state.fpsCap,
  });

  pipeline.process(videoEl);
}

function tick() {
  if (!loopRunning || !videoLoaded) return;
  processCurrentFrame();
}

function resetFrameMetrics() {
  pipeline._lastFrameTime = 0;
  processedFrameCount = 0;
  fpsWindowStart = 0;
  skippedFrameCount = 0;
}

function shouldSkipFrame(now) {
  const { fpsCap } = pipeline.params;
  if (!fpsCap) return false;
  const minInterval = 1000 / fpsCap;
  if (pipeline._lastFrameTime > 0 && now - pipeline._lastFrameTime < minInterval) {
    skippedFrameCount += 1;
    return true;
  }
  pipeline._lastFrameTime = now;
  return false;
}

function noteProcessedFrame(now) {
  if (!import.meta.env.DEV) return;
  processedFrameCount += 1;
  if (fpsWindowStart === 0) {
    fpsWindowStart = now;
    return;
  }
  if (processedFrameCount % 60 === 0) {
    const elapsed = now - fpsWindowStart;
    const measuredFps = elapsed > 0 ? 60000 / elapsed : 0;
    const skippedSuffix = skippedFrameCount ? ` (skipped ${skippedFrameCount})` : '';
    console.log(`FPS: ${measuredFps.toFixed(1)}${skippedSuffix}`);
    fpsWindowStart = now;
    skippedFrameCount = 0;
  }
}

function rvfcTick(now) {
  if (!shouldSkipFrame(now)) {
    tick();
    noteProcessedFrame(now);
  }
  if (loopRunning) {
    rvfcId = videoEl.requestVideoFrameCallback(rvfcTick);
  }
}

function rafTick(now) {
  if (!shouldSkipFrame(now)) {
    tick();
    noteProcessedFrame(now);
  }
  if (loopRunning) {
    animFrameId = requestAnimationFrame(rafTick);
  }
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  resetFrameMetrics();

  if (HAS_RVFC) {
    rvfcId = videoEl.requestVideoFrameCallback(rvfcTick);
  } else {
    animFrameId = requestAnimationFrame(rafTick);
  }
}

function stopLoop() {
  loopRunning = false;
  resetFrameMetrics();
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (rvfcId !== null && HAS_RVFC) {
    videoEl.cancelVideoFrameCallback(rvfcId);
    rvfcId = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!videoLoaded) return;
  if (document.hidden) {
    if (!videoEl.paused) {
      videoEl.pause();
      stopLoop();
      videoEl.dataset.autoPaused = 'true';
      controls.setPaused();
      timeline.setPaused();
    }
  } else {
    if (videoEl.dataset.autoPaused === 'true') {
      delete videoEl.dataset.autoPaused;
      videoEl.play().then(() => {
        controls.setPlaying();
        timeline.setPlaying();
        startLoop();
      });
    }
  }
});

videoEl.addEventListener('seeked', () => {
  timeline.syncNow();
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
});
