const { app, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const Recorder = require('./lib/recorder');
const Trigger = require('./lib/trigger');
const Marker = require('./lib/marker');
const AutoDetectEngine = require('./lib/auto-detect/engine');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
config.bufferDir = path.join(__dirname, config.bufferDir);
config.outputDir = path.join(__dirname, config.outputDir);

// Headless capture engine: never quit just because the (hidden) window closed.
app.on('window-all-closed', (e) => e.preventDefault());

let recorder;
let trigger;
let marker;
let autoDetect;

const markHotkey = config.markHotkey || 'F8';

app.whenReady().then(async () => {
  recorder = new Recorder(config);
  global.recorder = recorder;
  marker = new Marker(recorder);
  global.marker = marker;
  autoDetect = new AutoDetectEngine(recorder, marker, config.autoDetect || {});
  global.autoDetect = autoDetect;
  recorder.registerSegmentHook((segment) => {
    const segmentStartOffsetSec = (segment.startTs - recorder.getSessionStartTs()) / 1000;
    const segmentDurationSec = (segment.endTs - segment.startTs) / 1000;
    autoDetect.onSegmentComplete(segment.path, segmentStartOffsetSec, segmentDurationSec).catch((err) => {
      console.error('[auto-detect] segment handling failed:', err.message);
    });
  });

  if (process.argv.includes('--test-record')) {
    const runTest = require('./test/test-record');
    const exitCode = await runTest(recorder);
    app.exit(exitCode);
    return;
  }

  if (process.argv.includes('--test-trigger')) {
    const runTest = require('./test/test-trigger-manual');
    const exitCode = await runTest(recorder, Trigger, config);
    app.exit(exitCode);
    return;
  }

  if (process.argv.includes('--test-mark')) {
    const runTest = require('./test/test-mark');
    const exitCode = await runTest(recorder, Marker);
    app.exit(exitCode);
    return;
  }

  trigger = new Trigger(recorder, config, marker, autoDetect);
  trigger.init();

  const ok = globalShortcut.register(markHotkey, () => setImmediate(() => {
    marker.mark().catch((err) => {
      console.error('[marker] mark failed:', err && err.message ? err.message : err);
    });
  }));
  if (!ok) {
    console.error(`[marker] failed to register global shortcut "${markHotkey}"`);
  }
});

app.on('will-quit', () => {
  if (trigger) trigger.destroy();
  globalShortcut.unregister(markHotkey);
});

module.exports = {
  getRecorder: () => recorder,
  getMarker: () => marker,
};
