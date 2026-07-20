// Ad-hoc verification harness for Module 2 (Trigger). Drives the real Trigger
// class programmatically (same code path as the Insert hotkey / overlay click)
// so the toggle logic, recorder integration, tray/overlay sync, and
// notifications can be verified deterministically in environments where
// synthetic OS-level key/mouse injection into Electron is unreliable.
//
// Run with: electron . --test-trigger
const path = require('path');

module.exports = async function runTest(recorder, Trigger, config) {
  let exitCode = 0;
  const trigger = new Trigger(recorder, config);

  try {
    console.log('[test-trigger] init (creates overlay + tray + registers hotkey)...');
    trigger.init();

    console.log('[test-trigger] toggle #1 (expect: start)...');
    await trigger.toggle();
    if (!recorder.isRecording) throw new Error('expected isRecording=true after first toggle');
    console.log('[test-trigger] OK: recorder.isRecording === true after toggle');

    console.log('[test-trigger] recording for 12s to accumulate a segment...');
    await new Promise((resolve) => setTimeout(resolve, 12000));

    const segs = recorder.getSegments();
    console.log(`[test-trigger] segments accumulated: ${segs.length}`);
    if (segs.length < 1) throw new Error('expected at least 1 segment to have flushed');

    console.log('[test-trigger] toggle #2 (expect: stop + stitch)...');
    await trigger.toggle();
    if (recorder.isRecording) throw new Error('expected isRecording=false after second toggle');
    console.log('[test-trigger] OK: recorder.isRecording === false after second toggle');

    console.log('[test-trigger] PASS');
  } catch (err) {
    console.error('[test-trigger] FAIL:', err.message);
    exitCode = 1;
  } finally {
    trigger.destroy();
  }
  return exitCode;
};
