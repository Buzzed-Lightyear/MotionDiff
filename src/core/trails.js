/**
 * Merge multiple diff frames into a single trail image via per-channel max.
 *
 * In raw mode the highest raw value per channel wins (standard max),
 * and the base fill is 0 (black = no motion).
 *
 * In Posy mode the highest DEVIATION FROM 128 wins per channel,
 * and the base fill is 128 (gray = no motion). This distinction matters:
 * a pixel at value 50 carries more motion energy than one at 130 in Posy
 * space (deviation 78 vs 2), even though 50 < 130 numerically.
 *
 * @param {Uint8ClampedArray[]} frames - Array of diff frame pixel buffers
 * @param {boolean}             isPosy - Use deviation-from-128 comparison
 * @returns {Uint8ClampedArray|null}    New buffer, or null if frames is empty
 */
export function accumulate(frames, isPosy) {
  if (!frames.length) return null;

  const len = frames[0].length;
  const out = new Uint8ClampedArray(len);

  const base = isPosy ? 128 : 0;
  for (let i = 0; i < len; i += 4) {
    out[i]     = base;
    out[i + 1] = base;
    out[i + 2] = base;
    out[i + 3] = 255;
  }

  if (isPosy) {
    for (let t = 0; t < frames.length; t++) {
      const src = frames[t];
      for (let i = 0; i < len; i += 4) {
        const curDevR = Math.abs(out[i]     - 128);
        const curDevG = Math.abs(out[i + 1] - 128);
        const curDevB = Math.abs(out[i + 2] - 128);
        const srcDevR = Math.abs(src[i]     - 128);
        const srcDevG = Math.abs(src[i + 1] - 128);
        const srcDevB = Math.abs(src[i + 2] - 128);
        if (srcDevR > curDevR) out[i]     = src[i];
        if (srcDevG > curDevG) out[i + 1] = src[i + 1];
        if (srcDevB > curDevB) out[i + 2] = src[i + 2];
      }
    }
  } else {
    for (let t = 0; t < frames.length; t++) {
      const src = frames[t];
      for (let i = 0; i < len; i += 4) {
        if (src[i]     > out[i])     out[i]     = src[i];
        if (src[i + 1] > out[i + 1]) out[i + 1] = src[i + 1];
        if (src[i + 2] > out[i + 2]) out[i + 2] = src[i + 2];
      }
    }
  }

  return out;
}
