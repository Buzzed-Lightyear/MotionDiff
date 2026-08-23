# MotionDiff

Browser-based temporal frame differencing for revealing subtle motion in video.
Vite + vanilla ES modules. No framework. Deployed to GitHub Pages.

## Commands
- `npm run dev` — dev server at http://localhost:5173/MotionDiff/
- `npm test` — vitest run (core unit tests, node environment, no DOM/WebGL)
- `npm run build` — production build (must pass before any PR)

## Architecture — layer rules are strict, never violate them
```
core/  <- imports nothing (pure functions + CircularBuffer; all unit-testable in node)
app/   <- imports core/ only (Pipeline orchestration, WebGL renderer, Canvas2D worker fallback)
ui/    <- imports app/ only (DOM bindings)
main.js <- app/ + ui/, and core/ directly for pure helpers (wiring + render loop)
```
These rules govern imports between `src/` layers only. Third-party npm packages may be
imported at any layer (`ui/controls.js` imports `@simonwep/pickr`). Test files are also
exempt — `core/__tests__/core.test.js` imports `app/source-profile.js`.

## Key conventions
- Posy space: 128 (0.5 in shaders) = "no motion" baseline. Motion = deviation from 128.
  Raw mode baseline is 0. Any new math must respect the mode's baseline.
- Every visual algorithm exists twice: pure JS in `core/` (tested) and a GLSL mirror in
  `app/renderer.webgl.js`. The core version is the source of truth; the shader must match it.
- Dual render paths: WebGL2 preferred, Canvas2D + `pipeline.worker.js` fallback. New
  processing modes must either work on both paths or degrade gracefully with a
  `setStatus()` message on the unsupported path. Console logs which renderer is active.
- All runtime knobs live on `pipeline.params` (see `app/pipeline.js`). UI emits param
  changes through `initControls` → `emitParamChange` → `main.js` → `pipeline.params`.
- Tests live in `src/core/__tests__/core.test.js`, vitest, node env. Use the existing
  `makePixels([R,G,B,A], ...)` helper style for pixel buffers. New core modules get their
  own describe blocks in this file or a sibling `*.test.js` in the same folder.
- Processing resolution defaults to 640px wide (`DEFAULT_PROCESS_WIDTH`); frame store
  capacity is 120 frames. Don't grow either without a reason.

## Gotchas
- Web Audio / Tone.js cannot start without a user gesture — audio init must happen
  inside a click handler, never on page load.
- Rendering to float textures in WebGL2 requires the `EXT_color_buffer_float` extension —
  feature-detect, never assume.
- `index.html` is a single hand-written shell. Keep additions to it minimal: one
  container div per feature, build the rest of the DOM from a JS module. Two feature
  branches are developed in parallel off this branch — small `index.html` diffs merge
  cleanly, large ones conflict.
- Specs for in-flight features live in `specs/`. Read the relevant spec fully before
  writing any code, and treat its Non-goals and Files sections as hard boundaries.
