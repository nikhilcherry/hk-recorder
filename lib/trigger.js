const { app, BrowserWindow, Tray, Menu, globalShortcut, Notification, shell, nativeImage, screen } = require('electron');
const path = require('path');

const TRAY_IDLE_ICON = path.join(__dirname, '..', 'assets', 'tray-idle.png');
const TRAY_RECORDING_ICON = path.join(__dirname, '..', 'assets', 'tray-recording.png');
const OVERLAY_MAIN_SIZE = 56;
const OVERLAY_STAR_SIZE = 32;
const OVERLAY_GAP = 8;
const OVERLAY_WIDTH = OVERLAY_MAIN_SIZE;
const OVERLAY_HEIGHT = OVERLAY_MAIN_SIZE + OVERLAY_GAP + OVERLAY_STAR_SIZE;
const OVERLAY_MARGIN = 12;

class Trigger {
  constructor(recorder, config, marker) {
    this.recorder = recorder;
    this.config = config;
    this.marker = marker || null;
    this.hotkey = config.hotkey || 'Insert';
    this.tray = null;
    this.overlay = null;
    this._toggling = false;
  }

  init() {
    this._createOverlay();
    this._createTray();
    this._registerShortcut();
  }

  _createOverlay() {
    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - OVERLAY_WIDTH - OVERLAY_MARGIN;
    const y = workArea.y + OVERLAY_MARGIN;

    this.overlay = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      hasShadow: false,
      focusable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    this.overlay.setAlwaysOnTop(true, 'screen-saver');
    this.overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

    const { ipcMain } = require('electron');
    ipcMain.on('hk:overlay-toggle', () => this.toggle());
    ipcMain.on('hk:overlay-mark', () => {
      if (!this.marker) return;
      this.marker.mark().catch((err) => {
        console.error('[trigger] mark failed:', err && err.message ? err.message : err);
      });
    });
  }

  _createTray() {
    this.tray = new Tray(nativeImage.createFromPath(TRAY_IDLE_ICON));
    this.tray.setToolTip('hk-recorder');
    this._rebuildTrayMenu();
  }

  _rebuildTrayMenu() {
    const recording = this.recorder.isRecording;
    const menu = Menu.buildFromTemplate([
      {
        label: recording ? 'Stop' : 'Start',
        click: () => this.toggle(),
      },
      {
        label: 'Open output folder',
        click: () => shell.openPath(this.config.outputDir),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  _registerShortcut() {
    // Deferred via setImmediate so heavy async work (window creation, desktopCapturer)
    // doesn't run synchronously inside the native key-grab callback.
    const ok = globalShortcut.register(this.hotkey, () => setImmediate(() => this.toggle()));
    if (!ok) {
      console.error(`[trigger] failed to register global shortcut "${this.hotkey}"`);
    }
  }

  async toggle() {
    if (this._toggling) return;
    this._toggling = true;
    try {
      if (this.recorder.isRecording) {
        await this._stop();
      } else {
        await this._start();
      }
    } catch (err) {
      console.error('[trigger] toggle failed:', err && err.message ? err.message : err);
    } finally {
      this._toggling = false;
    }
  }

  async _start() {
    await this.recorder.start();
    this._syncState();
    new Notification({ title: 'hk-recorder', body: 'Recording...' }).show();
  }

  async _stop() {
    const outPath = await this.recorder.stop();
    this._syncState();
    new Notification({ title: 'hk-recorder', body: `Saved: ${outPath}` }).show();
  }

  _syncState() {
    const recording = this.recorder.isRecording;
    this.tray.setImage(nativeImage.createFromPath(recording ? TRAY_RECORDING_ICON : TRAY_IDLE_ICON));
    this._rebuildTrayMenu();
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.webContents.send('hk:state', { recording });
    }
  }

  destroy() {
    globalShortcut.unregister(this.hotkey);
    if (this.tray) this.tray.destroy();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
  }
}

module.exports = Trigger;
