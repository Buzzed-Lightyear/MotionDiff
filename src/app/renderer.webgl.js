/**
 * WebGL2 renderer for MotionDiff.
 *
 * Replaces the CPU Worker path for diff/blur/accumulate/composite.
 * All pixel math runs on the GPU via fragment shaders:
 *   - Program 1: Diff (Posy + Raw in one shader, branched by uniform)
 *   - Program 2: Trail accumulation (max-deviation merge across trail frames)
 *   - Program 3: Composite (diff / overlay / glow modes)
 *
 * The renderer also handles a 3×3 box blur pass when enabled.
 */

// ── Shader sources ──────────────────────────────────────────────

const VERT_SRC = `#version 300 es
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const DIFF_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uCurrent;
uniform sampler2D uOldR;
uniform sampler2D uOldG;
uniform sampler2D uOldB;
uniform float uThreshold;   // 0–60 mapped to 0.0–0.235
uniform int uAlgorithm;     // 0 = Posy, 1 = Raw Diff

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 cur = texture(uCurrent, vUV);
  vec4 oldR = texture(uOldR, vUV);
  vec4 oldG = texture(uOldG, vUV);
  vec4 oldB = texture(uOldB, vUV);

  // Assemble channel-shifted old frame
  vec3 old = vec3(oldR.r, oldG.g, oldB.b);

  vec3 result;
  float mag;

  if (uAlgorithm == 0) {
    // Posy: (current + invert(old) + 1/255) / 2
    // The +1/255 matches the CPU +1 before >>1 for rounding
    result = (cur.rgb + (1.0 - old) + (1.0 / 255.0)) * 0.5;
    mag = (abs(result.r - 0.5) + abs(result.g - 0.5) +
           abs(result.b - 0.5)) / 3.0;
    if (mag < uThreshold) result = vec3(0.5);
  } else {
    // Raw diff
    result = abs(cur.rgb - old);
    mag = (result.r + result.g + result.b) / 3.0;
    if (mag < uThreshold) result = vec3(0.0);
  }

  fragColor = vec4(result, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uInput;
uniform vec2 uTexelSize;  // 1.0/width, 1.0/height

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 offset = vec2(float(dx), float(dy)) * uTexelSize;
      sum += texture(uInput, vUV + offset).rgb;
    }
  }
  fragColor = vec4(sum / 9.0, 1.0);
}`;

// Two-input accumulation: merges "current best" with "next trail frame".
// Called iteratively from JS — one draw call per trail frame.
const ACCUM_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uAccum;   // current accumulated result (or base fill)
uniform sampler2D uTrail;   // next trail frame to merge
uniform int uIsPosy;        // 1 = posy, 0 = raw
uniform int uIsFirst;       // 1 = first pass (use base fill), 0 = read uAccum

in vec2 vUV;
out vec4 fragColor;

void main() {
  float baseVal = uIsPosy == 1 ? 0.5 : 0.0;
  vec3 best;
  if (uIsFirst == 1) {
    best = vec3(baseVal);
  } else {
    best = texture(uAccum, vUV).rgb;
  }

  vec3 s = texture(uTrail, vUV).rgb;

  if (uIsPosy == 1) {
    // Max deviation from 0.5 per channel
    vec3 bestDev = abs(best - 0.5);
    vec3 srcDev = abs(s - 0.5);
    if (srcDev.r > bestDev.r) best.r = s.r;
    if (srcDev.g > bestDev.g) best.g = s.g;
    if (srcDev.b > bestDev.b) best.b = s.b;
  } else {
    // Max raw value per channel
    best = max(best, s);
  }

  fragColor = vec4(best, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uDiff;
uniform sampler2D uOriginal;
uniform int uMode;       // 0=diff, 1=overlay, 2=glow
uniform int uAlgorithm;  // 0=posy, 1=raw

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 diff = texture(uDiff, vUV).rgb;
  vec3 orig = texture(uOriginal, vUV).rgb;

  vec3 result;

  if (uMode == 0) {
    // Diff only
    result = diff;
  } else if (uMode == 1) {
    // Overlay: screen blend of motion magnitude onto original
    vec3 mot;
    if (uAlgorithm == 0) {
      mot = min(vec3(1.0), abs(diff - 0.5) * 4.0);
    } else {
      mot = min(vec3(1.0), diff * 2.0);
    }
    // screen(a, b) = 1 - (1-a)*(1-b)
    result = 1.0 - (1.0 - orig) * (1.0 - mot);
  } else {
    // Glow: additive blend
    vec3 mot;
    if (uAlgorithm == 0) {
      mot = min(vec3(1.0), abs(diff - 0.5) * 6.0);
    } else {
      mot = min(vec3(1.0), diff * 3.0);
    }
    result = min(vec3(1.0), orig + mot);
  }

  fragColor = vec4(result, 1.0);
}`;

// ── Helpers ─────────────────────────────────────────────────────

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}`);
  }
  return sh;
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }
  return prog;
}

function createTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createFramebuffer(gl, tex) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return fb;
}

// ── WebGLRenderer class ─────────────────────────────────────────

const MAX_TRAILS = 20;

export class WebGLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The output canvas element
   * @throws {Error} If WebGL2 is not available
   */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not available');

    this.gl = gl;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;

    // Programs
    this._diffProg = null;
    this._blurProg = null;
    this._accumProg = null;
    this._compositeProg = null;

    // Geometry
    this._quadVAO = null;

    // Textures for current + old frames (4 slots for channel spread)
    this._texCurrent = null;
    this._texOldR = null;
    this._texOldG = null;
    this._texOldB = null;

    // Trail textures (ring of framebuffers)
    this._trailTextures = [];
    this._trailFBs = [];
    this._trailHead = -1;
    this._trailSize = 0;

    // Intermediate framebuffers
    this._diffTex = null;
    this._diffFB = null;
    this._blurTex = null;
    this._blurFB = null;
    this._accumTex = null;
    this._accumFB = null;
    // Ping-pong buffer for iterative accumulation
    this._accumTex2 = null;
    this._accumFB2 = null;

    this._init();
  }

  _init() {
    const gl = this.gl;

    // ── Compile shader programs ──
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);

    const diffFs = compileShader(gl, gl.FRAGMENT_SHADER, DIFF_FRAG);
    this._diffProg = linkProgram(gl, vs, diffFs);

    const blurFs = compileShader(gl, gl.FRAGMENT_SHADER, BLUR_FRAG);
    this._blurProg = linkProgram(gl, vs, blurFs);

    const accumFs = compileShader(gl, gl.FRAGMENT_SHADER, ACCUM_FRAG);
    this._accumProg = linkProgram(gl, vs, accumFs);

    const compFs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITE_FRAG);
    this._compositeProg = linkProgram(gl, vs, compFs);

    // We can delete the individual shader objects now — they're linked
    gl.deleteShader(vs);
    gl.deleteShader(diffFs);
    gl.deleteShader(blurFs);
    gl.deleteShader(accumFs);
    gl.deleteShader(compFs);

    // ── Fullscreen quad geometry ──
    this._quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this._quadVAO);

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    // Two triangles covering clip space [-1, 1]
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1,  1, 1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    // Bind aPosition at location 0 in all programs
    const loc = gl.getAttribLocation(this._diffProg, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // ── Create input textures ──
    this._texCurrent = createTexture(gl);
    this._texOldR = createTexture(gl);
    this._texOldG = createTexture(gl);
    this._texOldB = createTexture(gl);
  }

  /**
   * Set up framebuffers and textures for the processing resolution.
   * Must be called whenever video dimensions change.
   */
  setSize(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;

    const gl = this.gl;

    // Canvas must match processing resolution
    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);

    // ── Intermediate framebuffers ──
    // Diff output
    this._cleanupTexFB(this._diffTex, this._diffFB);
    this._diffTex = this._createSizedTexture(width, height);
    this._diffFB = createFramebuffer(gl, this._diffTex);

    // Blur (ping-pong with diff)
    this._cleanupTexFB(this._blurTex, this._blurFB);
    this._blurTex = this._createSizedTexture(width, height);
    this._blurFB = createFramebuffer(gl, this._blurTex);

    // Accumulation output (ping-pong pair)
    this._cleanupTexFB(this._accumTex, this._accumFB);
    this._accumTex = this._createSizedTexture(width, height);
    this._accumFB = createFramebuffer(gl, this._accumTex);

    this._cleanupTexFB(this._accumTex2, this._accumFB2);
    this._accumTex2 = this._createSizedTexture(width, height);
    this._accumFB2 = createFramebuffer(gl, this._accumTex2);

    // ── Trail ring buffer (re-create all) ──
    for (let i = 0; i < this._trailTextures.length; i++) {
      this._cleanupTexFB(this._trailTextures[i], this._trailFBs[i]);
    }
    this._trailTextures = [];
    this._trailFBs = [];
    for (let i = 0; i < MAX_TRAILS; i++) {
      const tex = this._createSizedTexture(width, height);
      const fb = createFramebuffer(gl, tex);
      this._trailTextures.push(tex);
      this._trailFBs.push(fb);
    }
    this._trailHead = -1;
    this._trailSize = 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createSizedTexture(w, h) {
    const gl = this.gl;
    const tex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  _cleanupTexFB(tex, fb) {
    const gl = this.gl;
    if (tex) gl.deleteTexture(tex);
    if (fb) gl.deleteFramebuffer(fb);
  }

  /**
   * Upload an image source (VideoFrame, HTMLVideoElement, ImageData, etc.)
   * to one of the input texture slots.
   * @param {TexImageSource} source
   * @param {'current'|'oldR'|'oldG'|'oldB'} slot
   */
  uploadFrame(source, slot) {
    const gl = this.gl;
    let tex;
    switch (slot) {
      case 'current': tex = this._texCurrent; break;
      case 'oldR':    tex = this._texOldR; break;
      case 'oldG':    tex = this._texOldG; break;
      case 'oldB':    tex = this._texOldB; break;
      default: return;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /**
   * Upload an ImageData buffer to a texture slot.
   */
  uploadImageData(imageData, slot) {
    const gl = this.gl;
    let tex;
    switch (slot) {
      case 'current': tex = this._texCurrent; break;
      case 'oldR':    tex = this._texOldR; break;
      case 'oldG':    tex = this._texOldG; break;
      case 'oldB':    tex = this._texOldB; break;
      default: return;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imageData.width, imageData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
  }

  /**
   * Run the diff shader. Output goes to the diff framebuffer.
   * @param {object} params - { threshold, algorithm }
   */
  renderDiff(params) {
    const gl = this.gl;
    const prog = this._diffProg;
    gl.useProgram(prog);

    // Bind textures to units
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurrent);
    gl.uniform1i(gl.getUniformLocation(prog, 'uCurrent'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texOldR);
    gl.uniform1i(gl.getUniformLocation(prog, 'uOldR'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._texOldG);
    gl.uniform1i(gl.getUniformLocation(prog, 'uOldG'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._texOldB);
    gl.uniform1i(gl.getUniformLocation(prog, 'uOldB'), 3);

    // Set uniforms
    // threshold: 0–60 in UI → normalize to 0.0–0.235 range (60/255 ≈ 0.235)
    gl.uniform1f(gl.getUniformLocation(prog, 'uThreshold'), params.threshold / 255.0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAlgorithm'), params.algorithm === 'posy' ? 0 : 1);

    // Draw to diff framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._diffFB);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Run the box blur shader on the diff output.
   * Reads from _diffTex, writes to _blurTex, then copies back.
   */
  renderBlur() {
    const gl = this.gl;
    const prog = this._blurProg;
    gl.useProgram(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uInput'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'uTexelSize'), 1.0 / this.width, 1.0 / this.height);

    // Render to blur FB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._blurFB);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Copy blur result back to diff texture (blit)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._blurFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._diffFB);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Push the current diff result into the trail ring buffer.
   * Copies from _diffTex to the next trail slot.
   */
  pushTrail() {
    const gl = this.gl;
    this._trailHead = (this._trailHead + 1) % MAX_TRAILS;
    if (this._trailSize < MAX_TRAILS) this._trailSize++;

    // Blit diff → trail slot
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._diffFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._trailFBs[this._trailHead]);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Run the trail accumulation via iterative ping-pong.
   * For each trail frame, merge it with the running accumulated result.
   * The final result ends up in _accumTex/_accumFB.
   * @param {number} trailLength - How many trail frames to merge
   * @param {boolean} isPosy
   */
  renderAccumulate(trailLength, isPosy) {
    const gl = this.gl;
    const prog = this._accumProg;
    gl.useProgram(prog);

    const T = Math.min(trailLength, this._trailSize);
    if (T === 0) return;

    const uAccum = gl.getUniformLocation(prog, 'uAccum');
    const uTrail = gl.getUniformLocation(prog, 'uTrail');
    const uIsPosy = gl.getUniformLocation(prog, 'uIsPosy');
    const uIsFirst = gl.getUniformLocation(prog, 'uIsFirst');

    gl.uniform1i(uIsPosy, isPosy ? 1 : 0);
    gl.bindVertexArray(this._quadVAO);

    // Ping-pong between _accumFB and _accumFB2
    // Read from A, write to B, then swap
    let readTex = this._accumTex;   // "current best" texture
    let readFB = this._accumFB;
    let writeTex = this._accumTex2;
    let writeFB = this._accumFB2;

    for (let i = 0; i < T; i++) {
      const trailIdx = (this._trailHead - i + MAX_TRAILS) % MAX_TRAILS;

      // Bind accumulated-so-far on unit 0
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform1i(uAccum, 0);

      // Bind this trail frame on unit 1
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._trailTextures[trailIdx]);
      gl.uniform1i(uTrail, 1);

      // On first pass, tell shader to use base fill instead of reading uAccum
      gl.uniform1i(uIsFirst, i === 0 ? 1 : 0);

      // Render to the write FB
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFB);
      gl.viewport(0, 0, this.width, this.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap ping-pong
      const tmpTex = readTex;
      const tmpFB = readFB;
      readTex = writeTex;
      readFB = writeFB;
      writeTex = tmpTex;
      writeFB = tmpFB;
    }

    // After the loop, the final result is in readTex/readFB.
    // We need it in _accumTex/_accumFB for the composite step.
    // If it's already there, great. If not, blit.
    if (readTex !== this._accumTex) {
      // The result ended up in _accumTex2 — blit to _accumTex
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFB);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._accumFB);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Run the composite shader. Output goes directly to canvas.
   * @param {string} mode - 'diff' | 'overlay' | 'glow'
   * @param {string} algorithm - 'posy' | 'raw'
   */
  renderComposite(mode, algorithm) {
    const gl = this.gl;
    const prog = this._compositeProg;
    gl.useProgram(prog);

    // Bind accumulated diff
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._accumTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uDiff'), 0);

    // Bind original frame
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurrent);
    gl.uniform1i(gl.getUniformLocation(prog, 'uOriginal'), 1);

    let modeInt = 0;
    if (mode === 'overlay') modeInt = 1;
    else if (mode === 'glow') modeInt = 2;
    gl.uniform1i(gl.getUniformLocation(prog, 'uMode'), modeInt);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAlgorithm'), algorithm === 'posy' ? 0 : 1);

    // Draw to canvas (null framebuffer)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Render a fallback solid color when no diff data is available.
   * @param {string} algorithm - 'posy' | 'raw'
   */
  renderBlank(algorithm) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    if (algorithm === 'posy') {
      gl.clearColor(0.5, 0.5, 0.5, 1.0);
    } else {
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Clear the trail buffer (e.g. on video change).
   */
  clearTrails() {
    this._trailHead = -1;
    this._trailSize = 0;
  }

  /**
   * Clean up all GPU resources.
   */
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Delete programs
    [this._diffProg, this._blurProg, this._accumProg, this._compositeProg].forEach(p => {
      if (p) gl.deleteProgram(p);
    });

    // Delete textures
    [this._texCurrent, this._texOldR, this._texOldG, this._texOldB,
     this._diffTex, this._blurTex, this._accumTex, this._accumTex2].forEach(t => {
      if (t) gl.deleteTexture(t);
    });

    // Delete framebuffers
    [this._diffFB, this._blurFB, this._accumFB, this._accumFB2].forEach(fb => {
      if (fb) gl.deleteFramebuffer(fb);
    });

    // Delete trail resources
    for (let i = 0; i < this._trailTextures.length; i++) {
      if (this._trailTextures[i]) gl.deleteTexture(this._trailTextures[i]);
      if (this._trailFBs[i]) gl.deleteFramebuffer(this._trailFBs[i]);
    }

    // VAO
    if (this._quadVAO) gl.deleteVertexArray(this._quadVAO);
  }
}
