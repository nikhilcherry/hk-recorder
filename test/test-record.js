const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const RECORD_MS = 35000;

function checkPlayable(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-v', 'error', '-i', filePath, '-f', 'null', '-'], (error, stdout, stderr) => {
      if (error) reject(new Error(`playability check failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

module.exports = async function runTest(recorder) {
  let exitCode = 0;
  try {
    console.log(`[test-record] starting recording for ${RECORD_MS / 1000}s...`);
    await recorder.start();
    if (!recorder.isRecording) throw new Error('isRecording should be true right after start()');

    await new Promise((resolve) => setTimeout(resolve, RECORD_MS));

    const segsBeforeStop = recorder.getSegments();
    console.log(`[test-record] segments accumulated in buffer index: ${segsBeforeStop.length}`);
    if (segsBeforeStop.length < 3) {
      throw new Error(`Expected >=3 segments, got ${segsBeforeStop.length}`);
    }

    console.log('[test-record] stopping...');
    const outPath = await recorder.stop();
    console.log('[test-record] stop() resolved with:', outPath);

    if (recorder.isRecording) throw new Error('isRecording should be false after stop()');

    if (!fs.existsSync(outPath)) throw new Error(`Output file does not exist: ${outPath}`);
    const stat = fs.statSync(outPath);
    if (stat.size === 0) throw new Error('Output file is empty');
    if (!/^session_.*\.mp4$/.test(path.basename(outPath))) {
      throw new Error(`Unexpected output filename: ${outPath}`);
    }

    await checkPlayable(outPath);
    console.log('[test-record] playability check passed');

    console.log(`[test-record] PASS (${segsBeforeStop.length} segments, output: ${outPath}, ${stat.size} bytes)`);
  } catch (err) {
    console.error('[test-record] FAIL:', err.message);
    exitCode = 1;
  }
  return exitCode;
};
