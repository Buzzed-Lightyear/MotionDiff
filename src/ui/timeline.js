const DEFAULT_FPS = 30;
const SCRUB_MAX = 1000;
const HOLD_THRESHOLD_MS = 200;
const REVERSE_INTERVAL_MS = 100;

function isTypingTarget(target) {
  return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
}

function clampTime(time, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(time, 0), duration);
}

function setRangeFill(slider) {
  if (!slider) return;
  const min = Number.parseFloat(slider.min || '0');
  const max = Number.parseFloat(slider.max || '100');
  const value = Number.parseFloat(slider.value || '0');
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  slider.style.backgroundSize = `${percent}% 100%, 100% 100%`;
}

export function initTimeline({ videoEl, onPlayPause, onStep, getFpsCap, getProcessingWidth }) {
  const scrubber = document.getElementById('timelineScrubber');
  const frameCounter = document.getElementById('frameCounter');
  const playbackRateSelect = document.getElementById('playbackRateSelect');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const btnStepBack = document.getElementById('btnStepBack');
  const btnStepForward = document.getElementById('btnStepForward');

  let dragging = false;
  let uiFrameId = null;
  let fps = DEFAULT_FPS;
  let holdPlaying = false;
  let reverseInterval = null;
  let activeStepPress = null;

  function getFPS() {
    return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  }

  function applyPlaybackRate() {
    videoEl.playbackRate = parseFloat(playbackRateSelect.value);
  }

  function updateFrameCounter() {
    const currentTime = clampTime(videoEl.currentTime || 0, videoEl.duration);
    const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    const currentFrame = Math.round(currentTime * getFPS());
    const totalFrames = Math.round(duration * getFPS());
    const fpsLabel = Number.isInteger(getFPS()) ? getFPS() : getFPS().toFixed(2);
    const fpsCap = typeof getFpsCap === 'function' ? getFpsCap() : null;
    const processingWidth = typeof getProcessingWidth === 'function' ? getProcessingWidth() : null;
    const sourceWidth = Number.isFinite(videoEl.videoWidth) && videoEl.videoWidth > 0 ? videoEl.videoWidth : null;
    const showWidthToken = Number.isFinite(processingWidth) && processingWidth > 0 && processingWidth !== sourceWidth;
    const showCapToken = Number.isFinite(fpsCap) && fpsCap > 0;
    const showContext = showWidthToken || showCapToken;
    const tokens = [
      `<span class="frame-counter__numbers">${currentFrame} / ${totalFrames}</span>`,
      '<span class="frame-counter__token">&middot;</span>',
      `<span class="frame-counter__token">${fpsLabel}fps${showContext ? ' src' : ''}</span>`,
    ];

    if (showWidthToken) {
      tokens.push('<span class="frame-counter__token">&middot;</span>');
      tokens.push(`<span class="frame-counter__token">${processingWidth}px</span>`);
    }

    if (showCapToken) {
      tokens.push('<span class="frame-counter__token">&middot;</span>');
      tokens.push(`<span class="frame-counter__token">cap ${fpsCap}fps</span>`);
    }

    frameCounter.innerHTML = tokens.join(' ');
  }

  function syncScrubber() {
    if (dragging) return;
    const duration = videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      scrubber.value = '0';
      setRangeFill(scrubber);
      updateFrameCounter();
      return;
    }
    const ratio = clampTime(videoEl.currentTime || 0, duration) / duration;
    scrubber.value = String(Math.round(ratio * SCRUB_MAX));
    setRangeFill(scrubber);
    updateFrameCounter();
  }

  function startUIUpdates() {
    if (uiFrameId !== null) return;

    const update = () => {
      syncScrubber();
      uiFrameId = requestAnimationFrame(update);
    };

    uiFrameId = requestAnimationFrame(update);
  }

  function detectFPS() {
    fps = DEFAULT_FPS;
    if (!videoEl.captureStream) {
      updateFrameCounter();
      return;
    }

    try {
      const stream = videoEl.captureStream();
      const track = stream.getVideoTracks()[0];
      const candidate = track?.getSettings?.().frameRate;
      if (Number.isFinite(candidate) && candidate > 0) {
        fps = candidate;
      }
      stream.getTracks().forEach((item) => item.stop());
    } catch {
      fps = DEFAULT_FPS;
    }

    updateFrameCounter();
  }

  function seekFromScrubber() {
    const duration = videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const nextTime = (parseFloat(scrubber.value) / SCRUB_MAX) * duration;
    videoEl.currentTime = clampTime(nextTime, duration);
    setRangeFill(scrubber);
    updateFrameCounter();
  }

  function setEnabled(enabled) {
    scrubber.disabled = !enabled;
    playbackRateSelect.disabled = !enabled;
    btnPlayPause.disabled = !enabled;
    btnStepBack.disabled = !enabled;
    btnStepForward.disabled = !enabled;
    if (!enabled) {
      activeStepPress = null;
      stopHoldState();
      setRangeFill(scrubber);
    }
  }

  function setPlaying() {
    btnPlayPause.innerHTML = '&#9646;&#9646;';
  }

  function setPaused() {
    btnPlayPause.innerHTML = '&#9654;';
  }

  function syncNow() {
    syncScrubber();
  }

  function stopReverseHold() {
    if (reverseInterval !== null) {
      clearInterval(reverseInterval);
      reverseInterval = null;
      videoEl.pause();
    }
  }

  function stopHoldState() {
    stopReverseHold();
    if (holdPlaying) {
      if (!videoEl.paused) {
        onPlayPause();
      }
      holdPlaying = false;
    }
  }

  function startForwardHold() {
    if (!videoEl.paused) return;
    applyPlaybackRate();
    onPlayPause();
    holdPlaying = true;
  }

  function startReverseHold() {
    stopReverseHold();
    if (!videoEl.paused) {
      onPlayPause();
    }
    // Reverse scrub is throttled - browsers require keyframe decoding
    // for backward seeks. Stutter on compressed video is expected.
    reverseInterval = setInterval(() => {
      if (videoEl.seeking) return;
      const currentTime = videoEl.currentTime || 0;
      const nextTime = Math.max(0, currentTime - (1 / getFPS()));
      if (nextTime !== currentTime) {
        videoEl.currentTime = nextTime;
      }
      updateFrameCounter();
    }, REVERSE_INTERVAL_MS);
  }

  function beginStepPress(direction, event) {
    if (event.cancelable) event.preventDefault();
    if (btnStepBack.disabled || btnStepForward.disabled) return;
    stopHoldState();
    if (activeStepPress?.timeoutId) {
      clearTimeout(activeStepPress.timeoutId);
    }

    const press = {
      direction,
      startedAt: performance.now(),
      holding: false,
      timeoutId: setTimeout(() => {
        if (activeStepPress !== press) return;
        press.holding = true;
        if (direction > 0) {
          startForwardHold();
        } else {
          startReverseHold();
        }
      }, HOLD_THRESHOLD_MS),
    };

    activeStepPress = press;
  }

  function endStepPress(direction, treatAsStep, event) {
    if (event?.cancelable) event.preventDefault();
    const press = activeStepPress;
    if (!press || press.direction !== direction) return;

    clearTimeout(press.timeoutId);
    activeStepPress = null;

    const elapsed = performance.now() - press.startedAt;
    if (!press.holding && treatAsStep && elapsed < HOLD_THRESHOLD_MS) {
      onStep(direction * (1 / getFPS()));
      return;
    }

    stopHoldState();
  }

  scrubber.addEventListener('pointerdown', () => {
    dragging = true;
  });

  scrubber.addEventListener('input', () => {
    dragging = true;
    seekFromScrubber();
  });

  scrubber.addEventListener('change', () => {
    dragging = false;
    seekFromScrubber();
  });

  document.addEventListener('pointerup', () => {
    dragging = false;
  });

  playbackRateSelect.addEventListener('change', () => {
    applyPlaybackRate();
    updateFrameCounter();
  });

  btnPlayPause.addEventListener('click', () => {
    onPlayPause();
  });

  btnStepBack.addEventListener('mousedown', (event) => {
    beginStepPress(-1, event);
  });
  btnStepBack.addEventListener('mouseup', (event) => {
    endStepPress(-1, true, event);
  });
  btnStepBack.addEventListener('mouseleave', (event) => {
    endStepPress(-1, false, event);
  });
  btnStepBack.addEventListener('touchstart', (event) => {
    beginStepPress(-1, event);
  }, { passive: false });
  btnStepBack.addEventListener('touchend', (event) => {
    endStepPress(-1, true, event);
  }, { passive: false });
  btnStepBack.addEventListener('touchcancel', (event) => {
    endStepPress(-1, false, event);
  }, { passive: false });

  btnStepForward.addEventListener('mousedown', (event) => {
    beginStepPress(1, event);
  });
  btnStepForward.addEventListener('mouseup', (event) => {
    endStepPress(1, true, event);
  });
  btnStepForward.addEventListener('mouseleave', (event) => {
    endStepPress(1, false, event);
  });
  btnStepForward.addEventListener('touchstart', (event) => {
    beginStepPress(1, event);
  }, { passive: false });
  btnStepForward.addEventListener('touchend', (event) => {
    endStepPress(1, true, event);
  }, { passive: false });
  btnStepForward.addEventListener('touchcancel', (event) => {
    endStepPress(1, false, event);
  }, { passive: false });

  document.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target)) return;

    if (event.code === 'Space') {
      event.preventDefault();
      onPlayPause();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onStep(-(1 / getFPS()));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onStep(1 / getFPS());
    }
  });

  videoEl.addEventListener('loadedmetadata', () => {
    detectFPS();
    applyPlaybackRate();
    syncNow();
  });

  videoEl.addEventListener('durationchange', syncNow);
  videoEl.addEventListener('ratechange', updateFrameCounter);
  videoEl.addEventListener('seeked', syncNow);
  videoEl.addEventListener('timeupdate', syncNow);

  setEnabled(false);
  setPaused();
  startUIUpdates();
  setRangeFill(scrubber);
  updateFrameCounter();

  return {
    setEnabled,
    setPlaying,
    setPaused,
    syncNow,
    getFPS,
  };
}
