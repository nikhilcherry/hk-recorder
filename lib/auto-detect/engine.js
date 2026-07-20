const fs = require('fs');
const { detectSceneCut } = require('./scene-detector');
const { extractFrame, scoreFrame } = require('./ai-scorer');

const DEFAULTS = {
  enabled: true,
  aiDetect: false,
  sceneThreshold: 0.4,
  cooldownSec: 20,
  aiIntervalSec: 30,
  segmentLengthSec: 10,
  aiModel: undefined,
};

/**
 * Watches completed recording segments and auto-marks highlights via a
 * Module-3-compatible marker: { mark(offsetSec, meta), getEntries?() }.
 * Consumers (Module 1's segment pipeline) call onSegmentComplete() once per
 * finished segment; this class never touches the filesystem outside ffmpeg
 * temp frames, and never writes highlights.json itself — that's the marker's job.
 */
class AutoDetectEngine {
  constructor(marker, config = {}) {
    if (!marker || typeof marker.mark !== 'function') {
      throw new Error('AutoDetectEngine requires a marker with a mark(offsetSec, meta) method');
    }
    this.marker = marker;
    this.config = { ...DEFAULTS, ...config };
    this.enabled = this.config.enabled;
    this._lastAutoMarkOffset = -Infinity;
    this._lastAiCheckOffset = -Infinity;
    this._apiKey = process.env.GEMINI_API_KEY || null;

    if (this.config.aiDetect && !this._apiKey) {
      console.warn('[auto-detect] aiDetect is enabled but GEMINI_API_KEY is not set — degrading to scene-only detection');
    }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  _lastMarkOffset() {
    let last = this._lastAutoMarkOffset;
    if (typeof this.marker.getEntries === 'function') {
      for (const entry of this.marker.getEntries() || []) {
        if (typeof entry.offsetSec === 'number' && entry.offsetSec > last) last = entry.offsetSec;
      }
    }
    return last;
  }

  _withinCooldown(offsetSec) {
    return offsetSec - this._lastMarkOffset() < this.config.cooldownSec;
  }

  _mark(offsetSec, source, reason) {
    this._lastAutoMarkOffset = offsetSec;
    this.marker.mark(offsetSec, { source, reason });
  }

  /**
   * @param {string} segmentPath finished segment file
   * @param {number} segmentStartOffsetSec segment's start offset within the recording, in seconds
   * @param {number} [segmentDurationSec]
   */
  async onSegmentComplete(segmentPath, segmentStartOffsetSec, segmentDurationSec = this.config.segmentLengthSec) {
    if (!this.enabled) return { auto: false };

    let sceneResult = { detected: false, offsets: [] };
    try {
      sceneResult = await detectSceneCut(segmentPath, this.config.sceneThreshold);
    } catch (err) {
      console.error('[auto-detect] scene detection failed:', err.message);
    }

    if (sceneResult.detected) {
      const offsetSec = segmentStartOffsetSec + sceneResult.offsets[0];
      if (!this._withinCooldown(offsetSec)) {
        this._mark(offsetSec, 'auto-scene', null);
        return { auto: true, source: 'auto-scene', offsetSec };
      }
    }

    if (this.config.aiDetect && this._apiKey) {
      const segmentEnd = segmentStartOffsetSec + segmentDurationSec;
      if (segmentEnd - this._lastAiCheckOffset >= this.config.aiIntervalSec) {
        this._lastAiCheckOffset = segmentEnd;
        let framePath;
        try {
          framePath = await extractFrame(segmentPath, Math.max(segmentDurationSec - 0.1, 0));
          const { notable, reason } = await scoreFrame(framePath, this._apiKey, { model: this.config.aiModel });
          if (notable && !this._withinCooldown(segmentEnd)) {
            this._mark(segmentEnd, 'auto-ai', reason);
            return { auto: true, source: 'auto-ai', offsetSec: segmentEnd, reason };
          }
        } catch (err) {
          console.error('[auto-detect] AI scoring failed, continuing scene-only:', err.message);
        } finally {
          if (framePath) fs.rm(framePath, { force: true }, () => {});
        }
      }
    }

    return { auto: false };
  }
}

module.exports = AutoDetectEngine;
