import { describe, it, expect } from 'vitest';
import {
  SCALES,
  DEFAULT_ATTACK_MS,
  DEFAULT_RELEASE_MS,
  DEFAULT_BASE_MIDI,
  cellEnergies,
  mapCell,
  midiToFreq,
  smoothEnergy,
} from '../energy.js';

/**
 * Build a width*height RGBA buffer filled with a single value on RGB.
 */
function makeFrame(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = fill;
    data[i + 1] = fill;
    data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return data;
}

/**
 * Paint the rectangle owned by one grid cell (uniform cell sizes).
 */
function paintCell(data, width, height, cols, rows, col, row, value) {
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  for (let y = row * cellH; y < (row + 1) * cellH; y++) {
    for (let x = col * cellW; x < (col + 1) * cellW; x++) {
      const idx = (y * width + x) * 4;
      data[idx]     = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
}

// ─────────────────────────────────────
//  energy.js — cellEnergies
// ─────────────────────────────────────

describe('cellEnergies', () => {
  // A1
  it('an all-128 Posy buffer is exactly zero in every cell', () => {
    const data = makeFrame(16, 8, 128);
    const grid = cellEnergies(data, 16, 8, 8, 4, true);

    expect(grid).toBeInstanceOf(Float32Array);
    expect(grid.length).toBe(32);
    for (let i = 0; i < grid.length; i++) {
      expect(grid[i]).toBe(0);
    }
  });

  // A1
  it('an all-0 Raw buffer is exactly zero in every cell', () => {
    const data = makeFrame(16, 8, 0);
    const grid = cellEnergies(data, 16, 8, 8, 4, false);

    expect(grid.length).toBe(32);
    for (let i = 0; i < grid.length; i++) {
      expect(grid[i]).toBe(0);
    }
  });

  // A2 — Posy: one cell at 255, everything else at the 128 baseline.
  it('Posy — a single 255 cell reads (255-128)/127 and leaves the rest silent', () => {
    const data = makeFrame(16, 8, 128);
    paintCell(data, 16, 8, 8, 4, 5, 2, 255);

    const grid = cellEnergies(data, 16, 8, 8, 4, true);
    const expected = (255 - 128) / 127; // exactly 1

    const hotIndex = 2 * 8 + 5;
    expect(grid[hotIndex]).toBeCloseTo(expected, 6);
    expect(Math.abs(grid[hotIndex] - expected)).toBeLessThan(1e-6);

    for (let i = 0; i < grid.length; i++) {
      if (i === hotIndex) continue;
      expect(grid[i]).toBe(0);
    }
  });

  // A2 — Raw: one cell at 255, everything else at the 0 baseline.
  it('Raw — a single 255 cell reads 255/255 and leaves the rest silent', () => {
    const data = makeFrame(16, 8, 0);
    paintCell(data, 16, 8, 8, 4, 5, 2, 255);

    const grid = cellEnergies(data, 16, 8, 8, 4, false);
    const expected = 255 / 255; // exactly 1

    const hotIndex = 2 * 8 + 5;
    expect(Math.abs(grid[hotIndex] - expected)).toBeLessThan(1e-6);

    for (let i = 0; i < grid.length; i++) {
      if (i === hotIndex) continue;
      expect(grid[i]).toBe(0);
    }
  });

  it('is row-major: row 0 is the top row of the frame', () => {
    const data = makeFrame(16, 8, 128);
    // Top-left cell only.
    paintCell(data, 16, 8, 8, 4, 0, 0, 255);

    const grid = cellEnergies(data, 16, 8, 8, 4, true);

    expect(grid[0]).toBeCloseTo(1, 6);
    expect(grid[8 * 3]).toBe(0); // bottom-left stays silent
  });

  it('averages partial motion inside a cell', () => {
    // 4x1 frame, 2 cells of 2 pixels. First cell: one pixel at 255, one at 128.
    const data = makeFrame(4, 1, 128);
    data[0] = 255; data[1] = 255; data[2] = 255;

    const grid = cellEnergies(data, 4, 1, 2, 1, true);

    expect(grid[0]).toBeCloseTo((127 / 2) / 127, 6);
    expect(grid[1]).toBe(0);
  });

  it('mixed channels use the mean of the three deviations', () => {
    // Single pixel: deviations 127, 0, 0 → mag 127/3.
    const data = new Uint8ClampedArray([255, 128, 128, 255]);
    const grid = cellEnergies(data, 1, 1, 1, 1, true);

    expect(grid[0]).toBeCloseTo((127 / 3) / 127, 6);
  });

  it('ignores the alpha channel', () => {
    const data = new Uint8ClampedArray([128, 128, 128, 0]);
    const grid = cellEnergies(data, 1, 1, 1, 1, true);

    expect(grid[0]).toBe(0);
  });

  it('clamps Posy deviations beyond 127 to 1', () => {
    // 0 deviates 128 from the baseline — one step past the normalizing range.
    const data = makeFrame(2, 2, 0);
    const grid = cellEnergies(data, 2, 2, 1, 1, true);

    expect(grid[0]).toBe(1);
  });

  it('edge cells absorb the remainder when the frame does not divide evenly', () => {
    // 5x1 frame, 2 cols → cellW 2, so col 0 owns x=0..1 and col 1 owns x=2..4.
    const data = makeFrame(5, 1, 128);
    // Only the far-right pixel moves: 1 of the 3 pixels in the edge cell.
    data[4 * 4] = 255; data[4 * 4 + 1] = 255; data[4 * 4 + 2] = 255;

    const grid = cellEnergies(data, 5, 1, 2, 1, true);

    expect(grid[0]).toBe(0);
    expect(grid[1]).toBeCloseTo((127 / 3) / 127, 6);
  });

  it('a 3x3 frame on a 2x2 grid covers every pixel exactly once', () => {
    const data = makeFrame(3, 3, 128);
    // Bottom-right pixel only — belongs to the edge cell in both axes.
    const idx = (2 * 3 + 2) * 4;
    data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;

    const grid = cellEnergies(data, 3, 3, 2, 2, true);

    expect(grid[0]).toBe(0); // 1 px cell (0,0)
    expect(grid[1]).toBe(0); // 2x1 cell
    expect(grid[2]).toBe(0); // 1x2 cell
    expect(grid[3]).toBeCloseTo((127 / 4) / 127, 6); // 2x2 cell, 1 px moving
  });

  it('cells with no pixels are silent rather than NaN', () => {
    // More columns than pixels: the leading cells own nothing.
    const grid = cellEnergies(makeFrame(2, 1, 0), 2, 1, 4, 1, false);

    expect(grid.length).toBe(4);
    for (let i = 0; i < grid.length; i++) {
      expect(Number.isNaN(grid[i])).toBe(false);
    }
  });

  it('returns a zero-filled grid of the right size for empty input', () => {
    const grid = cellEnergies(null, 0, 0, 4, 2, true);

    expect(grid.length).toBe(8);
    for (let i = 0; i < grid.length; i++) expect(grid[i]).toBe(0);
  });

  it('does not mutate the input buffer', () => {
    const data = makeFrame(8, 4, 128);
    paintCell(data, 8, 4, 4, 2, 1, 1, 200);
    const copy = new Uint8ClampedArray(data);

    cellEnergies(data, 8, 4, 4, 2, true);

    expect(data).toEqual(copy);
  });
});

// ─────────────────────────────────────
//  energy.js — mapCell
// ─────────────────────────────────────

describe('mapCell', () => {
  // A3 — pan
  it('pans hard left at col 0 and hard right at the last col', () => {
    expect(mapCell(0, 0, 8, 4).pan).toBe(-1);
    expect(mapCell(7, 0, 8, 4).pan).toBe(1);
  });

  // A3 — pan
  it('pan increases monotonically across columns', () => {
    const pans = [];
    for (let c = 0; c < 8; c++) pans.push(mapCell(c, 0, 8, 4).pan);

    for (let c = 1; c < pans.length; c++) {
      expect(pans[c]).toBeGreaterThan(pans[c - 1]);
    }
    expect(pans[4]).toBeCloseTo((4 / 7) * 2 - 1, 12);
  });

  it('a single column sits centered', () => {
    expect(mapCell(0, 0, 1, 4).pan).toBe(0);
  });

  // A3 — freq
  it('freq rises strictly from the bottom row to the top row', () => {
    const rows = 4;
    const freqs = [];
    // Walk bottom (row = rows-1) up to the top (row 0).
    for (let r = rows - 1; r >= 0; r--) freqs.push(mapCell(0, r, 8, rows).freq);

    for (let i = 1; i < freqs.length; i++) {
      expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    }
  });

  // A3 — pentatonic degrees
  it('pentatonic rows land on [0,2,4,7,9] semitones above baseMidi', () => {
    const rows = 5;
    for (let degree = 0; degree < 5; degree++) {
      const row = rows - 1 - degree; // degree 0 is the bottom row
      const { freq } = mapCell(0, row, 1, rows);
      expect(freq).toBeCloseTo(midiToFreq(DEFAULT_BASE_MIDI + SCALES.pentatonic[degree]), 9);
    }
  });

  it('wraps into the next octave once the scale runs out of degrees', () => {
    const rows = 7;
    // Degree 5 = first degree of the next octave.
    const { freq } = mapCell(0, rows - 1 - 5, 1, rows);
    expect(freq).toBeCloseTo(midiToFreq(DEFAULT_BASE_MIDI + 12), 9);
    // Degree 6 = second degree, one octave up.
    const next = mapCell(0, rows - 1 - 6, 1, rows).freq;
    expect(next).toBeCloseTo(midiToFreq(DEFAULT_BASE_MIDI + 12 + 2), 9);
  });

  it('honours the named scales', () => {
    const rows = 3;
    for (const name of ['pentatonic', 'major', 'minor', 'chromatic']) {
      const degrees = SCALES[name];
      for (let degree = 0; degree < rows; degree++) {
        const { freq } = mapCell(0, rows - 1 - degree, 1, rows, { scale: name });
        expect(freq).toBeCloseTo(midiToFreq(DEFAULT_BASE_MIDI + degrees[degree]), 9);
      }
    }
  });

  it('honours baseMidi and stepsPerRow', () => {
    const { freq } = mapCell(0, 0, 1, 2, { scale: 'chromatic', baseMidi: 60, stepsPerRow: 3 });
    // Top row of a 2-row grid = degree 3 → 3 chromatic semitones above 60.
    expect(freq).toBeCloseTo(midiToFreq(63), 9);
  });

  it('accepts an explicit degree array', () => {
    const { freq } = mapCell(0, 0, 1, 2, { scale: [0, 5], baseMidi: 40 });
    expect(freq).toBeCloseTo(midiToFreq(45), 9);
  });

  it('falls back to the defaults for unknown options', () => {
    const fallback = mapCell(3, 1, 8, 4, { scale: 'lydian-dominant', baseMidi: 'nope', stepsPerRow: 0 });
    const defaults = mapCell(3, 1, 8, 4);

    expect(fallback.pan).toBe(defaults.pan);
    expect(fallback.freq).toBe(defaults.freq);
  });

  it('clamps out-of-range cell coordinates', () => {
    expect(mapCell(99, 0, 8, 4).pan).toBe(mapCell(7, 0, 8, 4).pan);
    expect(mapCell(-5, 0, 8, 4).pan).toBe(mapCell(0, 0, 8, 4).pan);
  });
});

// ─────────────────────────────────────
//  energy.js — midiToFreq
// ─────────────────────────────────────

describe('midiToFreq', () => {
  it('A4 (MIDI 69) is 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 9);
  });

  it('an octave down halves the frequency', () => {
    expect(midiToFreq(57)).toBeCloseTo(220, 9);
    expect(midiToFreq(81)).toBeCloseTo(880, 9);
  });

  it('the default baseMidi of 45 is A2 (110 Hz)', () => {
    expect(midiToFreq(DEFAULT_BASE_MIDI)).toBeCloseTo(110, 9);
  });
});

// ─────────────────────────────────────
//  energy.js — smoothEnergy
// ─────────────────────────────────────

describe('smoothEnergy', () => {
  // A4
  it('reaches ~0.632 after one attack time constant', () => {
    const value = smoothEnergy(0, 1, DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, DEFAULT_ATTACK_MS);

    expect(value).toBeGreaterThan(0.632 - 0.02);
    expect(value).toBeLessThan(0.632 + 0.02);
  });

  // A4 — release is slower than attack.
  it('decays more slowly than it rises with the default time constants', () => {
    const rising = smoothEnergy(0, 1, DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, 100);
    const falling = smoothEnergy(1, 0, DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, 100);

    expect(rising).toBeGreaterThan(1 - falling);
  });

  it('uses the attack constant when rising and the release constant when falling', () => {
    const rise = smoothEnergy(0, 1, 60, 350, 60);
    const fall = smoothEnergy(1, 0, 60, 350, 60);

    expect(rise).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(fall).toBeCloseTo(Math.exp(-60 / 350), 12);
  });

  it('converges toward the target without overshooting', () => {
    let value = 0;
    for (let i = 0; i < 200; i++) {
      value = smoothEnergy(value, 1, 60, 350, 16.7);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(value).toBeCloseTo(1, 6);
  });

  it('holds steady when the target already equals the current value', () => {
    expect(smoothEnergy(0.4, 0.4, 60, 350, 16.7)).toBeCloseTo(0.4, 12);
  });

  it('returns the previous value for a non-positive or invalid dt', () => {
    expect(smoothEnergy(0.5, 1, 60, 350, 0)).toBe(0.5);
    expect(smoothEnergy(0.5, 1, 60, 350, -10)).toBe(0.5);
    expect(smoothEnergy(0.5, 1, 60, 350, NaN)).toBe(0.5);
  });

  it('snaps to the target when the time constant is zero', () => {
    expect(smoothEnergy(0.5, 1, 0, 350, 16.7)).toBe(1);
    expect(smoothEnergy(1, 0.2, 60, 0, 16.7)).toBe(0.2);
  });

  it('treats non-finite inputs as zero', () => {
    expect(smoothEnergy(NaN, 1, 60, 350, 60)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(smoothEnergy(1, NaN, 60, 350, 350)).toBeCloseTo(Math.exp(-1), 12);
  });

  it('defaults to 60 ms attack and 350 ms release', () => {
    expect(smoothEnergy(0, 1, undefined, undefined, 60)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(smoothEnergy(1, 0, undefined, undefined, 350)).toBeCloseTo(Math.exp(-1), 12);
  });
});
