/**
 * UI module — DOM controls, sliders, buttons, preset clips, event bindings.
 */

/**
 * @typedef {Object} UICallbacks
 * @property {(file: File) => void} onFileLoad
 * @property {(url: string) => void} onUrlLoad
 * @property {() => void} onPlayPause
 * @property {() => string} onDisplayCycle
 * @property {() => void} onAlgorithmToggle
 * @property {() => void} onBlurToggle
 */

export class UI {
  /** @param {UICallbacks} cb */
  constructor(cb) {
    this.cb = cb;

    // ── Input elements ──
    this.fileInput     = /** @type {HTMLInputElement} */  (document.getElementById('fileInput'));
    this.urlInput      = /** @type {HTMLInputElement} */  (document.getElementById('urlInput'));
    this.loadUrlBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('loadUrlBtn'));
    this.statusMsg     = /** @type {HTMLElement} */       (document.getElementById('statusMsg'));

    // ── Sliders ──
    this.sliderOffset    = /** @type {HTMLInputElement} */ (document.getElementById('sliderOffset'));
    this.sliderThreshold = /** @type {HTMLInputElement} */ (document.getElementById('sliderThreshold'));
    this.sliderTrail     = /** @type {HTMLInputElement} */ (document.getElementById('sliderTrail'));
    this.sliderSpread    = /** @type {HTMLInputElement} */ (document.getElementById('sliderSpread'));

    // ── Slider labels ──
    this.valOffset    = /** @type {HTMLElement} */ (document.getElementById('valOffset'));
    this.valThreshold = /** @type {HTMLElement} */ (document.getElementById('valThreshold'));
    this.valTrail     = /** @type {HTMLElement} */ (document.getElementById('valTrail'));
    this.valSpread    = /** @type {HTMLElement} */ (document.getElementById('valSpread'));

    // ── Buttons ──
    this.btnAlgo      = /** @type {HTMLButtonElement} */ (document.getElementById('btnAlgo'));
    this.btnBlur      = /** @type {HTMLButtonElement} */ (document.getElementById('btnBlur'));
    this.btnDisplay   = /** @type {HTMLButtonElement} */ (document.getElementById('btnDisplay'));
    this.btnPlayPause = /** @type {HTMLButtonElement} */ (document.getElementById('btnPlayPause'));

    // ── Indicators ──
    this.dotOriginal = document.getElementById('dotOriginal');
    this.dotDiff     = document.getElementById('dotDiff');
    this.placeholderOriginal = document.getElementById('placeholderOriginal');
    this.placeholderDiff     = document.getElementById('placeholderDiff');

    // ── State (read by main.js each tick) ──
    this.state = {
      frameOffset: 5,
      threshold: 10,
      trailLength: 5,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
      displayMode: 'overlay',
      playing: false,
    };

    this._bindEvents();
    this._buildPresets();
  }

  _bindEvents() {
    // File input
    this.fileInput.addEventListener('change', (e) => {
      const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
      if (file) this.cb.onFileLoad(file);
    });

    // URL load
    this.loadUrlBtn.addEventListener('click', () => {
      const url = this.urlInput.value.trim();
      if (url) this.cb.onUrlLoad(url);
    });
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = this.urlInput.value.trim();
        if (url) this.cb.onUrlLoad(url);
      }
    });

    // Sliders
    this.sliderOffset.addEventListener('input', () => {
      const v = parseInt(this.sliderOffset.value, 10);
      this.state.frameOffset = v;
      this.valOffset.textContent = `${v}f`;
    });
    this.sliderThreshold.addEventListener('input', () => {
      const v = parseInt(this.sliderThreshold.value, 10);
      this.state.threshold = v;
      this.valThreshold.textContent = String(v);
    });
    this.sliderTrail.addEventListener('input', () => {
      const v = parseInt(this.sliderTrail.value, 10);
      this.state.trailLength = v;
      this.valTrail.textContent = `${v}f`;
    });
    this.sliderSpread.addEventListener('input', () => {
      const v = parseInt(this.sliderSpread.value, 10);
      this.state.channelSpread = v;
      this.valSpread.textContent = `${v}f`;
    });

    // Algorithm toggle
    this.btnAlgo.addEventListener('click', () => {
      if (this.state.algorithm === 'posy') {
        this.state.algorithm = 'raw';
        this.btnAlgo.textContent = 'Raw Diff';
        this.btnAlgo.classList.remove('active');
      } else {
        this.state.algorithm = 'posy';
        this.btnAlgo.textContent = 'Posy';
        this.btnAlgo.classList.add('active');
      }
      this.cb.onAlgorithmToggle();
    });

    // Blur toggle
    this.btnBlur.addEventListener('click', () => {
      this.state.blurEnabled = !this.state.blurEnabled;
      this.btnBlur.textContent = `Blur: ${this.state.blurEnabled ? 'On' : 'Off'}`;
      this.btnBlur.classList.toggle('active', this.state.blurEnabled);
      this.cb.onBlurToggle();
    });

    // Display mode cycle
    this.btnDisplay.addEventListener('click', () => {
      const label = this.cb.onDisplayCycle();
      this.state.displayMode = label.toLowerCase();
      this.btnDisplay.textContent = `Mode: ${label}`;
    });

    // Play/Pause
    this.btnPlayPause.addEventListener('click', () => {
      this.cb.onPlayPause();
    });
  }

  /** Bind preset clip buttons already present in the HTML */
  _buildPresets() {
    const container = document.getElementById('presetClips');
    if (!container) return;

    const buttons = container.querySelectorAll('.preset-btn');
    buttons.forEach((btn) => {
      const url = btn.getAttribute('data-url');
      if (url) {
        btn.addEventListener('click', () => {
          this.urlInput.value = url;
          this.cb.onUrlLoad(url);
        });
      }
    });
  }

  /**
   * Set status message.
   * @param {string} text
   * @param {'info'|'success'|'error'} type
   */
  setStatus(text, type = 'info') {
    this.statusMsg.textContent = text;
    this.statusMsg.className = 'status-msg';
    if (type === 'error') this.statusMsg.classList.add('error');
    else if (type === 'success') this.statusMsg.classList.add('success');
  }

  /** Video started playing. */
  setPlaying() {
    this.state.playing = true;
    this.btnPlayPause.disabled = false;
    this.btnPlayPause.innerHTML = '&#9646;&#9646;';
    if (this.dotOriginal) this.dotOriginal.classList.add('active');
    if (this.dotDiff)     this.dotDiff.classList.add('active');
    if (this.placeholderOriginal) this.placeholderOriginal.style.display = 'none';
    if (this.placeholderDiff)     this.placeholderDiff.style.display = 'none';
  }

  /** Video paused. */
  setPaused() {
    this.state.playing = false;
    this.btnPlayPause.innerHTML = '&#9654;';
    if (this.dotOriginal) this.dotOriginal.classList.remove('active');
    if (this.dotDiff)     this.dotDiff.classList.remove('active');
  }

  /** Reset to placeholder state. */
  showPlaceholders() {
    if (this.placeholderOriginal) this.placeholderOriginal.style.display = 'flex';
    if (this.placeholderDiff)     this.placeholderDiff.style.display = 'flex';
    if (this.dotOriginal) this.dotOriginal.classList.remove('active');
    if (this.dotDiff)     this.dotDiff.classList.remove('active');
    this.btnPlayPause.disabled = true;
    this.btnPlayPause.innerHTML = '&#9654;';
  }
}
