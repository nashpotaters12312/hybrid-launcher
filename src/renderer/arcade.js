// Arcade: three small original games for when you can't decide what to play.
//  - Cover Match: a memory game made from your own library's covers
//  - Orbit Dodge: circle the core and dodge debris flying outward
//  - Quick Draw: hit the target as fast as you can
// Best scores are stored in settings.arcadeBest.

const ARCADE_GAMES = [
  {
    id: 'match',
    title: 'Cover Match',
    blurb: 'Flip cards to find matching pairs, using covers from your own library.',
    how: 'Click two cards. Match all 8 pairs in as few moves as you can.',
    best: (v) => `${v} moves`,
    better: (a, b) => a < b,
    start: startCoverMatch,
  },
  {
    id: 'orbit',
    title: 'Orbit Dodge',
    blurb: 'Circle the core, dodge the debris and grab stars. It gets faster.',
    how: 'Move with ← → or A D (or the mouse). Stars are worth bonus points.',
    best: (v) => `${v} pts`,
    better: (a, b) => a > b,
    start: startOrbitDodge,
  },
  {
    id: 'draw',
    title: 'Quick Draw',
    blurb: 'Wait for the target, then click it as fast as you can. 5 rounds.',
    how: "Click the target the moment it appears. Clicking too early costs a round.",
    best: (v) => `${v} ms`,
    better: (a, b) => a < b,
    start: startQuickDraw,
  },
];

const arcade = { game: null, cleanup: null, session: 0 };

function arcadeBest(id) {
  return (state.settings.arcadeBest || {})[id];
}

// Saves a new best; returns true if it was a record.
function recordScore(id, value) {
  const def = ARCADE_GAMES.find((g) => g.id === id);
  const prev = arcadeBest(id);
  if (prev != null && !def.better(value, prev)) return false;
  const best = { ...(state.settings.arcadeBest || {}), [id]: value };
  state.settings.arcadeBest = best;
  api.setSettings({ arcadeBest: best });
  return true;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Arcade lobby ----------
let arcadeSig = '';
function renderArcade() {
  const sig = JSON.stringify(state.settings.arcadeBest || {});
  if (sig === arcadeSig && $('#arcade').childElementCount) return;
  arcadeSig = sig;
  const icon = {
    match: el('div', { class: 'arc-icon match' }, el('span'), el('span'), el('span'), el('span')),
    orbit: el('div', { class: 'arc-icon orbit' }, el('span', { class: 'core' }), el('span', { class: 'ship' })),
    draw: el('div', { class: 'arc-icon draw' }, el('span')),
  };
  $('#arcade').replaceChildren(
    el('div', { class: 'arcade-head' },
      el('h2', { class: 'stats-title' }, 'Arcade'),
      el('p', { class: 'muted' }, "Can't decide what to play? Warm up with a quick round, then let the launcher pick for you.")
    ),
    el('div', { class: 'arc-cards' }, ...ARCADE_GAMES.map((g) => {
      const best = arcadeBest(g.id);
      const card = el('button', { class: 'arc-card', 'data-game': g.id },
        icon[g.id],
        el('div', { class: 'arc-name' }, g.title),
        el('div', { class: 'arc-blurb' }, g.blurb),
        el('div', { class: 'arc-best' }, best != null ? `Best: ${g.best(best)}` : 'No best score yet'),
        el('span', { class: 'btn primary arc-play' }, '▶  Play')
      );
      card.addEventListener('click', () => openArcadeGame(g.id));
      return card;
    })),
    el('div', { class: 'arcade-foot' },
      el('button', { class: 'btn pick-btn', onclick: () => openPicker() }, '🎲 Done warming up? Pick a game for me')
    )
  );
}

// ---------- Stage ----------
function openArcadeGame(id) {
  closeArcadeGame();
  const def = ARCADE_GAMES.find((g) => g.id === id);
  arcade.game = def;
  $('#arcade-title').textContent = def.title;
  $('#arcade-hud').textContent = '';
  $('#arcade-stage').hidden = false;
  document.body.classList.add('arcade-open');
  const body = $('#arcade-body');
  body.replaceChildren();
  // Each game run gets its own session; late callbacks from an old run are ignored.
  const session = ++arcade.session;
  const live = () => session === arcade.session && !$('#arcade-stage').hidden;
  arcade.cleanup = def.start(body, (text) => {
    if (live()) $('#arcade-hud').textContent = text;
  }, (score, label) => {
    if (live()) showResult(def, score, label);
  });
}

function closeArcadeGame() {
  if (arcade.cleanup) arcade.cleanup();
  arcade.cleanup = null;
  arcade.game = null;
  arcade.session++;
  $('#arcade-stage').hidden = true;
  document.body.classList.remove('arcade-open');
  if (state.filter === 'arcade') renderArcade();
}

function showResult(def, score, label) {
  const record = recordScore(def.id, score);
  const best = arcadeBest(def.id);
  const panel = el('div', { class: 'arc-result' },
    el('div', { class: 'arc-result-title' }, record ? '🏆 New best!' : 'Nice round!'),
    el('div', { class: 'arc-result-score' }, label),
    el('div', { class: 'muted' }, `Best: ${def.best(best)}`),
    el('div', { class: 'arc-result-actions' },
      el('button', { class: 'btn primary', onclick: () => openArcadeGame(def.id) }, 'Play again'),
      el('button', { class: 'btn', onclick: closeArcadeGame }, 'Back to Arcade'),
      el('button', { class: 'btn pick-btn', onclick: () => { closeArcadeGame(); openPicker(); } }, '🎲 Pick a real game')
    )
  );
  $('#arcade-body').append(el('div', { class: 'arc-overlay' }, panel));
  panel.querySelector('.btn.primary').focus();
}

$('#btn-arcade-close').addEventListener('click', closeArcadeGame);

// While a game is open it owns the keyboard (capture phase, before app shortcuts).
window.addEventListener('keydown', (e) => {
  if ($('#arcade-stage').hidden) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeArcadeGame();
  }
  e.stopPropagation();
}, true);

// ---------- Cover Match ----------
function startCoverMatch(root, hud, finish) {
  // Prefer games with covers; fill up with the rest, then with plain tiles.
  const pool = [...state.games.filter((g) => !g.hidden && g.cover), ...state.games.filter((g) => !g.hidden && !g.cover)]
    .sort(() => Math.random() - 0.5)
    .slice(0, 8);
  const shapes = ['●', '▲', '■', '◆', '★', '✚', '⬟', '⬢'];
  const faces = Array.from({ length: 8 }, (_, i) => {
    const g = pool[i];
    return g ? { key: g.id, cover: g.cover, name: g.name } : { key: `s${i}`, cover: '', name: shapes[i] };
  });
  const deck = [...faces, ...faces].map((f, i) => ({ ...f, uid: i })).sort(() => Math.random() - 0.5);

  let open = [];
  let moves = 0;
  let matched = 0;
  let lock = false;
  const started = Date.now();
  const update = () => hud(`Moves: ${moves}   ·   Pairs: ${matched}/8`);
  update();

  const grid = el('div', { class: 'match-grid' });
  for (const card of deck) {
    const front = el('div', { class: 'match-face front' });
    if (card.cover) front.style.background = `${cssUrl(card.cover)} center/cover no-repeat, ${gradientFor(card.name)}`;
    else {
      front.style.background = gradientFor(card.name);
      front.textContent = card.name;
    }
    const tile = el('button', { class: 'match-card', 'aria-label': 'Hidden card' },
      el('div', { class: 'match-inner' }, el('div', { class: 'match-face back' }), front));
    tile.addEventListener('click', () => {
      if (lock || tile.classList.contains('flipped')) return;
      tile.classList.add('flipped');
      tile.setAttribute('aria-label', card.name);
      open.push({ tile, card });
      if (open.length < 2) return;
      moves++;
      const [a, b] = open;
      open = [];
      if (a.card.key === b.card.key) {
        matched++;
        a.tile.classList.add('done');
        b.tile.classList.add('done');
        update();
        if (matched === 8) {
          const secs = Math.round((Date.now() - started) / 1000);
          setTimeout(() => finish(moves, `${moves} moves · ${secs}s`), 450);
        }
      } else {
        update();
        lock = true;
        setTimeout(() => {
          a.tile.classList.remove('flipped');
          b.tile.classList.remove('flipped');
          a.tile.setAttribute('aria-label', 'Hidden card');
          b.tile.setAttribute('aria-label', 'Hidden card');
          lock = false;
        }, 750);
      }
    });
    grid.append(tile);
  }
  root.append(grid);
  grid.querySelector('.match-card').focus();
  return () => {};
}

// ---------- Orbit Dodge ----------
function startOrbitDodge(root, hud, finish) {
  const canvas = el('canvas', { class: 'orbit-canvas' });
  root.append(canvas);
  const ctx2d = canvas.getContext('2d');
  const accent = cssVar('--accent') || '#7c5cff';
  const text = cssVar('--text') || '#e8eaf0';
  const muted = cssVar('--muted') || '#8b92a5';
  const danger = cssVar('--danger') || '#ff5c7a';
  const star = '#ffcc4d';

  let W = 0;
  let H = 0;
  const resize = () => {
    const r = root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const keys = new Set();
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'a', 'd'].includes(k)) {
      e.preventDefault();
      if (e.type === 'keydown') keys.add(k);
      else keys.delete(k);
    }
  };
  // Capture phase: the Arcade's own key guard stops events from bubbling further.
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  let mouseAngle = null;
  const onMouse = (e) => {
    const r = canvas.getBoundingClientRect();
    mouseAngle = Math.atan2(e.clientY - r.top - H / 2, e.clientX - r.left - W / 2);
  };
  canvas.addEventListener('mousemove', onMouse);
  canvas.addEventListener('mouseleave', () => {
    mouseAngle = null;
  });

  const ship = { angle: -Math.PI / 2 };
  let things = []; // { angle, dist, speed, size, kind: 'rock'|'star' }
  let t = 0;
  let spawnIn = 0.6;
  let bonus = 0;
  let alive = true;
  let paused = false;
  let last = performance.now();
  let raf = 0;

  const ring = () => Math.min(W, H) * 0.33;
  const score = () => Math.floor(t * 10) + bonus;

  const onBlur = () => {
    paused = true;
  };
  const onFocus = () => {
    paused = false;
    last = performance.now();
  };
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);

  function angleDiff(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!alive || paused) return draw();
    t += dt;
    const speedUp = 1 + t / 25;

    // Steering
    const turn = 3.4 * dt;
    if (keys.has('arrowleft') || keys.has('a')) ship.angle -= turn;
    else if (keys.has('arrowright') || keys.has('d')) ship.angle += turn;
    else if (mouseAngle != null) {
      const d = angleDiff(mouseAngle, ship.angle);
      ship.angle += Math.max(-turn, Math.min(turn, d));
    }

    // Spawning: debris bursts outward from the core; sometimes a star.
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawnIn = Math.max(0.18, 0.75 / speedUp) * (0.6 + Math.random() * 0.8);
      const isStar = Math.random() < 0.12;
      things.push({
        angle: Math.random() * Math.PI * 2,
        dist: 18,
        speed: (isStar ? 70 : 90 + Math.random() * 70) * speedUp,
        size: isStar ? 8 : 6 + Math.random() * 7,
        kind: isStar ? 'star' : 'rock',
      });
    }

    const R = ring();
    const sx = Math.cos(ship.angle) * R;
    const sy = Math.sin(ship.angle) * R;
    for (const th of things) {
      th.dist += th.speed * dt;
      const x = Math.cos(th.angle) * th.dist;
      const y = Math.sin(th.angle) * th.dist;
      if (Math.hypot(x - sx, y - sy) < th.size + 9) {
        if (th.kind === 'star') {
          bonus += 50;
          th.dead = true;
        } else {
          alive = false;
          const s = score();
          setTimeout(() => finish(s, `${s} points · ${t.toFixed(1)}s survived`), 500);
        }
      }
    }
    things = things.filter((th) => !th.dead && th.dist < Math.hypot(W, H));
    hud(`Score: ${score()}`);
    draw();
  }

  function draw() {
    const R = ring();
    ctx2d.clearRect(0, 0, W, H);
    ctx2d.save();
    ctx2d.translate(W / 2, H / 2);
    // Orbit ring
    ctx2d.strokeStyle = muted;
    ctx2d.globalAlpha = 0.35;
    ctx2d.lineWidth = 2;
    ctx2d.setLineDash([4, 8]);
    ctx2d.beginPath();
    ctx2d.arc(0, 0, R, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    ctx2d.globalAlpha = 1;
    // Core (pulses)
    const pulse = 14 + Math.sin(t * 4) * 2;
    ctx2d.fillStyle = accent;
    ctx2d.beginPath();
    ctx2d.arc(0, 0, pulse, 0, Math.PI * 2);
    ctx2d.fill();
    // Debris and stars
    for (const th of things) {
      const x = Math.cos(th.angle) * th.dist;
      const y = Math.sin(th.angle) * th.dist;
      ctx2d.fillStyle = th.kind === 'star' ? star : text;
      ctx2d.globalAlpha = th.kind === 'star' ? 1 : 0.85;
      ctx2d.beginPath();
      if (th.kind === 'star') {
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? th.size * 0.45 : th.size;
          const a = (i * Math.PI) / 5 - Math.PI / 2;
          ctx2d.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
      } else {
        ctx2d.arc(x, y, th.size, 0, Math.PI * 2);
      }
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
    // Ship: a small arrowhead facing along the orbit
    const sx = Math.cos(ship.angle) * R;
    const sy = Math.sin(ship.angle) * R;
    ctx2d.save();
    ctx2d.translate(sx, sy);
    ctx2d.rotate(ship.angle + Math.PI / 2);
    ctx2d.fillStyle = alive ? accent : danger;
    ctx2d.beginPath();
    ctx2d.moveTo(0, -12);
    ctx2d.lineTo(9, 9);
    ctx2d.lineTo(0, 4);
    ctx2d.lineTo(-9, 9);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.restore();
    ctx2d.restore();
    if (paused && alive) {
      ctx2d.fillStyle = text;
      ctx2d.font = '600 18px "Segoe UI", system-ui, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('Paused: click to continue', W / 2, H / 2 + ring() + 40);
    }
  }

  canvas.addEventListener('click', onFocus);
  raf = requestAnimationFrame(step);
  canvas.tabIndex = 0;
  canvas.focus();

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
  };
}

// ---------- Quick Draw ----------
function startQuickDraw(root, hud, finish) {
  const ROUNDS = 5;
  const times = [];
  let timer = 0;
  let shownAt = 0;
  let phase = 'idle'; // idle | waiting | target
  const field = el('div', { class: 'draw-field', tabindex: 0 });
  const msg = el('div', { class: 'draw-msg' }, 'Click anywhere to start');
  const target = el('button', { class: 'draw-target', 'aria-label': 'Target' });
  target.hidden = true;
  field.append(msg, target);
  root.append(field);
  field.focus();

  const update = () => hud(`Round ${Math.min(times.length + 1, ROUNDS)}/${ROUNDS}${times.length ? `   ·   Last: ${times[times.length - 1]} ms` : ''}`);
  update();

  function nextRound() {
    phase = 'waiting';
    msg.textContent = 'Wait for it…';
    target.hidden = true;
    field.classList.remove('early');
    timer = setTimeout(() => {
      phase = 'target';
      const r = field.getBoundingClientRect();
      const size = 64;
      target.style.left = `${size + Math.random() * Math.max(1, r.width - size * 3)}px`;
      target.style.top = `${size + Math.random() * Math.max(1, r.height - size * 3)}px`;
      target.hidden = false;
      msg.textContent = '';
      shownAt = performance.now();
    }, 900 + Math.random() * 2200);
  }

  target.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (phase !== 'target') return;
    const ms = Math.round(performance.now() - shownAt);
    times.push(ms);
    target.hidden = true;
    phase = 'idle';
    update();
    if (times.length >= ROUNDS) {
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      msg.textContent = '';
      setTimeout(() => finish(avg, `${avg} ms average · best round ${Math.min(...times)} ms`), 300);
    } else {
      msg.textContent = `${ms} ms! Click for the next round`;
    }
  });

  field.addEventListener('pointerdown', () => {
    if (phase === 'waiting') {
      // Too early: this round counts as a slow one.
      clearTimeout(timer);
      times.push(1000);
      phase = 'idle';
      field.classList.add('early');
      msg.textContent = 'Too soon! That round counts as 1000 ms. Click to continue';
      update();
      if (times.length >= ROUNDS) {
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        setTimeout(() => finish(avg, `${avg} ms average`), 300);
      }
    } else if (phase === 'idle' && times.length < ROUNDS) {
      nextRound();
    }
  });

  return () => clearTimeout(timer);
}
