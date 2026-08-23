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

import { magnifyFrame, seedStates } from '../core/magnify.js';

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
uniform vec3 uTintR;
uniform vec3 uTintG;
uniform vec3 uTintB;
uniform float uThreshold;   // 0-60 mapped to 0.0-0.235
uniform int uAlgorithm;     // 0 = Posy, 1 = Raw Diff

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 cur = texture(uCurrent, vUV);
  vec4 oldR = texture(uOldR, vUV);
  vec4 oldG = texture(uOldG, vUV);
  vec4 oldB = texture(uOldB, vUV);

  float tintSumR = max(dot(uTintR, vec3(1.0)), 0.0001);
  float tintSumG = max(dot(uTintG, vec3(1.0)), 0.0001);
  float tintSumB = max(dot(uTintB, vec3(1.0)), 0.0001);
  vec3 old = vec3(
    dot(oldR.rgb, uTintR / tintSumR),
    dot(oldG.rgb, uTintG / tintSumG),
    dot(oldB.rgb, uTintB / tintSumB)
  );

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
uniform int uAgeColorEnabled;
uniform int uTrailIndex;
uniform float uTrailAge[20];
uniform float uThreshold;
uniform vec3 uAgeColorNew;
uniform vec3 uAgeColorOld;

in vec2 vUV;
out vec4 fragColor;

void main() {
  float baseVal = (uIsPosy == 1 && uAgeColorEnabled == 0) ? 0.5 : 0.0;
  vec3 best;
  if (uIsFirst == 1) {
    best = vec3(baseVal);
  } else {
    best = texture(uAccum, vUV).rgb;
  }

  vec3 s = texture(uTrail, vUV).rgb;

  if (uIsPosy == 1 && uAgeColorEnabled == 1) {
    float age = uTrailAge[uTrailIndex];
    float motionMagnitude = (
      abs(s.r - 0.5) +
      abs(s.g - 0.5) +
      abs(s.b - 0.5)
    ) / 1.5;
    vec3 ageColor = mix(uAgeColorNew, uAgeColorOld, age);
    vec3 tinted = motionMagnitude > uThreshold ? ageColor * motionMagnitude : vec3(0.0);
    best = max(best, tinted);
  } else if (uIsPosy == 1) {
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

// Plain copy — used to downsample the current frame into the magnify
// working size (linear sampling does the pooling) and to seed the EMA
// state textures.
const COPY_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uInput;

in vec2 vUV;
out vec4 fragColor;

void main() {
  fragColor = vec4(texture(uInput, vUV).rgb, 1.0);
}`;

// One EMA step into a float render target. Run twice per frame with
// different alpha uniforms (fast follower from the HIGH cutoff, slow
// follower from the LOW cutoff). Mirrors core/magnify.js emaUpdate.
const EMA_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uState;   // previous EMA state (float texture)
uniform sampler2D uFrame;   // blurred/downsampled current frame
uniform float uAlpha;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 prev = texture(uState, vUV).rgb;
  vec3 frame = texture(uFrame, vUV).rgb;
  fragColor = vec4(prev + uAlpha * (frame - prev), 1.0);
}`;

// Magnify add-back: current full-res frame + amp * band, with the
// Rec.709 luma/chroma split. The float states sit at the downsampled
// size; linear texture sampling performs the upsample for free.
// Mirrors core/magnify.js magnifyPixel exactly, including clamping.
const MAG_COMPOSITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uFast;
uniform sampler2D uSlow;
uniform float uAmp;
uniform float uChroma;

in vec2 vUV;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 cur = texture(uCurrent, vUV).rgb;
  vec3 band = texture(uFast, vUV).rgb - texture(uSlow, vUV).rgb;
  float bandLuma = dot(band, LUMA);
  vec3 result = cur + uAmp * bandLuma + uAmp * uChroma * (band - vec3(bandLuma));
  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision mediump float;

uniform sampler2D uDiff;
uniform sampler2D uOriginal;
uniform int uMode;       // 0=diff, 1=overlay, 2=glow
uniform int uAlgorithm;  // 0=posy, 1=raw
uniform int uAgeColorEnabled;

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
    if (uAlgorithm == 0 && uAgeColorEnabled == 0) {
      mot = min(vec3(1.0), abs(diff - 0.5) * 4.0);
    } else {
      mot = min(vec3(1.0), diff * 2.0);
    }
    // screen(a, b) = 1 - (1-a)*(1-b)
    result = 1.0 - (1.0 - orig) * (1.0 - mot);
  } else {
    // Glow: additive blend
    vec3 mot;
    if (uAlgorithm == 0 && uAgeColorEnabled == 0) {
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

function hexToVec3(hex, fallback) {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  ];
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

    // ── Magnify resources (allocated lazily at the downsampled size) ──
    this._copyProg = null;
    this._emaProg = null;
    this._magCompositeProg = null;
    this._magW = 0;
    this._magH = 0;
    this._magFrameTex = null;
    this._magFrameFB = null;
    this._magBlurTex = null;
    this._magBlurFB = null;
    // Two ping-pong float texture pairs: fast and slow EMA states
    this._magFastTex = [null, null];
    this._magFastFB = [null, null];
    this._magSlowTex = [null, null];
    this._magSlowFB = [null, null];
    this._magStateRead = 0;
    this._magNeedsSeed = true;

    /** @type {boolean} Whether magnify mode can run on this context */
    this.magnifySupported = false;
    this._magUseFullFloat = false;

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

    const copyFs = compileShader(gl, gl.FRAGMENT_SHADER, COPY_FRAG);
    this._copyProg = linkProgram(gl, vs, copyFs);

    const emaFs = compileShader(gl, gl.FRAGMENT_SHADER, EMA_FRAG);
    this._emaProg = linkProgram(gl, vs, emaFs);

    const magCompFs = compileShader(gl, gl.FRAGMENT_SHADER, MAG_COMPOSITE_FRAG);
    this._magCompositeProg = linkProgram(gl, vs, magCompFs);

    // We can delete the individual shader objects now — they're linked
    gl.deleteShader(vs);
    gl.deleteShader(diffFs);
    gl.deleteShader(blurFs);
    gl.deleteShader(accumFs);
    gl.deleteShader(compFs);
    gl.deleteShader(copyFs);
    gl.deleteShader(emaFs);
    gl.deleteShader(magCompFs);

    // ── Magnify float-texture support ──
    // EMA states need render-to-float. Prefer RGBA32F (only when its
    // linear filtering extension is present — the upsample relies on it);
    // otherwise RGBA16F, which WebGL2 filters natively and which either
    // color-buffer extension makes renderable. With neither extension,
    // magnify mode is unavailable on the WebGL path.
    const extFloat = gl.getExtension('EXT_color_buffer_float');
    const extHalf = extFloat ? null : gl.getExtension('EXT_color_buffer_half_float');
    const extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.magnifySupported = Boolean(extFloat || extHalf);
    this._magUseFullFloat = Boolean(extFloat && extFloatLinear);

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
    this._magNeedsSeed = true;

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

  _createFloatTexture(w, h) {
    const gl = this.gl;
    const tex = createTexture(gl);
    const internal = this._magUseFullFloat ? gl.RGBA32F : gl.RGBA16F;
    const type = this._magUseFullFloat ? gl.FLOAT : gl.HALF_FLOAT;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    return tex;
  }

  /**
   * (Re)create the magnify working textures at the downsampled size.
   * Returns false (and marks magnify unsupported) if the float
   * framebuffer turns out to be incomplete on this driver.
   */
  _ensureMagResources(w, h) {
    if (this._magW === w && this._magH === h && this._magFrameTex) return true;
    const gl = this.gl;
    this._magW = w;
    this._magH = h;

    this._cleanupTexFB(this._magFrameTex, this._magFrameFB);
    this._magFrameTex = this._createSizedTexture(w, h);
    this._magFrameFB = createFramebuffer(gl, this._magFrameTex);

    this._cleanupTexFB(this._magBlurTex, this._magBlurFB);
    this._magBlurTex = this._createSizedTexture(w, h);
    this._magBlurFB = createFramebuffer(gl, this._magBlurTex);

    for (let i = 0; i < 2; i++) {
      this._cleanupTexFB(this._magFastTex[i], this._magFastFB[i]);
      this._magFastTex[i] = this._createFloatTexture(w, h);
      this._magFastFB[i] = createFramebuffer(gl, this._magFastTex[i]);

      this._cleanupTexFB(this._magSlowTex[i], this._magSlowFB[i]);
      this._magSlowTex[i] = this._createFloatTexture(w, h);
      this._magSlowFB[i] = createFramebuffer(gl, this._magSlowTex[i]);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._magFastFB[0]);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      console.warn('Magnify: float framebuffer incomplete, disabling magnify on WebGL');
      this.magnifySupported = false;
      return false;
    }

    this._magStateRead = 0;
    this._magNeedsSeed = true;
    return true;
  }

  _drawQuadTo(fb, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imageData.width, imageData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
  }

  /**
   * Run the diff shader. Output goes to the diff framebuffer.
   * @param {object} params - { threshold, algorithm, rgbTintR, rgbTintG, rgbTintB }
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
    // threshold: 0-60 in UI → normalize to 0.0-0.235 range (60/255 ≈ 0.235)
    gl.uniform1f(gl.getUniformLocation(prog, 'uThreshold'), params.threshold / 255.0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAlgorithm'), params.algorithm === 'posy' ? 0 : 1);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uTintR'), hexToVec3(params.rgbTintR, '#ff0000'));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uTintG'), hexToVec3(params.rgbTintG, '#00ff00'));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uTintB'), hexToVec3(params.rgbTintB, '#0000ff'));

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
  renderAccumulate(trailLength, isPosy, threshold, ageColorEnabled, ageColorNew, ageColorOld) {
    const gl = this.gl;
    const prog = this._accumProg;
    gl.useProgram(prog);

    const T = Math.min(trailLength, this._trailSize);
    if (T === 0) return;

    const uAccum = gl.getUniformLocation(prog, 'uAccum');
    const uTrail = gl.getUniformLocation(prog, 'uTrail');
    const uIsPosy = gl.getUniformLocation(prog, 'uIsPosy');
    const uIsFirst = gl.getUniformLocation(prog, 'uIsFirst');
    const uAgeColorEnabled = gl.getUniformLocation(prog, 'uAgeColorEnabled');
    const uTrailIndex = gl.getUniformLocation(prog, 'uTrailIndex');
    const uTrailAge = gl.getUniformLocation(prog, 'uTrailAge');
    const uThreshold = gl.getUniformLocation(prog, 'uThreshold');
    const uAgeColorNew = gl.getUniformLocation(prog, 'uAgeColorNew');
    const uAgeColorOld = gl.getUniformLocation(prog, 'uAgeColorOld');

    gl.uniform1i(uIsPosy, isPosy ? 1 : 0);
    gl.uniform1i(uAgeColorEnabled, ageColorEnabled ? 1 : 0);
    gl.uniform1f(uThreshold, threshold / 255.0);
    gl.uniform3fv(uAgeColorNew, hexToVec3(ageColorNew, '#ff4400'));
    gl.uniform3fv(uAgeColorOld, hexToVec3(ageColorOld, '#0044ff'));
    gl.bindVertexArray(this._quadVAO);

    const ages = new Float32Array(MAX_TRAILS);
    for (let i = 0; i < T; i++) {
      ages[i] = T <= 1 ? 0 : i / (T - 1);
    }
    gl.uniform1fv(uTrailAge, ages);

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
      gl.uniform1i(uTrailIndex, i);

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
  renderComposite(mode, algorithm, ageColorEnabled) {
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
    gl.uniform1i(gl.getUniformLocation(prog, 'uAgeColorEnabled'), ageColorEnabled ? 1 : 0);

    // Draw to canvas (null framebuffer)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Run the full magnify pass for the frame already uploaded to the
   * 'current' slot: downsample (+ optional blur), update both EMA state
   * textures, then composite current + amp·band to the canvas.
   *
   * Magnify deliberately bypasses the diff/trail/composite programs —
   * their uAlgorithm uniform only distinguishes Posy from Raw, so a third
   * mode routed through them would silently render as Raw.
   *
   * @param {object} opts - { alphaFast, alphaSlow, amp, chroma, downsample, blurEnabled }
   * @returns {boolean} false when magnify is unavailable on this context
   */
  renderMagnify(opts) {
    const gl = this.gl;
    if (!this.magnifySupported) return false;

    const ds = opts.downsample || 1;
    const w = Math.max(1, Math.round(this.width / ds));
    const h = Math.max(1, Math.round(this.height / ds));
    if (!this._ensureMagResources(w, h)) return false;

    // 1. Downsample the current frame (linear sampling = spatial pooling)
    gl.useProgram(this._copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurrent);
    gl.uniform1i(gl.getUniformLocation(this._copyProg, 'uInput'), 0);
    this._drawQuadTo(this._magFrameFB, w, h);
    let frameTex = this._magFrameTex;

    // 2. Optional pre-EMA box blur at the downsampled size
    if (opts.blurEnabled) {
      gl.useProgram(this._blurProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._magFrameTex);
      gl.uniform1i(gl.getUniformLocation(this._blurProg, 'uInput'), 0);
      gl.uniform2f(gl.getUniformLocation(this._blurProg, 'uTexelSize'), 1.0 / w, 1.0 / h);
      this._drawQuadTo(this._magBlurFB, w, h);
      frameTex = this._magBlurTex;
    }

    // 3. Seed both states with the current frame (never zero — that
    //    would flash bright and decay over seconds)
    if (this._magNeedsSeed) {
      gl.useProgram(this._copyProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      gl.uniform1i(gl.getUniformLocation(this._copyProg, 'uInput'), 0);
      this._drawQuadTo(this._magFastFB[this._magStateRead], w, h);
      this._drawQuadTo(this._magSlowFB[this._magStateRead], w, h);
      this._magNeedsSeed = false;
    }

    // 4. EMA updates — one program, run twice with different alpha
    gl.useProgram(this._emaProg);
    const uState = gl.getUniformLocation(this._emaProg, 'uState');
    const uFrame = gl.getUniformLocation(this._emaProg, 'uFrame');
    const uAlpha = gl.getUniformLocation(this._emaProg, 'uAlpha');
    const read = this._magStateRead;
    const write = 1 - read;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.uniform1i(uFrame, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uState, 0);

    gl.bindTexture(gl.TEXTURE_2D, this._magFastTex[read]);
    gl.uniform1f(uAlpha, opts.alphaFast);
    this._drawQuadTo(this._magFastFB[write], w, h);

    gl.bindTexture(gl.TEXTURE_2D, this._magSlowTex[read]);
    gl.uniform1f(uAlpha, opts.alphaSlow);
    this._drawQuadTo(this._magSlowFB[write], w, h);

    this._magStateRead = write;

    // 5. Composite to canvas: full-res current + upsampled amp·band
    const prog = this._magCompositeProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texCurrent);
    gl.uniform1i(gl.getUniformLocation(prog, 'uCurrent'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._magFastTex[write]);
    gl.uniform1i(gl.getUniformLocation(prog, 'uFast'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._magSlowTex[write]);
    gl.uniform1i(gl.getUniformLocation(prog, 'uSlow'), 2);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAmp'), opts.amp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uChroma'), opts.chroma);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }

  /**
   * Re-seed the EMA states from the next frame (source change, seek,
   * resize, or switching into magnify mode).
   */
  resetMagnifyState() {
    this._magNeedsSeed = true;
  }

  /**
   * Render a fallback solid color when no diff data is available.
   * @param {string} algorithm - 'posy' | 'raw'
   */
  renderBlank(algorithm, ageColorEnabled) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    if (algorithm === 'posy' && !ageColorEnabled) {
      gl.clearColor(0.5, 0.5, 0.5, 1.0);
    } else {
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Clear the trail buffer (e.g. on video change). The magnify EMA
   * states re-seed on the same occasions.
   */
  clearTrails() {
    this._trailHead = -1;
    this._trailSize = 0;
    this._magNeedsSeed = true;
  }

  /**
   * Clean up all GPU resources.
   */
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Delete programs
    [this._diffProg, this._blurProg, this._accumProg, this._compositeProg,
     this._copyProg, this._emaProg, this._magCompositeProg].forEach(p => {
      if (p) gl.deleteProgram(p);
    });

    // Delete textures
    [this._texCurrent, this._texOldR, this._texOldG, this._texOldB,
     this._diffTex, this._blurTex, this._accumTex, this._accumTex2,
     this._magFrameTex, this._magBlurTex,
     ...this._magFastTex, ...this._magSlowTex].forEach(t => {
      if (t) gl.deleteTexture(t);
    });

    // Delete framebuffers
    [this._diffFB, this._blurFB, this._accumFB, this._accumFB2,
     this._magFrameFB, this._magBlurFB,
     ...this._magFastFB, ...this._magSlowFB].forEach(fb => {
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

// ── Dev-only shader/core parity harness ─────────────────────────
// core/magnify.js is the source of truth; the magnify shaders must match
// it. Feeds the same 3-frame synthetic sequence through magnifyFrame and
// through the WebGL magnify path (readPixels) and reports the max
// per-channel difference (acceptance: < 3/255).

export function runMagnifyParityHarness() {
  const W = 16;
  const H = 12;
  const AMP = 15;
  const CHROMA = 1.0;
  const ALPHA_FAST = 0.342; // ≈ emaAlpha(2.0 Hz, 1000/30 ms)
  const ALPHA_SLOW = 0.136; // ≈ emaAlpha(0.7 Hz, 1000/30 ms)

  // Synthetic sequence: spatial ramps with a temporal wobble.
  const frames = [];
  for (let k = 0; k < 3; k++) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const wobble = Math.round(6 * Math.sin((k / 3) * 2 * Math.PI + x * 0.5));
        data[i]     = Math.min(255, Math.max(0, 40 + x * 12 + wobble));
        data[i + 1] = Math.min(255, Math.max(0, 60 + y * 14 - wobble));
        data[i + 2] = Math.min(255, Math.max(0, 128 + wobble * 2));
        data[i + 3] = 255;
      }
    }
    frames.push(new ImageData(data, W, H));
  }

  // CPU reference — the exact loop the worker fallback runs.
  const fast = new Float32Array(W * H * 4);
  const slow = new Float32Array(W * H * 4);
  seedStates(frames[0].data, fast, slow);
  const cpuOut = frames.map(() => new Uint8ClampedArray(W * H * 4));
  for (let k = 0; k < 3; k++) {
    magnifyFrame(frames[k].data, fast, slow, cpuOut[k], ALPHA_FAST, ALPHA_SLOW, AMP, CHROMA);
  }

  // GPU path on an isolated renderer instance.
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer(canvas);
  if (!renderer.magnifySupported) {
    renderer.dispose();
    return { supported: false, maxDiff: null, pass: false };
  }
  renderer.setSize(W, H);
  renderer.resetMagnifyState();
  const useFullFloat = renderer._magUseFullFloat;

  const gl = renderer.gl;
  const px = new Uint8Array(W * H * 4);
  let maxDiff = 0;
  for (let k = 0; k < 3; k++) {
    renderer.uploadImageData(frames[k], 'current');
    renderer.renderMagnify({
      alphaFast: ALPHA_FAST,
      alphaSlow: ALPHA_SLOW,
      amp: AMP,
      chroma: CHROMA,
      downsample: 1,
      blurEnabled: false,
    });
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // readPixels rows come back bottom-up relative to the image.
    for (let y = 0; y < H; y++) {
      const gpuRow = (H - 1 - y) * W * 4;
      const cpuRow = y * W * 4;
      for (let b = 0; b < W * 4; b++) {
        if ((b & 3) === 3) continue; // alpha
        const d = Math.abs(px[gpuRow + b] - cpuOut[k][cpuRow + b]);
        if (d > maxDiff) maxDiff = d;
      }
    }
  }
  renderer.dispose();
  return { supported: true, useFullFloat, maxDiff, pass: maxDiff < 3 };
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__magnifyParityHarness = runMagnifyParityHarness;
}
