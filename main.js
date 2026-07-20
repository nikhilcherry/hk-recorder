const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Recorder = require('./lib/recorder');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
config.bufferDir = path.join(__dirname, config.bufferDir);
config.outputDir = path.join(__dirname, config.outputDir);

// Headless capture engine: never quit just because the (hidden) window closed.
app.on('window-all-closed', (e) => e.preventDefault());

let recorder;

app.whenReady().then(async () => {
  recorder = new Recorder(config);
  global.recorder = recorder;

  if (process.argv.includes('--test-record')) {
    const runTest = require('./test/test-record');
    const exitCode = await runTest(recorder);
    app.exit(exitCode);
  }
});

module.exports = {
  getRecorder: () => recorder,
};
