# MotionDiff
Temporal motion extraction for video - runs entirely in the browser.

![MotionDiff app overview in Posy mode](docs/screenshots/app-overview.png)

## What it does
MotionDiff compares video frames across time and visualizes change instead of state. Static regions cancel out, while moving pixels stay visible as edges, halos, and trails. The result is a motion map that makes small shifts in leaves, water, smoke, clouds, or slow drifting light easier to see than in the original footage alone.

In Posy mode, the neutral "no motion" value is a gray midtone at 128. That gray field is useful: it means the background mathematically disappears into a constant baseline, and anything that departs from 128 represents motion energy. Brighter or darker deviations from gray show how far a pixel has moved through time, while the RGB channel offsets add directional color.

## Quick start
```bash
git clone <repo>
cd motiondiff
npm install
npm run dev
```

Then open `http://localhost:5173` and load a preset clip. In this repo the Vite base path is `/MotionDiff/`, so the full local URL is `http://localhost:5173/MotionDiff/`.

## How the algorithms work

### Posy Blend (default)
Posy Blend compares the current frame against an older frame after inverting the old one:

`blend = (current + invert(old)) / 2`

For a static pixel, the math always collapses to the same midpoint:

`static pixel: (V + (255 - V)) / 2 = 128`

That is true for every possible input value `V`. The consequence is the signature MotionDiff look: the background cancels to gray, and motion glows away from gray. With RGB time-shift enabled, the color of that glow depends on which channel is comparing against which moment in time, so direction and speed become visible as colored fringes instead of plain luminance.

### Raw Diff
Raw Diff uses absolute channel difference:

`diff = |current - old|`

Static regions go to black, and brighter pixels mean larger motion between the two samples. It is the more literal mode: high contrast, easy to read, and good for simple motion detection when you do not need Posy mode's gray-centered directional color.

### Frame offset (k)
The frame offset chooses how far back in time the comparison reaches.

| k value | Best for |
|---------|----------|
| 1-3 | Fast motion, people walking, hand gestures |
| 5-15 | General nature footage, moderate motion |
| 20-40 | Slow drift, clouds, fog, rising steam |
| 50-90 | Imperceptibly slow motion, moonrise, tide |

### RGB channel time-shift
Instead of comparing all channels to the same old frame, MotionDiff can offset them in time:

- Red samples `k`
- Green samples `k + spread`
- Blue samples `k + spread x 2`

That stagger turns time into color. When an edge moves, each channel sees it at a slightly different temporal position, so the merged result becomes a directional smear rather than a white outline.

```text
time:     now  <- current frame
R old:    t - k
G old:    t - (k + spread)
B old:    t - (k + spread x 2)
```

### Trail accumulation
Trail accumulation merges the last `T` diff frames into one image.

- Posy mode keeps the value with the largest deviation from 128 on each channel.
- Raw Diff keeps the largest raw channel value on each channel.

`T = trail length`, so larger values hold motion on screen longer. Short trails show immediate movement. Long trails turn motion into persistent streaks and ghosted silhouettes.

### Threshold
Threshold suppresses noise before accumulation.

- Low threshold: more sensitive, more noise.
- High threshold: cleaner image, but subtle motion can disappear.

### Display modes
| Mode | Description |
|------|-------------|
| Diff | Raw algorithm output only |
| Overlay | Motion screen-blended onto original frame |
| Glow | Original + amplified additive bloom from motion |

## Controls reference
| Control | Range | Default | Effect |
|---------|-------|---------|--------|
| Open File | Any local video file | None | Loads a local clip directly into the video element |
| URL Load | Any reachable video URL | Empty | Loads a remote clip, retrying through a CORS proxy if needed |
| Webcam | Browser camera stream | Hidden when unsupported | Starts a live camera source in the original panel |
| Screen | Browser display capture | Hidden when unsupported | Starts a live screen-share source in the original panel |
| Preset clips | Three built-in sample videos | None | Loads a known-good demo clip with one click |
| Parameter presets | Built-in + saved presets | None | Applies a named processing recipe immediately |
| Auto | One-shot action | Idle | Samples the loaded video and suggests offset + threshold |
| Save current | One-shot action | Idle | Saves the current processing state to localStorage |
| Delete | One-shot action | Disabled until a saved preset is selected | Removes a user-saved preset from localStorage |
| Timeline scrubber | Full clip duration | Start of clip | Seeks the loaded video without breaking the diff loop |
| Playback speed | 0.25x-2x | 1x | Changes `video.playbackRate` for slow inspection or faster playback |
| Hold step-back / forward | Hold mousedown | — | Plays video in that direction at current speed; release to pause |
| Offset | 1-90 frames | 5 | Sets the temporal comparison distance |
| Threshold | 0-60 | 10 | Filters out weak per-pixel motion |
| Trail | 1-20 frames | 5 | Controls how long motion persists |
| RGB Spread | 0-5 frames | 0 | Offsets R, G, and B in time to produce directional color |
| R/G/B tint colors | Color pickers | `#ff0000` / `#00ff00` / `#0000ff` | Custom hue for each channel-shifted frame (visible when Spread > 0) |
| Algorithm | Posy, Raw | Posy | Switches between gray-centered blend and absolute difference |
| Blur | Off, On | Off | Applies a 3 x 3 box blur to soften noisy diff output |
| Color Age | Off, On | Off | Recolors Posy trails from warm (new) to cool (old) |
| Age gradient start / end | Color pickers | `#ff4400` / `#0044ff` | New/old motion tint colors (visible when Color Age is on) |
| Resolution | 320-1920px | 640px | Processing width; higher values increase GPU load |
| FPS Cap | Max / 60 / 30 / 24 / 15 | Max | Limits diff processing rate independent of video playback |
| Display mode | Diff, Overlay, Glow | Overlay | Chooses how motion is composited for display |
| Record | Toggle | Off | Captures the output canvas to a downloadable WebM |
| Play/Pause | Toggle | Paused until a clip can autoplay | Starts or stops video playback and the diff loop |

### URL load
MotionDiff accepts direct media URLs and HLS manifests, and retries standard video URLs through a public CORS proxy if the first request fails.

#### YouTube
YouTube page URLs are not direct media files, so the browser cannot load them into the `<video>` element directly. Use `yt-dlp` to download the clip or extract a direct stream URL first, then load that resulting file or media URL into MotionDiff.

## Preset clips
MotionDiff ships with three Pexels clips chosen because they have stable cameras and continuous natural movement. Nature footage works better than fast-cut edits because temporal differencing assumes the scene is mostly static and only part of the image is moving. A hard cut makes the whole frame "move" at once, which overwhelms the signal.

- Trees in Wind: dense leaf texture and repeated branch motion make subtle gusts show up as layered halos and color fringing.
- Flowing River: watch the water surface, foam, and branch edges for constant moderate motion with good contrast.
- Sunset Timelapse: slow cloud drift and changing light are useful for larger offsets and longer trails.

## Test clips - what makes good footage
Good footage has a static camera, slow continuous motion, and textured areas that give the algorithm something to track. Leaves, water, grass, smoke, fog, fabric, and steam all work well because they produce many small local changes over time.

Avoid footage with fast cuts, camera pans, heavy handheld shake, or strong compression artifacts. Those conditions make the whole frame change at once, which reduces the separation between true subject motion and noise.

## Project structure
```text
.
|-- .github/workflows/deploy.yml       GitHub Actions workflow for production build and Pages deploy.
|-- public/favicon.svg                 Browser tab icon.
|-- public/icons.svg                   Shared SVG icon sheet.
|-- src/app/clips.js                   Built-in preset clip catalog.
|-- src/app/exporter.js                MediaRecorder-based WebM export helper.
|-- src/app/loader.js                  URL source detection for direct, HLS, and DASH cases.
|-- src/app/pipeline.js                Runtime orchestration for capture, buffering, and renderer selection.
|-- src/app/pipeline.worker.js         Canvas fallback worker for diff, blur, and trail accumulation.
|-- src/app/renderer.js                Canvas 2D compositing for diff, overlay, and glow modes.
|-- src/app/renderer.webgl.js          WebGL2 renderer and shader pipeline.
|-- src/core/analyze.js                Auto-configuration heuristic for sampled frame motion.
|-- src/core/__tests__/core.test.js    Unit tests for pure motion-processing logic.
|-- src/core/blur.js                   3 x 3 box blur implementation.
|-- src/core/buffer.js                 Circular frame buffer primitive.
|-- src/core/diff.js                   Posy Blend and Raw Diff pixel math.
|-- src/core/trails.js                 Trail accumulation rules for Posy and Raw modes.
|-- src/main.js                        App wiring and render loop control.
|-- src/ui/controls.js                 DOM event bindings for controls and presets.
|-- src/ui/presets.js                  Saved-configuration dropdown and localStorage persistence.
|-- src/ui/status.js                   Status bar helper.
|-- src/ui/timeline.js                 Timeline scrubber, transport controls, and shortcuts.
|-- index.html                         Single-page shell, styles, and DOM structure.
|-- package.json                       Scripts and top-level dependency declarations.
|-- vite.config.js                     Vite base-path configuration.
|-- README.md                          Project overview and algorithm reference.
`-- docs/examples/*.md                 Extended examples and parameter recipes.
```

Layer dependencies are intentionally strict:

```text
core/ <- no imports
app/  <- core/ only
ui/   <- app/ only
main.js <- app/ + ui/
```

## Renderer
MotionDiff detects WebGL2 at runtime and uses it when available; otherwise it falls back to a Canvas 2D + Worker pipeline. The console logs which renderer is active, so you can confirm the path immediately on load.

The WebGL renderer uploads frame data with `texImage2D` and keeps diff, blur, accumulation, and composite passes on the GPU. That avoids reading processed pixels back to the CPU every frame. The renderer also includes a `VideoFrame -> texImage2D` upload path, which is the ideal zero-readback direction for browser-native frame processing.

## Running tests
```bash
npm test
```

See [docs/examples/examples.md](docs/examples/examples.md) for annotated looks and [docs/examples/parameter-guide.md](docs/examples/parameter-guide.md) for tuning advice.
