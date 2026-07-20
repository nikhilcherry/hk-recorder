const { ipcRenderer } = require('electron');
const channels = require('../lib/ipc-channels');

let mediaStream = null;
let currentRecorder = null;
let segmentIndex = 0;
let segmentTimer = null;
let segmentLengthMs = 10000;
let stopping = false;

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

function beginSegment() {
  if (stopping || !mediaStream) return;

  const startTs = Date.now();
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mediaStream, { mimeType });
  const chunks = [];
  const index = segmentIndex++;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const endTs = Date.now();
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: mimeType });
      const buf = await blob.arrayBuffer();
      ipcRenderer.send(channels.SEGMENT_DATA, {
        index,
        startTs,
        endTs,
        bytes: new Uint8Array(buf),
      });
    }
    if (!stopping) {
      beginSegment();
    } else {
      finalizeStop();
    }
  };

  recorder.onerror = (e) => {
    ipcRenderer.send(channels.CAPTURE_ERROR, `MediaRecorder error: ${e.error && e.error.message}`);
  };

  currentRecorder = recorder;
  recorder.start();

  segmentTimer = setTimeout(() => {
    if (currentRecorder && currentRecorder.state === 'recording') {
      currentRecorder.stop();
    }
  }, segmentLengthMs);
}

function finalizeStop() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  currentRecorder = null;
  ipcRenderer.send(channels.CAPTURE_STOPPED);
}

ipcRenderer.on(channels.START_CAPTURE, async (event, opts) => {
  try {
    stopping = false;
    segmentIndex = 0;
    segmentLengthMs = opts.segmentLengthSec * 1000;

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: opts.sourceId,
          minWidth: opts.width,
          maxWidth: opts.width,
          minHeight: opts.height,
          maxHeight: opts.height,
          minFrameRate: opts.fps,
          maxFrameRate: opts.fps,
        },
      },
    });

    beginSegment();
  } catch (err) {
    ipcRenderer.send(channels.CAPTURE_ERROR, err.message);
  }
});

ipcRenderer.on(channels.STOP_CAPTURE, () => {
  stopping = true;
  if (segmentTimer) clearTimeout(segmentTimer);
  if (currentRecorder && currentRecorder.state === 'recording') {
    currentRecorder.stop();
  } else {
    finalizeStop();
  }
});
