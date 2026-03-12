/**
 * Renderer — writes pipeline results to the output canvas.
 * Three display modes: Diff, Overlay (screen blend), and Glow.
 */

/** @enum {string} */
export const DisplayMode = {
  DIFF: 'diff',
  OVERLAY: 'overlay',
  GLOW: 'glow',
};

const MODE_ORDER = [DisplayMode.DIFF, DisplayMode.OVERLAY, DisplayMode.GLOW];
const MODE_LABELS = { diff: 'Diff', overlay: 'Overlay', glow: 'Glow' };

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.mode = DisplayMode.OVERLAY;
  }

  /**
   * Resize the output canvas to match processing dimensions.
   * @param {number} w
   * @param {number} h
   */
  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** Fill the canvas with black. */
  renderBlack() {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Fill the canvas with neutral gray (Posy idle state). */
  renderGray() {
    this.ctx.fillStyle = '#808080';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Render the pipeline output in the current display mode.
   * @param {ImageData} currentFrame
   * @param {ImageData|null} accumulated
   * @param {string} algorithm - 'raw' or 'posy'
   */
  render(currentFrame, accumulated, algorithm) {
    if (!accumulated) {
      if (algorithm === 'posy') this.renderGray();
      else this.renderBlack();
      return;
    }

    switch (this.mode) {
      case DisplayMode.DIFF:
        this._renderDiff(accumulated);
        break;
      case DisplayMode.OVERLAY:
        this._renderOverlay(currentFrame, accumulated, algorithm);
        break;
      case DisplayMode.GLOW:
        this._renderGlow(currentFrame, accumulated, algorithm);
        break;
    }
  }

  /** Direct diff output. @param {ImageData} acc */
  _renderDiff(acc) {
    this.ctx.putImageData(acc, 0, 0);
  }

  /**
   * Screen-blend diff onto original.
   * Screen: result = 1 - (1 - base) * (1 - blend)
   * In 0–255: result = 255 - ((255 - base) * (255 - blend)) / 255
   * For Posy mode, we extract deviation from gray and use that as the blend.
   */
  _renderOverlay(currentFrame, accumulated, algorithm) {
    const orig = currentFrame.data;
    const diff = accumulated.data;
    const len = orig.length;
    const output = new ImageData(this.canvas.width, this.canvas.height);
    const out = output.data;

    if (algorithm === 'posy') {
      // Extract motion deviation from 128, screen-blend onto original
      for (let i = 0; i < len; i += 4) {
        // Deviation doubled and clamped for visibility
        const motR = Math.min(255, Math.abs(diff[i]     - 128) * 4);
        const motG = Math.min(255, Math.abs(diff[i + 1] - 128) * 4);
        const motB = Math.min(255, Math.abs(diff[i + 2] - 128) * 4);

        // Screen blend
        out[i]     = 255 - (((255 - orig[i])     * (255 - motR)) >> 8);
        out[i + 1] = 255 - (((255 - orig[i + 1]) * (255 - motG)) >> 8);
        out[i + 2] = 255 - (((255 - orig[i + 2]) * (255 - motB)) >> 8);
        out[i + 3] = 255;
      }
    } else {
      // Raw diff: screen blend directly
      for (let i = 0; i < len; i += 4) {
        const bR = Math.min(255, diff[i] * 2);
        const bG = Math.min(255, diff[i + 1] * 2);
        const bB = Math.min(255, diff[i + 2] * 2);
        out[i]     = 255 - (((255 - orig[i])     * (255 - bR)) >> 8);
        out[i + 1] = 255 - (((255 - orig[i + 1]) * (255 - bG)) >> 8);
        out[i + 2] = 255 - (((255 - orig[i + 2]) * (255 - bB)) >> 8);
        out[i + 3] = 255;
      }
    }

    this.ctx.putImageData(output, 0, 0);
  }

  /**
   * Glow mode: original + amplified bloom from motion.
   * Like overlay but with extra boost and additive blending.
   */
  _renderGlow(currentFrame, accumulated, algorithm) {
    const orig = currentFrame.data;
    const diff = accumulated.data;
    const len = orig.length;
    const output = new ImageData(this.canvas.width, this.canvas.height);
    const out = output.data;

    if (algorithm === 'posy') {
      for (let i = 0; i < len; i += 4) {
        const motR = Math.min(255, Math.abs(diff[i]     - 128) * 6);
        const motG = Math.min(255, Math.abs(diff[i + 1] - 128) * 6);
        const motB = Math.min(255, Math.abs(diff[i + 2] - 128) * 6);
        // Additive blend with clamp
        out[i]     = Math.min(255, orig[i]     + motR);
        out[i + 1] = Math.min(255, orig[i + 1] + motG);
        out[i + 2] = Math.min(255, orig[i + 2] + motB);
        out[i + 3] = 255;
      }
    } else {
      for (let i = 0; i < len; i += 4) {
        out[i]     = Math.min(255, orig[i]     + diff[i] * 3);
        out[i + 1] = Math.min(255, orig[i + 1] + diff[i + 1] * 3);
        out[i + 2] = Math.min(255, orig[i + 2] + diff[i + 2] * 3);
        out[i + 3] = 255;
      }
    }

    this.ctx.putImageData(output, 0, 0);
  }

  /**
   * Cycle to the next display mode.
   * @returns {string} the new mode label
   */
  cycleMode() {
    const idx = MODE_ORDER.indexOf(this.mode);
    this.mode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    return MODE_LABELS[this.mode];
  }

  /** @returns {string} */
  getModeLabel() {
    return MODE_LABELS[this.mode];
  }
}
