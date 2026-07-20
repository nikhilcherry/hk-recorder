const fs = require('fs');

/**
 * Test double for Module 3's marker, matching the contract AutoDetectEngine
 * expects: mark(offsetSec, meta) and getEntries(). Not for production use —
 * swap in the real Module 3 marker once it lands on main.
 */
class StubMarker {
  constructor(highlightsPath) {
    this.highlightsPath = highlightsPath;
    this._entries = fs.existsSync(highlightsPath) ? JSON.parse(fs.readFileSync(highlightsPath, 'utf8')) : [];
  }

  mark(offsetSec, meta = {}) {
    const entry = {
      offsetSec,
      source: meta.source || 'manual',
      reason: meta.reason || null,
      createdAt: new Date().toISOString(),
    };
    this._entries.push(entry);
    fs.writeFileSync(this.highlightsPath, JSON.stringify(this._entries, null, 2));
    return entry;
  }

  getEntries() {
    return this._entries.slice();
  }
}

module.exports = StubMarker;
