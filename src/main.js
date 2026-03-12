/**
 * main.js — Entry point. Wires pipeline, renderer, UI, and the frame loop.
 */

import { Pipeline, Algorithm } from './pipeline.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';

// ─── Core modules ───
const pipeline = new Pipeline();
const videoEl  = /** @type {HTMLVideoElement} */ (document.getElementById('videoEl'));
const canvas   = /** @type {HTMLCanvasElement} */ (document.getElementById('outputCanvas'));
const renderer = new Renderer(canvas);

// ─── Frame loop state ───
let loopRunning = false;
let animFrameId = null;
let videoLoaded = false;

// ─── UI ───
const ui = new UI({
  onFileLoad:       handleFileLoad,
  onUrlLoad:        handleUrlLoad,
  onPlayPause:      handlePlayPause,
  onDisplayCycle:   () => renderer.cycleMode(),
  onAlgorithmToggle: () => { /* pipeline reads state each tick */ },
  onBlurToggle:      () => { /* pipeline reads state each tick */ },
});

// ═══════════════════════════════════════
// VIDEO LOADING
// ═══════════════════════════════════════

function handleFileLoad(file) {
  const url = URL.createObjectURL(file);
  ui.setStatus('Loading...', 'info');
  loadVideo(url, true);
}

function handleUrlLoad(url) {
  ui.setStatus('Loading...', 'info');
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
      ui.setStatus('Retrying via CORS proxy...', 'info');
      videoEl.crossOrigin = 'anonymous';
      videoEl.src = proxied;

      const onCanPlayProxy = () => { cleanupProxy(); onVideoReady(); };
      const onErrorProxy = () => {
        cleanupProxy();
        ui.setStatus('\u2717 Failed \u2014 check URL', 'error');
        ui.showPlaceholders();
      };
      const cleanupProxy = () => {
        videoEl.removeEventListener('canplay', onCanPlayProxy);
        videoEl.removeEventListener('error', onErrorProxy);
      };
      videoEl.addEventListener('canplay', onCanPlayProxy);
      videoEl.addEventListener('error', onErrorProxy);
      videoEl.load();
    } else {
      ui.setStatus('\u2717 Failed to load file', 'error');
      ui.showPlaceholders();
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
  renderer.resize(pipeline.width, pipeline.height);
  ui.setStatus('\u2713 Loaded', 'success');

  videoEl.play().then(() => {
    ui.setPlaying();
    startLoop();
  }).catch(() => {
    ui.setStatus('\u2713 Loaded \u2014 press play', 'success');
    ui.setPaused();
    ui.btnPlayPause.disabled = false;
    if (ui.placeholderOriginal) ui.placeholderOriginal.style.display = 'none';
    if (ui.placeholderDiff)     ui.placeholderDiff.style.display = 'none';
  });
}

// ═══════════════════════════════════════
// PLAY / PAUSE
// ═══════════════════════════════════════

function handlePlayPause() {
  if (!videoLoaded) return;
  if (videoEl.paused) {
    videoEl.play().then(() => { ui.setPlaying(); startLoop(); });
  } else {
    videoEl.pause();
    ui.setPaused();
    stopLoop();
  }
}

// ═══════════════════════════════════════
// FRAME LOOP
// ═══════════════════════════════════════

function tick() {
  if (!loopRunning || !videoLoaded) return;

  // Sync pipeline parameters from UI state
  pipeline.frameOffset   = ui.state.frameOffset;
  pipeline.threshold     = ui.state.threshold;
  pipeline.trailLength   = ui.state.trailLength;
  pipeline.channelSpread = ui.state.channelSpread;
  pipeline.algorithm     = ui.state.algorithm === 'posy' ? Algorithm.POSY : Algorithm.RAW_DIFF;
  pipeline.blurEnabled   = ui.state.blurEnabled;

  const result = pipeline.process(videoEl);
  if (result) {
    renderer.render(result.currentFrame, result.accumulated, ui.state.algorithm);
  } else {
    if (ui.state.algorithm === 'posy') renderer.renderGray();
    else renderer.renderBlack();
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

// ═══════════════════════════════════════
// VISIBILITY CHANGE
// ═══════════════════════════════════════

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
      videoEl.play().then(() => { ui.setPlaying(); startLoop(); });
    }
  }
});
