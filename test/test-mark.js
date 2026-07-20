const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MARK_AT_MS = 40000;
const TAIL_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], (error, stdout, stderr) => {
      const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) {
        reject(new Error(`could not read duration for ${filePath}: ${error ? error.message : 'no Duration line'}`));
        return;
      }
      const [, hh, mm, ss] = match;
      resolve(Number(hh) * 3600 + Number(mm) * 60 + Number(ss));
    });
  });
}

module.exports = async function runTest(recorder, Marker) {
  let exitCode = 0;
  const marker = new Marker(recorder);
  try {
    console.log('[test-mark] starting recording...');
    await recorder.start();

    console.log(`[test-mark] waiting ${MARK_AT_MS / 1000}s before marking...`);
    await sleep(MARK_AT_MS);

    console.log('[test-mark] marking (expect ~45s window)...');
    const clipPath = await marker.mark();
    console.log('[test-mark] mark resolved:', clipPath);

    if (!fs.existsSync(clipPath)) throw new Error(`clip does not exist: ${clipPath}`);
    if (fs.statSync(clipPath).size === 0) throw new Error('clip file is empty');

    const clipDuration = await getDurationSec(clipPath);
    console.log(`[test-mark] clip duration: ${clipDuration.toFixed(2)}s`);
    if (Math.abs(clipDuration - 45) > 4) {
      throw new Error(`expected clip duration ~45s, got ${clipDuration.toFixed(2)}s`);
    }

    const highlights = JSON.parse(fs.readFileSync(marker.highlightsPath, 'utf8'));
    const entry = highlights[highlights.length - 1];
    console.log('[test-mark] highlights.json entry:', entry);

    const expectedClip = path.posix.join('clips', path.basename(clipPath));
    if (!entry || entry.clip !== expectedClip) {
      throw new Error(`unexpected highlights.json entry.clip: ${entry && entry.clip}`);
    }
    if (typeof entry.markedAt !== 'string' || Number.isNaN(Date.parse(entry.markedAt))) {
      throw new Error(`invalid markedAt: ${entry.markedAt}`);
    }
    if (typeof entry.sessionOffsetSec !== 'number' || Math.abs(entry.sessionOffsetSec - 40) > 2) {
      throw new Error(`unexpected sessionOffsetSec: ${entry.sessionOffsetSec}`);
    }
    if (typeof entry.durationSec !== 'number' || Math.abs(entry.durationSec - 45) > 4) {
      throw new Error(`unexpected durationSec: ${entry.durationSec}`);
    }

    console.log(`[test-mark] keeping recording alive ${TAIL_MS / 1000}s more before stopping...`);
    await sleep(TAIL_MS);

    console.log('[test-mark] stopping recording...');
    const sessionPath = await recorder.stop();
    console.log('[test-mark] stop() resolved with:', sessionPath);

    if (!fs.existsSync(sessionPath)) throw new Error(`session output missing: ${sessionPath}`);
    if (fs.statSync(sessionPath).size === 0) throw new Error('session output is empty');
    await getDurationSec(sessionPath); // throws if unplayable

    console.log('[test-mark] PASS');
  } catch (err) {
    console.error('[test-mark] FAIL:', err.message);
    exitCode = 1;
  }
  return exitCode;
};
