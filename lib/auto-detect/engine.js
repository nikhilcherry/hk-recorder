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
 * Watches completed recording segments and auto-marks highlights via
 * Module 3's real marker: mark(ts, {source, reason}) / getHighlights().
 *
 * mark() does async pre/post-roll clip extraction and can take a while (up
 * to ~45s waiting for post-roll buffer), so this engine fires marks without
 * awaiting them — same fire-and-forget pattern as the manual hotkey handler
 * in main.js — so scene detection on the next segment isn't stalled behind
 * a slow clip extraction.
 */
class AutoDetectEngine {
  constructor(recorder, marker, config = {}) {
    if (!marker || typeof marker.mark !== 'function') {
      throw new Error('AutoDetectEngine requires a marker with a mark(ts, meta) method');
    }
    if (!recorder || typeof recorder.getSessionStartTs !== 'function') {
      throw new Error('AutoDetectEngine requires a recorder with getSessionStartTs()');
    }
    this.recorder = recorder;
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

  // sessionOffsetSec of the most recent highlight, manual or auto — read from
  // highlights.json (source of truth) and reconciled with marks we've fired
  // that may not have finished writing yet.
  _lastMarkOffset() {
    let last = this._lastAutoMarkOffset;
    if (typeof this.marker.getHighlights === 'function') {
      for (const h of this.marker.getHighlights()) {
        if (typeof h.sessionOffsetSec === 'number' && h.sessionOffsetSec > last) last = h.sessionOffsetSec;
      }
    }
    return last;
  }

  _withinCooldown(offsetSec) {
    return offsetSec - this._lastMarkOffset() < this.config.cooldownSec;
  }

  _mark(offsetSec, source, reason) {
    this._lastAutoMarkOffset = offsetSec;
    const ts = this.recorder.getSessionStartTs() + offsetSec * 1000;
    const pending = this.marker.mark(ts, { source, reason });
    pending.catch((err) => {
      console.error(`[auto-detect] mark failed (${source}):`, err.message);
    });
    return pending;
  }

  /**
   * Call once per completed recording segment.
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
        const pending = this._mark(offsetSec, 'auto-scene', null);
        return { auto: true, source: 'auto-scene', offsetSec, pending };
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
            const pending = this._mark(segmentEnd, 'auto-ai', reason);
            return { auto: true, source: 'auto-ai', offsetSec: segmentEnd, reason, pending };
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
