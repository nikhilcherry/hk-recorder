const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const channels = require('./ipc-channels');

class Recorder {
  constructor(config) {
    this.config = {
      ...config,
      bufferDir: path.resolve(config.bufferDir),
      outputDir: path.resolve(config.outputDir),
    };
    this.isRecording = false;

    this._segments = [];
    this._win = null;
    this._stopResolve = null;
    this._stopReject = null;

    fs.mkdirSync(this.config.bufferDir, { recursive: true });
    fs.mkdirSync(this.config.outputDir, { recursive: true });

    this._registerIpc();
  }

  _registerIpc() {
    ipcMain.on(channels.SEGMENT_DATA, (event, { index, startTs, endTs, bytes }) => {
      const filePath = path.join(this.config.bufferDir, `seg_${index}.webm`);
      fs.writeFileSync(filePath, Buffer.from(bytes));
      this._segments.push({ path: filePath, startTs, endTs });
    });

    ipcMain.on(channels.CAPTURE_STOPPED, async () => {
      this.isRecording = false;
      try {
        const outPath = await this._stitch();
        this._clearBuffer();
        if (this._stopResolve) this._stopResolve(outPath);
      } catch (err) {
        if (this._stopReject) this._stopReject(err);
      } finally {
        this._stopResolve = null;
        this._stopReject = null;
      }
    });

    ipcMain.on(channels.CAPTURE_ERROR, (event, message) => {
      this.isRecording = false;
      const err = new Error(message);
      if (this._stopReject) {
        this._stopReject(err);
        this._stopResolve = null;
        this._stopReject = null;
      }
    });
  }

  async _ensureWindow() {
    if (this._win && !this._win.isDestroyed()) return;
    this._win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    await this._win.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  }

  async start() {
    if (this.isRecording) throw new Error('Recorder is already recording');
    await this._ensureWindow();

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
    const primary = sources[0];
    if (!primary) throw new Error('No screen source available for capture');

    this._segments = [];
    this.isRecording = true;

    this._win.webContents.send(channels.START_CAPTURE, {
      sourceId: primary.id,
      fps: this.config.fps,
      width: this.config.resolution.width,
      height: this.config.resolution.height,
      segmentLengthSec: this.config.segmentLengthSec,
    });
  }

  stop() {
    if (!this.isRecording) {
      return Promise.reject(new Error('Recorder is not recording'));
    }
    return new Promise((resolve, reject) => {
      this._stopResolve = resolve;
      this._stopReject = reject;
      this._win.webContents.send(channels.STOP_CAPTURE);
    });
  }

  getSegments() {
    return this._segments.slice();
  }

  async _stitch() {
    const segments = this._segments.slice().sort((a, b) => a.startTs - b.startTs);
    if (segments.length === 0) throw new Error('No segments recorded, nothing to stitch');

    const listPath = path.join(this.config.bufferDir, 'concat_list.txt');
    const listContent = segments
      .map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent);

    const datetime = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(this.config.outputDir, `session_${datetime}.mp4`);

    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-r', String(this.config.fps),
          outPath,
        ],
        (error, stdout, stderr) => {
          if (error) reject(new Error(`ffmpeg stitch failed: ${stderr || error.message}`));
          else resolve();
        }
      );
    });

    return outPath;
  }

  _clearBuffer() {
    for (const entry of fs.readdirSync(this.config.bufferDir)) {
      fs.rmSync(path.join(this.config.bufferDir, entry), { force: true });
    }
    this._segments = [];
  }
}

module.exports = Recorder;
