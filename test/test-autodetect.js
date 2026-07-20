#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const AutoDetectEngine = require('../lib/auto-detect/engine');
const StubMarker = require('./support/stub-marker');
const { makeConstantSegment, makeHardCutSegment } = require('./support/make-test-clip');

const SEGMENT_DURATION_SEC = 10;
const SEGMENT_COUNT = 6; // 60s total

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-autodetect-test-'));
  const highlightsPath = path.join(tmpDir, 'highlights.json');
  const marker = new StubMarker(highlightsPath);
  const engine = new AutoDetectEngine(marker, {
    sceneThreshold: 0.4,
    cooldownSec: 20,
    aiDetect: false,
    segmentLengthSec: SEGMENT_DURATION_SEC,
  });

  console.log('[test-autodetect] generating 60s of synthetic segments (hard scene cut in segment 2)...');
  const segmentPaths = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const segPath = path.join(tmpDir, `seg_${i}.mp4`);
    if (i === 2) {
      makeHardCutSegment(segPath, 'black', 'white', SEGMENT_DURATION_SEC);
    } else {
      makeConstantSegment(segPath, i % 2 === 0 ? 'black' : 'gray', SEGMENT_DURATION_SEC);
    }
    segmentPaths.push(segPath);
  }

  console.log('[test-autodetect] simulating recording playback, feeding segments to the engine...');
  for (let i = 0; i < segmentPaths.length; i++) {
    const startOffset = i * SEGMENT_DURATION_SEC;
    const result = await engine.onSegmentComplete(segmentPaths[i], startOffset, SEGMENT_DURATION_SEC);
    console.log(`  segment ${i} (offset ${startOffset}s):`, result);
  }

  const entries = marker.getEntries();
  console.log('[test-autodetect] highlights.json:', JSON.stringify(entries, null, 2));

  const autoScene = entries.filter((e) => e.source === 'auto-scene');
  assert(autoScene.length >= 1, 'expected at least one auto-scene highlight from the hard cut segment');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[test-autodetect] PASS — ${autoScene.length} auto-scene highlight(s) produced`);
}

main().catch((err) => {
  console.error('[test-autodetect] FAIL:', err);
  process.exit(1);
});
