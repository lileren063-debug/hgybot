// Cloudflare Worker handler: HEGEMONY member scores from pw.game
//
// Serves GET /api/clans/5/members[?range=month|week] in the shape the mini app expects:
//   { team: {...}, generated_at, items: [{ uuid, nickname, points, rank, avatar, level, premium }] }
//
// Source: https://pw.game/api/v2/team/my (returns the team of the logged-in account).
//   no query     -> weekly points (resets Monday)
//   ?range=month -> monthly points (default here)
// It needs the clan owner's pw.game login, stored as a Worker secret (never in code):
//   PW_COOKIE         value of the "Cookie" request header sent to pw.game/api/v2/team/my
//   PW_AUTHORIZATION  value of the "Authorization" header, if the game uses one instead
// Set them in Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets,
// or with `wrangler secret put PW_COOKIE`.

const PW_TEAM_URL = 'https://pw.game/api/v2/team/my';
const HEGEMONY_TEAM_ID = 5;
const CACHE_SECONDS = 120; // one upstream call per 2 minutes at most

export async function handleClanMembers(request, env, ctx) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/clans\/(\d+)\/members\/?$/);
  if (!match) return null;
  if (Number(match[1]) !== HEGEMONY_TEAM_ID) {
    return json({ ok: false, error: 'Only HEGEMONY (team 5) is available' }, 404);
  }

  const range = url.searchParams.get('range') === 'week' ? 'week' : 'month';

  // Shared edge cache keyed without the app's ?_t= cache-buster
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__cache/clans/${HEGEMONY_TEAM_ID}/members/${range}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.PW_COOKIE && !env.PW_AUTHORIZATION) {
    return json({ ok: false, error: 'PW_COOKIE / PW_AUTHORIZATION secret is not set' }, 500);
  }

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Referer': 'https://pw.game/',
    'User-Agent': 'Mozilla/5.0 (HGYinfo_bot clan tracker)'
  };
  if (env.PW_COOKIE) headers['Cookie'] = env.PW_COOKIE;
  if (env.PW_AUTHORIZATION) headers['Authorization'] = env.PW_AUTHORIZATION;

  let upstream;
  try {
    upstream = await fetch(range === 'month' ? `${PW_TEAM_URL}?range=month` : PW_TEAM_URL, { headers });
  } catch (err) {
    return json({ ok: false, error: 'pw.game unreachable' }, 502);
  }
  if (upstream.status === 401 || upstream.status === 403) {
    // Login expired: copy a fresh Cookie/Authorization value into the secret
    return json({ ok: false, error: 'pw.game login expired, update the secret' }, 502);
  }
  if (!upstream.ok) {
    return json({ ok: false, error: `pw.game HTTP ${upstream.status}` }, 502);
  }

  const body = await upstream.json().catch(() => null);
  const team = body && body.ok && body.data && body.data.team;
  if (!team || Number(team.id) !== HEGEMONY_TEAM_ID || !Array.isArray(team.members)) {
    return json({ ok: false, error: 'Unexpected pw.game response (is the secret from a HEGEMONY account?)' }, 502);
  }

  const items = team.members
    .map(m => ({
      uuid: m.id,
      nickname: m.username,
      points: Number(m.score) || 0,
      rank: Number(m.personalRatingPlace) || null,
      avatar: m.avatar || '',
      level: m.level,
      premium: Boolean(m.premium),
      is_owner: Boolean(m.isOwner)
    }))
    .sort((a, b) => b.points - a.points);

  const response = json({
    ok: true,
    generated_at: new Date().toISOString(),
    range,
    team: {
      id: team.id,
      name: team.name,
      avatar: team.imgUrl,
      score: team.score,
      rating_place: team.ratingPlace,
      member_count: team.memberCount
    },
    items
  }, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
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

// Usage inside your existing Worker:
//
//   import { handleClanMembers } from './hegemony-members-worker.js';
//
//   export default {
//     async fetch(request, env, ctx) {
//       const clanRes = await handleClanMembers(request, env, ctx);
//       if (clanRes) return clanRes;
//       // ... your existing /api proxy and /api/tg-bot-publish code ...
//     }
//   };
