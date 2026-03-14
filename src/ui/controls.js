function normalizeHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function parseNullableInt(value) {
  if (value === null || value === undefined || value === '' || value === 'max') {
    return null;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function initControls({
  onParams,
  onParamChange,
  onFileLoad,
  onUrlLoad,
  onDisplayCycle,
  onAlgorithmToggle,
  onBlurToggle,
  onAutoConfigure,
  onWebcamLoad,
  onScreenLoad,
  onProcessingWidthChange,
}) {
  const fileInput = document.getElementById('fileInput');
  const urlInput = document.getElementById('urlInput');
  const loadUrlBtn = document.getElementById('loadUrlBtn');
  const autoConfigBtn = document.getElementById('autoConfigBtn');
  const btnWebcam = document.getElementById('btnWebcam');
  const btnScreen = document.getElementById('btnScreen');

  const sliderOffset = document.getElementById('sliderOffset');
  const sliderThreshold = document.getElementById('sliderThreshold');
  const sliderTrail = document.getElementById('sliderTrail');
  const sliderSpread = document.getElementById('sliderSpread');

  const valOffset = document.getElementById('valOffset');
  const valThreshold = document.getElementById('valThreshold');
  const valTrail = document.getElementById('valTrail');
  const valSpread = document.getElementById('valSpread');

  const selectResolution = document.getElementById('selectResolution');
  const selectFpsCap = document.getElementById('selectFpsCap');
  const rgbTintGroup = document.getElementById('rgbTintGroup');
  const ageGradientGroup = document.getElementById('ageGradientGroup');
  const inputTintR = document.getElementById('rgbTintR');
  const inputTintG = document.getElementById('rgbTintG');
  const inputTintB = document.getElementById('rgbTintB');
  const inputAgeColorNew = document.getElementById('ageColorNew');
  const inputAgeColorOld = document.getElementById('ageColorOld');

  const btnAlgo = document.getElementById('btnAlgo');
  const btnBlur = document.getElementById('btnBlur');
  const btnAgeColor = document.getElementById('btnAgeColor');
  const btnDisplay = document.getElementById('btnDisplay');
  const btnRecord = document.getElementById('btnRecord');

  const dotOriginal = document.getElementById('dotOriginal');
  const dotDiff = document.getElementById('dotDiff');
  const placeholderOriginal = document.getElementById('placeholderOriginal');
  const placeholderDiff = document.getElementById('placeholderDiff');

  const state = {
    frameOffset: 5,
    threshold: 10,
    trailLength: 5,
    channelSpread: 0,
    algorithm: 'posy',
    blurEnabled: false,
    ageColorEnabled: false,
    displayMode: 'overlay',
    playing: false,
    rgbTintR: '#ff0000',
    rgbTintG: '#00ff00',
    rgbTintB: '#0000ff',
    ageColorNew: '#ff4400',
    ageColorOld: '#0044ff',
    processingWidth: 640,
    fpsCap: null,
  };

  function emitParamChange(params) {
    if (onParamChange) onParamChange(params);
  }

  function setOffset(value, notify = true) {
    const v = parseInt(value, 10);
    sliderOffset.value = String(v);
    state.frameOffset = v;
    valOffset.textContent = `${v}f`;
    if (notify) emitParamChange({ frameOffset: v });
  }

  function setThreshold(value, notify = true) {
    const v = parseInt(value, 10);
    sliderThreshold.value = String(v);
    state.threshold = v;
    valThreshold.textContent = String(v);
    if (notify) emitParamChange({ threshold: v });
  }

  function setTrailLength(value, notify = true) {
    const v = parseInt(value, 10);
    sliderTrail.value = String(v);
    state.trailLength = v;
    valTrail.textContent = `${v}f`;
    if (notify) emitParamChange({ trailLength: v });
  }

  function updateRgbTintVisibility() {
    if (!rgbTintGroup) return;
    const visible = state.channelSpread > 0;
    rgbTintGroup.hidden = !visible;
    [inputTintR, inputTintG, inputTintB].forEach((input) => {
      if (input) input.disabled = !visible;
    });
  }

  function setChannelSpread(value, notify = true) {
    const v = parseInt(value, 10);
    sliderSpread.value = String(v);
    state.channelSpread = v;
    valSpread.textContent = `${v}f`;
    updateRgbTintVisibility();
    if (notify) emitParamChange({ channelSpread: v });
  }

  function updateAgeColorVisibility() {
    const algorithmAllowsAgeColor = state.algorithm === 'posy';
    if (btnAgeColor) {
      btnAgeColor.hidden = !algorithmAllowsAgeColor;
      btnAgeColor.disabled = !algorithmAllowsAgeColor;
    }

    const showGradient = algorithmAllowsAgeColor && state.ageColorEnabled;
    if (ageGradientGroup) {
      ageGradientGroup.hidden = !showGradient;
      [inputAgeColorNew, inputAgeColorOld].forEach((input) => {
        if (input) input.disabled = !showGradient;
      });
    }
  }

  function setAlgorithm(algorithm, notify = true) {
    state.algorithm = algorithm;
    const isPosy = algorithm === 'posy';
    btnAlgo.textContent = isPosy ? 'Posy' : 'Raw Diff';
    btnAlgo.classList.toggle('active', isPosy);
    updateAgeColorVisibility();
    if (notify) emitParamChange({ algorithm });
  }

  function setBlurEnabled(enabled, notify = true) {
    state.blurEnabled = Boolean(enabled);
    btnBlur.textContent = `Blur: ${state.blurEnabled ? 'On' : 'Off'}`;
    btnBlur.classList.toggle('active', state.blurEnabled);
    if (notify) emitParamChange({ blurEnabled: state.blurEnabled });
  }

  function setAgeColorEnabled(enabled, notify = true) {
    state.ageColorEnabled = Boolean(enabled);
    if (btnAgeColor) {
      btnAgeColor.textContent = `Color Age: ${state.ageColorEnabled ? 'On' : 'Off'}`;
      btnAgeColor.classList.toggle('active', state.ageColorEnabled);
    }
    updateAgeColorVisibility();
    if (notify) emitParamChange({ ageColorEnabled: state.ageColorEnabled });
  }

  function setRgbTint(key, value, notify = true) {
    const nextValue = normalizeHex(value, state[key]);
    state[key] = nextValue;
    const input = key === 'rgbTintR' ? inputTintR : key === 'rgbTintG' ? inputTintG : inputTintB;
    if (input) input.value = nextValue;
    if (notify) emitParamChange({ [key]: nextValue });
  }

  function setAgeGradient(key, value, notify = true) {
    const fallback = key === 'ageColorNew' ? '#ff4400' : '#0044ff';
    const nextValue = normalizeHex(value, fallback);
    state[key] = nextValue;
    const input = key === 'ageColorNew' ? inputAgeColorNew : inputAgeColorOld;
    if (input) input.value = nextValue;
    if (notify) emitParamChange({ [key]: nextValue });
  }

  function setProcessingWidth(value, notify = true) {
    const nextWidth = parseInt(value, 10);
    if (!Number.isFinite(nextWidth)) return;
    state.processingWidth = nextWidth;
    if (selectResolution) selectResolution.value = String(nextWidth);
    if (notify && onProcessingWidthChange) onProcessingWidthChange(nextWidth);
  }

  function setFpsCap(value, notify = true) {
    const nextCap = parseNullableInt(value);
    state.fpsCap = nextCap;
    if (selectFpsCap) {
      selectFpsCap.value = nextCap === null ? 'max' : String(nextCap);
    }
    if (notify) emitParamChange({ fpsCap: nextCap });
  }

  function setDisplayMode(label) {
    state.displayMode = label.toLowerCase();
    btnDisplay.textContent = `Mode: ${label}`;
  }

  function applyParams(params) {
    if (params.frameOffset !== undefined) setOffset(params.frameOffset, false);
    if (params.threshold !== undefined) setThreshold(params.threshold, false);
    if (params.trailLength !== undefined) setTrailLength(params.trailLength, false);
    if (params.channelSpread !== undefined) setChannelSpread(params.channelSpread, false);
    if (params.algorithm !== undefined) setAlgorithm(params.algorithm, false);
    if (params.blurEnabled !== undefined) setBlurEnabled(params.blurEnabled, false);
    if (params.ageColorEnabled !== undefined) setAgeColorEnabled(params.ageColorEnabled, false);
    if (params.rgbTintR !== undefined) setRgbTint('rgbTintR', params.rgbTintR, false);
    if (params.rgbTintG !== undefined) setRgbTint('rgbTintG', params.rgbTintG, false);
    if (params.rgbTintB !== undefined) setRgbTint('rgbTintB', params.rgbTintB, false);
    if (params.ageColorNew !== undefined) setAgeGradient('ageColorNew', params.ageColorNew, false);
    if (params.ageColorOld !== undefined) setAgeGradient('ageColorOld', params.ageColorOld, false);
    if (params.processingWidth !== undefined) setProcessingWidth(params.processingWidth, false);
    if (params.fpsCap !== undefined) setFpsCap(params.fpsCap, false);
  }

  if (btnWebcam) {
    btnWebcam.hidden = !navigator.mediaDevices?.getUserMedia;
    btnWebcam.addEventListener('click', () => {
      if (onWebcamLoad) onWebcamLoad();
    });
  }

  if (btnScreen) {
    btnScreen.hidden = !navigator.mediaDevices?.getDisplayMedia;
    btnScreen.addEventListener('click', () => {
      if (onScreenLoad) onScreenLoad();
    });
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) onFileLoad(file);
  });

  loadUrlBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) onUrlLoad(url);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      if (url) onUrlLoad(url);
    }
  });

  sliderOffset.addEventListener('input', () => {
    setOffset(sliderOffset.value);
  });

  sliderThreshold.addEventListener('input', () => {
    setThreshold(sliderThreshold.value);
  });

  sliderTrail.addEventListener('input', () => {
    setTrailLength(sliderTrail.value);
  });

  sliderSpread.addEventListener('input', () => {
    setChannelSpread(sliderSpread.value);
  });

  inputTintR?.addEventListener('input', () => {
    setRgbTint('rgbTintR', inputTintR.value);
  });
  inputTintG?.addEventListener('input', () => {
    setRgbTint('rgbTintG', inputTintG.value);
  });
  inputTintB?.addEventListener('input', () => {
    setRgbTint('rgbTintB', inputTintB.value);
  });
  inputAgeColorNew?.addEventListener('input', () => {
    setAgeGradient('ageColorNew', inputAgeColorNew.value);
  });
  inputAgeColorOld?.addEventListener('input', () => {
    setAgeGradient('ageColorOld', inputAgeColorOld.value);
  });
  selectResolution?.addEventListener('change', () => {
    setProcessingWidth(selectResolution.value);
  });
  selectFpsCap?.addEventListener('change', () => {
    setFpsCap(selectFpsCap.value);
  });

  btnAlgo.addEventListener('click', () => {
    setAlgorithm(state.algorithm === 'posy' ? 'raw' : 'posy');
    if (onAlgorithmToggle) onAlgorithmToggle();
  });

  btnBlur.addEventListener('click', () => {
    setBlurEnabled(!state.blurEnabled);
    if (onBlurToggle) onBlurToggle();
  });

  btnAgeColor?.addEventListener('click', () => {
    if (state.algorithm !== 'posy') return;
    setAgeColorEnabled(!state.ageColorEnabled);
  });

  btnDisplay.addEventListener('click', () => {
    const label = onDisplayCycle();
    setDisplayMode(label);
  });

  btnRecord?.addEventListener('click', () => {
    if (onParams?.onRecordToggle) onParams.onRecordToggle();
  });

  autoConfigBtn?.addEventListener('click', () => {
    if (onAutoConfigure) onAutoConfigure();
  });

  const container = document.getElementById('presetClips');
  if (container) {
    const buttons = container.querySelectorAll('.preset-btn');
    buttons.forEach((btn) => {
      const url = btn.getAttribute('data-url');
      if (url) {
        btn.addEventListener('click', () => {
          urlInput.value = url;
          onUrlLoad(url);
        });
      }
    });
  }

  function setPlaying() {
    state.playing = true;
    if (dotOriginal) dotOriginal.classList.add('active');
    if (dotDiff) dotDiff.classList.add('active');
    if (placeholderOriginal) placeholderOriginal.style.display = 'none';
    if (placeholderDiff) placeholderDiff.style.display = 'none';
  }

  function setPaused() {
    state.playing = false;
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff) dotDiff.classList.remove('active');
  }

  function showPlaceholders() {
    if (placeholderOriginal) placeholderOriginal.style.display = 'flex';
    if (placeholderDiff) placeholderDiff.style.display = 'flex';
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff) dotDiff.classList.remove('active');
  }

  updateRgbTintVisibility();
  updateAgeColorVisibility();
  setFpsCap(state.fpsCap, false);
  if (selectResolution) selectResolution.value = String(state.processingWidth);

  return {
    state,
    setOffset,
    setThreshold,
    setTrailLength,
    setChannelSpread,
    setAlgorithm,
    setBlurEnabled,
    setAgeColorEnabled,
    setDisplayMode,
    setRgbTint,
    setAgeGradient,
    setProcessingWidth,
    setFpsCap,
    applyParams,
    setAutoBusy(isBusy) {
      if (!autoConfigBtn) return;
      autoConfigBtn.disabled = isBusy;
      autoConfigBtn.textContent = isBusy ? 'Auto...' : 'Auto';
    },
    setRecordEnabled(enabled) {
      if (!btnRecord) return;
      btnRecord.disabled = !enabled;
    },
    setRecording(isRecording) {
      if (!btnRecord) return;
      btnRecord.textContent = isRecording ? 'Stop' : 'Record';
      btnRecord.classList.toggle('recording', isRecording);
    },
    setPlaying,
    setPaused,
    showPlaceholders,
    get placeholderOriginal() { return placeholderOriginal; },
    get placeholderDiff() { return placeholderDiff; },
  };
}
