// Clan member points without a pw.game login
//
// The data API's public clan-players ranking (mrktsticker) lists every clan member with
// points across all clans, 20 per page. The pages are read once per range, cached, and
// filtered per clan. Monthly points there match pw.game team/my?range=month.
//
//   GET /api/clans/:teamId/members[?range=day|week|month]

const UPSTREAM_API = 'https://mrktsticker.alwaysdata.net/api';
const CACHE_SECONDS = 120;
const MAX_PAGES = 45;   // stays under the 50 subrequests a free Pages Function may make
const RANGES = ['day', 'week', 'month'];

export function normalizeRange(value, fallback = 'month') {
  return RANGES.includes(value) ? value : fallback;
}

export async function handleClanMembers(request, env, ctx) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/clans\/(\d+)\/members\/?$/);
  if (!match) return null;

  const teamId = Number(match[1]);
  const range = normalizeRange(url.searchParams.get('range'));
  let all;
  try {
    all = await getClanPlayers(range, ctx, url.origin);
  } catch (err) {
    return json({ ok: false, error: 'Data API unreachable' }, 502);
  }

  const items = membersOf(all, teamId);
  return json({
    ok: true,
    generated_at: all.generated_at,
    points_fetched_at: all.points_fetched_at,
    range,
    complete: all.complete,
    team: {
      id: teamId,
      name: items[0] ? items[0].clan_name : '',
      avatar: items[0] ? items[0].clan_avatar : ''
    },
    items
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// Members of one clan, best first; rank = place inside the clan
export function membersOf(all, teamId) {
  const items = all.players
    .filter(p => p.team_id === Number(teamId))
    .map(p => ({ ...p }))
    .sort((a, b) => b.points - a.points);
  items.forEach((m, i) => { m.rank = i + 1; });
  return items;
}

// All ranked players for a range. The last list is kept for a day and served at once;
// when it is older than CACHE_SECONDS it is rebuilt in the background.
// A build reads ~45 pages, so one request builds at most one list (free plan: 50 subrequests).
export async function getClanPlayers(range, ctx, origin) {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/__cache/clan-players/${range}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const age = (Date.now() - Number(cached.headers.get('X-Built-At') || 0)) / 1000;
    if (age > CACHE_SECONDS && !ctx.clanPlayersBuild) {
      ctx.clanPlayersBuild = true;
      const prev = { builtAt: Number(cached.headers.get('X-Built-At') || 0), data: await cached.clone().json() };
      ctx.waitUntil(buildAndStore(range, cache, cacheKey, prev, ctx.env && ctx.env.DB).catch(() => null));
    }
    return cached.json();
  }
  if (ctx.clanPlayersBuild) throw new Error('Another list is being built in this request');
  ctx.clanPlayersBuild = true;
  const fresh = await buildAndStore(range, cache, cacheKey);
  return fresh.json();
}

async function buildAndStore(range, cache, cacheKey, prev = null, db = null) {
  const first = await fetchPage(range, 1);
  const pageSize = Number(first.page_size) || (first.items || []).length || 20;
  const total = Number(first.total) || 0;
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / pageSize)));

  const rest = [];
  for (let page = 2; page <= pageCount; page++) {
    rest.push(fetchPage(range, page).catch(() => null));
  }
  const pages = [first, ...(await Promise.all(rest))];
  // A partial list would show members with 0 points, so keep the previous one instead
  if (pages.some(p => !p)) throw new Error('Some pages could not be read');

  const seen = new Set();
  const players = [];
  for (const page of pages) {
    for (const p of (page && page.items) || []) {
      if (!p || !p.uuid || seen.has(p.uuid)) continue;
      seen.add(p.uuid);
      players.push({
        uuid: p.uuid,
        nickname: p.nickname,
        points: Number(p.points) || 0,
        global_rank: Number(p.rank) || null,
        clan_place: Number(p.clan_place) || null,
        team_id: Number(p.team_id) || 0,
        clan_name: p.clan_name || '',
        clan_avatar: p.clan_avatar || '',
        avatar: p.avatar || p.mask_image_url || '',
        level: p.level,
        premium: Boolean(p.has_premium)
      });
    }
  }

  const response = json({
    ok: true,
    generated_at: new Date().toISOString(),
    points_fetched_at: first.points_fetched_at || null,
    range,
    complete: pageCount * pageSize >= total,
    players
  }, 200, { 'Cache-Control': 'public, max-age=86400', 'X-Built-At': String(Date.now()) });

  await cache.put(cacheKey, response.clone());
  if (prev && db) await noteGameReset(db, range, prev, players).catch(() => null);
  return response;
}

// The game resets day/week/month points at its own hour. When the total of a list falls sharply between
// two builds, the reset happened in between; the narrowest such window tells the reset time (see resetOffset).
async function noteGameReset(db, range, prev, players) {
  const sum = list => list.reduce((s, p) => s + (Number(p.points) || 0), 0);
  const before = sum((prev.data && prev.data.players) || []);
  const after = sum(players);
  if (!prev.builtAt || before < 1000 || after > before * 0.5) return;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'game_reset_v1'").first();
  const state = row ? JSON.parse(row.value) : {};
  const windows = (state[range] || []).concat([{ start: prev.builtAt, end: Date.now() }]).slice(-10);
  state[range] = windows;
  await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('game_reset_v1', ?)").bind(JSON.stringify(state)).run();
}

// Minutes after 00:00 UTC at which the game's day starts, from the narrowest seen reset window (null = unknown)
export function resetMinuteOfDay(state) {
  // Only windows of 90 minutes or less are precise enough to pick the hour
  const windows = ((state && state.day) || []).filter(w => w.end - w.start <= 90 * 60000);
  if (!windows.length) return null;
  const best = windows.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
  // Prefer a round time inside the window (the game resets on the hour or half hour)
  for (const step of [60, 30, 15, 5, 1]) {
    const ms = step * 60000;
    const t = Math.ceil(best.start / ms) * ms;
    if (t <= best.end) {
      const d = new Date(t);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
  }
  return null;
}

async function fetchPage(range, page) {
  const res = await fetch(`${UPSTREAM_API}/global/clan-players?range=${range}&page=${page}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders
    }
  });
}
