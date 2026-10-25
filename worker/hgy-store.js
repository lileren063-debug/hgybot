// Multi-clan platform store (Cloudflare D1): clans, admins, giveaways, rewards and tasks
//
//   GET  /api/platform                 -> { ok, clans, me, staff }   POST { action: clan_save | clan_remove | staff_save | staff_remove | link_reset | link | unlink }
//   GET  /api/giveaways[?clan=ID]      -> { ok, items }              POST { action: create | join | draw | delete }
//   GET  /api/rewards[?clan=ID]        -> { ok, items }              POST { action: create | claim | delete }
//   GET  /api/tasks[?clan=ID]          -> { ok, items, pending }     POST { action: create | delete | claim | review }
//
// Roles
//   main admin   SUPER_ADMIN_IDS (Telegram ids). Adds clans, turns giveaways/tasks on per clan, grants admins.
//   clan admin   clan_staff.role = 'clan_admin': every enabled feature of that one clan.
//   staff        clan_staff.role = 'staff': only the features flagged on its row (can_giveaways, can_tasks).
//   user         joins giveaways, claims rewards, completes tasks.
// Every POST, and the "me" part of a GET, needs the Telegram Mini App initData in the X-Telegram-Init-Data
// header. It is checked against BOT_TOKEN, so ids and rights cannot be faked; all checks run here.
//
// Setup (Cloudflare dashboard -> hgybot Pages project -> Settings):
//   DB               D1 database binding (tables are created on first use)
//   BOT_TOKEN        secret: the BotFather token of the bot that opens the Mini App
//   SUPER_ADMIN_IDS  optional: comma separated Telegram ids of main admins (default: Eren)
//
// HGY point balance (one wallet per Telegram user, current UTC month, like the game's monthly points):
//   monthly game points of the linked Pixel World player + task rewards - giveaway entries - reward claims

import { getClanPlayers } from './clan-points.js';

const DEFAULT_SUPER_ADMIN_IDS = '1563597048'; // @erenlil
const SEED_CLAN = {
  team_id: 5,
  name: 'HEGEMONY',
  avatar: 'https://static.pw.game/teams/34ca79e23c5a8670af7397dee3d9d815c10d8c4f255aa71dcc4c21859cd48c8b.jpg'
};
const SEED_STAFF = [{ team_id: 5, user_key: '5332662287', label: '@therizzller', role: 'clan_admin' }];

const INIT_DATA_MAX_AGE_SECONDS = 7 * 86400;
const MAX_RECORD_BYTES = 1500000; // images are data URLs; D1 rows hold up to 2 MB
const TASK_KINDS = ['clan_points', 'telegram_join', 'manual'];
const TASK_PERIODS = ['daily', 'weekly', 'season', 'once'];
const PERIOD_RANGE = { daily: 'day', weekly: 'week', season: 'month' };

let schemaReady = false;

export async function handleStore(request, env, ctx) {
  const url = new URL(request.url);
  const kind = url.pathname.replace(/\/+$/, '');
  const handlers = { '/api/platform': platform, '/api/giveaways': giveaways, '/api/rewards': rewards, '/api/tasks': tasks };
  const handler = handlers[kind];
  if (!handler) return null;

  if (!env.DB) {
    return json({ ok: false, error: 'DB (D1) binding is not set on the Pages project' }, 500);
  }
  await ensureSchema(env.DB);

  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
  const superIds = String(env.SUPER_ADMIN_IDS || DEFAULT_SUPER_ADMIN_IDS).split(',').map(s => s.trim()).filter(Boolean);
  const app = { db: env.DB, env, ctx, origin: url.origin, user, isSuper: Boolean(user && superIds.includes(user.id)) };

  let body = null;
  if (request.method === 'POST') {
    if (!user) return json({ ok: false, error: 'Open the app from Telegram to do this' }, 401);
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'Invalid JSON' }, 400);
    }
  } else if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const result = await handler(app, url, body);
    if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
    return json({ ok: true, ...result });
  } catch (err) {
    if (err && err.dataApi) return json({ ok: false, error: 'Game points are unavailable right now, try again in a minute' }, 502);
    throw err;
  }
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS giveaway_participants (giveaway_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (giveaway_id, user_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS reward_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, reward_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, claimed_at INTEGER NOT NULL)'),
    db.prepare("CREATE TABLE IF NOT EXISTS clans (team_id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', giveaways_enabled INTEGER NOT NULL DEFAULT 0, tasks_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clan_staff (team_id INTEGER NOT NULL, user_key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, can_giveaways INTEGER NOT NULL DEFAULT 0, can_tasks INTEGER NOT NULL DEFAULT 0, added_by TEXT, added_at INTEGER NOT NULL, PRIMARY KEY (team_id, user_key))"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_links (user_id TEXT PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL DEFAULT '', team_id INTEGER NOT NULL DEFAULT 0, clan_name TEXT NOT NULL DEFAULT '', linked_at INTEGER NOT NULL)"),
    db.prepare('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, clan_id INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS task_claims (task_id TEXT NOT NULL, user_id TEXT NOT NULL, period_key TEXT NOT NULL, status TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY (task_id, user_id, period_key))'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  ]);
  // Giveaways and rewards from before the multi-clan version belong to HEGEMONY
  for (const table of ['giveaways', 'rewards']) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN clan_id INTEGER NOT NULL DEFAULT ${SEED_CLAN.team_id}`).run();
    } catch (e) { /* column already there */ }
  }
  // Seed once, so a clan or admin the main admin removes stays removed
  const seeded = await db.prepare("SELECT value FROM meta WHERE key = 'seeded_v1'").first();
  if (!seeded) {
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO clans (team_id, name, avatar, giveaways_enabled, tasks_enabled, created_at) VALUES (?, ?, ?, 1, 1, ?)')
        .bind(SEED_CLAN.team_id, SEED_CLAN.name, SEED_CLAN.avatar, now),
      ...SEED_STAFF.map(s => db.prepare('INSERT OR IGNORE INTO clan_staff (team_id, user_key, label, role, can_giveaways, can_tasks, added_by, added_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
        .bind(s.team_id, s.user_key, s.label, s.role, 'seed', now)),
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_v1', ?)").bind(String(now))
    ]);
  }
  schemaReady = true;
}

// ---------------------------------------------------------------- permissions

function clanFromRow(c) {
  return {
    team_id: Number(c.team_id),
    name: c.name,
    avatar: c.avatar || '',
    giveaways_enabled: Boolean(c.giveaways_enabled),
    tasks_enabled: Boolean(c.tasks_enabled)
  };
}

async function listClans(db) {
  const res = await db.prepare('SELECT team_id, name, avatar, giveaways_enabled, tasks_enabled FROM clans ORDER BY created_at').all();
  return res.results.map(clanFromRow);
}

async function getClan(db, teamId) {
  const c = await db.prepare('SELECT team_id, name, avatar, giveaways_enabled, tasks_enabled FROM clans WHERE team_id = ?').bind(Number(teamId) || 0).first();
  return c ? clanFromRow(c) : null;
}

// { [team_id]: { role, giveaways, tasks } } for every clan this user may manage something in
async function getPerms(app) {
  if (app.perms) return app.perms;
  const perms = {};
  if (app.user) {
    const clans = await listClans(app.db);
    if (app.isSuper) {
      for (const c of clans) perms[c.team_id] = { role: 'super', giveaways: true, tasks: true };
    } else {
      const keys = [app.user.id];
      if (app.user.username) keys.push(app.user.username.toLowerCase());
      const rows = await app.db.prepare(`SELECT team_id, role, can_giveaways, can_tasks FROM clan_staff WHERE user_key IN (${keys.map(() => '?').join(',')})`)
        .bind(...keys).all();
      for (const r of rows.results) {
        const clan = clans.find(c => c.team_id === Number(r.team_id));
        if (!clan) continue;
        const full = r.role === 'clan_admin';
        const p = perms[clan.team_id] || { role: r.role, giveaways: false, tasks: false };
        if (full) p.role = 'clan_admin';
        p.giveaways = p.giveaways || (clan.giveaways_enabled && (full || Boolean(r.can_giveaways)));
        p.tasks = p.tasks || (clan.tasks_enabled && (full || Boolean(r.can_tasks)));
        perms[clan.team_id] = p;
      }
    }
  }
  app.perms = perms;
  return perms;
}

async function can(app, teamId, feature) {
  const p = (await getPerms(app))[Number(teamId)];
  return Boolean(p && p[feature]);
}

// ---------------------------------------------------------------- platform: clans, admins, links, balance

async function platform(app, url, body) {
  if (body) {
    const res = await postPlatform(app, body);
    if (res.error) return res;
    app.perms = null;
  }
  const out = { clans: await listClans(app.db), me: null };
  if (!app.user) return out;

  const link = await getLink(app.db, app.user.id);
  let balance = null;
  try {
    balance = await getBalance(app, link);
  } catch (e) {
    if (!(e && e.dataApi)) throw e;
  }
  out.me = {
    id: app.user.id,
    username: app.user.username,
    is_super: app.isSuper,
    perms: await getPerms(app),
    link,
    balance
  };
  if (app.isSuper) {
    const staff = await app.db.prepare('SELECT team_id, user_key, label, role, can_giveaways, can_tasks, added_at FROM clan_staff ORDER BY team_id, added_at').all();
    out.staff = staff.results.map(s => ({
      team_id: Number(s.team_id),
      user_key: s.user_key,
      label: s.label,
      role: s.role,
      can_giveaways: Boolean(s.can_giveaways),
      can_tasks: Boolean(s.can_tasks),
      added_at: s.added_at
    }));
  }
  return out;
}

async function postPlatform(app, body) {
  const db = app.db;
  const now = Date.now();
  const action = body.action;

  // Any verified user: link / unlink their own Pixel World player
  if (action === 'link') {
    const uuid = cleanText(body.uuid, 64);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(uuid)) return { error: 'Invalid player UUID' };
    const owner = await db.prepare('SELECT user_id FROM user_links WHERE uuid = ?').bind(uuid).first();
    if (owner && owner.user_id !== app.user.id) {
      return { error: 'This Pixel World player is already linked to another Telegram account. Ask the main admin to reset it.', status: 409 };
    }
    let player = null;
    try {
      player = await findPlayer(app, 'month', uuid);
    } catch (e) { /* link anyway; the clan is filled in on the next balance check */ }
    await db.prepare('INSERT OR REPLACE INTO user_links (user_id, uuid, nickname, team_id, clan_name, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(app.user.id, uuid, cleanText(player ? player.nickname : body.nickname, 60), player ? player.team_id : 0, player ? player.clan_name : '', now).run();
    return {};
  }
  if (action === 'unlink') {
    await db.prepare('DELETE FROM user_links WHERE user_id = ?').bind(app.user.id).run();
    return {};
  }

  // Everything else belongs to the main admin
  if (!app.isSuper) return { error: 'Only the main admin can do this', status: 403 };

  if (action === 'clan_save') {
    const c = body.clan || {};
    const teamId = Math.floor(Number(c.team_id) || 0);
    const name = cleanText(c.name, 60);
    if (teamId <= 0 || !name) return { error: 'Enter the clan team id and name' };
    await db.prepare(
      'INSERT INTO clans (team_id, name, avatar, giveaways_enabled, tasks_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, giveaways_enabled = excluded.giveaways_enabled, tasks_enabled = excluded.tasks_enabled'
    ).bind(teamId, name, cleanImage(c.avatar), c.giveaways_enabled ? 1 : 0, c.tasks_enabled ? 1 : 0, now).run();
    return {};
  }
  if (action === 'clan_remove') {
    const teamId = Number(body.team_id) || 0;
    // Giveaways, rewards and tasks stay stored; without the clan only the main admin can manage them
    await db.batch([
      db.prepare('DELETE FROM clans WHERE team_id = ?').bind(teamId),
      db.prepare('DELETE FROM clan_staff WHERE team_id = ?').bind(teamId)
    ]);
    return {};
  }
  if (action === 'staff_save') {
    const s = body.staff || {};
    const teamId = Number(s.team_id) || 0;
    if (!(await getClan(db, teamId))) return { error: 'Add the clan first' };
    const key = normalizeUserKey(s.user);
    if (!key) return { error: 'Enter a Telegram @username or numeric id' };
    const role = s.role === 'clan_admin' ? 'clan_admin' : 'staff';
    const canGw = role === 'clan_admin' || Boolean(s.can_giveaways);
    const canTasks = role === 'clan_admin' || Boolean(s.can_tasks);
    if (!canGw && !canTasks) return { error: 'Give the staff member at least one permission' };
    const label = /^\d+$/.test(key) ? cleanText(s.label, 60) || key : '@' + key;
    await db.prepare('INSERT OR REPLACE INTO clan_staff (team_id, user_key, label, role, can_giveaways, can_tasks, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(teamId, key, label, role, canGw ? 1 : 0, canTasks ? 1 : 0, app.user.id, now).run();
    return {};
  }
  if (action === 'staff_remove') {
    await db.prepare('DELETE FROM clan_staff WHERE team_id = ? AND user_key = ?').bind(Number(body.team_id) || 0, normalizeUserKey(body.user_key)).run();
    return {};
  }
  if (action === 'link_reset') {
    const v = cleanText(body.value, 64);
    if (!v) return { error: 'Enter a Telegram id or player UUID' };
    const res = await db.prepare('DELETE FROM user_links WHERE user_id = ? OR uuid = ?').bind(v, v).run();
    if (!res.meta || !res.meta.changes) return { error: 'No link found for that id or UUID', status: 404 };
    return {};
  }

  return { error: 'Unknown action' };
}

// '@Name' or a numeric Telegram id -> 'name' / '123'
function normalizeUserKey(value) {
  const s = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,40}$/.test(s) ? s : '';
}

async function getLink(db, userId) {
  const row = await db.prepare('SELECT uuid, nickname, team_id, clan_name, linked_at FROM user_links WHERE user_id = ?').bind(userId).first();
  return row ? { uuid: row.uuid, nickname: row.nickname, team_id: Number(row.team_id) || 0, clan_name: row.clan_name, linked_at: row.linked_at } : null;
}

async function rankedPlayers(app, range) {
  app.players = app.players || {};
  try {
    if (!app.players[range]) app.players[range] = (await getClanPlayers(range, app.ctx, app.origin)).players;
    return app.players[range];
  } catch (e) {
    const err = new Error('Data API unreachable');
    err.dataApi = true;
    throw err;
  }
}

async function findPlayer(app, range, uuid) {
  return (await rankedPlayers(app, range)).find(p => p.uuid === uuid) || null;
}

// The player's clan right now (from the live ranking), else the clan stored when linking
async function getMembership(app, link) {
  if (!link) return { player: null, team_id: 0, clan_name: '' };
  const player = await findPlayer(app, 'month', link.uuid);
  if (player && player.team_id && (player.team_id !== link.team_id || player.clan_name !== link.clan_name)) {
    await app.db.prepare('UPDATE user_links SET team_id = ?, clan_name = ?, nickname = ? WHERE user_id = ?')
      .bind(player.team_id, player.clan_name, cleanText(player.nickname, 60), app.user.id).run();
  }
  return {
    player,
    team_id: player ? player.team_id : link.team_id,
    clan_name: player ? player.clan_name : link.clan_name
  };
}

function utcMonthStart(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

async function getBalance(app, link) {
  const db = app.db;
  const userId = app.user.id;
  const since = utcMonthStart();
  const membership = await getMembership(app, link);
  const player = membership.player;
  const [earned, gw, rw] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM task_claims WHERE user_id = ? AND status = 'done' AND decided_at >= ?").bind(userId, since).first(),
    db.prepare("SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) AS s FROM giveaway_participants WHERE user_id = ? AND joined_at >= ?").bind(userId, since).first(),
    db.prepare("SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) AS s FROM reward_claims WHERE user_id = ? AND claimed_at >= ?").bind(userId, since).first()
  ]);
  const monthPoints = player ? player.points : 0;
  const taskPoints = Number(earned.s) || 0;
  const spent = (Number(gw.s) || 0) + (Number(rw.s) || 0);
  let rank = null;
  if (player) {
    rank = (await rankedPlayers(app, 'month')).filter(p => p.team_id === player.team_id && p.points > player.points).length + 1;
  }
  return {
    month_points: monthPoints,
    task_points: taskPoints,
    spent,
    balance: Math.max(0, monthPoints + taskPoints - spent),
    team_id: membership.team_id,
    clan_name: membership.clan_name,
    rank_in_clan: rank
  };
}

function displayName(user) {
  return user.username ? '@' + user.username : cleanText(user.first_name, 60) || 'Player';
}

// ---------------------------------------------------------------- giveaways

async function giveaways(app, url, body) {
  if (body) {
    const res = await postGiveaway(app, body);
    if (res.error) return res;
  }
  return { items: await listGiveaways(app.db, url.searchParams.get('clan')) };
}

async function listGiveaways(db, clanFilter) {
  const clanId = Number(clanFilter) || 0;
  const [gws, parts, clanList] = await Promise.all([
    clanId
      ? db.prepare('SELECT data, clan_id FROM giveaways WHERE clan_id = ? ORDER BY created_at DESC LIMIT 200').bind(clanId).all()
      : db.prepare('SELECT data, clan_id FROM giveaways ORDER BY created_at DESC LIMIT 200').all(),
    db.prepare('SELECT giveaway_id, data FROM giveaway_participants ORDER BY joined_at').all(),
    listClans(db)
  ]);
  const clans = new Map(clanList.map(c => [c.team_id, c]));
  const byGiveaway = new Map();
  for (const row of parts.results) {
    if (!byGiveaway.has(row.giveaway_id)) byGiveaway.set(row.giveaway_id, []);
    byGiveaway.get(row.giveaway_id).push(JSON.parse(row.data));
  }
  return gws.results.map(row => {
    const gw = JSON.parse(row.data);
    const clan = clans.get(Number(row.clan_id));
    gw.clanId = Number(row.clan_id);
    gw.clanName = clan ? clan.name : gw.clanName || '';
    gw.clanAvatar = clan ? clan.avatar : gw.clanAvatar || '';
    gw.participants = byGiveaway.get(gw.id) || [];
    return gw;
  });
}

async function getGiveaway(db, id) {
  const row = await db.prepare('SELECT data, clan_id FROM giveaways WHERE id = ?').bind(String(id || '')).first();
  return row ? { gw: JSON.parse(row.data), clanId: Number(row.clan_id) } : null;
}

async function postGiveaway(app, body) {
  const db = app.db;
  const user = app.user;
  const now = Date.now();

  if (body.action === 'create') {
    const clan = await getClan(db, body.clan_id);
    if (!clan) return { error: 'Choose the clan this giveaway belongs to' };
    if (!(await can(app, clan.team_id, 'giveaways'))) return { error: `You cannot create giveaways for ${clan.name}`, status: 403 };
    const g = body.giveaway || {};
    const title = cleanText(g.title, 120);
    if (!title) return { error: 'Title is required' };
    const gw = {
      id: 'gw_' + now + '_' + randomIndex(1000),
      title,
      description: cleanText(g.description, 1000),
      entryMode: g.entryMode === 'points' ? 'points' : 'free',
      minPoints: g.entryMode === 'points' ? Math.max(1, Math.floor(Number(g.minPoints) || 0)) : 0,
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
      creatorUsername: displayName(user),
      createdAt: now
    };
    const data = JSON.stringify(gw);
    if (data.length > MAX_RECORD_BYTES) return { error: 'Prize images are too large' };
    await db.prepare('INSERT INTO giveaways (id, data, created_at, clan_id) VALUES (?, ?, ?, ?)').bind(gw.id, data, now, clan.team_id).run();
    return {};
  }

  const found = await getGiveaway(db, body.giveaway_id);
  if (!found) return { error: 'Giveaway not found', status: 404 };
  const { gw, clanId } = found;

  if (body.action === 'delete') {
    if (!(await can(app, clanId, 'giveaways'))) return { error: "You cannot manage this clan's giveaways", status: 403 };
    // Entries go too, so points paid to join are given back
    await db.batch([
      db.prepare('DELETE FROM giveaway_participants WHERE giveaway_id = ?').bind(gw.id),
      db.prepare('DELETE FROM giveaways WHERE id = ?').bind(gw.id)
    ]);
    return {};
  }

  if (body.action === 'join') {
    if (gw.ended || gw.endsAtMs <= now) return { error: 'This giveaway has ended' };
    const already = await db.prepare('SELECT 1 AS x FROM giveaway_participants WHERE giveaway_id = ? AND user_id = ?').bind(gw.id, user.id).first();
    if (already) return { error: 'You have already joined this giveaway' };

    const cost = gw.entryMode === 'points' ? Math.max(0, Number(gw.minPoints) || 0) : 0;
    const restricted = gw.eligibleClan && gw.eligibleClan !== 'ALL';
    const link = await getLink(db, user.id);
    let clanName = link ? link.clan_name : '';
    if (cost > 0 || restricted) {
      if (!link) return { error: 'Link your Pixel World UUID in Profile first' };
      const bal = await getBalance(app, link);
      clanName = bal.clan_name;
      if (restricted && String(bal.clan_name).toLowerCase() !== String(gw.eligibleClan).toLowerCase()) {
        return { error: `Only ${gw.eligibleClan} members can join this giveaway` };
      }
      if (cost > bal.balance) {
        return { error: `Not enough points: you have ${bal.balance} PTS, entry costs ${cost} PTS` };
      }
    }

    const participant = {
      id: user.id, // always the verified Telegram id
      name: displayName(user),
      clan: clanName || cleanText(body.participant && body.participant.clan, 60),
      paidPoints: cost,
      joinedAt: now
    };
    const res = await db.prepare('INSERT OR IGNORE INTO giveaway_participants (giveaway_id, user_id, data, joined_at) VALUES (?, ?, ?, ?)')
      .bind(gw.id, user.id, JSON.stringify(participant), now).run();
    if (!res.meta || !res.meta.changes) return { error: 'You have already joined this giveaway' };
    return {};
  }

  if (body.action === 'draw') {
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

async function rewards(app, url, body) {
  if (body) {
    const res = await postReward(app, body);
    if (res.error) return res;
  }
  return { items: await listRewards(app.db, url.searchParams.get('clan')) };
}

async function listRewards(db, clanFilter) {
  const clanId = Number(clanFilter) || 0;
  const [rws, claims, clanList] = await Promise.all([
    clanId
      ? db.prepare('SELECT data, deleted, clan_id FROM rewards WHERE clan_id = ? ORDER BY created_at DESC LIMIT 200').bind(clanId).all()
      : db.prepare('SELECT data, deleted, clan_id FROM rewards ORDER BY created_at DESC LIMIT 200').all(),
    db.prepare('SELECT reward_id, data FROM reward_claims ORDER BY claimed_at').all(),
    listClans(db)
  ]);
  const clans = new Map(clanList.map(c => [c.team_id, c]));
  const byReward = new Map();
  for (const row of claims.results) {
    if (!byReward.has(row.reward_id)) byReward.set(row.reward_id, []);
    byReward.get(row.reward_id).push(JSON.parse(row.data));
  }
  return rws.results.map(row => {
    const rw = JSON.parse(row.data);
    const clan = clans.get(Number(row.clan_id));
    rw.clanId = Number(row.clan_id);
    rw.clanName = clan ? clan.name : '';
    rw.clanAvatar = clan ? clan.avatar : '';
    rw.claims = byReward.get(rw.id) || [];
    if (row.deleted) rw.deleted = true;
    return rw;
  });
}

async function postReward(app, body) {
  const db = app.db;
  const user = app.user;
  const now = Date.now();

  if (body.action === 'create') {
    const clan = await getClan(db, body.clan_id);
    if (!clan) return { error: 'Choose the clan this reward belongs to' };
    if (!(await can(app, clan.team_id, 'giveaways'))) return { error: `You cannot add rewards for ${clan.name}`, status: 403 };
    const r = body.reward || {};
    const name = cleanText(r.name, 120);
    const cost = Math.floor(Number(r.cost) || 0);
    if (!name || cost <= 0) return { error: 'Enter a reward name and a cost above 0' };
    const rw = {
      id: 'rw_' + now + '_' + randomIndex(1000),
      name,
      image: cleanImage(r.image),
      cost,
      stock: r.stock == null || r.stock === '' ? null : Math.max(1, Math.floor(Number(r.stock) || 1)),
      createdBy: user.id,
      createdAt: now
    };
    const data = JSON.stringify(rw);
    if (data.length > MAX_RECORD_BYTES) return { error: 'Reward image is too large' };
    await db.prepare('INSERT INTO rewards (id, data, created_at, clan_id) VALUES (?, ?, ?, ?)').bind(rw.id, data, now, clan.team_id).run();
    return {};
  }

  const row = await db.prepare('SELECT data, clan_id FROM rewards WHERE id = ? AND deleted = 0').bind(String(body.reward_id || '')).first();
  if (!row) return { error: 'Reward not found', status: 404 };
  const rw = JSON.parse(row.data);
  const clanId = Number(row.clan_id);

  if (body.action === 'delete') {
    if (!(await can(app, clanId, 'giveaways'))) return { error: "You cannot manage this clan's rewards", status: 403 };
    // Soft delete: claims stay, so points already spent stay counted
    await db.prepare('UPDATE rewards SET deleted = 1 WHERE id = ?').bind(rw.id).run();
    return {};
  }

  if (body.action === 'claim') {
    const link = await getLink(db, user.id);
    if (!link) return { error: 'Link your Pixel World UUID in Profile first' };
    const bal = await getBalance(app, link);
    if (bal.team_id !== clanId) return { error: 'This reward is for members of its clan only' };
    if (rw.cost > bal.balance) return { error: `Not enough points: you have ${bal.balance} PTS, this reward costs ${rw.cost} PTS` };
    const claim = {
      id: user.id,
      name: displayName(user),
      clan: bal.clan_name,
      uuid: link.uuid,
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

// ---------------------------------------------------------------- tasks

// Daily: UTC date. Weekly: Monday of the UTC week. Season: UTC month (the game's monthly reset). Once: forever.
export function periodKey(period, now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'daily') return day.toISOString().slice(0, 10);
  if (period === 'weekly') {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return 'W' + day.toISOString().slice(0, 10);
  }
  if (period === 'season') return day.toISOString().slice(0, 7);
  return 'once';
}

async function tasks(app, url, body) {
  if (body) {
    const res = await postTask(app, body);
    if (res.error) return res;
  }
  return listTasks(app, Number(url.searchParams.get('clan')) || 0);
}

async function listTasks(app, clanId) {
  const db = app.db;
  const [clans, perms, rows] = await Promise.all([
    listClans(db),
    getPerms(app),
    clanId
      ? db.prepare('SELECT data, clan_id FROM tasks WHERE deleted = 0 AND clan_id = ? ORDER BY created_at DESC').bind(clanId).all()
      : db.prepare('SELECT data, clan_id FROM tasks WHERE deleted = 0 ORDER BY created_at DESC').all()
  ]);

  // Tasks of a clan with tasks turned off are only shown to its managers
  const items = [];
  for (const row of rows.results) {
    const clan = clans.find(c => c.team_id === Number(row.clan_id));
    const manager = Boolean(perms[Number(row.clan_id)] && perms[Number(row.clan_id)].tasks);
    if (!clan || (!clan.tasks_enabled && !manager)) continue;
    const t = JSON.parse(row.data);
    t.clanId = clan.team_id;
    t.clanName = clan.name;
    t.clanAvatar = clan.avatar;
    t.periodKey = periodKey(t.period);
    t.canManage = manager;
    t.myStatus = null;
    items.push(t);
  }

  if (app.user && items.length) {
    const mine = await db.prepare('SELECT task_id, period_key, status FROM task_claims WHERE user_id = ?').bind(app.user.id).all();
    const byTask = new Map(mine.results.map(c => [c.task_id + '|' + c.period_key, c.status]));
    for (const t of items) t.myStatus = byTask.get(t.id + '|' + t.periodKey) || null;
  }

  // Manual tasks waiting for a decision, for the clans this user may review
  let pending = [];
  const reviewClans = Object.keys(perms).filter(id => perms[id].tasks && (!clanId || Number(id) === clanId)).map(Number);
  if (reviewClans.length) {
    const res = await db.prepare(
      'SELECT c.task_id, c.user_id, c.period_key, c.data, c.created_at, t.clan_id, t.data AS task FROM task_claims c JOIN tasks t ON t.id = c.task_id ' +
      `WHERE c.status = 'pending' AND t.deleted = 0 AND t.clan_id IN (${reviewClans.map(() => '?').join(',')}) ORDER BY c.created_at LIMIT 100`
    ).bind(...reviewClans).all();
    pending = res.results.map(r => {
      const t = JSON.parse(r.task);
      const d = JSON.parse(r.data);
      return {
        task_id: r.task_id,
        task_title: t.title,
        reward: t.reward,
        clan_id: Number(r.clan_id),
        user_id: r.user_id,
        user_name: d.name,
        note: d.note || '',
        period_key: r.period_key,
        created_at: r.created_at
      };
    });
  }
  return { items, pending };
}

async function getTask(db, id) {
  const row = await db.prepare('SELECT data, clan_id FROM tasks WHERE id = ? AND deleted = 0').bind(String(id || '')).first();
  if (!row) return null;
  const t = JSON.parse(row.data);
  t.clanId = Number(row.clan_id);
  return t;
}

// '@name', 'name' or a t.me link -> '@name'
function cleanChat(value) {
  const s = String(value || '').trim().replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{4,64}$/.test(s) ? '@' + s : '';
}

async function postTask(app, body) {
  const db = app.db;
  const user = app.user;
  const now = Date.now();

  if (body.action === 'create') {
    const clan = await getClan(db, body.clan_id);
    if (!clan) return { error: 'Choose the clan this task belongs to' };
    if (!(await can(app, clan.team_id, 'tasks'))) return { error: `You cannot create tasks for ${clan.name}`, status: 403 };
    const t = body.task || {};
    const kind = TASK_KINDS.includes(t.kind) ? t.kind : '';
    if (!kind) return { error: 'Choose a task type' };
    const title = cleanText(t.title, 120);
    if (!title) return { error: 'Task title is required' };
    const reward = Math.floor(Number(t.reward) || 0);
    if (reward <= 0 || reward > 1000000) return { error: 'Reward must be between 1 and 1,000,000 HGY points' };
    let period = TASK_PERIODS.includes(t.period) ? t.period : 'once';
    const task = {
      id: 'tk_' + now + '_' + randomIndex(1000),
      kind,
      title,
      description: cleanText(t.description, 500),
      reward,
      createdBy: user.id,
      createdByName: displayName(user),
      createdAt: now
    };
    if (kind === 'clan_points') {
      if (!PERIOD_RANGE[period]) period = 'daily';
      task.scope = t.scope === 'clan' ? 'clan' : 'player';
      task.target = Math.floor(Number(t.target) || 0);
      if (task.target <= 0) return { error: 'Enter a points target above 0' };
    } else if (kind === 'telegram_join') {
      period = 'once';
      task.chat = cleanChat(t.chat);
      if (!task.chat) return { error: 'Enter the channel or group as @name or t.me link' };
      task.url = 'https://t.me/' + task.chat.slice(1);
    } else {
      task.url = /^https:\/\/[^\s"'<>]+$/i.test(String(t.url || '').trim()) ? cleanText(t.url, 300) : '';
    }
    task.period = period;
    await db.prepare('INSERT INTO tasks (id, clan_id, data, created_at) VALUES (?, ?, ?, ?)').bind(task.id, clan.team_id, JSON.stringify(task), now).run();
    return {};
  }

  const task = await getTask(db, body.task_id);
  if (!task) return { error: 'Task not found', status: 404 };

  if (body.action === 'delete') {
    if (!(await can(app, task.clanId, 'tasks'))) return { error: "You cannot manage this clan's tasks", status: 403 };
    // Soft delete: points already earned stay counted
    await db.prepare('UPDATE tasks SET deleted = 1 WHERE id = ?').bind(task.id).run();
    return {};
  }

  if (body.action === 'review') {
    if (!(await can(app, task.clanId, 'tasks'))) return { error: "You cannot review this clan's tasks", status: 403 };
    const approve = Boolean(body.approve);
    const res = await db.prepare("UPDATE task_claims SET status = ?, points = ?, decided_at = ? WHERE task_id = ? AND user_id = ? AND period_key = ? AND status = 'pending'")
      .bind(approve ? 'done' : 'rejected', approve ? task.reward : 0, now, task.id, String(body.user_id || ''), String(body.period_key || '')).run();
    if (!res.meta || !res.meta.changes) return { error: 'This request was already handled' };
    return {};
  }

  if (body.action === 'claim') {
    const clan = await getClan(db, task.clanId);
    if (!clan || !clan.tasks_enabled) return { error: 'Tasks are turned off for this clan' };
    const key = periodKey(task.period);
    const existing = await db.prepare('SELECT status FROM task_claims WHERE task_id = ? AND user_id = ? AND period_key = ?').bind(task.id, user.id, key).first();
    if (existing && existing.status === 'done') return { error: 'You already completed this task' + (task.period === 'once' ? '' : ' for this period') };
    if (existing && existing.status === 'pending') return { error: 'Your request is waiting for an admin' };

    const link = await getLink(db, user.id);
    if (!link) return { error: 'Link your Pixel World UUID in Profile first' };
    const notMember = { error: `This task is for ${clan.name} members only` };

    let status = 'done';
    const data = { name: displayName(user), uuid: link.uuid };
    if (task.kind === 'clan_points') {
      // Only this period's list is read: one request may build one list at most
      const players = await rankedPlayers(app, PERIOD_RANGE[task.period]);
      const me = players.find(p => p.uuid === link.uuid);
      if ((me ? me.team_id : link.team_id) !== task.clanId) return notMember;
      const value = task.scope === 'clan'
        ? players.filter(p => p.team_id === task.clanId).reduce((s, p) => s + p.points, 0)
        : (me ? me.points : 0);
      if (value < task.target) return { error: `Not reached yet: ${value} / ${task.target} PTS` };
      data.value = value;
    } else if ((await getMembership(app, link)).team_id !== task.clanId) {
      return notMember;
    } else if (task.kind === 'telegram_join') {
      const check = await isChatMember(app.env.BOT_TOKEN, task.chat, user.id);
      if (check.error) return { error: check.error };
      if (!check.member) return { error: `Join ${task.chat} first, then tap Check again` };
    } else {
      status = 'pending';
      data.note = cleanText(body.note, 300);
    }

    // A rejected request may be sent again
    await db.prepare('INSERT OR REPLACE INTO task_claims (task_id, user_id, period_key, status, points, data, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(task.id, user.id, key, status, status === 'done' ? task.reward : 0, JSON.stringify(data), now, status === 'done' ? now : null).run();
    return {};
  }

  return { error: 'Unknown action' };
}

// Telegram Bot API getChatMember: the bot must be an admin of a channel (or a member of a group)
async function isChatMember(botToken, chat, userId) {
  if (!botToken) return { error: 'BOT_TOKEN is not set on the server' };
  let data;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${encodeURIComponent(userId)}`);
    data = await res.json();
  } catch (e) {
    return { error: 'Telegram is unreachable, try again' };
  }
  if (!data || !data.ok) {
    if (data && /user not found|participant_id_invalid/i.test(data.description || '')) return { member: false };
    return { error: `The bot cannot check ${chat} yet (it must be an admin there)` };
  }
  const st = data.result && data.result.status;
  return { member: ['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && Boolean(data.result.is_member)) };
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
