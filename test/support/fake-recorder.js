/**
 * Minimal stand-in for lib/recorder.js's public surface, just enough for
 * the real lib/marker.js to operate against pre-built segment files —
 * lets Module 4's test exercise the actual Module 3 marker instead of a
 * hand-rolled double.
 */
class FakeRecorder {
  constructor(config, segments, sessionStartTs) {
    this.config = config;
    this.isRecording = true;
    this._segments = segments;
    this._sessionStartTs = sessionStartTs;
  }

  getSessionStartTs() {
    return this._sessionStartTs;
  }

  getSegments() {
    return this._segments;
  }
}

module.exports = FakeRecorder;
