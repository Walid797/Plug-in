'use strict';
// Electron shell: starts the local server on a fixed port (127.0.0.1) and shows the app in a window.
// Everything the app needs is inside the installer, so it works with no internet. The only network use is the optional,
// photo-free check for a newer installer (electron-updater reads latest.yml); it fails silently when offline and can be
// turned off in  %APPDATA%\Hoshmand Photo Studio\desktop-settings.json  ->  { "autoUpdate": false }.
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startAppServer } = require('./appserver.cjs');

const PORT = 47877;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let win = null;
let srv = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop-settings.json'), 'utf8')); } catch { return {}; }
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
  try {
    srv = await startAppServer(path.join(__dirname, 'www'), PORT);
  } catch (err) {
    dialog.showErrorBox('Hoshmand Photo Studio', `درگاه ${PORT} روی این کمپیوتر مشغول است (شاید برنامه دوباره باز شده یا برنامهٔ دیگری آن را گرفته).\nآن را ببندید و دوباره امتحان کنید.\n\n${err.code || err.message}`);
    app.quit();
    return;
  }
  // only the camera (for taking a photo inside the app) may be requested; everything else is denied
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
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
