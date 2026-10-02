const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Serve wave files from the linked audio folder over a custom scheme.
// Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lcu-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let audioFolder = null;
let configFile = null;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (e) { return {}; }
}

function saveConfig(partial) {
  try {
    const cfg = loadConfig();
    Object.assign(cfg, partial);
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { /* non-fatal */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0f17',
    title: 'LCU Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  configFile = path.join(app.getPath('userData'), 'config.json');
  audioFolder = loadConfig().audioDir || null;

  protocol.handle('lcu-audio', (request) => {
    if (!audioFolder) return new Response('No audio folder linked', { status: 404 });
    const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const resolved = path.resolve(audioFolder, name);
    const base = path.resolve(audioFolder);
    if (!name || (resolved !== base && !resolved.startsWith(base + path.sep))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-file-dialog', async (event, opts) => {
  const win = BrowserWindow.getFocusedWindow();
  const directory = opts && opts.directory;
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Soundtracker LCU File',
    defaultPath: directory && fs.existsSync(directory) ? directory : undefined,
    filters: [
      { name: 'LCU Files (*.lcu)', extensions: ['lcu'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || res.filePaths.length === 0) return null;

  const filePath = res.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'latin1');
    return { success: true, filePath, filename: path.basename(filePath), content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function listAudioFolder() {
  if (!audioFolder || !fs.existsSync(audioFolder)) return [];
  try {
    return fs.readdirSync(audioFolder).filter(f => fs.statSync(path.join(audioFolder, f)).isFile());
  } catch (e) {
    return [];
  }
}

ipcMain.handle('link-audio-folder', async (event) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, {
    title: 'Select Show Audio Folder',
    defaultPath: audioFolder || undefined,
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true };

  audioFolder = res.filePaths[0];
  saveConfig({ audioDir: audioFolder });
  return { success: true, path: audioFolder, files: listAudioFolder() };
});

ipcMain.handle('get-audio-state', async () => {
  if (!audioFolder || !fs.existsSync(audioFolder)) {
    return { linked: false, path: audioFolder || '', files: [] };
  }
  return { linked: true, path: audioFolder, files: listAudioFolder() };
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'latin1');
    return { success: true, content, filePath, filename: path.basename(filePath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-aup-dialog', async (event, { defaultName, content }) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: 'Export Audacity Project',
    defaultPath: defaultName,
    filters: [
      { name: 'Audacity Project (*.aup)', extensions: ['aup'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, content, 'utf8');
    const dataDir = res.filePath.replace(/\.aup$/i, '') + '_data';
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    return { success: true, filePath: res.filePath, dataDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-file-dialog', async (event, { defaultName, content, filterName, extension }) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: 'Export ' + filterName,
    defaultPath: defaultName,
    filters: [
      { name: filterName, extensions: [extension] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { success: true, filePath: res.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});