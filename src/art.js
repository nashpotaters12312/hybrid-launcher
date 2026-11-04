// Automatic cover art lookup.
//  1. SteamGridDB (optional, needs a free API key) — huge community library.
//  2. Steam store search (no key) — official art for anything sold on Steam.
// Found images are downloaded into userData/covers so they work offline.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const STEAM_ART = (id, file) =>
  `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/${file}`;

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|edition|game of the year|goty|definitive|remastered|launcher)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pick the best result whose name really matches, so we don't attach the
// wrong game's art. Exact (normalized) match wins; otherwise accept a close
// prefix match like "Hades" vs "Hades II" only if lengths are similar.
function bestMatch(name, items, getName) {
  const want = normalize(name);
  if (!want) return null;
  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const have = normalize(getName(it));
    if (!have) continue;
    let score = 0;
    if (have === want) score = 1;
    else if (have.startsWith(want) || want.startsWith(have)) {
      const ratio = Math.min(have.length, want.length) / Math.max(have.length, want.length);
      if (ratio >= 0.7) score = ratio * 0.9;
    }
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best;
}

function createArtFinder({ fetch, coversDir, writeCover }) {
  async function getJson(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function exists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fromSteamGridDb(name, key) {
    const auth = { Authorization: `Bearer ${key}` };
    const search = await getJson(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(name)}`,
      auth
    );
    const game = bestMatch(name, search.data || [], (g) => g.name);
    if (!game) return null;
    const grids = await getJson(
      `https://www.steamgriddb.com/api/v2/grids/game/${game.id}?dimensions=600x900&types=static`,
      auth
    );
    const grid = (grids.data || []).find((g) => g.url);
    return grid ? grid.url : null;
  }

  async function steamAppIdFor(name) {
    const data = await getJson(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=US&l=english`
    );
    const app = bestMatch(name, (data.items || []).filter((i) => i.type === 'app'), (i) => i.name);
    return app ? String(app.id) : null;
  }

  // Tall cover first; fall back to the wide header if a game has no tall art.
  async function steamCover(appId) {
    for (const file of ['library_600x900.jpg', 'library_600x900_2x.jpg', 'header.jpg']) {
      const url = STEAM_ART(appId, file);
      if (await exists(url)) return url;
    }
    return null;
  }

  async function download(url, id) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error('Not an image');
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (writeCover) return writeCover(buf, coversDir, `auto-${id}`, ext);
    fs.mkdirSync(coversDir, { recursive: true });
    const file = path.join(coversDir, `auto-${id}${ext}`);
    fs.writeFileSync(file, buf);
    return pathToFileURL(file).href + `?v=${Date.now()}`;
  }

  // Returns { cover, steamAppId } or null.
  async function find(game, { sgdbKey } = {}) {
    let url = null;
    let steamAppId = game.source === 'steam' ? game.sourceId : null;

    if (!url && sgdbKey) {
      try {
        url = await fromSteamGridDb(game.name, sgdbKey);
      } catch {
        /* fall through to Steam */
      }
    }
    if (!url) {
      if (!steamAppId) steamAppId = await steamAppIdFor(game.name).catch(() => null);
      if (steamAppId) url = await steamCover(steamAppId);
    }
    if (!url) return null;

    const cover = await download(url, game.id).catch(() => url);
    return { cover, steamAppId };
  }

  // Is a web image really gone? 'missing' only on a definite 404/410 from
  // the server; network trouble is 'unknown' so we never delete art offline.
  async function probe(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return 'ok';
      return res.status === 404 || res.status === 410 ? 'missing' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  return { find, probe };
}

module.exports = { createArtFinder, normalize, bestMatch, STEAM_ART };
