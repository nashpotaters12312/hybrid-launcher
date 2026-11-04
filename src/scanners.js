// Detects installed games from Steam and Epic Games on Windows.
const fs = require('fs');
const path = require('path');

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
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

function steamRoots() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
    'D:\\Steam',
    'D:\\Program Files (x86)\\Steam',
  ];
  return candidates.filter((p) => fs.existsSync(path.join(p, 'steamapps')));
}

// Tools/redistributables Steam installs that aren't games.
const STEAM_SKIP = new Set(['228980', '1070560', '1391110', '1628350', '1493710', '250820']);

function scanSteam() {
  const libraries = new Set();
  for (const root of steamRoots()) {
    libraries.add(root);
    const vdf = readSafe(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (!vdf) continue;
    const parsed = parseVdf(vdf).libraryfolders || {};
    for (const entry of Object.values(parsed)) {
      const p = typeof entry === 'object' ? entry.path : entry;
      if (p) libraries.add(p);
    }
  }

  const games = [];
  const seen = new Set();
  for (const lib of libraries) {
    const appsDir = path.join(lib, 'steamapps');
    let files = [];
    try {
      files = fs.readdirSync(appsDir).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const acf = readSafe(path.join(appsDir, f));
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
        cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
        source: 'steam',
        sourceId: appid,
      });
    }
  }
  return games;
}

// ---------- Epic Games ----------
function scanEpic() {
  const dir = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Epic',
    'EpicGamesLauncher',
    'Data',
    'Manifests'
  );
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'));
  } catch {
    return [];
  }
  const games = [];
  for (const f of files) {
    try {
      const m = JSON.parse(readSafe(path.join(dir, f)));
      if (!m || !m.AppName || !m.DisplayName) continue;
      if (Array.isArray(m.AppCategories) && !m.AppCategories.includes('games')) continue;
      const id = `${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`;
      games.push({
        name: m.DisplayName,
        type: 'url',
        target: `com.epicgames.launcher://apps/${encodeURIComponent(id)}?action=launch&silent=true`,
        cover: '',
        source: 'epic',
        sourceId: m.AppName,
        iconFrom: m.InstallLocation && m.LaunchExecutable
          ? path.join(m.InstallLocation, m.LaunchExecutable)
          : '',
      });
    } catch {
      /* ignore broken manifests */
    }
  }
  return games;
}

module.exports = { scanSteam, scanEpic, parseVdf };
