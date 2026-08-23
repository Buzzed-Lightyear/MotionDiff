/**
 * Eulerian magnification core math (IIR variant).
 *
 * Each pixel's value over time is treated as a signal. Two exponential
 * moving averages (EMA) with different cutoff frequencies follow that
 * signal; their difference (band = fast − slow) is a temporal band-pass.
 * The band is multiplied by an amplification factor and added back onto
 * the current frame, making subtle periodic changes (pulse, breathing,
 * sway) visible in the original video.
 *
 * All functions operate on normalized 0..1 floats. This module is the
 * source of truth for the GLSL mirror in app/renderer.webgl.js.
 */

// Rec.709 luma weights — must match the shader constants exactly.
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// Floor keeping alpha inside (0, 1] while emaAlpha(f, 0) stays ≈ 0.
const MIN_ALPHA = 1e-6;

/**
 * Map a cutoff frequency to a per-frame EMA coefficient at the actual
 * frame interval: 1 − exp(−2π · freqHz · dtMs / 1000), clamped to (0, 1].
 * Pass the real dt each frame; do not assume 60 fps.
 *
 * @param {number} freqHz - Cutoff frequency in Hz
 * @param {number} dtMs   - Frame interval in milliseconds
 * @returns {number} EMA coefficient in (0, 1]
 */
export function emaAlpha(freqHz, dtMs) {
  const alpha = 1 - Math.exp((-2 * Math.PI * freqHz * dtMs) / 1000);
  if (!(alpha >= MIN_ALPHA)) return MIN_ALPHA;
  return alpha > 1 ? 1 : alpha;
}

/**
 * Single EMA step: state + alpha · (current − state).
 *
 * @param {number} state   - Previous EMA state (0..1)
 * @param {number} current - Current sample (0..1)
 * @param {number} alpha   - EMA coefficient (0..1]
 * @returns {number} Updated state
 */
export function emaUpdate(state, current, alpha) {
  return state + alpha * (current - state);
}

/**
 * Amplify a scalar band-pass sample: cur + amp · chroma · (fast − slow),
 * clamped to [0, 1]. For luma-like use pass chroma = 1 (the default) so
 * the result is cur + amp · (fast − slow); chroma < 1 scales the
 * amplification for color channels relative to a shared luma amp.
 *
 * @param {number} cur    - Current sample (0..1)
 * @param {number} fast   - Fast EMA state
 * @param {number} slow   - Slow EMA state
 * @param {number} amp    - Amplification factor
 * @param {number} [chroma] - Amp scale for chroma-like use (0..1)
 * @returns {number} Amplified sample clamped to [0, 1]
 */
export function magnifySample(cur, fast, slow, amp, chroma = 1) {
  const v = cur + amp * chroma * (fast - slow);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Amplify one RGB pixel with a luma/chroma split. The luma (Rec.709)
 * band is amplified by amp; the per-channel residual around that luma
 * band is amplified by amp · chroma:
 *   out = cur + amp·bandLuma + amp·chroma·(bandRGB − bandLuma)
 * Each channel is clamped to [0, 1].
 *
 * @param {number[]} curRGB  - Current pixel [r, g, b] (0..1)
 * @param {number[]} fastRGB - Fast EMA state [r, g, b]
 * @param {number[]} slowRGB - Slow EMA state [r, g, b]
 * @param {number}   amp     - Amplification factor
 * @param {number}   chroma  - Chroma amp scale (0..1)
 * @returns {number[]} Amplified [r, g, b] clamped to [0, 1]
 */
export function magnifyPixel(curRGB, fastRGB, slowRGB, amp, chroma) {
  const bandR = fastRGB[0] - slowRGB[0];
  const bandG = fastRGB[1] - slowRGB[1];
  const bandB = fastRGB[2] - slowRGB[2];
  const bandLuma = LUMA_R * bandR + LUMA_G * bandG + LUMA_B * bandB;
  const lumaTerm = amp * bandLuma;
  const chromaAmp = amp * chroma;

  let r = curRGB[0] + lumaTerm + chromaAmp * (bandR - bandLuma);
  let g = curRGB[1] + lumaTerm + chromaAmp * (bandG - bandLuma);
  let b = curRGB[2] + lumaTerm + chromaAmp * (bandB - bandLuma);
  if (r < 0) r = 0; else if (r > 1) r = 1;
  if (g < 0) g = 0; else if (g > 1) g = 1;
  if (b < 0) b = 0; else if (b > 1) b = 1;
  return [r, g, b];
}

/**
 * Seed both EMA states from a frame so the first magnified frame equals
 * the input exactly (zero-seeding would produce a bright flash decaying
 * over seconds).
 *
 * @param {Uint8ClampedArray} frame - RGBA pixel data (0..255)
 * @param {Float32Array}      fast  - Fast EMA state, same length as frame
 * @param {Float32Array}      slow  - Slow EMA state, same length as frame
 */
export function seedStates(frame, fast, slow) {
  const len = frame.length;
  for (let i = 0; i < len; i++) {
    const v = frame[i] / 255;
    fast[i] = v;
    slow[i] = v;
  }
}

/**
 * Full-frame magnification loop: update both EMA states in place from
 * curData, then write the amplified frame into out. Used verbatim by the
 * Canvas2D worker fallback.
 *
 * When the EMA input is pre-blurred, pass the blurred pixels as curData
 * and the unblurred frame as baseData so the states follow the blurred
 * signal while the band is added back onto the original image (this
 * mirrors the WebGL path). baseData defaults to curData.
 *
 * @param {Uint8ClampedArray} curData   - Current RGBA frame, EMA input
 * @param {Float32Array}      fastState - Fast EMA state (updated in place)
 * @param {Float32Array}      slowState - Slow EMA state (updated in place)
 * @param {Uint8ClampedArray} out       - Output RGBA buffer
 * @param {number}            alphaFast - EMA coefficient from the HIGH cutoff
 * @param {number}            alphaSlow - EMA coefficient from the LOW cutoff
 * @param {number}            amp       - Amplification factor
 * @param {number}            chroma    - Chroma amp scale (0..1)
 * @param {Uint8ClampedArray} [baseData] - RGBA frame the band is added onto
 */
export function magnifyFrame(curData, fastState, slowState, out, alphaFast, alphaSlow, amp, chroma, baseData = curData) {
  const len = curData.length;
  const chromaAmp = amp * chroma;
  for (let i = 0; i < len; i += 4) {
    const r = curData[i] / 255;
    const g = curData[i + 1] / 255;
    const b = curData[i + 2] / 255;

    const fastR = fastState[i]     + alphaFast * (r - fastState[i]);
    const fastG = fastState[i + 1] + alphaFast * (g - fastState[i + 1]);
    const fastB = fastState[i + 2] + alphaFast * (b - fastState[i + 2]);
    fastState[i]     = fastR;
    fastState[i + 1] = fastG;
    fastState[i + 2] = fastB;

    const slowR = slowState[i]     + alphaSlow * (r - slowState[i]);
    const slowG = slowState[i + 1] + alphaSlow * (g - slowState[i + 1]);
    const slowB = slowState[i + 2] + alphaSlow * (b - slowState[i + 2]);
    slowState[i]     = slowR;
    slowState[i + 1] = slowG;
    slowState[i + 2] = slowB;

    const bandR = fastR - slowR;
    const bandG = fastG - slowG;
    const bandB = fastB - slowB;
    const bandLuma = LUMA_R * bandR + LUMA_G * bandG + LUMA_B * bandB;
    const lumaTerm = amp * bandLuma;

    // Uint8ClampedArray assignment clamps to [0, 255] and rounds.
    out[i]     = (baseData[i]     / 255 + lumaTerm + chromaAmp * (bandR - bandLuma)) * 255;
    out[i + 1] = (baseData[i + 1] / 255 + lumaTerm + chromaAmp * (bandG - bandLuma)) * 255;
    out[i + 2] = (baseData[i + 2] / 255 + lumaTerm + chromaAmp * (bandB - bandLuma)) * 255;
    out[i + 3] = 255;
  }
}
