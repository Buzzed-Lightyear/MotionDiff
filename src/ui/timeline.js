const DEFAULT_FPS = 30;
const SCRUB_MAX = 1000;
const HOLD_THRESHOLD_MS = 200;
const REVERSE_INTERVAL_MS = 16;

function isTypingTarget(target) {
  return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
}

function clampTime(time, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(time, 0), duration);
}

export function initTimeline({ videoEl, onPlayPause, onStep }) {
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
    frameCounter.textContent = `${currentFrame} / ${totalFrames} @ ${fpsLabel} fps`;
  }

  function syncScrubber() {
    if (dragging) return;
    const duration = videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      scrubber.value = '0';
      updateFrameCounter();
      return;
    }
    const ratio = clampTime(videoEl.currentTime || 0, duration) / duration;
    scrubber.value = String(Math.round(ratio * SCRUB_MAX));
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
    reverseInterval = setInterval(() => {
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
  updateFrameCounter();

  return {
    setEnabled,
    setPlaying,
    setPaused,
    syncNow,
    getFPS,
  };
}
