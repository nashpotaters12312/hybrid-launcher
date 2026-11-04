// Extra features on top of app.js: collections, notes, the right-click menu,
// the Stats page, list/grid switching, keyboard navigation, desktop shortcuts.
// (Classic scripts share top-level names, so app.js helpers are usable here.)

let isWindows = navigator.userAgent.includes('Windows');
api.platform().then((p) => {
  isWindows = p === 'win32';
});

// ---------- Small text prompt (window.prompt isn't available in Electron) ----------
function askText(title, initial = '', okLabel = 'Save') {
  const dlg = $('#dlg-ask');
  if (dlg.open) return Promise.resolve(null);
  $('#ask-title').textContent = title;
  $('#btn-ask-ok').textContent = okLabel;
  const input = $('#ask-input');
  input.value = initial;
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    const done = (value) => {
      cleanup();
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) done(v);
    };
    const onCancel = () => done(null);
    const cleanup = () => {
      $('#form-ask').removeEventListener('submit', onSubmit);
      $('#btn-ask-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
    };
    $('#form-ask').addEventListener('submit', onSubmit);
    $('#btn-ask-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
  });
}

// ---------- Collections ----------
function renderCollectionsNav() {
  const nav = $('#collections-nav');
  const counts = new Map();
  for (const g of state.games) {
    if (g.hidden) continue;
    for (const c of g.collections || []) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const sig = state.collections.map((c) => `${c}:${counts.get(c) || 0}`).join('|') + '#' + state.filter;
  if (nav.dataset.sig === sig) return;
  nav.dataset.sig = sig;
  nav.replaceChildren(
    ...state.collections.map((c) => {
      const b = el('button', { class: 'nav-item' + (state.filter === `col:${c}` ? ' active' : ''), title: c },
        el('span', { class: 'nav-label' }, c),
        el('span', { class: 'count' }, counts.get(c) || '')
      );
      b.dataset.filter = `col:${c}`;
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Rename…', action: () => renameCollection(c) },
          { label: 'Delete collection', danger: true, action: () => deleteCollection(c) },
        ]);
      });
      return b;
    }),
    ...(state.collections.length ? [] : [el('div', { class: 'nav-hint' }, 'Group games like "Co-op" or "Backlog".')])
  );
}

async function newCollection(addGame = null) {
  const name = await askText('New collection', '', 'Create');
  if (!name) return;
  const r = await api.addCollection(name);
  if (r.error) return toast(r.error, true);
  if (addGame) await api.updateGame(addGame.id, { collections: [...(addGame.collections || []), r.name] });
  await refresh();
  toast(addGame ? `Added ${addGame.name} to ${r.name}` : `Created ${r.name}`);
}

async function renameCollection(from) {
  const to = await askText('Rename collection', from);
  if (!to || to === from) return;
  const r = await api.renameCollection(from, to);
  if (r.error) return toast(r.error, true);
  if (state.filter === `col:${from}`) state.filter = `col:${r.name}`;
  await refresh();
  savePrefs();
}

async function deleteCollection(name) {
  if (!confirm(`Delete the collection "${name}"?\n(Your games stay in your library.)`)) return;
  await api.deleteCollection(name);
  if (state.filter === `col:${name}`) setFilter('all');
  await refresh();
}

async function toggleCollection(g, name) {
  const cur = g.collections || [];
  const next = cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name];
  await api.updateGame(g.id, { collections: next });
  await refresh();
}

$('#btn-new-collection').addEventListener('click', () => newCollection());

// ---------- Notes ----------
function notesBox(g) {
  const box = el('textarea', {
    id: 'notes',
    class: 'notes',
    rows: 4,
    placeholder: 'Save locations, controls, where you left off…',
    spellcheck: 'true',
  });
  box.value = g.notes || '';
  let t;
  const save = () => {
    clearTimeout(t);
    if ((g.notes || '') === box.value) return;
    g.notes = box.value;
    api.updateGame(g.id, { notes: box.value });
  };
  box.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(save, 600);
  });
  box.addEventListener('blur', save);
  return box;
}

// ---------- Desktop shortcut ----------
async function createShortcut(g) {
  const r = await api.createShortcut(g.id);
  if (r.error) toast(r.error, true);
  else toast(`Shortcut for ${g.name} added to your desktop`);
}

// ---------- Right-click menu ----------
const ctx = $('#ctx');

function closeMenu() {
  if (ctx.hidden) return;
  ctx.hidden = true;
  ctx.replaceChildren();
  ctx._returnFocus?.focus?.();
}

function openMenu(x, y, items, returnFocus = null) {
  ctx.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { class: 'ctx-sep', role: 'separator' });
    if (it.header) return el('div', { class: 'ctx-head' }, it.header);
    const b = el('button', { class: 'ctx-item' + (it.danger ? ' danger' : ''), role: 'menuitem' },
      el('span', { class: 'ctx-check' }, it.checked ? '✓' : ''),
      it.label
    );
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    return b;
  }));
  ctx._returnFocus = returnFocus;
  ctx.hidden = false;
  // Keep the menu on screen.
  const { innerWidth: W, innerHeight: H } = window;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.max(4, Math.min(x, W - r.width - 4))}px`;
  ctx.style.top = `${Math.max(4, Math.min(y, H - r.height - 4))}px`;
  ctx.querySelector('.ctx-item')?.focus();
}

function gameMenuItems(g) {
  return [
    g.running
      ? { label: 'Stop', danger: true, action: () => stopGame(g) }
      : { label: 'Play', action: () => launch(g.id) },
    { label: 'Details', action: () => { state.selectedId = null; select(g.id); } },
    '-',
    { label: g.favorite ? 'Remove from favorites' : 'Add to favorites', action: () => toggle(g, 'favorite') },
    { header: 'Collections' },
    ...state.collections.map((c) => ({
      label: c,
      checked: g.collections?.includes(c),
      action: () => toggleCollection(g, c),
    })),
    { label: 'New collection…', action: () => newCollection(g) },
    '-',
    { label: 'Edit…', action: () => openEditor(g) },
    { label: g.cover ? 'Find a new cover' : 'Find cover', action: () => findArt(g) },
    ...(g.type !== 'url' ? [{ label: 'Open folder', action: () => api.openFolder(g.id) }] : []),
    ...(isWindows ? [{ label: 'Create desktop shortcut', action: () => createShortcut(g) }] : []),
    '-',
    { label: g.hidden ? 'Unhide' : 'Hide', action: () => toggle(g, 'hidden') },
    { label: 'Remove from library', danger: true, action: () => removeGame(g) },
  ];
}

$('#grid').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  e.preventDefault();
  const g = state.games.find((x) => x.id === card.dataset.id);
  if (g) openMenu(e.clientX, e.clientY, gameMenuItems(g), card);
});

document.addEventListener('mousedown', (e) => {
  if (!ctx.hidden && !ctx.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
$('.content').addEventListener('scroll', closeMenu, { passive: true });
ctx.addEventListener('keydown', (e) => {
  const items = [...ctx.querySelectorAll('.ctx-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = items.length;
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
  }
});

// ---------- Grid / list toggle ----------
$('#view-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b || state.view === b.dataset.view) return;
  state.view = b.dataset.view;
  document.querySelectorAll('#view-toggle .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  render({ animate: true });
  savePrefs();
});

// ---------- Keyboard navigation ----------
// Arrow keys move between games, Enter plays, Space opens details,
// F favorites, and the Menu key (or Shift+F10) opens the right-click menu.
function gridItems() {
  return [...$('#grid').querySelectorAll('.card[data-id]')];
}

function moveFocus(from, key) {
  const items = gridItems();
  if (!items.length) return;
  const i = items.indexOf(from);
  if (i < 0) return items[0].focus();
  if (key === 'ArrowLeft') return items[Math.max(0, i - 1)].focus();
  if (key === 'ArrowRight') return items[Math.min(items.length - 1, i + 1)].focus();
  // Up/down: nearest item in the previous/next visual row.
  const a = from.getBoundingClientRect();
  const down = key === 'ArrowDown';
  let best = null;
  let bestScore = Infinity;
  for (const it of items) {
    const b = it.getBoundingClientRect();
    const dy = down ? b.top - a.top : a.top - b.top;
    if (dy <= 4) continue;
    const score = dy * 1000 + Math.abs(b.left - a.left);
    if (score < bestScore) {
      best = it;
      bestScore = score;
    }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', behavior: setting('animations', true) ? 'smooth' : 'auto' });
  }
}

$('#grid').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card || e.target !== card) return;
  const g = state.games.find((x) => x.id === card.dataset.id);
  if (!g) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    moveFocus(card, e.key);
  } else if (e.key === ' ') {
    e.preventDefault();
    select(g.id);
  } else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggle(g, 'favorite');
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const r = card.getBoundingClientRect();
    openMenu(r.left + 20, r.top + 40, gameMenuItems(g), card);
  }
});

// Arrow Down from the search box jumps into the games.
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    gridItems()[0]?.focus();
  }
});

// ---------- Stats ----------
const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const hrs = (min) => (min >= 60 ? `${(min / 60).toFixed(min >= 600 ? 0 : 1)} hrs` : `${Math.round(min)} min`);

let statsSeq = 0;
async function renderStats() {
  const seq = ++statsSeq;
  let sessions = await api.sessions();
  if (seq !== statsSeq || state.filter !== 'stats') return; // a newer render won

  const games = state.games.filter((g) => !g.hidden);
  const known = new Set(state.games.map((g) => g.id));
  sessions = sessions.filter((s) => known.has(s.id)); // ignore removed games
  const now = Date.now();
  const totalMin = games.reduce((s, g) => s + (g.playtimeMinutes || 0), 0);
  const weekStart = startOfDay(now) - 6 * DAY_MS;
  const weekMin = sessions.filter((s) => s.start >= weekStart).reduce((t, s) => t + s.minutes, 0);
  const playedThisWeek = new Set(games.filter((g) => g.lastPlayed >= weekStart).map((g) => g.id)).size;
  const never = games.filter((g) => !g.lastPlayed).length;

  const tile = (label, value, sub) =>
    el('div', { class: 'tile' }, el('small', {}, label), el('b', {}, value), sub ? el('span', {}, sub) : null);

  // Daily play time, last 14 days (each session counted on the day it started).
  const today = startOfDay(now);
  const days = Array.from({ length: 14 }, (_, i) => ({ day: today - (13 - i) * DAY_MS, min: 0 }));
  for (const s of sessions) {
    const d = days.find((x) => x.day === startOfDay(s.start));
    if (d) d.min += s.minutes;
  }
  const maxDay = Math.max(...days.map((d) => d.min));
  const fmtDay = (t, opts) => new Date(t).toLocaleDateString(undefined, opts);

  const daily = maxDay > 0
    ? el('div', { class: 'cols', role: 'img', 'aria-label': 'Play time per day for the last 14 days' },
        el('div', { class: 'cols-grid' }, el('span', {}, hrs(maxDay)), el('span', {}, '0')),
        ...days.map((d) => el('div', {
          class: 'col',
          'data-tip': `${fmtDay(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.min ? hrs(d.min) : 'not played'}`,
        },
          el('div', { class: 'col-bar', style: `height:${d.min ? Math.max(2, (d.min / maxDay) * 100) : 0}%` }),
          el('div', { class: 'col-label' }, fmtDay(d.day, { weekday: 'narrow' }))
        ))
      )
    : el('p', { class: 'muted empty-chart' }, 'Play a game from the launcher and your daily play time shows up here.');

  // Horizontal bar list (one hue: these are magnitudes, not categories).
  const barList = (rows, fmt, empty) => rows.length
    ? el('div', { class: 'bars' }, ...rows.map((r) => el('div', { class: 'bar-row', 'data-tip': `${r.label}: ${fmt(r.value)}` },
        el('div', { class: 'bar-label', title: r.label }, r.label),
        el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `width:${Math.max(1.5, (r.value / rows[0].value) * 100)}%` })),
        el('div', { class: 'bar-value' }, fmt(r.value))
      )))
    : el('p', { class: 'muted empty-chart' }, empty);

  const top = games.filter((g) => g.playtimeMinutes >= 1)
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes).slice(0, 10)
    .map((g) => ({ label: g.name, value: g.playtimeMinutes }));

  const bySource = Object.entries(SOURCE_LABEL)
    .map(([k, label]) => ({ label: k === 'custom' ? 'My games' : label, value: games.filter((g) => g.source === k).length }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  $('#stats').replaceChildren(
    el('h2', { class: 'stats-title' }, 'Your stats'),
    el('div', { class: 'tiles' },
      tile('Games', String(games.length), `${state.games.length - games.length ? `${state.games.length - games.length} hidden` : 'in your library'}`),
      tile('Total play time', totalMin >= 1 ? hrs(totalMin) : '—', 'tracked by the launcher'),
      tile('This week', weekMin >= 1 ? hrs(weekMin) : '—', `${playedThisWeek} game${playedThisWeek === 1 ? '' : 's'} played`),
      tile('Never played', String(never), games.length ? `${Math.round((never / games.length) * 100)}% of your library` : '')
    ),
    el('div', { class: 'panels' },
      el('section', { class: 'panel wide' }, el('h3', {}, 'Play time, last 14 days'), daily),
      el('section', { class: 'panel' }, el('h3', {}, 'Most played'),
        barList(top, hrs, 'No play time tracked yet.')),
      el('section', { class: 'panel' }, el('h3', {}, 'Library by store'),
        barList(bySource, (v) => `${v} game${v === 1 ? '' : 's'}`, 'Your library is empty.'))
    ),
    el('p', { class: 'muted small stats-note' },
      'Play time is tracked for games started from the launcher with their own .exe (including Epic games). Steam games launched through Steam aren\'t tracked here.')
  );
}

// Hover tooltip for the charts.
const tip = el('div', { class: 'chart-tip', role: 'tooltip' });
tip.hidden = true;
document.body.append(tip);
$('#stats').addEventListener('mousemove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) {
    tip.hidden = true;
    return;
  }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
});
$('#stats').addEventListener('mouseleave', () => {
  tip.hidden = true;
});

// ---------- Messages from the main process ----------
api.onPickRequest(() => {
  if (!document.querySelector('dialog[open]')) openPicker();
});
api.onErrorToast((msg) => toast(msg, true));

// ---------- Updates ----------
let update = { state: 'idle' };

function updateLine(s) {
  switch (s.state) {
    case 'dev': return 'Updates work in the installed app.';
    case 'checking': return 'Checking for updates…';
    case 'none': return "You're up to date.";
    case 'available': return `Version ${s.version} is available.`;
    case 'downloading': return `Downloading version ${s.version}… ${s.percent || 0}%`;
    case 'ready': return `Version ${s.version} is ready. Restart to update.`;
    case 'error': return s.message || "Couldn't check for updates.";
    default: return '';
  }
}

function renderUpdate(s) {
  const prev = update.state;
  update = s || { state: 'idle' };
  const btn = $('#btn-update');
  const show = ['available', 'downloading', 'ready'].includes(update.state);
  btn.hidden = !show;
  btn.disabled = update.state === 'downloading';
  btn.classList.toggle('ready', update.state === 'ready');
  btn.style.setProperty('--progress', `${update.percent || 0}%`);
  btn.textContent = update.state === 'ready'
    ? `⬆ Update to ${update.version}`
    : update.state === 'downloading'
      ? `Downloading… ${update.percent || 0}%`
      : `⬇ Get version ${update.version}`;
  btn.title = update.state === 'ready' ? 'Restart Hybrid Launcher and install the update' : '';
  $('#update-line').textContent = updateLine(update);
  const checkBtn = $('#btn-check-update');
  checkBtn.disabled = ['checking', 'downloading'].includes(update.state);
  checkBtn.textContent = update.state === 'ready' ? 'Restart to update' : 'Check for updates';
  if (update.state === 'ready' && prev !== 'ready') {
    toast(`Version ${update.version} is ready. Click Update in the sidebar to restart.`);
  }
}

async function runUpdateAction() {
  if (update.state === 'available') return api.downloadUpdate();
  if (update.state !== 'ready') return;
  const playing = state.games.filter((g) => g.running).map((g) => g.name);
  const note = playing.length ? `\n\n${playing.join(', ')} will keep running; play time so far is saved.` : '';
  if (!confirm(`Restart Hybrid Launcher to install version ${update.version}?${note}`)) return;
  api.installUpdate();
}

$('#btn-update').addEventListener('click', runUpdateAction);
$('#btn-check-update').addEventListener('click', async () => {
  if (update.state === 'ready') return runUpdateAction();
  renderUpdate(await api.checkForUpdates());
});
$('#btn-settings').addEventListener('click', async () => {
  const info = await api.appInfo();
  $('#update-version').textContent = `Hybrid Launcher ${info.version}`;
  renderUpdate(await api.updateStatus());
});
api.onUpdateStatus(renderUpdate);
api.updateStatus().then(renderUpdate);
