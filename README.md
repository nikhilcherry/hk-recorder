# hk-recorder

A headless screen recorder built as four composable Electron/Node modules: always-on capture, a tray/hotkey trigger, a manual highlight marker, and an auto-detector that marks highlights on its own.

- **Module 1 — Capture Core:** rolling segmented screen capture, stitched to mp4 on stop.
- **Module 2 — Trigger Layer:** tray icon + global hotkey + floating overlay to start/stop recording.
- **Module 3 — Highlight Marker:** press a hotkey (or click the overlay star) mid-recording to save a `[-30s, +15s]` clip around that moment, without interrupting the ongoing recording.
- **Module 4 — Auto-Detect Highlights:** marks highlights automatically — local ffmpeg scene-cut detection by default, optional Gemini Flash "is this a notable moment?" scoring — feeding the exact same marker as Module 3.

Module 1: **Capture Core** — a headless screen recording engine. No UI. Exposes `start()` / `stop()` and produces an mp4.

## Stack

- Electron (main process) drives [`desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer) and controls a hidden renderer window that runs `MediaRecorder`.
- [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) stitches the recorded segments into a final mp4.

Because `desktopCapturer` and `MediaRecorder` only exist inside an Electron renderer/main pair, `lib/recorder.js` must be used from within an Electron **main process** after `app.whenReady()` — it isn't a plain Node module you can `require` outside Electron.

## Setup

```bash
npm install
```

## Usage

```bash
npm start
```

This boots Electron, constructs a `Recorder` from `config.json`, and exposes it as `global.recorder` (and via `require('./main').getRecorder()`) for other processes/modules to drive.

Programmatic usage from within an Electron main process:

```js
const Recorder = require('./lib/recorder');
const config = require('./config.json');

app.whenReady().then(async () => {
  const recorder = new Recorder(config);

  recorder.start();                 // begins capturing the primary display
  // ... later ...
  const mp4Path = await recorder.stop(); // stitches segments, returns path to final mp4
});
```

### Config (`config.json`)

| Key                | Description                                   |
|--------------------|------------------------------------------------|
| `fps`              | Capture frame rate                            |
| `resolution`       | `{ width, height }` requested capture size    |
| `segmentLengthSec` | Length of each rolling `.webm` segment        |
| `bufferDir`        | Where in-progress segments are written        |
| `outputDir`        | Where the final stitched mp4 is written       |

## Interface contract

```js
recorder.start()            // -> void, begins capturing the primary display at config fps/resolution
recorder.stop()             // -> Promise<string>, path to final mp4
recorder.getSegments()      // -> [{ path, startTs, endTs }], rolling in-memory segment index
recorder.isRecording        // -> bool
```

`getSegments()` is the interface a later fusion module (Module 3) is expected to consume — it's kept up to date as each 10s segment is flushed to `bufferDir`, not just at the end of a recording.

## How it works

1. `start()` asks `desktopCapturer` for the primary screen source and messages a hidden `BrowserWindow` (`renderer/capture.js`) to begin capture via `getUserMedia` with `chromeMediaSource: 'desktop'`.
2. The renderer records in a loop: it starts a fresh `MediaRecorder` for the stream, lets it run for `segmentLengthSec` seconds, stops it (which flushes a fully self-contained, independently playable `.webm` file), and immediately starts the next one. Each finished segment's bytes are sent to the main process over IPC and written to `./buffer/seg_<n>.webm`.
3. The main process keeps a rolling in-memory index of `{ path, startTs, endTs }` for every segment as it lands — this is what `getSegments()` returns.
4. `stop()` tells the renderer to stop. If a segment is mid-flight, its `MediaRecorder` is stopped immediately, which flushes the partial segment as a valid `.webm` file before capture fully halts (no data is dropped).
5. Once the renderer confirms capture has stopped, the main process concatenates all buffered segments (in `startTs` order) using ffmpeg's concat demuxer and re-encodes to H.264 mp4 at `./out/session_<datetime>.mp4`, then clears `./buffer`.

## Test

```bash
npm run test-record
```

Boots Electron in test mode, records for 35 seconds, stops, and asserts:

- `recorder.isRecording` toggles correctly around `start()`/`stop()`
- at least 3 segments were accumulated in the in-memory index during recording
- `./out/session_*.mp4` exists, is non-empty, and passes an ffmpeg playability check (`ffmpeg -v error -i <file> -f null -`)

Exits non-zero on any failure.

## Notes / limitations

- Requires a running display server (X11/Wayland) — `desktopCapturer` needs one to enumerate screen sources.
- Video only (no audio track) in this module.
- `lib/recorder.js` uses `nodeIntegration: true` / `contextIsolation: false` for its hidden capture window. This is safe here because the window only ever loads a bundled local file (`renderer/capture.html`), never remote or untrusted content.

## Module 2: Trigger Layer

`lib/trigger.js` puts a UI around `Recorder` without `Recorder` knowing it exists: a tray icon (idle/recording states), a global hotkey (`Insert`, configurable via `hotkey` in `config.json`), and a small always-on-top overlay window with a record button and a mark ("star") button.

- Hotkey or tray "Start"/"Stop" both call the same `toggle()`, which drives `recorder.start()` / `recorder.stop()` and keeps the tray icon, tray menu, and overlay in sync.
- The overlay's star button calls `marker.mark()` (Module 3) directly over IPC, independent of the record toggle.
- The tray's context menu also hosts Module 4's auto-detect on/off checkbox (see below).

### Test

```bash
electron . --test-trigger
```

Drives `Trigger` programmatically through a full start → record 12s → stop cycle and asserts `recorder.isRecording` and segment accumulation at each step — more deterministic than synthesizing real OS-level key/mouse input into Electron.

## Module 3: Highlight Marker

Press **F8** (configurable via `markHotkey` in `config.json`) mid-recording, or click the small star button under the overlay's record button, to save a highlight clip without interrupting the recording.

`lib/marker.js` exposes a single entry point:

```js
marker.mark()   // -> Promise<clipPath>, resolves once the clip has been written
```

It's decoupled from hotkeys entirely — the F8 binding and the overlay star button both just call `marker.mark()`, and any other caller (e.g. a future auto-detection module) can too.

On `mark()`:

1. The current timestamp is captured.
2. Once `ts + 15s` has been captured by the recorder, the `[ts-30s, ts+15s]` window is cut out of the rolling segment buffer (`recorder.getSegments()`) via an ffmpeg concat + trim, independent of the segments' eventual use in the final stitched `session.mp4`.
3. The clip is written to `./out/clips/clip_<n>.mp4` and an entry is appended to `./out/highlights.json`:
   ```json
   [{
     "clip": "clips/clip_001.mp4",
     "markedAt": "<iso>",
     "sessionOffsetSec": 142,
     "durationSec": 45,
     "source": "manual",
     "reason": null
   }]
   ```
   `mark(ts, meta)` takes an optional second argument — `{ source, reason }` — used by Module 4's auto-detector to tag its own marks (`"auto-scene"` / `"auto-ai"`, with `reason` set for AI-scored ones). Callers that omit it, like the hotkey and overlay star button, get `source: "manual"`.

Marks near the start of a recording clamp to the available buffer instead of failing. Rapid/overlapping marks are each processed independently and don't clobber each other's `highlights.json` entries. `Recorder.stop()` now awaits any in-flight marks (via `registerPreClearHook`) before clearing the segment buffer, so a mark that's still extracting never loses its source segments.

### Test

```bash
npm run test-mark
```

Starts a recording, marks a highlight at t=40s, verifies the resulting clip exists with a ~45s duration and a valid `highlights.json` entry, then confirms the recording still stops and stitches into a full `session.mp4`.

## Module 4: Auto-Detect Highlights

No keypress needed — `lib/auto-detect/engine.js` (`AutoDetectEngine`) watches every completed segment and calls Module 3's `marker.mark(ts, meta)` itself when something looks worth keeping. It's wired into `main.js` via `recorder.registerSegmentHook()`, so it runs automatically alongside the manual hotkey/overlay marker on every recording.

**Detection modes:**

1. **Local scene detection (default, zero-cost).** Every completed 10s segment is run through ffmpeg's `select='gt(scene,0.4)'` scene-change filter (`lib/auto-detect/scene-detector.js`). If any frame's scene score clears the threshold, that offset gets `marker.mark(ts, { source: 'auto-scene' })`.
2. **AI scoring (optional, `config.autoDetect.aiDetect: true`).** Every `aiIntervalSec` (default 30s), the last frame of a segment is grabbed and sent to Gemini Flash (`lib/auto-detect/ai-scorer.js`) with: *"Screen recording frame during a software demo. Is a notable moment happening (result appearing, error, success state, big UI change)? Reply JSON {notable: bool, reason: string}"*. A `notable: true` verdict marks the highlight with `source: 'auto-ai'` and the model's `reason` attached.

**Other behavior:**

- **Cooldown:** no auto-mark fires within `cooldownSec` (default 20s) of the previous mark, manual or auto — checked against `marker.getHighlights()`, the real highlights.json.
- **Tagging:** every highlight entry carries `source: "auto-scene" | "auto-ai" | "manual"`, with `reason` populated for AI-sourced marks.
- **Toggle:** an "Auto-Detect Highlights" checkbox in the tray menu (`lib/auto-detect/tray-menu.js`, spliced in by `lib/trigger.js`) flips `AutoDetectEngine.setEnabled()` at runtime.
- **Degrades silently:** if `GEMINI_API_KEY` isn't set, AI scoring is skipped (one warning logged at startup) and scene-only detection keeps working — recording is never blocked on the AI path.
- **Non-blocking:** `marker.mark()` can take up to ~45s (waiting for post-roll buffer + ffmpeg extraction), so the engine fires marks without awaiting them, matching the manual hotkey's fire-and-forget pattern — scene detection on the next segment is never stalled behind a slow clip extraction.

### Config (`config.json`)

```json
"autoDetect": {
  "enabled": true,
  "aiDetect": false,
  "sceneThreshold": 0.4,
  "cooldownSec": 20,
  "aiIntervalSec": 30
}
```

| Key              | Description                                              |
|------------------|------------------------------------------------------------|
| `enabled`        | Master on/off for auto-detect (also toggled via tray menu) |
| `aiDetect`       | Enable Gemini Flash scoring (needs `GEMINI_API_KEY` env var) |
| `sceneThreshold` | ffmpeg scene-score threshold, 0–1                          |
| `cooldownSec`    | Minimum gap between any two marks, manual or auto           |
| `aiIntervalSec`  | How often (seconds) to run an AI check                     |

### Test

```bash
npm run test-autodetect
```

Generates six synthetic 10s segments (60s total) with a hard scene cut in one of them, feeds them through `AutoDetectEngine` against the **real** `lib/marker.js` (via a lightweight `FakeRecorder` test double preloaded with the segment buffer — not a mocked marker), and asserts at least one `source: "auto-scene"` entry lands in `highlights.json` with a real, non-empty extracted clip on disk.
