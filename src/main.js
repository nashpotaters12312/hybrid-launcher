const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const scanners = require('./scanners');

let win;
const running = new Map(); // gameId -> { startedAt }

// ---------- Library storage ----------
const libraryPath = () => path.join(app.getPath('userData'), 'library.json');

function loadLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(libraryPath(), 'utf8'));
    return Array.isArray(data.games) ? data : { games: [] };
  } catch {
    return { games: [] };
  }
}

function saveLibrary(lib) {
  fs.mkdirSync(path.dirname(libraryPath()), { recursive: true });
  const tmp = libraryPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2));
  fs.renameSync(tmp, libraryPath());
}

let library;

function updateGame(id, patch) {
  const g = library.games.find((x) => x.id === id);
  if (!g) return null;
  Object.assign(g, patch);
  saveLibrary(library);
  return g;
}

function notifyChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('library:changed');
}

// Older versions launched Epic games through the Epic Games Launcher link.
// Switch any such entries to run the game's .exe directly when it's installed.
function migrateEpicToDirect() {
  const legacy = library.games.filter((g) => g.source === 'epic' && g.type === 'url');
  if (!legacy.length) return;
  const scanned = new Map(scanners.scanEpic().map((e) => [e.sourceId, e]));
  let changed = false;
  for (const g of legacy) {
    const e = scanned.get(g.sourceId);
    if (!e || e.type !== 'exe') continue;
    Object.assign(g, { type: 'exe', target: e.target, args: e.args, workingDir: e.workingDir, epicUrl: e.epicUrl });
    changed = true;
  }
  if (changed) saveLibrary(library);
}

// ---------- Launching ----------
function recordSession(id, startedAt) {
  const g = library.games.find((x) => x.id === id);
  if (!g) return;
  const minutes = (Date.now() - startedAt) / 60000;
  g.playtimeMinutes = (g.playtimeMinutes || 0) + minutes;
  saveLibrary(library);
  running.delete(id);
  notifyChanged();
}

async function launchGame(id) {
  const g = library.games.find((x) => x.id === id);
  if (!g) throw new Error('Game not found');

  g.lastPlayed = Date.now();
  saveLibrary(library);

  if (g.type === 'url') {
    // Steam / Epic / any protocol launcher — hand off to Windows.
    await shell.openExternal(g.target);
    return { tracked: false };
  }

  if (!fs.existsSync(g.target)) throw new Error(`File not found:\n${g.target}`);

  const ext = path.extname(g.target).toLowerCase();
  if (ext !== '.exe' && ext !== '.bat' && ext !== '.cmd') {
    // Shortcuts (.lnk, .url) and anything else: let Windows open it.
    const err = await shell.openPath(g.target);
    if (err) throw new Error(err);
    return { tracked: false };
  }

  const args = (g.args || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const child = spawn(g.target, args.map((a) => a.replace(/^"|"$/g, '')), {
    cwd: g.workingDir || path.dirname(g.target),
    detached: true,
    stdio: 'ignore',
    shell: ext !== '.exe',
  });
  const startedAt = Date.now();
  running.set(id, { startedAt });
  child.on('exit', () => recordSession(id, startedAt));
  child.on('error', () => running.delete(id));
  child.unref();
  notifyChanged();

  if (library.settings?.minimizeOnLaunch && win) win.minimize();
  return { tracked: true };
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('library:get', () => ({
    games: library.games.map((g) => ({ ...g, running: running.has(g.id) })),
    settings: library.settings || {},
  }));

  ipcMain.handle('library:add', (_e, game) => {
    const g = {
      id: crypto.randomUUID(),
      name: game.name?.trim() || 'Untitled',
      type: game.type || 'exe',
      target: game.target,
      args: game.args || '',
      workingDir: game.workingDir || '',
      epicUrl: game.epicUrl || '',
      cover: game.cover || '',
      icon: game.icon || '',
      source: game.source || 'custom',
      sourceId: game.sourceId || '',
      favorite: false,
      hidden: false,
      playtimeMinutes: 0,
      lastPlayed: null,
      addedAt: Date.now(),
    };
    library.games.push(g);
    saveLibrary(library);
    return g;
  });

  ipcMain.handle('library:update', (_e, id, patch) => updateGame(id, patch));

  ipcMain.handle('library:remove', (_e, id) => {
    library.games = library.games.filter((g) => g.id !== id);
    saveLibrary(library);
    return true;
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    library.settings = { ...(library.settings || {}), ...patch };
    saveLibrary(library);
    return library.settings;
  });

  ipcMain.handle('game:launch', async (_e, id) => {
    try {
      return { ok: true, ...(await launchGame(id)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('game:openFolder', (_e, id) => {
    const g = library.games.find((x) => x.id === id);
    if (g && g.type !== 'url') shell.showItemInFolder(g.target);
  });

  ipcMain.handle('dialog:pickGame', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a game',
      properties: ['openFile'],
      filters: [
        { name: 'Games & shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    return { target: file, name: prettifyName(file) };
  });

  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose cover art',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    // Copy into userData so the cover survives the original being moved.
    const src = r.filePaths[0];
    const dir = path.join(app.getPath('userData'), 'covers');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, crypto.randomUUID() + path.extname(src));
    fs.copyFileSync(src, dest);
    return 'file:///' + dest.replace(/\\/g, '/');
  });

  ipcMain.handle('game:icon', async (_e, target) => {
    try {
      const img = await app.getFileIcon(target, { size: 'large' });
      return img.toDataURL();
    } catch {
      return null;
    }
  });

  ipcMain.handle('scan:run', async () => {
    const found = [...scanners.scanSteam(), ...scanners.scanEpic()];
    const existing = new Set(library.games.map((g) => `${g.source}:${g.sourceId}`));
    const fresh = found.filter((f) => !existing.has(`${f.source}:${f.sourceId}`));
    return { found: found.length, fresh };
  });

  ipcMain.handle('window:control', (_e, action) => {
    if (!win) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
  });
}

function prettifyName(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(win64|win32|x64|shipping|launcher)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0f1117',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.nashpotaters.hybridlauncher');
    library = loadLibrary();
    migrateEpicToDirect();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
