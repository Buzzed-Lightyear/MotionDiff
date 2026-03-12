export function initControls({ onParams, onPlayPause, onFileLoad, onUrlLoad, onDisplayCycle, onAlgorithmToggle, onBlurToggle }) {
  const fileInput     = document.getElementById('fileInput');
  const urlInput      = document.getElementById('urlInput');
  const loadUrlBtn    = document.getElementById('loadUrlBtn');

  const sliderOffset    = document.getElementById('sliderOffset');
  const sliderThreshold = document.getElementById('sliderThreshold');
  const sliderTrail     = document.getElementById('sliderTrail');
  const sliderSpread    = document.getElementById('sliderSpread');

  const valOffset    = document.getElementById('valOffset');
  const valThreshold = document.getElementById('valThreshold');
  const valTrail     = document.getElementById('valTrail');
  const valSpread    = document.getElementById('valSpread');

  const btnAlgo      = document.getElementById('btnAlgo');
  const btnBlur      = document.getElementById('btnBlur');
  const btnDisplay   = document.getElementById('btnDisplay');
  const btnPlayPause = document.getElementById('btnPlayPause');

  const dotOriginal = document.getElementById('dotOriginal');
  const dotDiff     = document.getElementById('dotDiff');
  const placeholderOriginal = document.getElementById('placeholderOriginal');
  const placeholderDiff     = document.getElementById('placeholderDiff');

  const state = {
    frameOffset: 5,
    threshold: 10,
    trailLength: 5,
    channelSpread: 0,
    algorithm: 'posy',
    blurEnabled: false,
    displayMode: 'overlay',
    playing: false,
  };

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
    const v = parseInt(sliderOffset.value, 10);
    state.frameOffset = v;
    valOffset.textContent = `${v}f`;
  });

  sliderThreshold.addEventListener('input', () => {
    const v = parseInt(sliderThreshold.value, 10);
    state.threshold = v;
    valThreshold.textContent = String(v);
  });

  sliderTrail.addEventListener('input', () => {
    const v = parseInt(sliderTrail.value, 10);
    state.trailLength = v;
    valTrail.textContent = `${v}f`;
  });

  sliderSpread.addEventListener('input', () => {
    const v = parseInt(sliderSpread.value, 10);
    state.channelSpread = v;
    valSpread.textContent = `${v}f`;
  });

  btnAlgo.addEventListener('click', () => {
    if (state.algorithm === 'posy') {
      state.algorithm = 'raw';
      btnAlgo.textContent = 'Raw Diff';
      btnAlgo.classList.remove('active');
    } else {
      state.algorithm = 'posy';
      btnAlgo.textContent = 'Posy';
      btnAlgo.classList.add('active');
    }
    if (onAlgorithmToggle) onAlgorithmToggle();
  });

  btnBlur.addEventListener('click', () => {
    state.blurEnabled = !state.blurEnabled;
    btnBlur.textContent = `Blur: ${state.blurEnabled ? 'On' : 'Off'}`;
    btnBlur.classList.toggle('active', state.blurEnabled);
    if (onBlurToggle) onBlurToggle();
  });

  btnDisplay.addEventListener('click', () => {
    const label = onDisplayCycle();
    state.displayMode = label.toLowerCase();
    btnDisplay.textContent = `Mode: ${label}`;
  });

  btnPlayPause.addEventListener('click', () => {
    onPlayPause();
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
    btnPlayPause.disabled = false;
    btnPlayPause.innerHTML = '&#9646;&#9646;';
    if (dotOriginal) dotOriginal.classList.add('active');
    if (dotDiff)     dotDiff.classList.add('active');
    if (placeholderOriginal) placeholderOriginal.style.display = 'none';
    if (placeholderDiff)     placeholderDiff.style.display = 'none';
  }

  function setPaused() {
    state.playing = false;
    btnPlayPause.innerHTML = '&#9654;';
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff)     dotDiff.classList.remove('active');
  }

  function showPlaceholders() {
    if (placeholderOriginal) placeholderOriginal.style.display = 'flex';
    if (placeholderDiff)     placeholderDiff.style.display = 'flex';
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff)     dotDiff.classList.remove('active');
    btnPlayPause.disabled = true;
    btnPlayPause.innerHTML = '&#9654;';
  }

  return {
    state,
    setPlaying,
    setPaused,
    showPlaceholders,
    get btnPlayPause() { return btnPlayPause; },
    get placeholderOriginal() { return placeholderOriginal; },
    get placeholderDiff() { return placeholderDiff; },
  };
}
