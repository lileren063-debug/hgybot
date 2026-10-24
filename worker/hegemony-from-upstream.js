// HEGEMONY member scores without a pw.game login
//
// Serves GET /api/clans/5/members[?range=month|week] from the public clan-players ranking
// of the data API (mrktsticker). That ranking holds every clan member with points across
// all clans, 20 per page, so the pages are read and filtered to team 5.
// Monthly points there match pw.game team/my?range=month.

const UPSTREAM_API = 'https://mrktsticker.alwaysdata.net/api';
const HEGEMONY_TEAM_ID = 5;
const CACHE_SECONDS = 120;
const MAX_PAGES = 45;   // stays under the 50 subrequests a free Pages Function may make

export async function handleClanMembersFromUpstream(request, env, ctx) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/clans\/(\d+)\/members\/?$/);
  if (!match) return null;
  if (Number(match[1]) !== HEGEMONY_TEAM_ID) {
    return json({ ok: false, error: 'Only HEGEMONY (team 5) is available' }, 404);
  }

  const range = url.searchParams.get('range') === 'week' ? 'week' : 'month';

  // The last list is kept for a day and served at once; when it is older than
  // CACHE_SECONDS it is rebuilt in the background (reading ~45 pages takes a while)
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__cache/clans/${HEGEMONY_TEAM_ID}/members-upstream/${range}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const age = (Date.now() - Number(cached.headers.get('X-Built-At') || 0)) / 1000;
    if (age > CACHE_SECONDS) ctx.waitUntil(buildAndStore(range, cache, cacheKey).catch(() => null));
    return cached;
  }

  try {
    return await buildAndStore(range, cache, cacheKey);
  } catch (err) {
    return json({ ok: false, error: 'Data API unreachable' }, 502);
  }
}

async function buildAndStore(range, cache, cacheKey) {
  const first = await fetchPage(range, 1);
  const pageSize = Number(first.page_size) || (first.items || []).length || 20;
  const total = Number(first.total) || 0;
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / pageSize)));

  const rest = [];
  for (let page = 2; page <= pageCount; page++) {
    rest.push(fetchPage(range, page).catch(() => null));
  }
  const pages = [first, ...(await Promise.all(rest))];

  const seen = new Set();
  const items = [];
  let clanAvatar = '';
  for (const page of pages) {
    for (const p of (page && page.items) || []) {
      if (Number(p.team_id) !== HEGEMONY_TEAM_ID || seen.has(p.uuid)) continue;
      seen.add(p.uuid);
      clanAvatar = clanAvatar || p.clan_avatar || '';
      items.push({
        uuid: p.uuid,
        nickname: p.nickname,
        points: Number(p.points) || 0,
        rank: Number(p.rank) || null,
        clan_place: Number(p.clan_place) || null,
        avatar: p.avatar || p.mask_image_url || '',
        level: p.level,
        premium: Boolean(p.has_premium)
      });
    }
  }
  items.sort((a, b) => b.points - a.points);

  const response = json({
    ok: true,
    generated_at: new Date().toISOString(),
    points_fetched_at: first.points_fetched_at || null,
    range,
    complete: pageCount * pageSize >= total,
    team: { id: HEGEMONY_TEAM_ID, name: 'HEGEMONY', avatar: clanAvatar },
    items
  }, 200, { 'Cache-Control': 'public, max-age=86400', 'X-Built-At': String(Date.now()) });

  await cache.put(cacheKey, response.clone());
  return response;
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
