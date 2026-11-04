// "Pick for me": chooses a game from the user's library.
//  - Smart pick (always available, offline): weighted random that favours
//    games you haven't touched in a while, unplayed games and favourites.
//  - AI pick (optional, needs the user's Anthropic API key): Claude reads the
//    library plus a mood ("something chill, 30 minutes") and explains its pick.
const Anthropic = require('@anthropic-ai/sdk');

const AnthropicClient = Anthropic.default || Anthropic;
const DAY = 24 * 60 * 60 * 1000;

const MODES = {
  surprise: 'Surprise me',
  new: 'Something I haven\'t played',
  comeback: 'A game I haven\'t played in a while',
  favorite: 'One of my favorites',
};

function candidates(games, excludeIds = []) {
  const skip = new Set(excludeIds);
  return games.filter((g) => !g.hidden && !g.running && !skip.has(g.id));
}

function weightFor(g, mode, now = Date.now()) {
  const daysSince = g.lastPlayed ? (now - g.lastPlayed) / DAY : null;
  switch (mode) {
    case 'new':
      return g.lastPlayed ? 0 : 1;
    case 'favorite':
      return g.favorite ? 1 + Math.min(daysSince ?? 30, 60) / 30 : 0;
    case 'comeback':
      return daysSince != null && daysSince >= 14 ? 1 + Math.min(daysSince, 180) / 30 : 0;
    default: {
      // Surprise: everything can come up, but freshly played games are rare
      // and forgotten / unplayed / favourite games come up more often.
      let w = 1;
      if (daysSince == null) w += 1.5;
      else if (daysSince < 1) w *= 0.15;
      else if (daysSince < 3) w *= 0.5;
      else w += Math.min(daysSince, 90) / 45;
      if (g.favorite) w *= 1.6;
      return w;
    }
  }
}

function reasonFor(g, mode, now = Date.now()) {
  const days = g.lastPlayed ? Math.floor((now - g.lastPlayed) / DAY) : null;
  if (days == null) return "You've never played this one. Today's the day.";
  if (mode === 'favorite' || g.favorite) return 'One of your favorites, always a safe bet.';
  if (days >= 30) return `You haven't played this in ${days} days.`;
  if (days >= 7) return 'It has been a little while since you played this.';
  return 'The dice have spoken.';
}

function smartPick(games, { mode = 'surprise', excludeIds = [] } = {}, rand = Math.random) {
  let pool = candidates(games, excludeIds);
  if (!pool.length) pool = candidates(games); // everything excluded: allow repeats
  if (!pool.length) return { error: 'Add some games to your library first.' };

  let weighted = pool.map((g) => [g, weightFor(g, mode)]).filter(([, w]) => w > 0);
  let note = '';
  if (!weighted.length) {
    note = `No games match "${MODES[mode] || mode}", so here's a surprise instead. `;
    weighted = pool.map((g) => [g, weightFor(g, 'surprise')]);
  }
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [g, w] of weighted) {
    r -= w;
    if (r <= 0) return { gameId: g.id, reason: note + reasonFor(g, mode), ai: false };
  }
  const last = weighted[weighted.length - 1][0];
  return { gameId: last.id, reason: note + reasonFor(last, mode), ai: false };
}

// ---------- AI pick ----------
const PICK_SCHEMA = {
  type: 'object',
  properties: {
    game_id: { type: 'string', description: 'The id of the chosen game, copied exactly from the library.' },
    reason: { type: 'string', description: 'One or two friendly sentences on why this game fits right now.' },
  },
  required: ['game_id', 'reason'],
  additionalProperties: false,
};

const SYSTEM = `You pick one game for the player to play right now from their own library.
Only ever choose a game from the library list you are given, and return its id exactly.
Use what you know about each game (genre, typical session length, single-player or multiplayer, tone) together with the player's request and their play history.
If the player gives no request, pick something they would enjoy that they haven't played recently, with a bit of variety.
Write the reason to the player in one or two short, friendly sentences. Don't mention ids.`;

function describe(g, now) {
  const days = g.lastPlayed ? Math.floor((now - g.lastPlayed) / DAY) : null;
  const hours = Math.round((g.playtimeMinutes || 0) / 6) / 10;
  return [
    `id=${g.id}`,
    `name=${JSON.stringify(g.name)}`,
    `store=${g.source}`,
    days == null ? 'never played' : `last played ${days} day(s) ago`,
    hours ? `${hours}h tracked` : null,
    g.favorite ? 'favorite' : null,
  ].filter(Boolean).join(' | ');
}

async function aiPick(games, { apiKey, mood = '', mode = 'surprise', excludeIds = [] }) {
  let pool = candidates(games, excludeIds);
  if (!pool.length) pool = candidates(games);
  if (!pool.length) return { error: 'Add some games to your library first.' };

  const now = Date.now();
  const request = mood.trim() || MODES[mode] || MODES.surprise;
  const client = new AnthropicClient({ apiKey, maxRetries: 1, timeout: 60_000 });

  let response;
  try {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low', // a quick pick doesn't need deep reasoning
        format: { type: 'json_schema', schema: PICK_SCHEMA },
      },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `My library:\n${pool.map((g) => describe(g, now)).join('\n')}\n\nWhat I'm in the mood for: ${request}`,
      }],
    });
  } catch (err) {
    if (err instanceof AnthropicClient.AuthenticationError) return { error: 'Your Anthropic API key was rejected. Check it in Settings.' };
    if (err instanceof AnthropicClient.PermissionDeniedError) return { error: "Your Anthropic API key doesn't have access to this model." };
    if (err instanceof AnthropicClient.RateLimitError) return { error: 'The AI is busy right now. Try again in a moment.' };
    if (err instanceof AnthropicClient.APIConnectionError) return { error: "Couldn't reach the AI. Check your internet connection." };
    if (err instanceof AnthropicClient.APIError) return { error: `The AI request failed (${err.status ?? 'error'}).` };
    return { error: 'The AI request failed.' };
  }

  if (response.stop_reason === 'refusal') return { error: "The AI couldn't make a pick for that request." };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'The AI gave an unexpected answer. Try again.' };
  }
  const game = pool.find((g) => g.id === parsed.game_id);
  if (!game) return { error: 'The AI picked a game that isn\'t in your library. Try again.' };
  return { gameId: game.id, reason: String(parsed.reason || '').slice(0, 400), ai: true };
}

module.exports = { smartPick, aiPick, weightFor, MODES };
