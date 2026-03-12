import { Pipeline } from './app/pipeline.js';
import { render } from './app/renderer.js';
import { initControls } from './ui/controls.js';
import { setStatus } from './ui/status.js';

const MODE_ORDER = ['diff', 'overlay', 'glow'];
const MODE_LABELS = { diff: 'Diff', overlay: 'Overlay', glow: 'Glow' };

const pipeline = new Pipeline();
const videoEl = document.getElementById('videoEl');
const canvas = document.getElementById('outputCanvas');
const outputCtx = canvas.getContext('2d', { willReadFrequently: true });

let loopRunning = false;
let animFrameId = null;
let videoLoaded = false;
let currentMode = 'overlay';

function cycleMode() {
  const idx = MODE_ORDER.indexOf(currentMode);
  currentMode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
  return MODE_LABELS[currentMode];
}

const controls = initControls({
  onFileLoad: handleFileLoad,
  onUrlLoad: handleUrlLoad,
  onPlayPause: handlePlayPause,
  onDisplayCycle: () => cycleMode(),
  onAlgorithmToggle: () => {},
  onBlurToggle: () => {},
});

pipeline.init(videoEl, canvas);

function handleFileLoad(file) {
  const url = URL.createObjectURL(file);
  setStatus('Loading...', 'info');
  loadVideo(url, true);
}

function handleUrlLoad(url) {
  setStatus('Loading...', 'info');
  loadVideo(url, false);
}

function loadVideo(src, isLocal) {
  stopLoop();
  videoLoaded = false;

  videoEl.removeAttribute('src');
  videoEl.load();

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
        setStatus('\u2717 Failed \u2014 check URL', 'error');
        controls.showPlaceholders();
      };
      const cleanupProxy = () => {
        videoEl.removeEventListener('canplay', onCanPlayProxy);
        videoEl.removeEventListener('error', onErrorProxy);
      };
      videoEl.addEventListener('canplay', onCanPlayProxy);
      videoEl.addEventListener('error', onErrorProxy);
      videoEl.load();
    } else {
      setStatus('\u2717 Failed to load file', 'error');
      controls.showPlaceholders();
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

function onVideoReady() {
  videoLoaded = true;
  pipeline.updateDimensions(videoEl);
  canvas.width = pipeline.width;
  canvas.height = pipeline.height;
  setStatus('\u2713 Loaded', 'success');

  videoEl.play().then(() => {
    controls.setPlaying();
    startLoop();
  }).catch(() => {
    setStatus('\u2713 Loaded \u2014 press play', 'success');
    controls.setPaused();
    controls.btnPlayPause.disabled = false;
    if (controls.placeholderOriginal) controls.placeholderOriginal.style.display = 'none';
    if (controls.placeholderDiff)     controls.placeholderDiff.style.display = 'none';
  });
}

function handlePlayPause() {
  if (!videoLoaded) return;
  if (videoEl.paused) {
    videoEl.play().then(() => { controls.setPlaying(); startLoop(); });
  } else {
    videoEl.pause();
    controls.setPaused();
    stopLoop();
  }
}

function tick() {
  if (!loopRunning || !videoLoaded) return;

  pipeline.setParams({
    frameOffset: controls.state.frameOffset,
    threshold: controls.state.threshold,
    trailLength: controls.state.trailLength,
    channelSpread: controls.state.channelSpread,
    algorithm: controls.state.algorithm,
    blurEnabled: controls.state.blurEnabled,
  });

  const result = pipeline.process(videoEl);
  if (result) {
    render(currentMode, result.accumulated, result.currentFrame, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm);
  } else {
    render(currentMode, null, null, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm);
  }

  scheduleNext();
}

function scheduleNext() {
  if (!loopRunning) return;
  animFrameId = requestAnimationFrame(tick);
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  scheduleNext();
}

function stopLoop() {
  loopRunning = false;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!videoLoaded) return;
  if (document.hidden) {
    if (!videoEl.paused) {
      videoEl.pause();
      stopLoop();
      videoEl.dataset.autoPaused = 'true';
    }
  } else {
    if (videoEl.dataset.autoPaused === 'true') {
      delete videoEl.dataset.autoPaused;
      videoEl.play().then(() => { controls.setPlaying(); startLoop(); });
    }
  }
});
