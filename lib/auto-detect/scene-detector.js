const { execFile } = require('child_process');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {
  ffmpegPath = 'ffmpeg';
}

const PTS_TIME_RE = /pts_time:([\d.]+)/g;

/**
 * Runs ffmpeg's scene-change filter over a segment and reports whether any
 * frame's scene score exceeded `threshold`.
 * @param {string} segmentPath
 * @param {number} threshold
 * @returns {Promise<{detected: boolean, offsets: number[]}>} offsets are seconds relative to segment start
 */
function detectSceneCut(segmentPath, threshold = 0.4) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-i', segmentPath, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 32 },
      (error, _stdout, stderr) => {
        const offsets = [...stderr.matchAll(PTS_TIME_RE)].map((m) => parseFloat(m[1]));
        if (error && offsets.length === 0 && !stderr.includes('pts_time')) {
          reject(error);
          return;
        }
        resolve({ detected: offsets.length > 0, offsets });
      }
    );
  });
}

module.exports = { detectSceneCut };
