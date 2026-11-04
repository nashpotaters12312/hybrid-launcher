// Detects installed games from Steam and Epic Games on Windows.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const fsp = fs.promises;
const { STEAM_ART } = require('./art');

// Everything here is async so scanning never freezes the window.
async function readSafe(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true }, (err, out) => {
      const m = !err && out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
      resolve(m ? path.normalize(m[1].trim()) : null);
    });
  });
}

// ---------- Steam ----------
// Minimal Valve KeyValues (VDF/ACF) parser.
function parseVdf(text) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[2] ?? m[1].replace(/\\\\/g, '\\'));
  let i = 0;
  function obj() {
    const out = {};
    while (i < tokens.length) {
      const key = tokens[i++];
      if (key === '}') return out;
      const val = tokens[i++];
      out[key.toLowerCase()] = val === '{' ? obj() : val;
    }
    return out;
  }
  return obj();
}

// Steam records where it is installed in the registry; read it so installs
// on any drive or folder are found, not just the default locations.
async function steamPathsFromRegistry() {
  if (process.platform !== 'win32') return [];
  const found = await Promise.all([
    regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
  ]);
  return found.filter(Boolean);
}

async function steamRoots() {
  const candidates = [
    ...(await steamPathsFromRegistry()),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
    'D:\\Steam',
    'D:\\Program Files (x86)\\Steam',
  ];
  const unique = [...new Set(candidates.map((p) => p.toLowerCase()))].map(
    (lc) => candidates.find((p) => p.toLowerCase() === lc)
  );
  const ok = await Promise.all(unique.map((p) => exists(path.join(p, 'steamapps'))));
  return unique.filter((_, i) => ok[i]);
}

// Tools/redistributables Steam installs that aren't games.
const STEAM_SKIP = new Set(['228980', '1070560', '1391110', '1628350', '1493710', '250820']);

async function scanSteam() {
  const libraries = new Set();
  for (const root of await steamRoots()) {
    libraries.add(root);
    const vdf = await readSafe(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (!vdf) continue;
    const parsed = parseVdf(vdf).libraryfolders || {};
    for (const entry of Object.values(parsed)) {
      const p = typeof entry === 'object' ? entry.path : entry;
      if (p) libraries.add(p);
    }
  }

  // Read every library folder, and every manifest inside it, in parallel.
  const perLibrary = await Promise.all(
    [...libraries].map(async (lib) => {
      const appsDir = path.join(lib, 'steamapps');
      const files = await fsp.readdir(appsDir).catch(() => []);
      return Promise.all(
        files.filter((f) => /^appmanifest_\d+\.acf$/.test(f)).map((f) => readSafe(path.join(appsDir, f)))
      );
    })
  );

  const games = [];
  const seen = new Set();
  for (const acf of perLibrary.flat()) {
    if (!acf) continue;
    const state = parseVdf(acf).appstate || {};
    const appid = state.appid;
    if (!appid || seen.has(appid) || STEAM_SKIP.has(appid)) continue;
    if (/redistributable|steamworks|proton|runtime/i.test(state.name || '')) continue;
    seen.add(appid);
    games.push({
      name: state.name || `Steam App ${appid}`,
      type: 'url',
      target: `steam://rungameid/${appid}`,
      cover: STEAM_ART(appid, 'library_600x900.jpg'),
      source: 'steam',
      sourceId: appid,
    });
  }
  return games;
}

// ---------- Epic Games ----------
async function scanEpic() {
  const dir = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Epic',
    'EpicGamesLauncher',
    'Data',
    'Manifests'
  );
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.item'));
  const results = await Promise.all(files.map(async (f) => {
    try {
      const m = JSON.parse(await readSafe(path.join(dir, f)));
      if (!m || !m.AppName || !m.DisplayName) return null;
      if (Array.isArray(m.AppCategories) && !m.AppCategories.includes('games')) return null;
      const id = `${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`;
      const epicUrl = `com.epicgames.launcher://apps/${encodeURIComponent(id)}?action=launch&silent=true`;
      const exe = m.InstallLocation && m.LaunchExecutable
        ? path.join(m.InstallLocation, m.LaunchExecutable)
        : '';
      // Run the game's own .exe so the Epic Games Launcher isn't opened.
      // Fall back to the Epic link only if we can't find the executable.
      const direct = exe && (await exists(exe));
      return {
        name: m.DisplayName,
        type: direct ? 'exe' : 'url',
        target: direct ? exe : epicUrl,
        args: direct ? (m.LaunchCommand || '').trim() : '',
        workingDir: direct ? path.dirname(exe) : '',
        epicUrl,
        cover: '',
        source: 'epic',
        sourceId: m.AppName,
        iconFrom: exe,
      };
    } catch {
      return null; // ignore broken manifests
    }
  }));
  return results.filter(Boolean);
}

module.exports = { scanSteam, scanEpic, parseVdf };
