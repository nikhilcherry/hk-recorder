#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const AutoDetectEngine = require('../lib/auto-detect/engine');
const Marker = require('../lib/marker');
const FakeRecorder = require('./support/fake-recorder');
const { makeConstantSegment, makeHardCutSegment } = require('./support/make-test-clip');

const SEGMENT_DURATION_SEC = 10;
const SEGMENT_COUNT = 6; // 60s total, matching the spec's "record for 60s" test

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-autodetect-test-'));
  const bufferDir = path.join(tmpDir, 'buffer');
  const outputDir = path.join(tmpDir, 'out');
  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('[test-autodetect] generating 60s of synthetic segments (hard scene cut in segment 2)...');
  const segmentPaths = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const segPath = path.join(bufferDir, `seg_${i}.mp4`);
    if (i === 2) {
      makeHardCutSegment(segPath, 'black', 'white', SEGMENT_DURATION_SEC);
    } else {
      makeConstantSegment(segPath, i % 2 === 0 ? 'black' : 'gray', SEGMENT_DURATION_SEC);
    }
    segmentPaths.push(segPath);
  }

  // Real Module 3 marker against a fake recorder pre-loaded with the whole
  // buffer, so its pre/post-roll clip extraction has everything it needs
  // without a live capture pipeline.
  const sessionStartTs = Date.now() - SEGMENT_COUNT * SEGMENT_DURATION_SEC * 1000;
  const segments = segmentPaths.map((segPath, i) => ({
    path: segPath,
    startTs: sessionStartTs + i * SEGMENT_DURATION_SEC * 1000,
    endTs: sessionStartTs + (i + 1) * SEGMENT_DURATION_SEC * 1000,
  }));
  const recorder = new FakeRecorder({ outputDir, bufferDir, fps: 10 }, segments, sessionStartTs);
  const marker = new Marker(recorder);

  const engine = new AutoDetectEngine(recorder, marker, {
    sceneThreshold: 0.4,
    cooldownSec: 20,
    aiDetect: false,
    segmentLengthSec: SEGMENT_DURATION_SEC,
  });

  console.log('[test-autodetect] simulating recording playback, feeding segments to the engine...');
  for (let i = 0; i < segmentPaths.length; i++) {
    const startOffset = i * SEGMENT_DURATION_SEC;
    const result = await engine.onSegmentComplete(segmentPaths[i], startOffset, SEGMENT_DURATION_SEC);
    console.log(`  segment ${i} (offset ${startOffset}s):`, { ...result, pending: undefined });
  }

  console.log('[test-autodetect] waiting for in-flight marker.mark() clip extractions...');
  await marker.waitForPending();

  const entries = marker.getHighlights();
  console.log('[test-autodetect] highlights.json:', JSON.stringify(entries, null, 2));

  const autoScene = entries.filter((e) => e.source === 'auto-scene');
  assert(autoScene.length >= 1, 'expected at least one auto-scene highlight from the hard cut segment');

  for (const entry of autoScene) {
    const clipPath = path.join(outputDir, entry.clip);
    assert(fs.existsSync(clipPath), `expected extracted clip to exist: ${clipPath}`);
    assert(fs.statSync(clipPath).size > 0, `expected extracted clip to be non-empty: ${clipPath}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[test-autodetect] PASS — ${autoScene.length} auto-scene highlight(s) produced`);
}

main().catch((err) => {
  console.error('[test-autodetect] FAIL:', err);
  process.exit(1);
});
