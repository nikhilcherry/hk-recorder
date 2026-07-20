const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {
  ffmpegPath = 'ffmpeg';
}

const DEFAULT_MODEL = 'gemini-flash-latest';
const PROMPT =
  'Screen recording frame during a software demo. Is a notable moment happening ' +
  '(result appearing, error, success state, big UI change)? Reply JSON {notable: bool, reason: string}';

function endpoint(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

/** Grabs a single JPEG frame from a video file at the given offset. */
function extractFrame(videoPath, atSec = 0) {
  const framePath = path.join(os.tmpdir(), `hk-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-y', '-ss', String(Math.max(atSec, 0)), '-i', videoPath, '-frames:v', '1', '-q:v', '3', framePath],
      (error) => (error ? reject(error) : resolve(framePath))
    );
  });
}

/** Sends a frame to Gemini Flash and returns its notability verdict. */
async function scoreFrame(framePath, apiKey, { model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('scoreFrame requires an apiKey');

  const imageB64 = fs.readFileSync(framePath).toString('base64');
  const body = {
    contents: [
      {
        parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }],
      },
    ],
    generationConfig: { responseMimeType: 'application/json' },
  };

  const res = await fetchImpl(endpoint(model, apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini response missing text content');

  const parsed = JSON.parse(text);
  return { notable: !!parsed.notable, reason: parsed.reason || '' };
}

module.exports = { extractFrame, scoreFrame, DEFAULT_MODEL };
