(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();function e(e){return new Worker(`/MotionDiff/assets/pipeline.worker-Ba0zrSUA.js`,{name:e?.name})}var t=`#version 300 es
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`,n=`#version 300 es
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
}`,r=`#version 300 es
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
}`,i=`#version 300 es
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
}`,a=`#version 300 es
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
}`;function o(e,t,n){let r=e.createShader(t);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS)){let t=e.getShaderInfoLog(r);throw e.deleteShader(r),Error(`Shader compile error: ${t}`)}return r}function s(e,t,n){let r=e.createProgram();if(e.attachShader(r,t),e.attachShader(r,n),e.linkProgram(r),!e.getProgramParameter(r,e.LINK_STATUS)){let t=e.getProgramInfoLog(r);throw e.deleteProgram(r),Error(`Program link error: ${t}`)}return r}function c(e){let t=e.createTexture();return e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),t}function l(e,t){let n=e.createFramebuffer();return e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0),n}var u=20,d=class{constructor(e){let t=e.getContext(`webgl2`,{alpha:!1,antialias:!1,premultipliedAlpha:!1,preserveDrawingBuffer:!1});if(!t)throw Error(`WebGL2 not available`);this.gl=t,this.canvas=e,this.width=0,this.height=0,this._diffProg=null,this._blurProg=null,this._accumProg=null,this._compositeProg=null,this._quadVAO=null,this._texCurrent=null,this._texOldR=null,this._texOldG=null,this._texOldB=null,this._trailTextures=[],this._trailFBs=[],this._trailHead=-1,this._trailSize=0,this._diffTex=null,this._diffFB=null,this._blurTex=null,this._blurFB=null,this._accumTex=null,this._accumFB=null,this._accumTex2=null,this._accumFB2=null,this._init()}_init(){let e=this.gl,l=o(e,e.VERTEX_SHADER,t),u=o(e,e.FRAGMENT_SHADER,n);this._diffProg=s(e,l,u);let d=o(e,e.FRAGMENT_SHADER,r);this._blurProg=s(e,l,d);let f=o(e,e.FRAGMENT_SHADER,i);this._accumProg=s(e,l,f);let p=o(e,e.FRAGMENT_SHADER,a);this._compositeProg=s(e,l,p),e.deleteShader(l),e.deleteShader(u),e.deleteShader(d),e.deleteShader(f),e.deleteShader(p),this._quadVAO=e.createVertexArray(),e.bindVertexArray(this._quadVAO);let m=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,m),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),e.STATIC_DRAW);let h=e.getAttribLocation(this._diffProg,`aPosition`);e.enableVertexAttribArray(h),e.vertexAttribPointer(h,2,e.FLOAT,!1,0,0),e.bindVertexArray(null),this._texCurrent=c(e),this._texOldR=c(e),this._texOldG=c(e),this._texOldB=c(e)}setSize(e,t){if(this.width===e&&this.height===t)return;this.width=e,this.height=t;let n=this.gl;this.canvas.width=e,this.canvas.height=t,n.viewport(0,0,e,t),this._cleanupTexFB(this._diffTex,this._diffFB),this._diffTex=this._createSizedTexture(e,t),this._diffFB=l(n,this._diffTex),this._cleanupTexFB(this._blurTex,this._blurFB),this._blurTex=this._createSizedTexture(e,t),this._blurFB=l(n,this._blurTex),this._cleanupTexFB(this._accumTex,this._accumFB),this._accumTex=this._createSizedTexture(e,t),this._accumFB=l(n,this._accumTex),this._cleanupTexFB(this._accumTex2,this._accumFB2),this._accumTex2=this._createSizedTexture(e,t),this._accumFB2=l(n,this._accumTex2);for(let e=0;e<this._trailTextures.length;e++)this._cleanupTexFB(this._trailTextures[e],this._trailFBs[e]);this._trailTextures=[],this._trailFBs=[];for(let r=0;r<u;r++){let r=this._createSizedTexture(e,t),i=l(n,r);this._trailTextures.push(r),this._trailFBs.push(i)}this._trailHead=-1,this._trailSize=0,n.bindFramebuffer(n.FRAMEBUFFER,null)}_createSizedTexture(e,t){let n=this.gl,r=c(n);return n.texImage2D(n.TEXTURE_2D,0,n.RGBA8,e,t,0,n.RGBA,n.UNSIGNED_BYTE,null),r}_cleanupTexFB(e,t){let n=this.gl;e&&n.deleteTexture(e),t&&n.deleteFramebuffer(t)}uploadFrame(e,t){let n=this.gl,r;switch(t){case`current`:r=this._texCurrent;break;case`oldR`:r=this._texOldR;break;case`oldG`:r=this._texOldG;break;case`oldB`:r=this._texOldB;break;default:return}n.bindTexture(n.TEXTURE_2D,r),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!0),n.texImage2D(n.TEXTURE_2D,0,n.RGBA,n.RGBA,n.UNSIGNED_BYTE,e)}uploadImageData(e,t){let n=this.gl,r;switch(t){case`current`:r=this._texCurrent;break;case`oldR`:r=this._texOldR;break;case`oldG`:r=this._texOldG;break;case`oldB`:r=this._texOldB;break;default:return}n.bindTexture(n.TEXTURE_2D,r),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!0),n.texImage2D(n.TEXTURE_2D,0,n.RGBA,e.width,e.height,0,n.RGBA,n.UNSIGNED_BYTE,e.data)}renderDiff(e){let t=this.gl,n=this._diffProg;t.useProgram(n),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this._texCurrent),t.uniform1i(t.getUniformLocation(n,`uCurrent`),0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,this._texOldR),t.uniform1i(t.getUniformLocation(n,`uOldR`),1),t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_2D,this._texOldG),t.uniform1i(t.getUniformLocation(n,`uOldG`),2),t.activeTexture(t.TEXTURE3),t.bindTexture(t.TEXTURE_2D,this._texOldB),t.uniform1i(t.getUniformLocation(n,`uOldB`),3),t.uniform1f(t.getUniformLocation(n,`uThreshold`),e.threshold/255),t.uniform1i(t.getUniformLocation(n,`uAlgorithm`),e.algorithm===`posy`?0:1),t.bindFramebuffer(t.FRAMEBUFFER,this._diffFB),t.viewport(0,0,this.width,this.height),t.bindVertexArray(this._quadVAO),t.drawArrays(t.TRIANGLES,0,6)}renderBlur(){let e=this.gl,t=this._blurProg;e.useProgram(t),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this._diffTex),e.uniform1i(e.getUniformLocation(t,`uInput`),0),e.uniform2f(e.getUniformLocation(t,`uTexelSize`),1/this.width,1/this.height),e.bindFramebuffer(e.FRAMEBUFFER,this._blurFB),e.viewport(0,0,this.width,this.height),e.bindVertexArray(this._quadVAO),e.drawArrays(e.TRIANGLES,0,6),e.bindFramebuffer(e.READ_FRAMEBUFFER,this._blurFB),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,this._diffFB),e.blitFramebuffer(0,0,this.width,this.height,0,0,this.width,this.height,e.COLOR_BUFFER_BIT,e.NEAREST),e.bindFramebuffer(e.FRAMEBUFFER,null)}pushTrail(){let e=this.gl;this._trailHead=(this._trailHead+1)%u,this._trailSize<u&&this._trailSize++,e.bindFramebuffer(e.READ_FRAMEBUFFER,this._diffFB),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,this._trailFBs[this._trailHead]),e.blitFramebuffer(0,0,this.width,this.height,0,0,this.width,this.height,e.COLOR_BUFFER_BIT,e.NEAREST),e.bindFramebuffer(e.FRAMEBUFFER,null)}renderAccumulate(e,t){let n=this.gl,r=this._accumProg;n.useProgram(r);let i=Math.min(e,this._trailSize);if(i===0)return;let a=n.getUniformLocation(r,`uAccum`),o=n.getUniformLocation(r,`uTrail`),s=n.getUniformLocation(r,`uIsPosy`),c=n.getUniformLocation(r,`uIsFirst`);n.uniform1i(s,t?1:0),n.bindVertexArray(this._quadVAO);let l=this._accumTex,d=this._accumFB,f=this._accumTex2,p=this._accumFB2;for(let e=0;e<i;e++){let t=(this._trailHead-e+u)%u;n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,l),n.uniform1i(a,0),n.activeTexture(n.TEXTURE1),n.bindTexture(n.TEXTURE_2D,this._trailTextures[t]),n.uniform1i(o,1),n.uniform1i(c,e===0?1:0),n.bindFramebuffer(n.FRAMEBUFFER,p),n.viewport(0,0,this.width,this.height),n.drawArrays(n.TRIANGLES,0,6);let r=l,i=d;l=f,d=p,f=r,p=i}l!==this._accumTex&&(n.bindFramebuffer(n.READ_FRAMEBUFFER,d),n.bindFramebuffer(n.DRAW_FRAMEBUFFER,this._accumFB),n.blitFramebuffer(0,0,this.width,this.height,0,0,this.width,this.height,n.COLOR_BUFFER_BIT,n.NEAREST)),n.bindFramebuffer(n.FRAMEBUFFER,null)}renderComposite(e,t){let n=this.gl,r=this._compositeProg;n.useProgram(r),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,this._accumTex),n.uniform1i(n.getUniformLocation(r,`uDiff`),0),n.activeTexture(n.TEXTURE1),n.bindTexture(n.TEXTURE_2D,this._texCurrent),n.uniform1i(n.getUniformLocation(r,`uOriginal`),1);let i=0;e===`overlay`?i=1:e===`glow`&&(i=2),n.uniform1i(n.getUniformLocation(r,`uMode`),i),n.uniform1i(n.getUniformLocation(r,`uAlgorithm`),t===`posy`?0:1),n.bindFramebuffer(n.FRAMEBUFFER,null),n.viewport(0,0,this.width,this.height),n.bindVertexArray(this._quadVAO),n.drawArrays(n.TRIANGLES,0,6)}renderBlank(e){let t=this.gl;t.bindFramebuffer(t.FRAMEBUFFER,null),t.viewport(0,0,this.width,this.height),e===`posy`?t.clearColor(.5,.5,.5,1):t.clearColor(0,0,0,1),t.clear(t.COLOR_BUFFER_BIT)}clearTrails(){this._trailHead=-1,this._trailSize=0}dispose(){let e=this.gl;if(e){[this._diffProg,this._blurProg,this._accumProg,this._compositeProg].forEach(t=>{t&&e.deleteProgram(t)}),[this._texCurrent,this._texOldR,this._texOldG,this._texOldB,this._diffTex,this._blurTex,this._accumTex,this._accumTex2].forEach(t=>{t&&e.deleteTexture(t)}),[this._diffFB,this._blurFB,this._accumFB,this._accumFB2].forEach(t=>{t&&e.deleteFramebuffer(t)});for(let t=0;t<this._trailTextures.length;t++)this._trailTextures[t]&&e.deleteTexture(this._trailTextures[t]),this._trailFBs[t]&&e.deleteFramebuffer(this._trailFBs[t]);this._quadVAO&&e.deleteVertexArray(this._quadVAO)}}},f=640,p=120,m=`requestVideoFrameCallback`in HTMLVideoElement.prototype,h=class{constructor(){this._capCanvas=null,this._capCtx=null,this.width=0,this.height=0,this._frameStore=Array(p),this._storeHead=-1,this._storeSize=0,this._worker=null,this._workerBusy=!1,this._pendingFrame=null,this._useVideoFrame=m,this._useWebGL=!1,this._glRenderer=null,this._outputCanvas=null,this.params={frameOffset:5,threshold:10,trailLength:5,channelSpread:0,algorithm:`posy`,blurEnabled:!1},this.onResult=null}init(e,t){this._outputCanvas=t,this._capCanvas=document.createElement(`canvas`),this._capCtx=this._capCanvas.getContext(`2d`,{willReadFrequently:!0});try{this._glRenderer=new d(t),this._useWebGL=!0,console.log(`Renderer: WebGL2`)}catch(e){console.log(`WebGL2 init failed:`,e.message),console.log(`Renderer: Canvas 2D (fallback)`),this._useWebGL=!1,this._glRenderer=null,this._initWorker()}}_initWorker(){this._worker&&this._worker.terminate(),this._worker=new e,this._workerBusy=!1,this._worker.onmessage=e=>{let t=e.data;if(t.type!==`result`)return;this._workerBusy=!1;let n=null,r=null;if(t.accumulatedBuffer){let e=new Uint8ClampedArray(t.accumulatedBuffer);n=new ImageData(e,this.width,this.height)}if(t.currentFrameBuffer){let e=new Uint8ClampedArray(t.currentFrameBuffer);r=new ImageData(e,this.width,this.height)}this.onResult&&this.onResult({currentFrame:r,accumulated:n})}}start(){this._frameStore=Array(p),this._storeHead=-1,this._storeSize=0,this._useWebGL&&this._glRenderer&&this._glRenderer.clearTrails(),this._worker&&this._worker.postMessage({type:`clear`}),this._workerBusy=!1}stop(){this._workerBusy=!1}setParams(e){e.frameOffset!==void 0&&(this.params.frameOffset=e.frameOffset),e.threshold!==void 0&&(this.params.threshold=e.threshold),e.trailLength!==void 0&&(this.params.trailLength=e.trailLength),e.channelSpread!==void 0&&(this.params.channelSpread=e.channelSpread),e.algorithm!==void 0&&(this.params.algorithm=e.algorithm),e.blurEnabled!==void 0&&(this.params.blurEnabled=e.blurEnabled)}updateDimensions(e){let t=e.videoWidth,n=e.videoHeight;if(!t||!n)return;let r=f/t;this.width=f,this.height=Math.round(n*r),this._capCanvas.width=this.width,this._capCanvas.height=this.height,this._useWebGL&&this._glRenderer&&this._glRenderer.setSize(this.width,this.height),this.start()}captureFrame(e){if(!this.width||!this.height)return null;try{if(this._useVideoFrame){let t=new VideoFrame(e);return this._capCtx.drawImage(t,0,0,this.width,this.height),t.close(),this._capCtx.getImageData(0,0,this.width,this.height)}else return this._capCtx.drawImage(e,0,0,this.width,this.height),this._capCtx.getImageData(0,0,this.width,this.height)}catch{return null}}_storePush(e){this._storeHead=(this._storeHead+1)%p,this._frameStore[this._storeHead]=e,this._storeSize<p&&this._storeSize++}_storeGet(e){if(e<0||e>=this._storeSize)return null;let t=(this._storeHead-e+p)%p;return this._frameStore[t]}process(e){this._useWebGL?this._processWebGL(e):this._processWorker(e)}_processWebGL(e){let t=this.captureFrame(e);if(!t)return;if(this._storePush(t),this._storeSize<2){this._glRenderer.renderBlank(this.params.algorithm);return}let n=this._glRenderer,{frameOffset:r,threshold:i,channelSpread:a,trailLength:o,algorithm:s,blurEnabled:c}=this.params,l=r,u=a,d=e=>Math.min(e,this._storeSize-1),f=d(l),p=d(l+u),m=d(l+u*2),h=this._storeGet(f),g=this._storeGet(p),_=this._storeGet(m);if(!h||!g||!_){n.renderBlank(s);return}n.uploadImageData(t,`current`),n.uploadImageData(h,`oldR`),n.uploadImageData(g,`oldG`),n.uploadImageData(_,`oldB`),n.renderDiff({threshold:i,algorithm:s}),c&&n.renderBlur(),n.pushTrail();let v=s===`posy`;n.renderAccumulate(o,v),n.renderComposite(this._currentMode||`diff`,s)}setMode(e){this._currentMode=e}_processWorker(e){let t=this.captureFrame(e);if(!t)return;let n=t.data.buffer.byteLength,r=new ArrayBuffer(n);if(new Uint8ClampedArray(r).set(t.data),this._storePush(r),this._workerBusy)return;this._workerBusy=!0;let i=t.data.buffer,a=Array(p);for(let e=0;e<p;e++){let t=this._frameStore[e];t?a[e]=t.slice(0):a[e]=null}this._worker.postMessage({type:`process`,currentFrameBuffer:i,frameStoreBuffers:a,frameStoreSize:this._storeSize,frameStoreHead:this._storeHead,params:{...this.params},width:this.width,height:this.height},[i])}};function g(e,t,n,r,i,a,o){if(!t){o===`posy`?r.fillStyle=`#808080`:r.fillStyle=`#000`,r.fillRect(0,0,i,a);return}switch(e){case`diff`:_(t,r);break;case`overlay`:v(n,t,r,i,a,o);break;case`glow`:y(n,t,r,i,a,o);break}}function _(e,t){t.putImageData(e,0,0)}function v(e,t,n,r,i,a){let o=e.data,s=t.data,c=o.length,l=new ImageData(r,i),u=l.data;if(a===`posy`)for(let e=0;e<c;e+=4){let t=Math.min(255,Math.abs(s[e]-128)*4),n=Math.min(255,Math.abs(s[e+1]-128)*4),r=Math.min(255,Math.abs(s[e+2]-128)*4);u[e]=255-((255-o[e])*(255-t)>>8),u[e+1]=255-((255-o[e+1])*(255-n)>>8),u[e+2]=255-((255-o[e+2])*(255-r)>>8),u[e+3]=255}else for(let e=0;e<c;e+=4){let t=Math.min(255,s[e]*2),n=Math.min(255,s[e+1]*2),r=Math.min(255,s[e+2]*2);u[e]=255-((255-o[e])*(255-t)>>8),u[e+1]=255-((255-o[e+1])*(255-n)>>8),u[e+2]=255-((255-o[e+2])*(255-r)>>8),u[e+3]=255}n.putImageData(l,0,0)}function y(e,t,n,r,i,a){let o=e.data,s=t.data,c=o.length,l=new ImageData(r,i),u=l.data;if(a===`posy`)for(let e=0;e<c;e+=4){let t=Math.min(255,Math.abs(s[e]-128)*6),n=Math.min(255,Math.abs(s[e+1]-128)*6),r=Math.min(255,Math.abs(s[e+2]-128)*6);u[e]=Math.min(255,o[e]+t),u[e+1]=Math.min(255,o[e+1]+n),u[e+2]=Math.min(255,o[e+2]+r),u[e+3]=255}else for(let e=0;e<c;e+=4)u[e]=Math.min(255,o[e]+s[e]*3),u[e+1]=Math.min(255,o[e+1]+s[e+1]*3),u[e+2]=Math.min(255,o[e+2]+s[e+2]*3),u[e+3]=255;n.putImageData(l,0,0)}function b({onParams:e,onPlayPause:t,onFileLoad:n,onUrlLoad:r,onDisplayCycle:i,onAlgorithmToggle:a,onBlurToggle:o}){let s=document.getElementById(`fileInput`),c=document.getElementById(`urlInput`),l=document.getElementById(`loadUrlBtn`),u=document.getElementById(`sliderOffset`),d=document.getElementById(`sliderThreshold`),f=document.getElementById(`sliderTrail`),p=document.getElementById(`sliderSpread`),m=document.getElementById(`valOffset`),h=document.getElementById(`valThreshold`),g=document.getElementById(`valTrail`),_=document.getElementById(`valSpread`),v=document.getElementById(`btnAlgo`),y=document.getElementById(`btnBlur`),b=document.getElementById(`btnDisplay`),x=document.getElementById(`btnPlayPause`),S=document.getElementById(`dotOriginal`),C=document.getElementById(`dotDiff`),w=document.getElementById(`placeholderOriginal`),T=document.getElementById(`placeholderDiff`),E={frameOffset:5,threshold:10,trailLength:5,channelSpread:0,algorithm:`posy`,blurEnabled:!1,displayMode:`overlay`,playing:!1};s.addEventListener(`change`,e=>{let t=e.target.files?.[0];t&&n(t)}),l.addEventListener(`click`,()=>{let e=c.value.trim();e&&r(e)}),c.addEventListener(`keydown`,e=>{if(e.key===`Enter`){let e=c.value.trim();e&&r(e)}}),u.addEventListener(`input`,()=>{let e=parseInt(u.value,10);E.frameOffset=e,m.textContent=`${e}f`}),d.addEventListener(`input`,()=>{let e=parseInt(d.value,10);E.threshold=e,h.textContent=String(e)}),f.addEventListener(`input`,()=>{let e=parseInt(f.value,10);E.trailLength=e,g.textContent=`${e}f`}),p.addEventListener(`input`,()=>{let e=parseInt(p.value,10);E.channelSpread=e,_.textContent=`${e}f`}),v.addEventListener(`click`,()=>{E.algorithm===`posy`?(E.algorithm=`raw`,v.textContent=`Raw Diff`,v.classList.remove(`active`)):(E.algorithm=`posy`,v.textContent=`Posy`,v.classList.add(`active`)),a&&a()}),y.addEventListener(`click`,()=>{E.blurEnabled=!E.blurEnabled,y.textContent=`Blur: ${E.blurEnabled?`On`:`Off`}`,y.classList.toggle(`active`,E.blurEnabled),o&&o()}),b.addEventListener(`click`,()=>{let e=i();E.displayMode=e.toLowerCase(),b.textContent=`Mode: ${e}`}),x.addEventListener(`click`,()=>{t()});let D=document.getElementById(`presetClips`);D&&D.querySelectorAll(`.preset-btn`).forEach(e=>{let t=e.getAttribute(`data-url`);t&&e.addEventListener(`click`,()=>{c.value=t,r(t)})});function O(){E.playing=!0,x.disabled=!1,x.innerHTML=`&#9646;&#9646;`,S&&S.classList.add(`active`),C&&C.classList.add(`active`),w&&(w.style.display=`none`),T&&(T.style.display=`none`)}function k(){E.playing=!1,x.innerHTML=`&#9654;`,S&&S.classList.remove(`active`),C&&C.classList.remove(`active`)}function A(){w&&(w.style.display=`flex`),T&&(T.style.display=`flex`),S&&S.classList.remove(`active`),C&&C.classList.remove(`active`),x.disabled=!0,x.innerHTML=`&#9654;`}return{state:E,setPlaying:O,setPaused:k,showPlaceholders:A,get btnPlayPause(){return x},get placeholderOriginal(){return w},get placeholderDiff(){return T}}}var x=document.getElementById(`statusMsg`);function S(e,t){x.textContent=e,x.className=`status-msg`,t===`error`?x.classList.add(`error`):t===`success`&&x.classList.add(`success`)}var C=[`diff`,`overlay`,`glow`],w={diff:`Diff`,overlay:`Overlay`,glow:`Glow`},T=`requestVideoFrameCallback`in HTMLVideoElement.prototype,E=new h,D=document.getElementById(`videoEl`),O=document.getElementById(`outputCanvas`),k=null,A=!1,j=null,M=null,N=!1,P=`overlay`;function F(){return P=C[(C.indexOf(P)+1)%C.length],E.setMode(P),w[P]}var I=b({onFileLoad:L,onUrlLoad:R,onPlayPause:V,onDisplayCycle:()=>F(),onAlgorithmToggle:()=>{},onBlurToggle:()=>{}});E.init(D,O),E.setMode(P),console.log(`Frame source: ${T?`requestVideoFrameCallback + VideoFrame`:`requestAnimationFrame (fallback)`}`),E._useWebGL||(k=O.getContext(`2d`,{willReadFrequently:!0}));function L(e){let t=URL.createObjectURL(e);S(`Loading...`,`info`),z(t,!0)}function R(e){S(`Loading...`,`info`),z(e,!1)}function z(e,t){K(),N=!1,D.removeAttribute(`src`),D.load(),t?D.removeAttribute(`crossOrigin`):D.crossOrigin=`anonymous`,D.src=e,D.muted=!0,D.loop=!0,D.playsInline=!0;let n=()=>{i(),B()},r=()=>{if(i(),t)S(`✗ Failed to load file`,`error`),I.showPlaceholders();else{let t=`https://corsproxy.io/?${encodeURIComponent(e)}`;S(`Retrying via CORS proxy...`,`info`),D.crossOrigin=`anonymous`,D.src=t;let n=()=>{i(),B()},r=()=>{i(),S(`✗ Failed — check URL`,`error`),I.showPlaceholders()},i=()=>{D.removeEventListener(`canplay`,n),D.removeEventListener(`error`,r)};D.addEventListener(`canplay`,n),D.addEventListener(`error`,r),D.load()}},i=()=>{D.removeEventListener(`canplay`,n),D.removeEventListener(`error`,r)};D.addEventListener(`canplay`,n),D.addEventListener(`error`,r),D.load()}function B(){N=!0,E.updateDimensions(D),E._useWebGL||(O.width=E.width,O.height=E.height),S(`✓ Loaded`,`success`),D.play().then(()=>{I.setPlaying(),G()}).catch(()=>{S(`✓ Loaded — press play`,`success`),I.setPaused(),I.btnPlayPause.disabled=!1,I.placeholderOriginal&&(I.placeholderOriginal.style.display=`none`),I.placeholderDiff&&(I.placeholderDiff.style.display=`none`)})}function V(){N&&(D.paused?D.play().then(()=>{I.setPlaying(),G()}):(D.pause(),I.setPaused(),K()))}E.onResult=e=>{!A||!N||E._useWebGL||(e&&e.accumulated?g(P,e.accumulated,e.currentFrame,k,E.width,E.height,I.state.algorithm):e&&e.currentFrame&&g(P,null,e.currentFrame,k,E.width,E.height,I.state.algorithm))};function H(){!A||!N||(E.setParams({frameOffset:I.state.frameOffset,threshold:I.state.threshold,trailLength:I.state.trailLength,channelSpread:I.state.channelSpread,algorithm:I.state.algorithm,blurEnabled:I.state.blurEnabled}),E.process(D))}function U(e,t){H(),A&&(M=D.requestVideoFrameCallback(U))}function W(){H(),A&&(j=requestAnimationFrame(W))}function G(){A||(A=!0,T?M=D.requestVideoFrameCallback(U):j=requestAnimationFrame(W))}function K(){A=!1,j!==null&&(cancelAnimationFrame(j),j=null),M!==null&&T&&(D.cancelVideoFrameCallback(M),M=null)}document.addEventListener(`visibilitychange`,()=>{N&&(document.hidden?D.paused||(D.pause(),K(),D.dataset.autoPaused=`true`):D.dataset.autoPaused===`true`&&(delete D.dataset.autoPaused,D.play().then(()=>{I.setPlaying(),G()})))});