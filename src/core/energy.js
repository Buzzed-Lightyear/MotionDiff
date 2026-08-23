/**
 * Motion energy grid math for sonification.
 *
 * Pure functions only — this module imports nothing (core layer rule).
 *
 * A diff frame already encodes motion as a deviation from the mode's baseline:
 * 128 in Posy space, 0 in Raw space. `cellEnergies` downsamples that deviation
 * to a coarse grid so each cell can drive one synth voice; `mapCell` turns a
 * cell coordinate into a stereo position and a pitch; `smoothEnergy` is the
 * per-voice envelope follower that keeps gain changes click-free.
 */

/** Posy "no motion" value. Raw mode's baseline is 0. */
const POSY_BASELINE = 128;
/** Largest deviation Posy space normalizes against (matches posyBlend's mag). */
const POSY_RANGE = 127;
const RAW_BASELINE = 0;
const RAW_RANGE = 255;

/** Scale degrees in semitones, one octave; higher degrees wrap and add 12. */
export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const DEFAULT_SCALE = 'pentatonic';
export const DEFAULT_BASE_MIDI = 45;
export const DEFAULT_STEPS_PER_ROW = 1;
export const DEFAULT_ATTACK_MS = 60;
export const DEFAULT_RELEASE_MS = 350;

/** One 60 fps frame — used when a caller has no measured frame delta yet. */
const DEFAULT_DT_MS = 1000 / 60;

function gridDim(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function clampIndex(value, length) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), length - 1);
}

function resolveScale(scale) {
  if (Array.isArray(scale) && scale.length > 0) {
    const degrees = scale.filter((step) => Number.isFinite(step));
    if (degrees.length > 0) return degrees;
  }
  if (typeof scale === 'string' && SCALES[scale]) return SCALES[scale];
  return SCALES[DEFAULT_SCALE];
}

/**
 * Mean per-pixel motion magnitude per grid cell, normalized to 0..1.
 *
 * Motion magnitude per pixel is the mean of the three channel deviations from
 * the mode's baseline — the same `mag` that posyBlend/rawDiff threshold on.
 * The grid is row-major, row 0 being the top row of the image.
 *
 * Cells are `floor(width / cols)` by `floor(height / rows)` pixels; the last
 * column and last row absorb any remainder pixels so the whole frame is covered.
 *
 * @param {Uint8ClampedArray|Uint8Array} data - RGBA diff pixels, width*height*4
 * @param {number}  width
 * @param {number}  height
 * @param {number}  cols
 * @param {number}  rows
 * @param {boolean} isPosy - Posy space (baseline 128) vs Raw space (baseline 0)
 * @returns {Float32Array} cols*rows energies in 0..1, row-major
 */
export function cellEnergies(data, width, height, cols, rows, isPosy) {
  const nCols = gridDim(cols);
  const nRows = gridDim(rows);
  const out = new Float32Array(nCols * nRows);

  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!data || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return out;

  const baseline = isPosy ? POSY_BASELINE : RAW_BASELINE;
  const range = isPosy ? POSY_RANGE : RAW_RANGE;
  const cellW = Math.floor(w / nCols);
  const cellH = Math.floor(h / nRows);

  for (let r = 0; r < nRows; r++) {
    const y0 = Math.min(r * cellH, h);
    const y1 = r === nRows - 1 ? h : Math.min(y0 + cellH, h);

    for (let c = 0; c < nCols; c++) {
      const x0 = Math.min(c * cellW, w);
      const x1 = c === nCols - 1 ? w : Math.min(x0 + cellW, w);

      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++) {
          sum += (
            Math.abs(data[idx] - baseline) +
            Math.abs(data[idx + 1] - baseline) +
            Math.abs(data[idx + 2] - baseline)
          ) / 3;
          idx += 4;
          count++;
        }
      }

      // A grid finer than the frame leaves some cells with no pixels — silent.
      out[r * nCols + c] = count === 0 ? 0 : Math.min(1, (sum / count) / range);
    }
  }

  return out;
}

/** MIDI note number to frequency in Hz. */
export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * Map a grid cell to a stereo position and a pitch.
 *
 * Pan is linear across columns: col 0 is hard left (−1), the last column is
 * hard right (+1), and a single-column grid sits centered at 0.
 * Pitch ascends bottom row → top row, one `stepsPerRow` scale degree per row,
 * wrapping into higher octaves once the scale runs out of degrees.
 *
 * @param {number} col
 * @param {number} row - 0 is the TOP row (row-major, image order)
 * @param {number} cols
 * @param {number} rows
 * @param {{scale?: string|number[], baseMidi?: number, stepsPerRow?: number}} [opts]
 * @returns {{pan: number, freq: number}}
 */
export function mapCell(col, row, cols, rows, opts = {}) {
  const nCols = gridDim(cols);
  const nRows = gridDim(rows);
  const c = clampIndex(col, nCols);
  const r = clampIndex(row, nRows);

  const pan = nCols <= 1 ? 0 : (c / (nCols - 1)) * 2 - 1;

  const degrees = resolveScale(opts.scale);
  const baseMidi = Number.isFinite(opts.baseMidi) ? Number(opts.baseMidi) : DEFAULT_BASE_MIDI;
  const steps = Math.floor(Number(opts.stepsPerRow));
  const stepsPerRow = Number.isFinite(steps) && steps > 0 ? steps : DEFAULT_STEPS_PER_ROW;

  // Bottom row is degree 0 so pitch rises with height in the frame.
  const degree = (nRows - 1 - r) * stepsPerRow;
  const octave = Math.floor(degree / degrees.length);
  const semitone = degrees[degree - octave * degrees.length] + octave * 12;

  return { pan, freq: midiToFreq(baseMidi + semitone) };
}

/**
 * One-pole envelope follower: rising energy uses the attack time constant,
 * falling energy uses the (slower) release, so voices bloom quickly and decay
 * gently instead of chattering with the frame rate.
 *
 * @param {number} prev      - Previous smoothed value
 * @param {number} target    - Latest raw energy
 * @param {number} [attackMs]
 * @param {number} [releaseMs]
 * @param {number} [dtMs]    - Milliseconds since the previous update
 * @returns {number}
 */
export function smoothEnergy(
  prev,
  target,
  attackMs = DEFAULT_ATTACK_MS,
  releaseMs = DEFAULT_RELEASE_MS,
  dtMs = DEFAULT_DT_MS,
) {
  const from = Number.isFinite(prev) ? Number(prev) : 0;
  const to = Number.isFinite(target) ? Number(target) : 0;
  const dt = Number(dtMs);
  if (!Number.isFinite(dt) || dt <= 0) return from;

  const tau = Number(to >= from ? attackMs : releaseMs);
  if (!Number.isFinite(tau) || tau <= 0) return to;

  const coef = 1 - Math.exp(-dt / tau);
  return from + (to - from) * coef;
}
