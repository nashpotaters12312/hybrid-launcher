const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const scanners = require('./scanners');
const { createArtFinder } = require('./art');
const images = require('./images');
const picker = require('./picker');

const dirs = {
  get covers() { return path.join(app.getPath('userData'), 'covers'); },
  get icons() { return path.join(app.getPath('userData'), 'icons'); },
};

let win;
const running = new Map(); // gameId -> { startedAt }

// ---------- Library storage ----------
const libraryPath = () => path.join(app.getPath('userData'), 'library.json');

function readLibraryFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Array.isArray(data.games) ? data : null;
  } catch {
    return null;
  }
}

// If library.json is damaged, fall back to the last good copy instead of
// starting empty and overwriting the user's games.
function loadLibrary() {
  const file = libraryPath();
  const backup = file.replace(/\.json$/, '.backup.json');
  const main = readLibraryFile(file);
  if (main) {
    try {
      fs.copyFileSync(file, backup); // last known good copy
    } catch {
      /* not fatal */
    }
    return main;
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file.replace(/\.json$/, `.damaged-${Date.now()}.json`));
    } catch {
      /* not fatal */
    }
  }
  return readLibraryFile(file + '.tmp') || readLibraryFile(backup) || { games: [] };
}

function writeLibraryNow(lib) {
  fs.mkdirSync(path.dirname(libraryPath()), { recursive: true });
  const tmp = libraryPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2));
  fs.renameSync(tmp, libraryPath());
}

// Writes are batched so rapid changes (art lookups, scans) don't stall the UI.
let saveTimer = null;
function saveLibrary(lib) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeLibraryNow(lib);
    } catch (err) {
      console.error('Saving the library failed, retrying:', err.message);
      saveTimer = setTimeout(() => saveLibrary(lib), 2000);
    }
  }, 250);
}

function flushLibrary() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeLibraryNow(library);
    } catch (err) {
      console.error('Saving the library failed:', err.message);
    }
  }
}

let library;

function updateGame(id, patch) {
  const g = library.games.find((x) => x.id === id);
  if (!g) return null;
  Object.assign(g, patch);
  saveLibrary(library);
  return g;
}

let notifyPending = false;
function notifyChanged() {
  if (notifyPending) return;
  notifyPending = true;
  setTimeout(() => {
    notifyPending = false;
    if (win && !win.isDestroyed()) win.webContents.send('library:changed');
  }, 50);
}

function sendArtProgress() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('art:progress', artQueue.length + (artBusy ? 1 : 0));
  }
}

// Older versions launched Epic games through the Epic Games Launcher link.
// Switch any such entries to run the game's .exe directly when it's installed.
async function migrateEpicToDirect() {
  const legacy = library.games.filter((g) => g.source === 'epic' && g.type === 'url');
  if (!legacy.length) return;
  const scanned = new Map((await scanners.scanEpic()).map((e) => [e.sourceId, e]));
  let changed = false;
  for (const g of legacy) {
    const e = scanned.get(g.sourceId);
    if (!e || e.type !== 'exe') continue;
    Object.assign(g, { type: 'exe', target: e.target, args: e.args, workingDir: e.workingDir, epicUrl: e.epicUrl });
    changed = true;
  }
  if (changed) {
    saveLibrary(library);
    notifyChanged();
  }
}

// ---------- Automatic cover art ----------
const ART_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // re-check games with no art weekly
let artFinder;
const artQueue = [];
const artForced = new Set();
let artBusy = false;

const isWebCover = (g) => /^https?:/i.test(g.cover || '');

function needsArt(g) {
  const due = !g.artCheckedAt || Date.now() - g.artCheckedAt > ART_RETRY_MS;
  // Missing covers, and Steam's web covers (saved locally so they work offline).
  return due && (!g.cover || (isWebCover(g) && g.source === 'steam'));
}

function queueArt(ids, force = false) {
  for (const id of ids) {
    if (force) artForced.add(id);
    if (!artQueue.includes(id)) artQueue.push(id);
  }
  sendArtProgress();
  processArtQueue();
}

async function processArtQueue() {
  if (artBusy) return;
  artBusy = true;
  try {
    while (artQueue.length) {
      const id = artQueue.shift();
      const force = artForced.delete(id);
      const g = library.games.find((x) => x.id === id);
      if (!g || (!force && !needsArt(g))) continue;
      let found = null;
      try {
        found = await artFinder.find(g, { sgdbKey: library.settings?.sgdbKey });
      } catch {
        /* offline or service error: try again later */
      }
      const current = library.games.find((x) => x.id === id);
      if (!current) continue;
      current.artCheckedAt = Date.now();
      const upgradeWeb = isWebCover(current) && current.source === 'steam' && !images.fromFileUrl(current.cover);
      if (found && (!current.cover || force || current.coverBroken || upgradeWeb)) {
        current.cover = found.cover;
        current.coverAuto = true;
        if (found.steamAppId) current.steamAppId = found.steamAppId;
      } else if (current.coverBroken) {
        const file = images.fromFileUrl(current.cover);
        const gone = file ? !fs.existsSync(file) : (await artFinder.probe(current.cover)) === 'missing';
        if (gone) current.cover = ''; // really gone: show the placeholder
        else current.artBrokenAt = 0; // just couldn't load right now: try again later
      }
      delete current.coverBroken;
      saveLibrary(library);
      notifyChanged();
      sendArtProgress();
    }
  } finally {
    artBusy = false;
    sendArtProgress();
  }
}

function addGame(game) {
  const g = {
    id: crypto.randomUUID(),
    name: game.name?.trim() || 'Untitled',
    type: game.type || 'exe',
    target: game.target,
    args: game.args || '',
    workingDir: game.workingDir || '',
    epicUrl: game.epicUrl || '',
    cover: game.cover || '',
    icon: '',
    source: game.source || 'custom',
    sourceId: game.sourceId || '',
    favorite: false,
    hidden: false,
    playtimeMinutes: 0,
    lastPlayed: null,
    addedAt: Date.now(),
  };
  g.icon = images.saveIcon(game.icon, dirs.icons, g.id);
  library.games.push(g);
  saveLibrary(library);
  if (!g.cover) queueArt([g.id]);
  return g;
}

// ---------- Scanning ----------
async function findNewGames() {
  const [steam, epic] = await Promise.all([scanners.scanSteam(), scanners.scanEpic()]);
  const found = [...steam, ...epic];
  const existing = new Set(library.games.map((g) => `${g.source}:${g.sourceId}`));
  const fresh = found.filter((f) => !existing.has(`${f.source}:${f.sourceId}`));
  return { found: found.length, fresh };
}

async function autoScan() {
  const { fresh } = await findNewGames();
  if (!fresh.length) return;
  for (const f of fresh) {
    let icon = '';
    if (f.iconFrom) {
      try {
        icon = (await app.getFileIcon(f.iconFrom, { size: 'large' })).toDataURL();
      } catch {
        /* no icon */
      }
    }
    addGame({ ...f, icon });
  }
  notifyChanged();
  if (win && !win.isDestroyed()) win.webContents.send('scan:auto', fresh.map((f) => f.name));
}

// ---------- Launching ----------
function recordSession(id, startedAt) {
  if (!running.has(id)) return; // already recorded (e.g. on quit)
  running.delete(id);
  const g = library.games.find((x) => x.id === id);
  if (g) {
    g.playtimeMinutes = (g.playtimeMinutes || 0) + (Date.now() - startedAt) / 60000;
    saveLibrary(library);
  }
  notifyChanged();
}

// Split launch options like: -windowed -path="C:\My Games\x" "two words"
// Quotes only group words; they are not passed to the game.
function parseArgs(text) {
  return ((text || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/"/g, ''));
}

const cmdQuote = (a) => (/[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function markLaunched(g) {
  g.lastPlayed = Date.now();
  saveLibrary(library);
  if (library.settings?.minimizeOnLaunch && win) win.minimize();
}

// Resolves once the process has started, or rejects with the spawn error.
function startProcess(file, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, opts);
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

async function launchGame(id) {
  const g = library.games.find((x) => x.id === id);
  if (!g) throw new Error('Game not found');
  if (running.has(id)) throw new Error(`${g.name} is already running.`);

  if (g.type === 'url') {
    // Steam / Epic / any protocol launcher — hand off to Windows.
    await shell.openExternal(g.target);
    markLaunched(g);
    return { tracked: false };
  }

  if (!fs.existsSync(g.target)) throw new Error(`File not found:\n${g.target}`);

  const ext = path.extname(g.target).toLowerCase();
  if (ext !== '.exe' && ext !== '.bat' && ext !== '.cmd') {
    // Shortcuts (.lnk, .url) and anything else: let Windows open it.
    const err = await shell.openPath(g.target);
    if (err) throw new Error(err);
    markLaunched(g);
    return { tracked: false };
  }

  const args = parseArgs(g.args);
  const isScript = ext !== '.exe';
  const cwd = g.workingDir && fs.existsSync(g.workingDir) ? g.workingDir : path.dirname(g.target);
  let child;
  try {
    child = isScript
      // Batch files run through cmd; quote so folders with spaces work.
      ? await startProcess([g.target, ...args].map(cmdQuote).join(' '), [], { cwd, detached: true, stdio: 'ignore', shell: true, windowsHide: true })
      : await startProcess(g.target, args, { cwd, detached: true, stdio: 'ignore' });
  } catch (err) {
    // Games that need admin rights can't be started directly; Windows'
    // own launcher shows the UAC prompt instead.
    if (!isScript && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'UNKNOWN')) {
      const shellErr = await shell.openPath(g.target);
      if (!shellErr) {
        markLaunched(g);
        return { tracked: false };
      }
    }
    throw new Error(`Couldn't start ${g.name} (${err.code || err.message}).`);
  }

  const startedAt = Date.now();
  running.set(id, { startedAt });
  child.on('exit', () => recordSession(id, startedAt));
  child.unref();
  markLaunched(g);
  notifyChanged();
  return { tracked: true };
}

// Closing the launcher mid-game: keep the time played so far.
function recordAllRunning() {
  for (const [id, { startedAt }] of running) recordSession(id, startedAt);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('library:get', () => ({
    games: library.games.map((g) => ({ ...g, running: running.has(g.id) })),
    settings: library.settings || {},
  }));

  ipcMain.handle('library:add', (_e, game) => addGame(game));

  ipcMain.handle('library:update', (_e, id, patch) => {
    const before = library.games.find((x) => x.id === id);
    if (before && 'cover' in patch && patch.cover !== before.cover) patch.coverAuto = false;
    if (patch.icon) patch.icon = images.saveIcon(patch.icon, dirs.icons, id);
    if (before && 'target' in patch && patch.target !== before.target) patch.workingDir = '';
    const g = updateGame(id, patch);
    if (g && !g.cover) queueArt([g.id], true);
    return g;
  });

  // Find art for one game now (replaces an automatic cover, never a custom one
  // unless the user asks from the button).
  ipcMain.handle('art:find', (_e, id) => queueArt([id], true));

  ipcMain.handle('art:findMissing', () => {
    const ids = library.games.filter((g) => !g.cover).map((g) => g.id);
    queueArt(ids, true);
    return ids.length;
  });

  // The renderer reports a cover that failed to load (moved file, dead URL).
  ipcMain.handle('art:broken', (_e, id) => {
    const g = library.games.find((x) => x.id === id);
    if (!g || !g.cover || g.artBrokenAt > Date.now() - ART_RETRY_MS) return;
    const file = images.fromFileUrl(g.cover);
    if (file && fs.existsSync(file)) return; // file is fine, nothing to fix
    if (!file && !net.isOnline()) return; // web cover just can't load offline
    g.artBrokenAt = Date.now();
    g.coverBroken = true;
    saveLibrary(library);
    queueArt([id], true);
  });

  ipcMain.handle('art:status', () => ({ pending: artQueue.length + (artBusy ? 1 : 0) }));

  ipcMain.handle('library:remove', (_e, id) => {
    const g = library.games.find((x) => x.id === id);
    library.games = library.games.filter((x) => x.id !== id);
    saveLibrary(library);
    // Delete this game's own cover and icon files (only ones we created).
    for (const url of [g?.cover, g?.icon]) {
      const file = images.fromFileUrl(url);
      const ours = file && [dirs.covers, dirs.icons].some((d) => file.startsWith(d + path.sep));
      if (ours) fs.promises.unlink(file).catch(() => {});
    }
    return true;
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    library.settings = { ...(library.settings || {}), ...patch };
    if ('startWithWindows' in patch) applyLoginItem();
    saveLibrary(library);
    return library.settings;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    canAutoStart: app.isPackaged && process.platform === 'win32',
  }));

  ipcMain.handle('data:openFolder', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Back up library',
      defaultPath: path.join(app.getPath('documents'), `hybrid-launcher-backup-${stamp}.json`),
      filters: [{ name: 'Library backup', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    flushLibrary();
    const { sgdbKey, anthropicKey, ...settings } = library.settings || {}; // keep API keys out of backups
    fs.writeFileSync(r.filePath, JSON.stringify({ ...library, settings }, null, 2));
    return r.filePath;
  });

  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Restore library backup',
      properties: ['openFile'],
      filters: [{ name: 'Library backup', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    } catch {
      return { error: "That file isn't a valid backup." };
    }
    if (!Array.isArray(data.games)) return { error: "That file isn't a Hybrid Launcher backup." };
    // Merge: games from the backup replace matching ones, everything else is kept.
    const byId = new Map(library.games.map((g) => [g.id, g]));
    let added = 0;
    for (const g of data.games) {
      if (!g || !g.id || !g.target) continue;
      if (!byId.has(g.id)) added++;
      byId.set(g.id, g);
    }
    library.games = [...byId.values()];
    library.settings = { ...(data.settings || {}), ...(library.settings || {}) };
    saveLibrary(library);
    notifyChanged();
    return { added, total: data.games.length };
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
    const buf = await fs.promises.readFile(src);
    return images.writeCover(buf, dirs.covers, crypto.randomUUID(), path.extname(src));
  });

  ipcMain.handle('game:icon', async (_e, target) => {
    try {
      const img = await app.getFileIcon(target, { size: 'large' });
      return img.toDataURL();
    } catch {
      return null;
    }
  });

  ipcMain.handle('scan:run', () => findNewGames());

  ipcMain.handle('pick:game', async (_e, opts = {}) => {
    const games = library.games.map((g) => ({ ...g, running: running.has(g.id) }));
    const key = library.settings?.anthropicKey;
    if (opts.ai && key) {
      const r = await picker.aiPick(games, { apiKey: key, mood: opts.mood, mode: opts.mode, excludeIds: opts.excludeIds });
      if (!r.error) return r;
      // AI unavailable: still give the player a game, and say why.
      const fallback = picker.smartPick(games, opts);
      return fallback.error ? r : { ...fallback, warning: r.error };
    }
    return picker.smartPick(games, opts);
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
function applyLoginItem() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: !!library.settings?.startWithWindows,
    args: ['--hidden'],
  });
}

function boundsAreVisible(b) {
  const { screen } = require('electron');
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100
  );
}

function createWindow() {
  const saved = library.settings?.window;
  const bounds = saved && boundsAreVisible(saved) ? saved : { width: 1280, height: 800 };
  win = new BrowserWindow({
    ...bounds,
    show: false,
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
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const startHidden = process.argv.includes('--hidden') && library.settings?.startMinimized;
  win.once('ready-to-show', () => {
    if (saved?.maximized && !startHidden) win.maximize();
    if (startHidden) {
      win.showInactive();
      win.minimize();
    } else {
      win.show();
    }
  });

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b = maximized ? (library.settings?.window || win.getNormalBounds()) : win.getBounds();
    library.settings = { ...(library.settings || {}), window: { ...b, maximized } };
    saveLibrary(library);
  };
  let t;
  const later = () => { clearTimeout(t); t = setTimeout(remember, 400); };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
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
    artFinder = createArtFinder({
      fetch: (url, opts) => net.fetch(url, opts),
      coversDir: dirs.covers,
      writeCover: images.writeCover,
    });
    registerIpc();
    createWindow();
    // Fill in art for games that don't have any yet.
    applyLoginItem();
    // Housekeeping runs after the window is up so it never delays startup.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await migrateEpicToDirect();
        if (await images.migrateImages(library.games, { iconsDir: dirs.icons, coversDir: dirs.covers })) {
          saveLibrary(library);
          notifyChanged();
        }
        if (library.settings?.autoScan) await autoScan();
        queueArt(library.games.filter(needsArt).map((g) => g.id));
      }, 300);
    });
  });

  app.on('before-quit', () => {
    recordAllRunning();
    flushLibrary();
  });
  app.on('window-all-closed', () => app.quit());
}
