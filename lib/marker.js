const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PRE_ROLL_SEC = 30;
const POST_ROLL_SEC = 15;
const POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Highlight marker: given a moment in an in-progress recording, waits for
// enough buffer to be captured, then cuts [ts-30s, ts+15s] out of the
// recorder's rolling segment buffer into its own clip. Knows nothing about
// hotkeys or UI — callers (a hotkey, the overlay star button, Module 4's
// auto-detector) just call mark().
class Marker {
  constructor(recorder) {
    this.recorder = recorder;
    this.outputDir = recorder.config.outputDir;
    this.bufferDir = recorder.config.bufferDir;
    this.fps = recorder.config.fps;
    this.clipsDir = path.join(this.outputDir, 'clips');
    this.highlightsPath = path.join(this.outputDir, 'highlights.json');

    fs.mkdirSync(this.clipsDir, { recursive: true });

    this._nextIndex = this._loadHighlights().length + 1;
    this._writeQueue = Promise.resolve();
    this._pending = new Set();

    if (typeof this.recorder.registerPreClearHook === 'function') {
      this.recorder.registerPreClearHook(() => this.waitForPending());
    }
  }

  // Resolves once every mark() call issued so far has finished reading the
  // segments it needs. Recorder awaits this before clearing its buffer.
  waitForPending() {
    return Promise.all(this._pending);
  }

  // meta.source tags who triggered the mark ("manual" | "auto-scene" | "auto-ai");
  // callers that omit it (hotkey, overlay button) are implicitly manual.
  // meta.reason carries Module 4's AI-scoring justification, when present.
  mark(ts = Date.now(), meta = {}) {
    if (!this.recorder.isRecording) {
      return Promise.reject(new Error('Cannot mark highlight: recorder is not recording'));
    }
    const sessionStartTs = this.recorder.getSessionStartTs();
    const index = this._nextIndex++;
    const task = this._process(ts, sessionStartTs, index, meta).finally(() => this._pending.delete(task));
    this._pending.add(task);
    return task;
  }

  _loadHighlights() {
    if (!fs.existsSync(this.highlightsPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.highlightsPath, 'utf8'));
    } catch {
      return [];
    }
  }

  // Public snapshot of highlights.json, e.g. for Module 4's cooldown check.
  getHighlights() {
    return this._loadHighlights();
  }

  async _process(ts, sessionStartTs, index, meta = {}) {
    const windowEndTarget = ts + POST_ROLL_SEC * 1000;
    await this._waitUntilCaptured(windowEndTarget);

    const windowStart = Math.max(ts - PRE_ROLL_SEC * 1000, sessionStartTs);
    const segments = this.recorder.getSegments().slice().sort((a, b) => a.startTs - b.startTs);
    const overlapping = segments.filter((s) => s.endTs > windowStart && s.startTs < windowEndTarget);
    if (overlapping.length === 0) {
      throw new Error('No buffered segments overlap the requested highlight window');
    }

    const actualStart = Math.max(windowStart, overlapping[0].startTs);
    const actualEnd = Math.min(windowEndTarget, overlapping[overlapping.length - 1].endTs);

    const clipName = `clip_${String(index).padStart(3, '0')}.mp4`;
    const clipPath = path.join(this.clipsDir, clipName);
    await this._extract(overlapping, actualStart, actualEnd, clipPath);

    await this._appendHighlight({
      clip: path.posix.join('clips', clipName),
      markedAt: new Date(ts).toISOString(),
      sessionOffsetSec: Math.round((ts - sessionStartTs) / 1000),
      durationSec: Math.round((actualEnd - actualStart) / 1000),
      source: meta.source || 'manual',
      reason: meta.reason || null,
    });

    return clipPath;
  }

  // Waits until the rolling segment buffer covers targetEndTs, or until
  // recording stops (e.g. the user hit stop before the post-roll finished
  // capturing) — in which case we proceed with whatever was captured.
  async _waitUntilCaptured(targetEndTs) {
    for (;;) {
      const segs = this.recorder.getSegments();
      const latestEnd = segs.reduce((max, s) => Math.max(max, s.endTs), 0);
      if (latestEnd >= targetEndTs || !this.recorder.isRecording) return;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async _extract(segments, startTs, endTs, outPath) {
    const listPath = path.join(
      this.bufferDir,
      `mark_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
    );
    const listContent = segments
      .map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent);

    const seekSec = Math.max((startTs - segments[0].startTs) / 1000, 0);
    const durationSec = Math.max((endTs - startTs) / 1000, 0.1);

    try {
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath,
          [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-ss', String(seekSec),
            '-t', String(durationSec),
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-r', String(this.fps),
            outPath,
          ],
          (error, stdout, stderr) => {
            if (error) reject(new Error(`ffmpeg clip extraction failed: ${stderr || error.message}`));
            else resolve();
          }
        );
      });
    } finally {
      fs.rmSync(listPath, { force: true });
    }
  }

  // Serializes reads/writes of highlights.json so overlapping marks can't
  // clobber each other's entries.
  _appendHighlight(entry) {
    const run = () => {
      const arr = this._loadHighlights();
      arr.push(entry);
      fs.writeFileSync(this.highlightsPath, JSON.stringify(arr, null, 2));
    };
    const result = this._writeQueue.then(run, run);
    this._writeQueue = result.catch(() => {});
    return result;
  }
}

module.exports = Marker;
