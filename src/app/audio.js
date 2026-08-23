import { SCALES, mapCell, smoothEnergy } from '../core/energy.js';

/**
 * Motion sonification engine.
 *
 * One continuously running sine voice per grid cell: the diff frame's energy
 * grid controls gain only, so a cell fades in and out instead of retriggering.
 * Signal chain per voice is Oscillator → Gain → Panner, all summed into a
 * master Gain → Limiter → destination.
 *
 * Tone.js is imported lazily inside start(): a top-level `tone` import pulls
 * Web Audio into `npm test`, which runs in plain node with no AudioContext.
 * start() must be called from a user gesture — browsers refuse to start an
 * AudioContext any other way.
 *
 * Every aesthetic decision here is a runtime parameter so it can be tuned by
 * ear afterwards; see DEFAULT_AUDIO_PARAMS for the defaults.
 */

/** Scale names core/energy.js knows, for the UI to offer. */
export const SCALE_NAMES = Object.keys(SCALES);

/** Voice cap — cols * rows above this is refused and clamped down. */
export const MAX_VOICES = 64;

export const DEFAULT_AUDIO_PARAMS = {
  enabled: false,
  masterVolume: -12, // dB
  cols: 8,
  rows: 4,
  scale: 'pentatonic',
  baseMidi: 45,
  gate: 0.02,
  attackMs: 60,
  releaseMs: 350,
};

/** Below this the master is treated as fully off rather than very quiet. */
const MIN_VOLUME_DB = -60;
/** setTargetAtTime time constant for per-voice gain — never set .value (clicks). */
const GAIN_RAMP_SECONDS = 0.03;
/** Master fades, used when starting, stopping and changing volume. */
const MASTER_RAMP_SECONDS = 0.05;
/** Outgoing voices fade over this before a grid-size rebuild tears them down. */
const REBUILD_FADE_SECONDS = 0.01;
const REBUILD_DISPOSE_MS = 120;
/** One 60 fps frame — the assumed delta for the first update after a start. */
const DEFAULT_DT_MS = 1000 / 60;
/** A tab that was backgrounded shouldn't collapse the envelope in one step. */
const MAX_DT_MS = 250;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function dbToGain(db) {
  return db <= MIN_VOLUME_DB ? 0 : Math.pow(10, db / 20);
}

export class AudioEngine {
  /**
   * @param {Partial<typeof DEFAULT_AUDIO_PARAMS>} [params]
   */
  constructor(params = {}) {
    this.params = { ...DEFAULT_AUDIO_PARAMS, ...params };

    /** @type {((message: string) => void)|null} Reports clamped grid sizes. */
    this.onNotice = null;

    this._Tone = null;
    this._starting = null;
    this._running = false;

    /** @type {{osc: object, gain: object, panner: object}[]} */
    this._voices = [];
    /** Preallocated envelope state — update() must not allocate. */
    this._envelopes = new Float32Array(0);
    this._lastUpdateMs = 0;

    this._master = null;
    this._limiter = null;

    this._applyGridLimit();
  }

  /** Whether the graph is built and voices are live. */
  isRunning() {
    return this._running;
  }

  /**
   * Grid the pipeline should produce, or 0x0 while nothing is listening — the
   * pipeline skips the readback entirely at 0.
   * @returns {{cols: number, rows: number}}
   */
  getGridSize() {
    if (!this._running) return { cols: 0, rows: 0 };
    return { cols: this.params.cols, rows: this.params.rows };
  }

  /**
   * Build the graph and resume the AudioContext. Idempotent, and safe to call
   * again after stop(). MUST be called from inside a user gesture handler.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._running) return;
    if (this._starting) return this._starting;

    this._starting = this._startInternal();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _startInternal() {
    if (!this._Tone) {
      this._Tone = await import('tone');
    }
    await this._Tone.start();

    if (!this._master) {
      // Start silent and ramp up so enabling audio doesn't thump.
      this._limiter = new this._Tone.Limiter(-6).toDestination();
      this._master = new this._Tone.Gain(0).connect(this._limiter);
    }
    if (this._voices.length === 0) this._buildVoices();

    this.params.enabled = true;
    this._running = true;
    this._lastUpdateMs = 0;
    this._master.gain.rampTo(dbToGain(this.params.masterVolume), MASTER_RAMP_SECONDS);
  }

  /**
   * Drive the voices from one processed frame's energy grid.
   * Called once per processed video frame; allocates nothing.
   * @param {Float32Array|null} grid - cols*rows energies in 0..1, row-major
   */
  update(grid) {
    if (!this._running || !grid || this._voices.length === 0) return;

    const { gate, attackMs, releaseMs } = this.params;

    const nowMs = performance.now();
    let dtMs = this._lastUpdateMs === 0 ? DEFAULT_DT_MS : nowMs - this._lastUpdateMs;
    this._lastUpdateMs = nowMs;
    if (!(dtMs > 0)) dtMs = DEFAULT_DT_MS;
    else if (dtMs > MAX_DT_MS) dtMs = MAX_DT_MS;

    const audioNow = this._Tone.now();
    const count = Math.min(grid.length, this._voices.length);

    for (let i = 0; i < count; i++) {
      // The envelope keeps the ungated value so a cell can recover smoothly.
      const smoothed = smoothEnergy(this._envelopes[i], grid[i], attackMs, releaseMs, dtMs);
      this._envelopes[i] = smoothed;
      const level = smoothed < gate ? 0 : smoothed;
      this._voices[i].gain.gain.setTargetAtTime(level, audioNow, GAIN_RAMP_SECONDS);
    }
  }

  /**
   * Update runtime parameters. `enabled: false` stops the engine; `enabled:
   * true` is ignored here because starting needs a user gesture — call start().
   * @param {Partial<typeof DEFAULT_AUDIO_PARAMS>} [p]
   */
  setParams(p = {}) {
    if (p.masterVolume !== undefined) {
      this.params.masterVolume = clampNumber(p.masterVolume, MIN_VOLUME_DB, 6, DEFAULT_AUDIO_PARAMS.masterVolume);
      if (this._master) {
        this._master.gain.rampTo(this._running ? dbToGain(this.params.masterVolume) : 0, MASTER_RAMP_SECONDS);
      }
    }

    if (p.gate !== undefined) {
      this.params.gate = clampNumber(p.gate, 0, 1, DEFAULT_AUDIO_PARAMS.gate);
    }
    if (p.attackMs !== undefined) {
      this.params.attackMs = clampNumber(p.attackMs, 1, 5000, DEFAULT_AUDIO_PARAMS.attackMs);
    }
    if (p.releaseMs !== undefined) {
      this.params.releaseMs = clampNumber(p.releaseMs, 1, 10000, DEFAULT_AUDIO_PARAMS.releaseMs);
    }

    let gridChanged = false;
    if (p.cols !== undefined) {
      this.params.cols = clampInt(p.cols, 1, MAX_VOICES, DEFAULT_AUDIO_PARAMS.cols);
      gridChanged = true;
    }
    if (p.rows !== undefined) {
      this.params.rows = clampInt(p.rows, 1, MAX_VOICES, DEFAULT_AUDIO_PARAMS.rows);
      gridChanged = true;
    }
    if (gridChanged) this._applyGridLimit();

    let mappingChanged = false;
    if (p.scale !== undefined) {
      this.params.scale = SCALES[p.scale] ? p.scale : DEFAULT_AUDIO_PARAMS.scale;
      mappingChanged = true;
    }
    if (p.baseMidi !== undefined) {
      this.params.baseMidi = clampInt(p.baseMidi, 0, 127, DEFAULT_AUDIO_PARAMS.baseMidi);
      mappingChanged = true;
    }

    if (gridChanged && this._voices.length !== this.params.cols * this.params.rows) {
      this._rebuildVoices();
    } else if (gridChanged || mappingChanged) {
      this._remapVoices();
    }

    if (p.enabled === false) this.stop();
  }

  /**
   * Fade the voices out and stop driving them. The graph stays built so start()
   * can bring it back without another user gesture.
   */
  stop() {
    this.params.enabled = false;
    if (!this._running) return;

    this._running = false;
    this._lastUpdateMs = 0;

    const now = this._Tone.now();
    for (let i = 0; i < this._voices.length; i++) {
      const param = this._voices[i].gain.gain;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(0, now, GAIN_RAMP_SECONDS);
      this._envelopes[i] = 0;
    }
    if (this._master) this._master.gain.rampTo(0, MASTER_RAMP_SECONDS);
  }

  /** Tear the whole graph down. The engine can be start()ed again afterwards. */
  dispose() {
    this.params.enabled = false;
    this._running = false;
    this._starting = null;
    this._lastUpdateMs = 0;

    this._disposeVoices(this._voices);
    this._voices = [];
    this._envelopes = new Float32Array(0);

    if (this._master) {
      this._master.dispose();
      this._master = null;
    }
    if (this._limiter) {
      this._limiter.dispose();
      this._limiter = null;
    }
  }

  // ── Internals ───────────────────────────────────────────────

  /**
   * Refuse grids above the voice cap and clamp them down — a few hundred
   * oscillators is enough to starve the render loop.
   */
  _applyGridLimit() {
    const cols = clampInt(this.params.cols, 1, MAX_VOICES, DEFAULT_AUDIO_PARAMS.cols);
    let rows = clampInt(this.params.rows, 1, MAX_VOICES, DEFAULT_AUDIO_PARAMS.rows);

    if (cols * rows > MAX_VOICES) {
      rows = Math.max(1, Math.floor(MAX_VOICES / cols));
      if (this.onNotice) {
        this.onNotice(`Grid clamped to ${cols}x${rows} — ${MAX_VOICES} voices max.`);
      }
    }

    this.params.cols = cols;
    this.params.rows = rows;
  }

  _buildVoices() {
    const Tone = this._Tone;
    const { cols, rows, scale, baseMidi } = this.params;
    const count = cols * rows;

    this._voices = new Array(count);
    this._envelopes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const { pan, freq } = mapCell(i % cols, (i / cols) | 0, cols, rows, { scale, baseMidi });
      const panner = new Tone.Panner(pan).connect(this._master);
      const gain = new Tone.Gain(0).connect(panner);
      // Oscillators run continuously; energy only ever moves the gain.
      const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' }).connect(gain);
      osc.start();
      this._voices[i] = { osc, gain, panner };
    }
  }

  _remapVoices() {
    const { cols, rows, scale, baseMidi } = this.params;
    for (let i = 0; i < this._voices.length; i++) {
      const { pan, freq } = mapCell(i % cols, (i / cols) | 0, cols, rows, { scale, baseMidi });
      this._voices[i].panner.pan.rampTo(pan, MASTER_RAMP_SECONDS);
      this._voices[i].osc.frequency.rampTo(freq, MASTER_RAMP_SECONDS);
    }
  }

  _rebuildVoices() {
    if (!this._Tone || !this._master) return;

    // Fade the outgoing bank before tearing it down so resizing doesn't click.
    const outgoing = this._voices;
    const now = this._Tone.now();
    for (const voice of outgoing) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, REBUILD_FADE_SECONDS);
    }
    setTimeout(() => this._disposeVoices(outgoing), REBUILD_DISPOSE_MS);

    this._buildVoices();
  }

  _disposeVoices(voices) {
    for (const voice of voices) {
      voice.osc.stop();
      voice.osc.dispose();
      voice.gain.dispose();
      voice.panner.dispose();
    }
  }
}
