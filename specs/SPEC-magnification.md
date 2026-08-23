# SPEC: Eulerian magnification — amplify subtle change and add it back

Status: ready for implementation. Read CLAUDE.md first. The Non-goals and Files
sections below are hard boundaries.
Reference: Wu et al., "Eulerian Video Magnification" (MIT CSAIL, SIGGRAPH 2012) —
this spec implements the simplest IIR variant, not the full Laplacian pyramid.

## Context
MotionDiff's existing algorithms display change as its own image. Magnification
instead treats each pixel's value over time as a signal, band-pass filters it
temporally, multiplies the filtered part by an amplification factor, and adds it
back onto the current frame — making invisible changes (pulse, breathing, sway)
visible in the original video. The band-pass is built from two exponential moving
averages (EMA): band = emaFast − emaSlow.

## Goal
A new algorithm mode `magnify` selectable next to Posy/Raw. With default params on
webcam input, slow periodic changes in the ~0.7–2 Hz range become visibly amplified;
static regions stay unchanged; the image does not blow out or accumulate drift.

## Non-goals (do not implement)
- Laplacian/Gaussian pyramid decomposition (single spatial scale + blur only).
- Motion (phase-based) magnification — this is intensity/color magnification.
- Camera stabilization. Shaky input will look bad; that is accepted and documented.
- Any change to Posy/Raw behavior, trails behavior in those modes, or export.

## No new dependencies.

## Files
Create:
- `src/core/magnify.js` — pure math, zero imports.
- `src/core/__tests__/magnify.test.js` — vitest, node env.

Modify (keep diffs minimal — parallel branch warning in CLAUDE.md):
- `src/app/renderer.webgl.js` — EMA state textures + magnify programs.
- `src/app/pipeline.js` — params, mode routing, state reset wiring.
- `src/app/pipeline.worker.js` — Float32Array fallback implementation using core fns.
- `src/app/renderer.js` — composite the worker-produced magnified frame (it is a
  plain RGBA frame; existing draw path should mostly work).
- `src/ui/controls.js` + `index.html` — add `magnify` to the algorithm selector and
  a small params section; disable/gray the controls that have no effect in magnify
  mode (frame offset, channel spread, trails).
- `src/main.js` — only if mode routing requires it.

## Design

### core/magnify.js (pure, fully tested — source of truth for the shader)
- `emaAlpha(freqHz, dtMs)` → `1 − exp(−2π · freqHz · dtMs / 1000)`, clamped to
  (0, 1]. This maps a cutoff frequency to a per-frame EMA coefficient at the
  actual frame interval (pass real dt each frame; do not assume 60 fps).
- `emaUpdate(state, current, alpha)` → `state + alpha · (current − state)`.
  Operates on normalized 0..1 floats.
- `magnifySample(cur, fast, slow, amp, chroma)` → amplified value:
  `cur + amp · (fast − slow)` for luma-like use; the `chroma` factor (0..1)
  scales amp for the color channels relative to a shared luma amp — define
  `magnifyPixel(curRGB, fastRGB, slowRGB, amp, chroma)` that computes luma
  (Rec.709 weights) band separately from per-channel chroma band:
  `out = cur + amp·bandLuma + amp·chroma·(bandRGB − bandLuma)`. Clamp 0..1.
- `magnifyFrame(curData, fastState, slowState, out, alphaFast, alphaSlow, amp,
  chroma)` — full-frame loop over Uint8ClampedArray current + Float32Array states,
  used verbatim by the worker fallback.

### Signal-flow (both render paths, per processed frame)
1. Capture current frame at processing width ÷ `magDownsample` (default 2 →
   320 px wide). Downsampling IS the spatial pooling; additionally run the
   existing box blur when `blurEnabled`.
2. Update both EMA states with the blurred/downsampled frame:
   `alphaFast = emaAlpha(magFreqHigh, dt)`, `alphaSlow = emaAlpha(magFreqLow, dt)`.
   (Note: the HIGH cutoff produces the FAST follower.)
3. Band = fast − slow. Output = current full-res frame + upsampled amp·band
   (linear upsample; in WebGL this is free via linear texture sampling).
4. Display output directly (magnify mode bypasses trails and composite modes;
   `renderComposite` overlay/glow semantics do not apply — mode shows the
   magnified frame, full stop).

### WebGL specifics
- EMA states need render-to-float: feature-detect `EXT_color_buffer_float`; if
  absent, fall back to RGBA16F via `EXT_color_buffer_half_float`; if that is also
  absent, magnify mode is unavailable on the WebGL path → `setStatus` message and
  fall through to the worker path for this mode only if feasible, otherwise
  disable the option with a tooltip. Do not silently render garbage.
- Two ping-pong texture pairs (fast, slow) at the downsampled size. New fragment
  program for EMA update (one program, run twice with different alpha uniform) and
  one for the composite add-back. Mirror `core/magnify.js` math exactly, including
  the luma/chroma split and clamping.
- Algorithm-uniform trap: the existing shaders select the mode with
  `algorithm === 'posy' ? 0 : 1` (the `uAlgorithm` uniform, set in `renderDiff` and
  `renderComposite`). A third mode therefore falls through as Raw and renders
  silently wrong. Route magnify around those programs with its own path rather
  than adding a third branch to the existing shaders.
- State reset: on source change, seek, resize, or switching into magnify mode,
  seed both states with the current frame (NOT zero — zero-seeding produces a
  bright flash decaying over seconds). Wire into the same paths that call
  `clearTrails()`.

### Worker fallback
- Maintain `fastState`/`slowState` Float32Arrays; call `magnifyFrame`. Accept that
  this path is slower; process at width ≤ 320 in magnify mode. Correctness over
  speed; perf on this path is manual-check only.

### Params (all on `pipeline.params`, all live-adjustable via UI)
- `magAmp` — amplification, default 15, range 1–60.
- `magFreqLow` — band low cutoff Hz, default 0.7, range 0.05–5.
- `magFreqHigh` — band high cutoff Hz, default 2.0, range 0.1–10. UI must enforce
  high > low.
- `magChroma` — 0..1, default 1.0.
- `magDownsample` — 1, 2, or 4; default 2.
- Existing `blurEnabled` applies pre-EMA.

## Tasks (in order)
1. `core/magnify.js` + full test file. `npm test` green before moving on.
2. Worker-path implementation end to end (force the fallback temporarily to see
   it): mode selectable, output visible, state reset on seek works.
3. WebGL path: float-texture detection, EMA programs, composite, reset wiring.
4. UI: algorithm option, params section, irrelevant-control disabling.
5. Self-review pass: re-read this spec; check every acceptance criterion; check no
   file outside the Files list changed; `npm test` + `npm run build` final run.

## Acceptance criteria (all must hold)
- A1 `emaAlpha`: monotonic in freq and in dt; `emaAlpha(f, 0) ≈ 0`; clamped ≤ 1.
- A2 Band-pass response (scalar simulation, dt = 1000/30 ms, 900 steps): feed
  `x(t) = 0.5 + 0.1·sin(2π·f·t)` through both EMAs; measure steady-state band
  amplitude over the last 300 steps. With defaults (0.7 Hz, 2.0 Hz): at
  f = 1.2 Hz band amplitude ≥ 0.35 × input amplitude (expect ≈ 0.48); at
  f = 8 Hz it is ≤ 0.20 × input (expect ≈ 0.175); for constant input the band
  settles to |band| < 1e−4. The 8 Hz bound is deliberately loose: the difference
  of two one-pole EMAs rolls off at only 6 dB/octave, so this design cannot reach
  0.15 at 8 Hz. Do not tighten it by changing the defaults or adding filter
  poles — both are out of scope; the loose stopband is accepted.
- A3 `magnifyPixel`: static input (cur = fast = slow) returns cur exactly;
  output is clamped to [0, 1] for adversarial inputs; `chroma = 0` on a pure
  color oscillation with constant luma returns (near) unamplified output.
- A4 Numerical stability: 10 000 `emaUpdate` iterations with random inputs in
  [0,1] produce no NaN/Infinity and state stays within [0,1].
- A5 State seeding: a helper `seedStates(frame, fast, slow)` exists and tests
  confirm the first magnified frame after seeding equals the input frame.
- A6 Shader/core parity: dev-only harness feeds the same 3-frame synthetic
  sequence through `magnifyFrame` and through the WebGL path (readPixels);
  max per-channel difference < 3/255.
- A7 Layer rules hold: `core/magnify.js` has zero imports.
- A8 `npm test` and `npm run build` exit 0.
- A9 Manual checklist for the owner in the PR description: webcam + defaults →
  visible breathing/pulse amplification on a still subject; seek during playback →
  no flash; switch magnify→posy→magnify → no residual state; no-float-texture
  path (spoof by disabling extension in code temporarily) → clean status message,
  no garbage frame.

## Definition of done
All of A1–A8 verified by commands the session actually ran (paste outputs in the
PR), A9 as a checklist in the PR description. Open a PR titled
"feat: eulerian magnification mode" targeting the branch this session was started
from. Do not merge.
