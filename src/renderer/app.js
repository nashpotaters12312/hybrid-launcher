const api = window.launcher;
const $ = (sel) => document.querySelector(sel);

const state = {
  games: [],
  settings: {},
  filter: 'all',
  query: '',
  sort: 'name',
  selectedId: null,
  editingId: null,
  scanResults: [],
};

// ---------- Helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

function formatPlaytime(min) {
  if (!min || min < 1) return 'Never tracked';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 10 ? `${h.toFixed(1)} hrs` : `${Math.round(h)} hrs`;
}

function formatAgo(ts) {
  if (!ts) return 'Never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return d === 1 ? 'Yesterday' : `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}

// Deterministic color pair for games with no artwork.
function gradientFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(160deg, hsl(${h} 55% 32%), hsl(${(h + 50) % 360} 60% 16%))`;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2500);
}

const SOURCE_LABEL = { steam: 'Steam', epic: 'Epic', custom: 'PC' };

// ---------- Data ----------
// Coalesce bursts of refresh requests (e.g. many covers arriving) into one.
let refreshing = null;
let refreshAgain = false;
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const { games, settings } = await api.getLibrary();
      state.games = games;
      state.settings = settings;
      applyAppearance();
      render();
    } while (refreshAgain);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

// ---------- Appearance ----------
const ACCENTS = ['#7c5cff', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4'];

function lighten(hex, amt = 0.25) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * amt));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function setting(key, fallback) {
  const v = state.settings[key];
  return v === undefined ? fallback : v;
}

function applyAppearance() {
  const root = document.documentElement.style;
  const accent = setting('accent', ACCENTS[0]);
  root.setProperty('--accent', accent);
  root.setProperty('--accent-2', lighten(accent));
  root.setProperty('--card-min', `${setting('cardSize', 160)}px`);
  document.body.classList.toggle('no-anim', !setting('animations', true));
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function visibleGames() {
  const q = state.query.trim().toLowerCase();
  let list = state.games.filter((g) => (state.filter === 'hidden' ? g.hidden : !g.hidden));
  switch (state.filter) {
    case 'favorites': list = list.filter((g) => g.favorite); break;
    case 'recent': list = list.filter((g) => g.lastPlayed); break;
    case 'steam': case 'epic': case 'custom': list = list.filter((g) => g.source === state.filter); break;
  }
  if (q) list = list.filter((g) => g.name.toLowerCase().includes(q));

  const sort = state.filter === 'recent' ? 'recent' : state.sort;
  const byName = (a, b) => collator.compare(a.name, b.name);
  const cmp = {
    name: byName,
    recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b),
    playtime: (a, b) => (b.playtimeMinutes || 0) - (a.playtimeMinutes || 0) || byName(a, b),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  }[sort];
  return list.sort(cmp);
}

// ---------- Rendering ----------
const loadedImages = new Set();
const cardCache = new Map(); // id -> { sig, node }

// Everything that changes how a card looks. If it's unchanged, the existing
// DOM node (and its already-decoded image) is reused — no flicker.
function cardSig(g) {
  return [g.name, g.cover, g.icon, g.source, g.running, g.favorite, formatAgo(g.lastPlayed)].join('|');
}

function cardFor(g) {
  const sig = cardSig(g);
  const hit = cardCache.get(g.id);
  if (hit && hit.sig === sig) return hit.node;
  const node = gameCard(g);
  cardCache.set(g.id, { sig, node });
  return node;
}

// Reorder/insert/remove only what changed instead of rebuilding the grid.
function reconcile(container, nodes) {
  let i = 0;
  for (const node of nodes) {
    const at = container.children[i];
    if (at !== node) container.insertBefore(node, at || null);
    i++;
  }
  while (container.children.length > nodes.length) container.lastElementChild.remove();
}
function coverNode(g) {
  const box = el('div', { class: 'cover' });
  box.style.background = gradientFor(g.name);
  const fallback = () => {
    box.style.background = gradientFor(g.name);
    box.append(el('div', { class: 'fallback' }, g.icon ? el('img', { src: g.icon, alt: '' }) : null, g.name));
  };
  if (g.cover) {
    const img = el('img', { class: 'art', src: g.cover, alt: '', loading: 'lazy', decoding: 'async' });
    if (loadedImages.has(g.cover)) img.classList.add('loaded'); // no fade for images already seen
    img.addEventListener('load', () => {
      loadedImages.add(g.cover);
      img.classList.add('loaded');
    });
    img.addEventListener('error', () => {
      img.remove();
      fallback();
      reportBrokenArt(g.id);
    });
    box.append(img);
  } else {
    fallback();
  }
  box.append(el('div', { class: 'badge' }, SOURCE_LABEL[g.source] || 'PC'));
  if (g.running) box.append(el('div', { class: 'badge running' }, 'Playing'));
  if (g.favorite) box.append(el('div', { class: 'fav' }, '★'));
  box.append(el('div', { class: 'play-overlay' }, el('span', {}, '▶')));
  return box;
}

function gameCard(g) {
  const card = el('div', {
    class: 'card',
    tabindex: 0,
    title: g.name,
  });
  const cover = coverNode(g);
  cover.querySelector('.play-overlay span').addEventListener('click', (e) => {
    e.stopPropagation();
    launch(g.id);
  });
  card.append(
    cover,
    el('div', { class: 'card-name' }, g.name),
    el('div', { class: 'card-meta' }, g.lastPlayed ? `Played ${formatAgo(g.lastPlayed)}` : 'Not played yet')
  );
  card.dataset.id = g.id;
  card.addEventListener('click', () => select(g.id));
  card.addEventListener('dblclick', () => launch(g.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') launch(g.id);
  });
  return card;
}

function renderCounts() {
  const shown = state.games.filter((g) => !g.hidden);
  const counts = {
    all: shown.length,
    favorites: shown.filter((g) => g.favorite).length,
    steam: shown.filter((g) => g.source === 'steam').length,
    epic: shown.filter((g) => g.source === 'epic').length,
    custom: shown.filter((g) => g.source === 'custom').length,
    hidden: state.games.filter((g) => g.hidden).length,
  };
  for (const [k, v] of Object.entries(counts)) {
    const n = $(`#c-${k}`);
    if (n) n.textContent = v || '';
  }
}

let continueSig = '';
function renderContinue() {
  const sec = $('#continue');
  const recent = state.games
    .filter((g) => g.lastPlayed && !g.hidden)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, 4);
  const show = setting('showContinue', true) && state.filter === 'all' && !state.query && recent.length > 0;
  sec.classList.toggle('hidden', !show);
  if (!show) return;
  const sig = recent.map((g) => [g.id, g.name, g.cover, g.steamAppId, formatAgo(g.lastPlayed), Math.round(g.playtimeMinutes || 0)].join(',')).join('|');
  if (sig === continueSig) return;
  continueSig = sig;
  sec.replaceChildren(
    el('h3', {}, 'Continue playing'),
    el('div', { class: 'continue-row' }, recent.map((g) => {
      const hero = el('div', { class: 'hero', title: `Play ${g.name}` },
        el('div', { class: 'hero-info' },
          el('div', { class: 'hero-name' }, g.name),
          el('div', { class: 'hero-meta' }, `${formatAgo(g.lastPlayed)} · ${formatPlaytime(g.playtimeMinutes)}`)
        )
      );
      // Steam has a wide header image that suits this row better than the tall cover.
      const steamId = g.steamAppId || (g.source === 'steam' ? g.sourceId : '');
      const wide = steamId
        ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`
        : g.cover;
      hero.style.background = wide ? `url("${wide}") center/cover no-repeat, ${gradientFor(g.name)}` : gradientFor(g.name);
      hero.addEventListener('click', () => launch(g.id));
      return hero;
    }))
  );
}

const noMatch = el('p', { class: 'muted no-match' }, 'No games match.');

function render({ animate = false } = {}) {
  renderCounts();
  renderContinue();
  const list = visibleGames();
  const grid = $('#grid');
  const nodes = list.map(cardFor);
  const libraryEmpty = state.games.length === 0;
  if (!libraryEmpty && list.length === 0) nodes.push(noMatch);
  reconcile(grid, nodes);
  for (const node of nodes) node.classList.toggle('selected', node.dataset.id === state.selectedId);
  // Drop cached cards for games that were removed.
  const ids = new Set(state.games.map((g) => g.id));
  for (const id of cardCache.keys()) if (!ids.has(id)) cardCache.delete(id);

  if (animate) {
    grid.classList.remove('swap');
    void grid.offsetWidth; // restart the animation
    grid.classList.add('swap');
  }
  $('#empty').classList.toggle('hidden', !libraryEmpty);
  renderDetail();
}

let detailSig = '';
function renderDetail() {
  const panel = $('#detail');
  const g = state.games.find((x) => x.id === state.selectedId);
  panel.classList.toggle('open', !!g);
  $('.app').classList.toggle('panel-open', !!g);
  if (!g) {
    detailSig = '';
    return;
  }
  const sig = [g.id, g.name, g.cover, g.icon, g.running, g.favorite, g.hidden, g.target, g.args, g.type,
    Math.round(g.playtimeMinutes || 0), formatAgo(g.lastPlayed)].join('|');
  if (sig === detailSig) return;
  detailSig = sig;

  const art = el('div', { class: 'detail-art' });
  art.style.background = g.cover
    ? `url("${g.cover}") center/cover no-repeat, ${gradientFor(g.name)}`
    : gradientFor(g.name);
  if (!g.cover && g.icon) art.append(el('img', { class: 'icon', src: g.icon, alt: '' }));
  art.append(el('button', { class: 'detail-close', title: 'Close', onclick: () => select(null) }, '✕'));

  const playBtn = el('button', { class: 'btn play', onclick: () => launch(g.id) }, g.running ? 'Running' : '▶  Play');
  if (g.running) playBtn.disabled = true;

  panel.replaceChildren(
    art,
    el('div', { class: 'detail-body' },
      el('h2', {}, g.name),
      playBtn,
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('small', {}, 'Play time'), el('b', {}, formatPlaytime(g.playtimeMinutes))),
        el('div', { class: 'stat' }, el('small', {}, 'Last played'), el('b', {}, formatAgo(g.lastPlayed)))
      ),
      el('div', { class: 'target' }, g.target + (g.args ? `  ${g.args}` : '')),
      g.type === 'url' && g.source !== 'custom'
        ? el('div', { class: 'muted', style: 'font-size:12px' }, `Launches through ${SOURCE_LABEL[g.source]}. Play time is tracked by that app.`)
        : null,
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn', onclick: () => toggle(g, 'favorite') }, g.favorite ? '★ Unfavorite' : '☆ Favorite'),
        el('button', { class: 'btn', onclick: () => openEditor(g) }, 'Edit'),
        el('button', { class: 'btn', onclick: () => findArt(g) }, g.cover ? 'New cover' : 'Find cover'),
        g.type !== 'url' ? el('button', { class: 'btn', onclick: () => api.openFolder(g.id) }, 'Open folder') : null,
        el('button', { class: 'btn', onclick: () => toggle(g, 'hidden') }, g.hidden ? 'Unhide' : 'Hide'),
        el('button', { class: 'btn danger', onclick: () => removeGame(g) }, 'Remove')
      )
    )
  );
}

// ---------- Cover art ----------
const reportedBroken = new Set();
function reportBrokenArt(id) {
  if (reportedBroken.has(id)) return;
  reportedBroken.add(id);
  api.artBroken(id);
}

async function findArt(g) {
  toast(`Looking for cover art for ${g.name}…`);
  const before = g.cover;
  whenArtDone(() => {
    const now = state.games.find((x) => x.id === g.id);
    if (now && now.cover && now.cover !== before) toast(`Found cover art for ${g.name}`);
    else toast(`No cover art found for ${g.name}. You can pick one with Edit.`);
  });
  await api.findArt(g.id);
}

// The main process pushes how many lookups are left.
let artDoneCallbacks = [];
function whenArtDone(cb) {
  artDoneCallbacks.push(cb);
}
api.onArtProgress(async (pending) => {
  const status = $('#art-status');
  status.classList.toggle('hidden', pending === 0);
  status.textContent = `Finding cover art… (${pending} left)`;
  if (pending === 0 && artDoneCallbacks.length) {
    await refresh();
    const cbs = artDoneCallbacks;
    artDoneCallbacks = [];
    cbs.forEach((cb) => cb());
  }
});

// ---------- Actions ----------
function select(id) {
  state.selectedId = state.selectedId === id ? null : id;
  render();
}

function savePrefs() {
  api.setSettings({ lastFilter: state.filter, sort: state.sort });
}

async function launch(id) {
  const g = state.games.find((x) => x.id === id);
  if (!g) return;
  if (g.running) return toast(`${g.name} is already running`);
  toast(`Launching ${g.name}…`);
  const res = await api.launch(id);
  if (!res.ok) toast(`Couldn't launch ${g.name}\n${res.error}`, true);
  await refresh();
}

async function toggle(g, key) {
  await api.updateGame(g.id, { [key]: !g[key] });
  await refresh();
}

async function removeGame(g) {
  if (!confirm(`Remove "${g.name}" from your library?\n(This does not uninstall the game.)`)) return;
  await api.removeGame(g.id);
  state.selectedId = null;
  await refresh();
  toast(`Removed ${g.name}`);
}

// ---------- Add / edit dialog ----------
const addForm = $('#form-add');
// form.name / form.target are built-in form properties, so read fields via .elements.
const F = addForm.elements;

function openEditor(g = null) {
  state.editingId = g ? g.id : null;
  $('#dlg-add-title').textContent = g ? 'Edit game' : 'Add a game';
  addForm.reset();
  if (g) {
    F.target.value = g.target;
    F.name.value = g.name;
    F.args.value = g.args || '';
    F.cover.value = g.cover || '';
  }
  $('#dlg-add').showModal();
}

$('#btn-browse').addEventListener('click', async () => {
  const pick = await api.pickGame();
  if (!pick) return;
  F.target.value = pick.target;
  if (!F.name.value) F.name.value = pick.name;
});

$('#btn-cover').addEventListener('click', async () => {
  const url = await api.pickImage();
  if (url) F.cover.value = url;
});

$('#btn-add-cancel').addEventListener('click', () => $('#dlg-add').close());

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = F.target.value.trim().replace(/^"|"$/g, '');
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^file:/i.test(target);
  const data = {
    name: F.name.value.trim(),
    target,
    type: isUrl ? 'url' : 'exe',
    args: F.args.value.trim(),
    cover: F.cover.value.trim(),
  };
  if (!isUrl) data.icon = (await api.fileIcon(target)) || '';

  if (state.editingId) {
    await api.updateGame(state.editingId, data);
    toast('Saved');
  } else {
    const g = await api.addGame({ ...data, source: 'custom' });
    state.selectedId = g.id;
    toast(`Added ${g.name}`);
  }
  $('#dlg-add').close();
  await refresh();
});

// ---------- Scan dialog ----------
async function runScan() {
  const btn = $('#btn-scan');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const { found, fresh } = await api.scan();
    if (found === 0) return toast('No Steam or Epic games found on this PC.');
    if (fresh.length === 0) return toast(`All ${found} detected games are already in your library.`);
    state.scanResults = fresh.sort((a, b) => a.name.localeCompare(b.name));
    $('#scan-summary').textContent = `${fresh.length} new game${fresh.length === 1 ? '' : 's'} found. Untick any you don't want.`;
    $('#scan-list').replaceChildren(...state.scanResults.map((g, i) =>
      el('label', { class: 'scan-item' },
        el('input', { type: 'checkbox', checked: true, 'data-i': i }),
        g.name,
        el('span', { class: 'src' }, SOURCE_LABEL[g.source])
      )
    ));
    $('#dlg-scan').showModal();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan for games';
  }
}

$('#btn-scan-cancel').addEventListener('click', () => $('#dlg-scan').close());

$('#form-scan').addEventListener('submit', async (e) => {
  e.preventDefault();
  const picked = [...document.querySelectorAll('#scan-list input:checked')].map((c) => state.scanResults[c.dataset.i]);
  for (const g of picked) {
    const icon = g.iconFrom ? (await api.fileIcon(g.iconFrom)) || '' : '';
    await api.addGame({ ...g, icon });
  }
  $('#dlg-scan').close();
  await refresh();
  toast(`Added ${picked.length} game${picked.length === 1 ? '' : 's'}`);
});

// ---------- Wiring ----------
document.querySelectorAll('.nav-item[data-filter]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    if (state.filter === b.dataset.filter) return;
    state.filter = b.dataset.filter;
    render({ animate: true });
    savePrefs();
  })
);

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    render();
  }, 60);
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render({ animate: true });
  savePrefs();
});
$('#btn-add').addEventListener('click', () => openEditor());
$('#btn-scan').addEventListener('click', runScan);
$('#empty [data-action="add"]').addEventListener('click', () => openEditor());
$('#empty [data-action="scan"]').addEventListener('click', runScan);
// ---------- Settings ----------
const settingInputs = document.querySelectorAll('#dlg-settings [data-setting]');

function fillSettings() {
  for (const input of settingInputs) {
    const key = input.dataset.setting;
    const def = input.dataset.default === 'true';
    if (input.type === 'checkbox') input.checked = !!setting(key, def);
    else input.value = setting(key, input.id === 'opt-cardsize' ? 160 : '');
  }
  $('#opt-sgdb').value = state.settings.sgdbKey || '';
  $('#swatches').replaceChildren(...ACCENTS.map((c) =>
    el('button', {
      type: 'button',
      class: 'swatch' + (c === setting('accent', ACCENTS[0]) ? ' active' : ''),
      style: `background:${c}`,
      title: c,
      onclick: () => changeSetting({ accent: c }).then(fillSettings),
    })
  ));
  $('#row-startmin').classList.toggle('disabled', !setting('startWithWindows', false));
}

async function changeSetting(patch) {
  Object.assign(state.settings, patch); // apply instantly, save in background
  applyAppearance();
  continueSig = '';
  render();
  state.settings = await api.setSettings(patch);
}

for (const input of settingInputs) {
  const key = input.dataset.setting;
  if (input.type === 'checkbox') {
    input.addEventListener('change', () => {
      changeSetting({ [key]: input.checked });
      if (key === 'startWithWindows') $('#row-startmin').classList.toggle('disabled', !input.checked);
    });
  } else {
    // Live preview while dragging the slider.
    input.addEventListener('input', () => {
      document.documentElement.style.setProperty('--card-min', `${input.value}px`);
    });
    input.addEventListener('change', () => changeSetting({ [key]: Number(input.value) }));
  }
}

$('#btn-settings').addEventListener('click', async () => {
  const info = await api.appInfo();
  $('#app-version').textContent = `Version ${info.version}`;
  $('#row-autostart').classList.toggle('disabled', !info.canAutoStart);
  fillSettings();
  if (!info.canAutoStart) $('#row-startmin').classList.add('disabled');
  $('#dlg-settings').showModal();
});
$('#opt-sgdb').addEventListener('change', (e) => changeSetting({ sgdbKey: e.target.value.trim() }));
$('#btn-find-missing').addEventListener('click', async () => {
  const before = state.games.filter((g) => !g.cover).length;
  if (!before) return toast('Every game already has a cover.');
  toast(`Looking for covers for ${before} game${before === 1 ? '' : 's'}…`);
  $('#dlg-settings').close();
  whenArtDone(() => {
    const still = state.games.filter((g) => !g.cover).length;
    toast(still ? `Done. ${before - still} found, ${still} still without a cover.` : 'Done. All covers found.');
  });
  await api.findMissingArt();
});
$('#btn-export').addEventListener('click', async () => {
  const file = await api.exportData();
  if (file) toast(`Library backed up to\n${file}`);
});
$('#btn-import').addEventListener('click', async () => {
  const r = await api.importData();
  if (!r) return;
  if (r.error) return toast(r.error, true);
  await refresh();
  toast(`Restored ${r.total} game${r.total === 1 ? '' : 's'} (${r.added} new)`);
});
$('#btn-datafolder').addEventListener('click', () => api.openDataFolder());

api.onAutoScan((names) =>
  toast(names.length === 1 ? `New game added: ${names[0]}` : `${names.length} new games added`)
);
api.onMaximized((max) => {
  $('[data-win="max"]').innerHTML = max ? '&#x2750;' : '&#x25A2;';
  $('[data-win="max"]').title = max ? 'Restore' : 'Maximize';
});

document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => api.windowControl(b.dataset.win)));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selectedId && !document.querySelector('dialog[open]')) select(null);
  if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && document.activeElement.tagName !== 'INPUT')) {
    e.preventDefault();
    $('#search').focus();
  }
});

// Allow dragging an .exe/.lnk straight onto the window to add it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = window.launcher.pathForFile ? window.launcher.pathForFile(f) : f.path;
  if (!p) return;
  openEditor();
  F.target.value = p;
  F.name.value = p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ');
});

api.onChanged(refresh);
(async () => {
  const { games, settings } = await api.getLibrary();
  state.games = games;
  state.settings = settings;
  // Restore where you left off.
  state.filter = settings.lastFilter || 'all';
  state.sort = settings.sort || 'name';
  $('#sort').value = state.sort;
  document.querySelectorAll('.nav-item[data-filter]').forEach((x) =>
    x.classList.toggle('active', x.dataset.filter === state.filter)
  );
  applyAppearance();
  render(); // first paint straight from the initial load, no second round-trip
})();
