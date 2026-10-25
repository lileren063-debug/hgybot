// Shared store for giveaways and the rewards shop (Cloudflare D1)
//
//   GET  /api/giveaways  -> { ok, items }            POST /api/giveaways { action: create | join | draw }
//   GET  /api/rewards    -> { ok, items }            POST /api/rewards   { action: create | claim | delete }
//
// Every POST must carry the Telegram Mini App initData in the X-Telegram-Init-Data header.
// It is checked against BOT_TOKEN, so the user id, admin rights and joins cannot be faked.
// Setup (Cloudflare dashboard -> hgybot Pages project -> Settings):
//   DB         D1 database binding (tables are created on first use)
//   BOT_TOKEN  secret: the BotFather token of the bot that opens the Mini App

const ADMINS = ['therizzller', '5332662287', 'erenlil', '1563597048'];
const INIT_DATA_MAX_AGE_SECONDS = 7 * 86400;
const MAX_RECORD_BYTES = 1500000; // images are data URLs; D1 rows hold up to 2 MB

let schemaReady = false;

export async function handleStore(request, env) {
  const url = new URL(request.url);
  const kind = url.pathname.replace(/\/+$/, '');
  if (kind !== '/api/giveaways' && kind !== '/api/rewards') return null;

  if (!env.DB) {
    return json({ ok: false, error: 'DB (D1) binding is not set on the Pages project' }, 500);
  }
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    return json({ ok: true, items: kind === '/api/giveaways' ? await listGiveaways(env.DB) : await listRewards(env.DB) });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
  if (!user) {
    return json({ ok: false, error: 'Open the app from Telegram to do this' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const result = kind === '/api/giveaways'
    ? await postGiveaway(env.DB, user, body)
    : await postReward(env.DB, user, body);
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);

  return json({ ok: true, items: kind === '/api/giveaways' ? await listGiveaways(env.DB) : await listRewards(env.DB) });
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS giveaway_participants (giveaway_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (giveaway_id, user_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS reward_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, reward_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, claimed_at INTEGER NOT NULL)')
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------- giveaways

async function listGiveaways(db) {
  const [gws, parts] = await Promise.all([
    db.prepare('SELECT data FROM giveaways ORDER BY created_at DESC LIMIT 100').all(),
    db.prepare('SELECT giveaway_id, data FROM giveaway_participants ORDER BY joined_at').all()
  ]);
  const byGiveaway = new Map();
  for (const row of parts.results) {
    if (!byGiveaway.has(row.giveaway_id)) byGiveaway.set(row.giveaway_id, []);
    byGiveaway.get(row.giveaway_id).push(JSON.parse(row.data));
  }
  return gws.results.map(row => {
    const gw = JSON.parse(row.data);
    gw.participants = byGiveaway.get(gw.id) || [];
    return gw;
  });
}

async function getGiveaway(db, id) {
  const row = await db.prepare('SELECT data FROM giveaways WHERE id = ?').bind(String(id || '')).first();
  return row ? JSON.parse(row.data) : null;
}

async function postGiveaway(db, user, body) {
  const now = Date.now();

  if (body.action === 'create') {
    if (!isAdmin(user)) return { error: 'Only admins can create giveaways', status: 403 };
    const g = body.giveaway || {};
    const title = cleanText(g.title, 120);
    if (!title) return { error: 'Title is required' };
    const gw = {
      id: 'gw_' + now,
      title,
      description: cleanText(g.description, 1000),
      entryMode: g.entryMode === 'points' ? 'points' : 'free',
      minPoints: Math.max(0, Math.floor(Number(g.minPoints) || 0)),
      eligibleClan: cleanText(g.eligibleClan, 60) || 'ALL',
      eligibleClanAvatar: cleanImage(g.eligibleClanAvatar),
      prizes: (Array.isArray(g.prizes) ? g.prizes : []).slice(0, 10).map(p => ({
        name: cleanText(p && p.name, 120),
        tag: cleanText(p && p.tag, 40),
        image: cleanImage(p && p.image)
      })),
      endsAtMs: Math.min(now + 90 * 86400000, Math.max(now + 60000, Number(g.endsAtMs) || 0)),
      winner: null,
      ended: false,
      creatorId: user.id,
      creatorUsername: user.username ? '@' + user.username : cleanText(user.first_name, 60) || 'Admin',
      createdAt: now
    };
    const data = JSON.stringify(gw);
    if (data.length > MAX_RECORD_BYTES) return { error: 'Prize images are too large' };
    await db.prepare('INSERT INTO giveaways (id, data, created_at) VALUES (?, ?, ?)').bind(gw.id, data, now).run();
    return {};
  }

  if (body.action === 'join') {
    const gw = await getGiveaway(db, body.giveaway_id);
    if (!gw) return { error: 'Giveaway not found', status: 404 };
    if (gw.ended || gw.endsAtMs <= now) return { error: 'This giveaway has ended' };
    const p = body.participant || {};
    const participant = {
      id: user.id, // always the verified Telegram id
      name: user.username ? '@' + user.username : cleanText(user.first_name, 60) || 'Player',
      clan: cleanText(p.clan, 60),
      paidPoints: gw.entryMode === 'points' ? gw.minPoints : 0,
      joinedAt: now
    };
    const res = await db.prepare('INSERT OR IGNORE INTO giveaway_participants (giveaway_id, user_id, data, joined_at) VALUES (?, ?, ?, ?)')
      .bind(gw.id, user.id, JSON.stringify(participant), now).run();
    if (!res.meta || !res.meta.changes) return { error: 'You have already joined this giveaway' };
    return {};
  }

  if (body.action === 'draw') {
    const gw = await getGiveaway(db, body.giveaway_id);
    if (!gw) return { error: 'Giveaway not found', status: 404 };
    if (gw.ended) return {};
    if (gw.endsAtMs > now) return { error: 'This giveaway has not ended yet' };
    const parts = await db.prepare('SELECT data FROM giveaway_participants WHERE giveaway_id = ?').bind(gw.id).all();
    const list = parts.results.map(r => JSON.parse(r.data));
    gw.ended = true;
    gw.winner = list.length ? list[randomIndex(list.length)] : { name: 'No Participants', clan: '—' };
    gw.drawnAt = now;
    // Only the first draw counts, even when several clients ask at the same moment
    await db.prepare("UPDATE giveaways SET data = ? WHERE id = ? AND json_extract(data, '$.ended') = 0")
      .bind(JSON.stringify(gw), gw.id).run();
    return {};
  }

  return { error: 'Unknown action' };
}

// ---------------------------------------------------------------- rewards

async function listRewards(db) {
  const [rws, claims] = await Promise.all([
    db.prepare('SELECT data, deleted FROM rewards ORDER BY created_at DESC LIMIT 200').all(),
    db.prepare('SELECT reward_id, data FROM reward_claims ORDER BY claimed_at').all()
  ]);
  const byReward = new Map();
  for (const row of claims.results) {
    if (!byReward.has(row.reward_id)) byReward.set(row.reward_id, []);
    byReward.get(row.reward_id).push(JSON.parse(row.data));
  }
  return rws.results.map(row => {
    const rw = JSON.parse(row.data);
    rw.claims = byReward.get(rw.id) || [];
    if (row.deleted) rw.deleted = true;
    return rw;
  });
}

async function postReward(db, user, body) {
  const now = Date.now();

  if (body.action === 'create') {
    if (!isAdmin(user)) return { error: 'Only admins can add rewards', status: 403 };
    const r = body.reward || {};
    const name = cleanText(r.name, 120);
    const cost = Math.floor(Number(r.cost) || 0);
    if (!name || cost <= 0) return { error: 'Enter a reward name and a cost above 0' };
    const rw = {
      id: 'rw_' + now,
      name,
      image: cleanImage(r.image),
      cost,
      stock: r.stock == null || r.stock === '' ? null : Math.max(1, Math.floor(Number(r.stock) || 1)),
      createdBy: user.id,
      createdAt: now
    };
    const data = JSON.stringify(rw);
    if (data.length > MAX_RECORD_BYTES) return { error: 'Reward image is too large' };
    await db.prepare('INSERT INTO rewards (id, data, created_at) VALUES (?, ?, ?)').bind(rw.id, data, now).run();
    return {};
  }

  if (body.action === 'delete') {
    if (!isAdmin(user)) return { error: 'Only admins can delete rewards', status: 403 };
    // Soft delete: claims stay, so points already spent stay counted
    await db.prepare('UPDATE rewards SET deleted = 1 WHERE id = ?').bind(String(body.reward_id || '')).run();
    return {};
  }

  if (body.action === 'claim') {
    const row = await db.prepare('SELECT data FROM rewards WHERE id = ? AND deleted = 0').bind(String(body.reward_id || '')).first();
    if (!row) return { error: 'Reward not found', status: 404 };
    const rw = JSON.parse(row.data);
    const c = body.claim || {};
    const claim = {
      id: user.id,
      name: user.username ? '@' + user.username : cleanText(user.first_name, 60) || 'Player',
      clan: cleanText(c.clan, 60),
      uuid: cleanText(c.uuid, 64),
      paidPoints: rw.cost,
      claimedAt: now
    };
    // Insert only while stock is left (one statement, so two claims cannot take the last item)
    const res = await db.prepare(
      'INSERT INTO reward_claims (reward_id, user_id, data, claimed_at) ' +
      'SELECT ?, ?, ?, ? WHERE ? IS NULL OR (SELECT COUNT(*) FROM reward_claims WHERE reward_id = ?) < ?'
    ).bind(rw.id, user.id, JSON.stringify(claim), now, rw.stock, rw.id, rw.stock).run();
    if (!res.meta || !res.meta.changes) return { error: 'This reward is sold out' };
    return {};
  }

  return { error: 'Unknown action' };
}

// ---------------------------------------------------------------- helpers

// Telegram Mini App initData check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(dataCheckString)));
  const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!timingSafeEqual(hex, hash.toLowerCase())) return null;

  const authDate = Number(params.get('auth_date')) || 0;
  if (Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  try {
    const u = JSON.parse(params.get('user') || 'null');
    if (!u || !u.id) return null;
    return { id: String(u.id), username: u.username || '', first_name: u.first_name || '' };
  } catch (e) {
    return null;
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(user) {
  return ADMINS.includes(String(user.username || '').toLowerCase()) || ADMINS.includes(user.id);
}

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// http(s) links or uploaded JPEG/PNG/WebP data URLs only
function cleanImage(value) {
  const s = String(value || '').trim();
  if (/^https?:\/\//i.test(s) && s.length < 2000) return s;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
  return '';
}

function randomIndex(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
