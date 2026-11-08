'use strict';
// Electron shell: starts the local server on a fixed port (127.0.0.1) and shows the app in a window.
// Everything the app needs is inside the installer, so it works with no internet. The only network use is the optional,
// photo-free check for a newer installer (electron-updater reads latest.yml); it fails silently when offline and can be
// turned off in  %APPDATA%\Hoshmand Photo Studio\desktop-settings.json  ->  { "autoUpdate": false }.
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startAppServer } = require('./appserver.cjs');
const { needsSoftwareGraphics, useSoftwareGraphics } = require('./graphics.cjs');

const PORT = 47877;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let win = null;
let srv = null;

// The AI models (MediaPipe) need WebGL even on their CPU path. Since Chromium 137 (Electron 37) a blocklisted or
// crashing GPU driver no longer falls back to software WebGL automatically, so on such Windows PCs background removal
// and face analysis failed ("reading 'activeTexture'"). This switch restores the software (SwiftShader) fallback. The
// window only ever shows this app's own local files, so the "unsafe" part (untrusted web content on SwiftShader) does
// not apply here.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop-settings.json'), 'utf8')); } catch { return {}; }
}
const stateFile = () => path.join(app.getPath('userData'), 'desktop-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch })); } catch { /* read-only profile */ }
}

// A PC without a graphics card: always use SwiftShader for WebGL (see graphics.cjs). Must be set before "ready".
// Override in desktop-settings.json: { "graphics": "software" | "hardware" | "auto" }.
const SOFTWARE_GRAPHICS = useSoftwareGraphics(readSettings(), readState());
if (SOFTWARE_GRAPHICS) app.commandLine.appendSwitch('use-angle', 'swiftshader');

/** In "auto" mode, if this PC has no real graphics card, remember it and restart once in software mode. */
async function switchToSoftwareGraphicsIfNeeded() {
  if (SOFTWARE_GRAPHICS || (readSettings().graphics || 'auto') !== 'auto') return false;
  let info = null;
  try { info = await app.getGPUInfo('basic'); } catch { return false; }
  if (!needsSoftwareGraphics(info)) return false;
  writeState({ softwareGraphics: true });
  app.relaunch();
  app.exit(0);
  return true;
}

// Permissions the app may use: the camera (taking a photo inside the app) and persistent storage (so projects and
// photos are never evicted when the disk is nearly full). Everything else is denied.
const ALLOWED_PERMISSIONS = new Set(['media', 'persistent-storage']);

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });


/**
 * After an update the service worker of the previous version would keep serving the old app code from its cache
 * until the user reloads twice. When the installed version changes, drop only the service worker and its Cache
 * Storage for this origin. Projects, photos, settings and installed models (IndexedDB, localStorage) are kept.
 */
async function dropStaleAppCache() {
  const version = app.getVersion();
  if (readState().appVersion === version) return;
  try {
    await session.defaultSession.clearStorageData({ origin: ORIGIN, storages: ['serviceworkers', 'cachestorage'] });
  } catch { /* nothing cached yet */ }
  writeState({ appVersion: version });
}

function setupUpdates() {
  if (!app.isPackaged || readSettings().autoUpdate === false) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(win, {
      type: 'info', buttons: ['حالا راه‌اندازی مجدد', 'بعداً'], defaultId: 1, cancelId: 1, title: 'به‌روزرسانی آماده است',
      message: `نسخهٔ ${info.version} دانلود شد.`, detail: 'پروژه‌ها و عکس‌های شما سر جایشان می‌مانند. اگر «بعداً» را بزنید، با بستن برنامه نصب می‌شود.',
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); }).catch(() => {});
  });
  autoUpdater.on('error', () => { /* offline or no release yet: stay silent */ });
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
}

async function createWindow() {
  if (await switchToSoftwareGraphicsIfNeeded()) return;
  try {
    srv = await startAppServer(path.join(__dirname, 'www'), PORT);
  } catch (err) {
    dialog.showErrorBox('Hoshmand Photo Studio', `درگاه ${PORT} روی این کمپیوتر مشغول است (شاید برنامه دوباره باز شده یا برنامهٔ دیگری آن را گرفته).\nآن را ببندید و دوباره امتحان کنید.\n\n${err.code || err.message}`);
    app.quit();
    return;
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  await dropStaleAppCache();
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600, show: false, autoHideMenuBar: true, title: 'Hoshmand Photo Studio',
    icon: path.join(__dirname, 'build', 'icon.png'), backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN) || url === 'about:blank') return { action: 'allow' };
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  await win.loadURL(ORIGIN);
  win.on('closed', () => { win = null; });
  setupUpdates();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (srv) srv.close(); app.quit(); });
