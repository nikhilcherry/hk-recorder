const { execFileSync } = require('child_process');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {
  ffmpegPath = 'ffmpeg';
}

/** A flat-color clip with no scene change — a negative case. */
function makeConstantSegment(outPath, color, durationSec) {
  execFileSync(
    ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=10:d=${durationSec}`, '-pix_fmt', 'yuv420p', outPath],
    { stdio: 'ignore' }
  );
}

/** Two flat-color halves concatenated — a hard cut at the midpoint. */
function makeHardCutSegment(outPath, colorA, colorB, durationSec) {
  const half = durationSec / 2;
  execFileSync(
    ffmpegPath,
    [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${colorA}:s=320x240:r=10:d=${half}`,
      '-f', 'lavfi', '-i', `color=c=${colorB}:s=320x240:r=10:d=${half}`,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]',
      '-pix_fmt', 'yuv420p',
      outPath,
    ],
    { stdio: 'ignore' }
  );
}

module.exports = { makeConstantSegment, makeHardCutSegment };
