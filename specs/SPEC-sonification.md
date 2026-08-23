# SPEC: Sonification — turn the diff frame into sound

Status: ready for implementation. Read CLAUDE.md first. Scope boundaries are hard.

## Context
MotionDiff computes a per-pixel motion measurement: in Posy mode, |value − 128| per
channel; in Raw mode, the raw channel value. This spec adds an audio layer that
downsamples that measurement to a coarse grid and drives one synth voice per cell,
so motion in the frame becomes spatialized sound. Aesthetic tuning is explicitly NOT
this task's job — every aesthetic decision must be a runtime parameter with the
default noted below, so the owner can tune by ear afterward.

## Goal
With a video playing and audio enabled, motion on the left of the frame produces
sound panned left, motion higher in the frame produces higher pitch, and stronger
motion is louder. Silence when the frame is static. No clicks, no pops, no per-frame
allocation in the audio update path.

## Non-goals (do not implement)
- Beat/onset detection, MIDI, recording audio to file, microphone input.
- Preset persistence for audio params (presets module untouched).
- Mobile audio quirk handling beyond the standard user-gesture start.
- Any change to existing visual modes, trails, or export.

## New dependency
- `tone` (latest v15.x). This is the only new dependency. Import it ONLY inside
  `src/app/audio.js`, and only via dynamic `import()` inside the engine's `start()`
  method — top-level Tone imports break `npm test` (node has no Web Audio).

## Files
Create:
- `src/core/energy.js` — pure math, zero imports (layer rule).
- `src/core/__tests__/energy.test.js` — vitest, node env.
- `src/app/audio.js` — `AudioEngine` class wrapping Tone.js.
- `src/ui/audio-panel.js` — builds its own DOM inside a single container div,
  exports `initAudioPanel({ engine, container })`.

Modify (keep diffs minimal — parallel branch warning in CLAUDE.md):
- `src/app/pipeline.js` — add `getEnergyGrid(cols, rows)` (see below).
- `src/app/renderer.webgl.js` — add `readEnergyGrid(cols, rows)`.
- `src/app/pipeline.worker.js` — compute energies with core function, include in
  the result message.
- `src/main.js` — instantiate engine, call `engine.update(grid)` once per processed
  frame, wire panel init.
- `index.html` — ONE line: `<div id="audioPanel"></div>` in the controls area.

## Design

### core/energy.js (pure, fully tested)
- `cellEnergies(data, width, height, cols, rows, isPosy)` → `Float32Array(cols*rows)`,
  row-major. Each cell = mean per-pixel motion magnitude inside that cell, normalized
  to 0..1 (divide by 127 in Posy mode, 255 in Raw). Motion magnitude per pixel =
  mean of the three channel deviations from the mode's baseline (128 Posy, 0 Raw) —
  identical definition to `posyBlend`'s `mag`. Handle width/height not divisible by
  cols/rows (edge cells take the remainder pixels).
- `mapCell(col, row, cols, rows, opts)` → `{ pan, freq }`. Pan: linear, col 0 → −1,
  last col → +1 (single column → 0). Freq: rows map bottom→top to ascending notes of
  a scale. `opts = { scale, baseMidi, stepsPerRow }`; scales provided: `pentatonic`
  ([0,2,4,7,9]), `major`, `minor`, `chromatic`. Default: pentatonic, baseMidi 45,
  one scale degree per row. Include `midiToFreq(m)` (440 · 2^((m−69)/12)).
- `smoothEnergy(prev, target, attackMs, releaseMs, dtMs)` → number. One-pole
  envelope follower: rising uses attack coefficient, falling uses release, where
  `coef = 1 − exp(−dt/tau)`. Defaults: attack 60 ms, release 350 ms.

### Energy readback
- WebGL path: `readEnergyGrid(cols, rows)` renders the current diff texture (post
  threshold, pre composite) into a `cols×rows` framebuffer with linear filtering,
  then `readPixels` — at the default 8×4 that is 128 bytes, negligible. Convert to
  the same normalized Float32Array format as `cellEnergies` (the GPU mean-downsample
  approximates the per-cell mean; exact equality with core is NOT required — see
  acceptance A6 tolerance).
- Worker path: worker already holds the diff `Uint8ClampedArray`; call
  `cellEnergies` there and attach the Float32Array to the posted result.
- `pipeline.getEnergyGrid(cols, rows)` returns the latest grid from whichever path
  is active, or null before the first processed frame.

### app/audio.js — AudioEngine
- `start()` — dynamic-imports Tone, `Tone.start()`, builds voices. Must only ever
  be called from a user gesture. Idempotent.
- Voice bank: one sine `Tone.Oscillator` (or `Tone.Synth` with envelope disabled)
  per cell → per-voice `Tone.Gain` → per-voice `Tone.Panner` → master `Tone.Gain`
  → `Tone.Limiter(-6)` → destination. Oscillators run continuously; energy controls
  gain only.
- `update(grid)` — called once per processed video frame. For each cell: smooth the
  energy (core `smoothEnergy`), apply a noise gate (energy below `gate` → 0), then
  ramp the voice gain with `gain.gain.setTargetAtTime(value, now, 0.03)`. NEVER set
  `.value` directly (clicks). No allocation inside this method (preallocate state
  arrays; rebuild only when grid size changes).
- `setParams(p)` / `stop()` / `dispose()`.
- Runtime params (all live-adjustable): `enabled`, `masterVolume` (dB, default −12),
  `cols` (default 8), `rows` (default 4), `scale` (default pentatonic), `baseMidi`
  (default 45), `gate` (default 0.02), `attackMs` (60), `releaseMs` (350),
  `maxVoices` cap: if cols×rows > 64, refuse and clamp (CPU guard).

### ui/audio-panel.js
Toggle button "Enable audio" (this is the user gesture → `engine.start()`), then
sliders/selects for every runtime param above. Match the existing control styling
patterns from `ui/controls.js` (range fill, labels). All wiring stays inside this
module; `main.js` only calls `initAudioPanel`.

## Tasks (in order)
1. `core/energy.js` + full test file. Run `npm test` — green before moving on.
2. Worker-path energies: worker computes and posts grid; `pipeline.getEnergyGrid`
   returns it (WebGL path returns null for now). Verify in dev server with WebGL
   manually disabled (temporarily force the fallback), grid values logged.
3. WebGL `readEnergyGrid` + wire into `getEnergyGrid`. Verify parity per A6.
4. `app/audio.js` engine with all params.
5. `ui/audio-panel.js` + `main.js` + `index.html` wiring.
6. Self-review pass: re-read this spec top to bottom; check every acceptance
   criterion; check no file outside the Files list changed; run `npm test` and
   `npm run build` one final time.

## Acceptance criteria (all must hold)
- A1 `cellEnergies`: an all-128 Posy buffer → every cell exactly 0. An all-0 Raw
  buffer → every cell 0.
- A2 `cellEnergies`: a 16×8 Posy buffer that is 128 everywhere except one cell
  region set to 255 → energy 1.0 (±1e−6 of (255−128)/127… compute expected exactly)
  in that cell, 0 in all others. Same shape test for Raw mode.
- A3 `mapCell`: pan is −1 at col 0, +1 at last col, monotonic across cols; freq is
  strictly increasing bottom row → top row; pentatonic degrees match [0,2,4,7,9]
  offsets from baseMidi.
- A4 `smoothEnergy`: from 0 toward 1, value after one attack time-constant is
  ≈ 0.632 (±0.02); decay from 1 toward 0 with default params is slower than the
  rise (assert value at t=100 ms rising > 1 − value at t=100 ms falling).
- A5 No top-level `tone` import anywhere: `grep -rn "from 'tone'" src/` returns
  only the dynamic import line inside `audio.js` (or nothing, if using
  `await import('tone')`). `npm test` passes in plain node.
- A6 WebGL/worker parity: for the built-in test pattern (add a tiny dev-only
  function that feeds two synthetic frames through both paths), corresponding
  cells differ by < 0.05.
- A7 Layer rules hold: `core/energy.js` has zero import statements; `ui/audio-panel.js`
  imports only from `app/`.
- A8 `npm test` and `npm run build` both exit 0.
- A9 Manual checklist for the owner, written into the PR description: enable audio
  via button (no autoplay errors in console), wave hand left of webcam frame →
  sound in left channel, static scene + gate default → silence, kill the page →
  no lingering audio.

## Definition of done
All of A1–A8 verified by commands the session actually ran (paste outputs in the PR),
A9 written as a checklist in the PR description. Open a PR titled
"feat: motion sonification (audio grid)" targeting the branch this session was
started from. Do not merge.
