# MotionDiff

Temporal motion extraction tool inspired by [Posy's video](https://www.youtube.com/watch?v=NSS6yAMZF78). Captures live or pre-recorded video, computes frame-to-frame differences using two algorithms, and visualizes the result with configurable trail accumulation, blur, and display modes.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in a browser. Load a video file or paste a URL to begin.

## Architecture

```
src/
├── core/           Pure functions — no DOM, no imports
│   ├── buffer.js   CircularBuffer for frame storage
│   ├── diff.js     posyBlend() and rawDiff() pixel math
│   ├── blur.js     boxBlur() 3×3 convolution
│   └── trails.js   accumulate() max-across-T-frames merge
├── app/            Application logic — imports from core/ only
│   ├── pipeline.js Frame capture, diff orchestration, state
│   ├── renderer.js render() — diff, overlay (screen blend), glow (additive)
│   └── clips.js    TEST_CLIPS preset video URLs
├── ui/             DOM controls — may import from app/
│   ├── controls.js initControls() with dependency-injected callbacks
│   └── status.js   setStatus() status bar helper
└── main.js         Wiring — imports from app/ and ui/ only
```

### Dependency Rules

| Layer    | May import from |
|----------|----------------|
| `core/`  | nothing        |
| `app/`   | `core/`        |
| `ui/`    | `app/`         |
| `main.js`| `app/`, `ui/`  |

## Algorithms

**Posy Blend** — `(current + invert(old) + 1) >> 1`. Static pixels produce gray (128); motion deviates from gray. Threshold filters by average deviation from 128.

**Raw Diff** — `abs(current - old)` per channel. Static pixels produce black; motion produces bright edges. Threshold filters by average magnitude.

## Controls

| Control     | Range   | Description                                 |
|-------------|---------|---------------------------------------------|
| Offset      | 1–90f   | Frame delay for temporal comparison          |
| Threshold   | 0–60    | Minimum motion magnitude to display          |
| Trail       | 1–20f   | Number of diff frames to accumulate          |
| RGB Spread  | 0–5f    | Per-channel time offset for chromatic effect  |
| Algorithm   | Posy/Raw| Toggle between invert-blend and absolute diff|
| Blur        | On/Off  | 3×3 box blur on diff output                 |
| Mode        | Diff/Overlay/Glow | Display mode cycle              |

## Display Modes

- **Diff** — Raw diff output directly
- **Overlay** — Screen blend of motion onto the original frame
- **Glow** — Additive blend with amplified motion (bloom effect)

## Build

```bash
npm run build   # Production build in dist/
```
