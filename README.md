# hk-recorder

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

`npm start` and `npm run test-record` launch Electron with `--ozone-platform=x11 --disable-features=WebRtcPipeWireCapturer` (see `package.json`). On Linux under a Wayland session, Chromium's screen capture otherwise routes through the `xdg-desktop-portal` PipeWire screencast API, which requires an interactive consent dialog per session and isn't viable for a headless engine. These flags force the classic X11 (`XShm`) capture path, which works over XWayland without any consent prompt and is what `desktopCapturer` uses here.

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

- Requires a running display server. On Linux, an X11 (or XWayland) `DISPLAY` is required — see the ozone/PipeWire note above for why Wayland-native sessions need the `--ozone-platform=x11 --disable-features=WebRtcPipeWireCapturer` flags baked into the npm scripts.
- Video only (no audio track) in this module.
- `lib/recorder.js` uses `nodeIntegration: true` / `contextIsolation: false` for its hidden capture window. This is safe here because the window only ever loads a bundled local file (`renderer/capture.html`), never remote or untrusted content.
