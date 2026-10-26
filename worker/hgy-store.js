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
//   NOTIFY_IDS       optional: Telegram ids that get activity messages from the bot (default: Eren only)
//
// HGY points: the bot's own currency, one wallet per Telegram user, kept (no monthly reset):
//   task rewards - giveaway entries - reward claims
// In-game clan points are separate: they only decide clan-points tasks and clan membership.

import { getClanPlayers, resetMinuteOfDay } from './clan-points.js';

const DEFAULT_SUPER_ADMIN_IDS = '1563597048'; // @erenlil
const SEED_CLAN = {
  team_id: 5,
  name: 'HEGEMONY',
  avatar: 'https://static.pw.game/teams/34ca79e23c5a8670af7397dee3d9d815c10d8c4f255aa71dcc4c21859cd48c8b.jpg'
};
const SEED_STAFF = [{ team_id: 5, user_key: '5332662287', label: '@therizzller', role: 'clan_admin' }];
// Tasks with clan_id 0 are open to every user and managed by the main admin only
const GLOBAL_CLAN = { team_id: 0, name: 'All Clans', avatar: '', giveaways_enabled: false, tasks_enabled: true };
const SEED_GLOBAL_TASKS = [
  { title: 'Follow HegemonyGames', chat: '@HegemonyGames', reward: 100 },
  { title: 'Join the hegemonyprivate chat', chat: '@hegemonyprivate', reward: 50 }
];

// Entries and claims before this were paid with clan points, not HGY points
const HGY_SPEND_SINCE = Date.parse('2026-10-25T05:30:00Z');
const INIT_DATA_MAX_AGE_SECONDS = 7 * 86400;
const MAX_RECORD_BYTES = 1500000; // images are data URLs; D1 rows hold up to 2 MB
const TASK_KINDS = ['clan_points', 'telegram_join', 'manual'];
const TASK_PERIODS = ['daily', 'weekly', 'season', 'once'];
const PERIOD_RANGE = { daily: 'day', weekly: 'week', season: 'month' };

let schemaReady = false;

export async function handleStore(request, env, ctx) {
  const url = new URL(request.url);
  const kind = url.pathname.replace(/\/+$/, '');
  const handlers = { '/api/platform': platform, '/api/giveaways': giveaways, '/api/rewards': rewards, '/api/tasks': tasks, '/api/cron/daily': cronDaily, '/api/leaderboard': leaderboard };
  const handler = handlers[kind];
  if (kind === '/api/announce-image' && env.DB) return serveAnnouncementImage(env.DB);
  if (!handler) return null;

  if (!env.DB) {
    return json({ ok: false, error: 'DB (D1) binding is not set on the Pages project' }, 500);
  }
  await ensureSchema(env.DB);

  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
  const superIds = String(env.SUPER_ADMIN_IDS || DEFAULT_SUPER_ADMIN_IDS).split(',').map(s => s.trim()).filter(Boolean);
  const app = { db: env.DB, env, ctx, origin: url.origin, user, isSuper: Boolean(user && superIds.includes(user.id)) };
  // Activity messages go only to Eren unless NOTIFY_IDS says otherwise
  app.notifyIds = String(env.NOTIFY_IDS || DEFAULT_SUPER_ADMIN_IDS).split(',').map(s => s.trim()).filter(Boolean);
  if (user) await noteFirstVisit(app);
  // Any visit may post today's announcement once it is due; /api/cron/daily is the hourly backup
  if (ctx && ctx.waitUntil && kind !== '/api/cron/daily') ctx.waitUntil(sendDailyAnnouncement(app).catch(() => null));

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
    return json({ ok: true, ...result, ...(app.warning ? { warning: app.warning } : {}) });
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
    db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS users_seen (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, first_seen INTEGER NOT NULL)')
  ]);
  // Giveaways and rewards from before the multi-clan version belong to HEGEMONY
  for (const table of ['giveaways', 'rewards']) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN clan_id INTEGER NOT NULL DEFAULT ${SEED_CLAN.team_id}`).run();
    } catch (e) { /* column already there */ }
  }
  try {
    // Users who blocked the bot are skipped by the daily broadcast
    await db.prepare('ALTER TABLE users_seen ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) { /* column already there */ }
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
  const seededTasks = await db.prepare("SELECT value FROM meta WHERE key = 'seeded_global_tasks_v1'").first();
  if (!seededTasks) {
    const now = Date.now();
    await db.batch([
      ...SEED_GLOBAL_TASKS.map((t, i) => {
        const task = {
          id: `tk_global_${i + 1}`,
          kind: 'telegram_join',
          title: t.title,
          description: '',
          reward: t.reward,
          chat: t.chat,
          url: 'https://t.me/' + t.chat.slice(1),
          period: 'once',
          createdBy: 'seed',
          createdByName: 'HEGEMONY',
          createdAt: now
        };
        return db.prepare('INSERT OR IGNORE INTO tasks (id, clan_id, data, created_at) VALUES (?, 0, ?, ?)').bind(task.id, JSON.stringify(task), now + SEED_GLOBAL_TASKS.length - i); // newest first, so keep list order
      }),
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_global_tasks_v1', ?)").bind(String(now))
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

async function getTaskClan(db, teamId) {
  return Number(teamId) === 0 ? GLOBAL_CLAN : getClan(db, teamId);
}

async function canManageTasks(app, teamId) {
  return Number(teamId) === 0 ? app.isSuper : can(app, teamId, 'tasks');
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
  if (app.inspect) out.inspect = app.inspect;
  if (app.isSuper) {
    out.announce = await getAnnouncement(app.db);
    out.announce.broadcast = await broadcastStatus(app.db);
    const reset = await app.db.prepare("SELECT value FROM meta WHERE key = 'game_reset_v1'").first();
    out.game_reset_minute = resetMinuteOfDay(reset ? JSON.parse(reset.value) : null);
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
    notifyAdmins(app, `🔗 <b>Oyuncu bağladı</b>\n${who(app.user)}\nPixel World: ${esc(player ? player.nickname : body.nickname || uuid)}${player && player.clan_name ? ' (' + esc(player.clan_name) + ')' : ''}`);
    return {};
  }
  if (action === 'unlink') {
    await db.prepare('DELETE FROM user_links WHERE user_id = ?').bind(app.user.id).run();
    return {};
  }

  // Everything else belongs to the main admin
  if (!app.isSuper) return { error: 'Only the main admin can do this', status: 403 };

  if (action === 'announce_save' || action === 'announce_send_now') {
    const a = body.announce || {};
    const prev = await getAnnouncement(db);
    const next = {
      enabled: Boolean(a.enabled),
      chats: cleanText(a.chats, 300).split(/[\s,]+/).filter(c => /^(@[A-Za-z0-9_]{4,64}|-?\d{5,20})$/.test(c)).slice(0, 5),
      to_users: Boolean(a.to_users),
      image: await saveAnnouncementImage(app, a.image, prev.image),
      text: cleanText(a.text, 3500),
      hour: Math.min(23, Math.max(0, Math.floor(Number(a.hour) || 0))),
      last_sent: prev.last_sent
    };
    const noTarget = !next.text || (!next.chats.length && !next.to_users);
    if (next.enabled && noTarget) return { error: 'Enter the message and choose all bot users or at least one chat (@channel or chat id)' };
    if (action === 'announce_send_now') {
      if (noTarget) return { error: 'Enter the message and choose who gets it first' };
      // Counts as today's message, so nobody gets it twice today
      next.last_sent = new Date().toISOString().slice(0, 10);
    }
    await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('announce_v1', ?)").bind(JSON.stringify(next)).run();
    if (action === 'announce_send_now') {
      if (next.to_users) await startBroadcast(app, next, next.last_sent);
      const results = await postAnnouncement(app, next);
      const failed = results.filter(r => !r.ok).map(f => `${f.chat}: ${f.error}`).join(' • ');
      // With private messages running, a bad channel must not stop them; it is reported as a warning
      if (failed && !next.to_users) return { error: failed };
      if (failed) app.warning = failed;
    }
    return {};
  }

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
  if (action === 'inspect') {
    app.inspect = await inspectPlayer(app, cleanText(body.value, 64).replace(/^@/, ''));
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

// Points leaderboard: every user's Points (same formula as the wallet), grouped by their linked clan
async function leaderboard(app) {
  const db = app.db;
  const since = HGY_SPEND_SINCE;
  const rows = (await db.prepare(`
    WITH ids AS (
      SELECT user_id FROM task_claims WHERE status = 'done'
      UNION SELECT user_id FROM giveaway_participants
      UNION SELECT user_id FROM reward_claims
    )
    SELECT ids.user_id AS user_id,
      (SELECT COALESCE(SUM(points), 0) FROM task_claims t WHERE t.user_id = ids.user_id AND t.status = 'done') AS earned,
      (SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) FROM giveaway_participants g WHERE g.user_id = ids.user_id AND g.joined_at >= ?) +
      (SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) FROM reward_claims r WHERE r.user_id = ids.user_id AND r.claimed_at >= ?) AS spent,
      (SELECT COUNT(*) FROM task_claims t WHERE t.user_id = ids.user_id AND t.status = 'done') AS tasks,
      l.nickname AS nickname, l.team_id AS team_id, l.clan_name AS clan_name, s.data AS tg
    FROM ids
    LEFT JOIN user_links l ON l.user_id = ids.user_id
    LEFT JOIN users_seen s ON s.user_id = ids.user_id
  `).bind(since, since).all()).results;

  const clans = new Map((await listClans(db)).map(c => [c.team_id, c]));
  const players = rows.map(r => {
    let tg = {};
    try { tg = JSON.parse(r.tg || '{}'); } catch (e) { /* ignore */ }
    const teamId = Number(r.team_id) || 0;
    const clan = clans.get(teamId);
    return {
      name: r.nickname || tg.first_name || (tg.username ? '@' + tg.username : 'Player'),
      team_id: teamId,
      clan_name: clan ? clan.name : (r.clan_name || ''),
      clan_avatar: clan ? clan.avatar : '',
      points: (Number(r.earned) || 0) - (Number(r.spent) || 0),
      earned: Number(r.earned) || 0,
      tasks: Number(r.tasks) || 0,
      me: Boolean(app.user && app.user.id === r.user_id)
    };
  }).filter(p => p.earned > 0).sort((a, b) => b.points - a.points || b.earned - a.earned);

  const byClan = new Map();
  for (const p of players) {
    const key = p.team_id || 0;
    const c = byClan.get(key) || { team_id: key, clan_name: p.clan_name || 'No clan', clan_avatar: p.clan_avatar, points: 0, earned: 0, players: 0 };
    c.points += p.points;
    c.earned += p.earned;
    c.players += 1;
    byClan.set(key, c);
  }
  const clanTotals = [...byClan.values()].sort((a, b) => b.points - a.points);
  return { items: players.slice(0, 300), clans: clanTotals };
}

// Main admin support tool: everything the server knows about one player (UUID, Telegram id or @username)
async function inspectPlayer(app, q) {
  const db = app.db;
  if (!q) return { error: 'Enter a player UUID, Telegram id or @username' };
  let link = await db.prepare('SELECT user_id, uuid, nickname, team_id, clan_name, linked_at FROM user_links WHERE uuid = ? OR user_id = ?').bind(q, q).first();
  let seen = null;
  if (!link) {
    seen = await db.prepare("SELECT user_id, data, first_seen, blocked FROM users_seen WHERE user_id = ? OR lower(json_extract(data, '$.username')) = lower(?)").bind(q, q).first();
    if (seen) link = await db.prepare('SELECT user_id, uuid, nickname, team_id, clan_name, linked_at FROM user_links WHERE user_id = ?').bind(seen.user_id).first();
  }
  const userId = link ? link.user_id : seen ? seen.user_id : (/^\d{4,20}$/.test(q) ? q : '');
  if (!seen && userId) seen = await db.prepare('SELECT user_id, data, first_seen, blocked FROM users_seen WHERE user_id = ?').bind(userId).first();
  const uuid = link ? link.uuid : (/^[A-Za-z0-9-]{20,64}$/.test(q) ? q : '');

  const out = { query: q, telegram_id: userId, uuid, problems: [] };
  out.telegram = seen ? { ...JSON.parse(seen.data || '{}'), first_seen: seen.first_seen, blocked: Boolean(seen.blocked) } : null;
  out.link = link ? { uuid: link.uuid, nickname: link.nickname, team_id: Number(link.team_id), clan_name: link.clan_name, linked_at: link.linked_at } : null;

  // Live game ranking for this uuid
  if (uuid) {
    out.ranking = {};
    for (const range of ['day', 'week', 'month']) {
      try {
        const p = await findPlayer(app, range, uuid);
        out.ranking[range] = p ? { nickname: p.nickname, team_id: p.team_id, clan_name: p.clan_name, points: p.points, rank: p.global_rank } : null;
      } catch (e) {
        out.ranking[range] = 'game data unavailable';
      }
    }
  }

  if (userId) {
    const since = HGY_SPEND_SINCE;
    const [claims, entries, rclaims, earned, gwSpent, rwSpent] = await Promise.all([
      db.prepare('SELECT task_id, period_key, status, points, created_at FROM task_claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(userId).all(),
      db.prepare('SELECT giveaway_id, data, joined_at FROM giveaway_participants WHERE user_id = ? ORDER BY joined_at DESC LIMIT 20').bind(userId).all(),
      db.prepare('SELECT reward_id, data, claimed_at FROM reward_claims WHERE user_id = ? ORDER BY claimed_at DESC LIMIT 20').bind(userId).all(),
      db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM task_claims WHERE user_id = ? AND status = 'done'").bind(userId).first(),
      db.prepare("SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) AS s FROM giveaway_participants WHERE user_id = ? AND joined_at >= ?").bind(userId, since).first(),
      db.prepare("SELECT COALESCE(SUM(json_extract(data, '$.paidPoints')), 0) AS s FROM reward_claims WHERE user_id = ? AND claimed_at >= ?").bind(userId, since).first()
    ]);
    const titles = new Map((await db.prepare('SELECT id, data FROM tasks').all()).results.map(r => [r.id, JSON.parse(r.data).title]));
    out.points = { earned: Number(earned.s) || 0, spent: (Number(gwSpent.s) || 0) + (Number(rwSpent.s) || 0) };
    out.points.balance = out.points.earned - out.points.spent;
    out.tasks = claims.results.map(c => ({ task: titles.get(c.task_id) || c.task_id, period: c.period_key, status: c.status, points: c.points, at: c.created_at }));
    out.giveaways = entries.results.map(e => ({ id: e.giveaway_id, paid: JSON.parse(e.data).paidPoints || 0, at: e.joined_at }));
    out.rewards = rclaims.results.map(e => ({ id: e.reward_id, paid: JSON.parse(e.data).paidPoints || 0, at: e.claimed_at }));
  }

  // Common causes, in plain words
  if (!out.telegram && !out.link) out.problems.push('This player never opened the app (or opened it outside Telegram).');
  if (uuid && !out.link) out.problems.push('No Telegram account has linked this Pixel World UUID yet.');
  if (out.link && out.ranking && out.ranking.month === null) out.problems.push('UUID not found in this month\'s game ranking (0 points this month or wrong UUID), so clan tasks/rewards cannot see their clan.');
  if (out.link && out.ranking && out.ranking.month && out.ranking.month.team_id && !(await db.prepare('SELECT 1 AS x FROM clans WHERE team_id = ?').bind(out.ranking.month.team_id).first())) {
    out.problems.push(`Their clan ${out.ranking.month.clan_name} (#${out.ranking.month.team_id}) is not added to the platform.`);
  }
  if (out.telegram && out.telegram.blocked) out.problems.push('They blocked the bot.');
  if (out.tasks && out.tasks.some(t => t.status === 'pending')) out.problems.push('They have task requests waiting for a clan admin.');
  return out;
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

// Points of one player for a range from the data API's player page (stats when ranked, else last_seen)
async function playerPagePoints(uuid, range) {
  try {
    const res = await fetch(`https://mrktsticker.alwaysdata.net/api/player/${encodeURIComponent(uuid)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();
    const stat = d && d.stats && d.stats[range] && d.stats[range].points;
    const seen = d && d.activity && d.activity.last_seen;
    const points = stat != null ? Number(stat) : seen && seen[range + '_points'] != null ? Number(seen[range + '_points']) : null;
    if (points == null) return null;
    const teamId = Number((d.clan && d.clan.team_id) || (seen && seen.clan_id)) || 0;
    return { uuid, points, team_id: teamId, clan_name: (d.clan && d.clan.name) || (seen && seen.clan_name) || '' };
  } catch (e) {
    return null;
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

async function getBalance(app, link) {
  const db = app.db;
  const userId = app.user.id;
  const since = HGY_SPEND_SINCE;
  const membership = await getMembership(app, link);
  const player = membership.player;
  const [earned, gw, rw] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(points), 0) AS s FROM task_claims WHERE user_id = ? AND status = 'done'").bind(userId).first(),
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
    balance: Math.max(0, taskPoints - spent),
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
    const prizeList = gw.prizes.map(p => p.name).filter(Boolean).join(', ');
    notifyAdmins(app, `🎉 <b>Yeni çekiliş</b> • ${esc(clan.name)}\n${who(user)}\n${esc(gw.title)}${prizeList ? '\n🏆 ' + esc(prizeList) : ''}\n🎟 ${gw.entryMode === 'points' ? gw.minPoints + ' Points' : 'Ücretsiz'}${gw.eligibleClan !== 'ALL' ? ' • sadece ' + esc(gw.eligibleClan) : ''}\n⏳ Bitiş: ${new Date(gw.endsAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
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
    notifyAdmins(app, `🗑 <b>Çekiliş silindi</b> • ${esc(await clanLabel(db, clanId))}\n${who(user)}\n${esc(gw.title)}`);
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
      // Clan-only giveaways need the linked player's clan; HGY points need no link
      if (restricted && !link) return { error: 'Link your Pixel World UUID in Profile first' };
      const bal = await getBalance(app, link);
      clanName = bal.clan_name;
      if (restricted && String(bal.clan_name).toLowerCase() !== String(gw.eligibleClan).toLowerCase()) {
        return { error: `Only ${gw.eligibleClan} members can join this giveaway` };
      }
      if (cost > bal.balance) {
        return { error: `Not enough points: you have ${bal.balance}, entry costs ${cost}` };
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
    notifyAdmins(app, `🎁 <b>Çekilişe katıldı</b>\n${who(user)}\n${esc(gw.title)}${cost ? ` (−${cost} Points)` : ''}`);
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
    const drawn = await db.prepare("UPDATE giveaways SET data = ? WHERE id = ? AND json_extract(data, '$.ended') = 0")
      .bind(JSON.stringify(gw), gw.id).run();
    if (drawn.meta && drawn.meta.changes) {
      const w = gw.winner;
      notifyAdmins(app, `🏁 <b>Çekiliş bitti</b> • ${esc(await clanLabel(db, clanId))}\n${esc(gw.title)}\n👥 Katılımcı: ${list.length}\n🥇 Kazanan: ${w && w.id ? `<a href="tg://user?id=${encodeURIComponent(w.id)}">${esc(w.name)}</a> • ID <code>${esc(w.id)}</code>` : 'yok'}`, true);
    }
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
    notifyAdmins(app, `🛍 <b>Yeni ödül</b> • ${esc(clan.name)}\n${who(user)}\n${esc(rw.name)} • ${rw.cost} Points • stok: ${rw.stock == null ? 'sınırsız' : rw.stock}`);
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
    notifyAdmins(app, `🗑 <b>Ödül silindi</b> • ${esc(await clanLabel(db, clanId))}\n${who(user)}\n${esc(rw.name)}`);
    return {};
  }

  if (body.action === 'claim') {
    const link = await getLink(db, user.id);
    if (!link) return { error: 'Link your Pixel World UUID in Profile first' };
    const bal = await getBalance(app, link);
    if (bal.team_id !== clanId) return { error: 'This reward is for members of its clan only' };
    if (rw.cost > bal.balance) return { error: `Not enough points: you have ${bal.balance}, this reward costs ${rw.cost}` };
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
    notifyAdmins(app, `🏆 <b>Ödül aldı</b>\n${who(user)}\n${esc(rw.name)} (−${rw.cost} Points)\nPixel World: ${esc(link.nickname || link.uuid)}${bal.clan_name ? ' (' + esc(bal.clan_name) + ')' : ''}`);
    return {};
  }

  return { error: 'Unknown action' };
}

// ---------------------------------------------------------------- tasks

// Daily: UTC date. Weekly: Monday of the UTC week. Season: UTC month (the game's monthly reset). Once: forever.
// Task periods follow the game's own reset hour. offsetMin moves the clock so that the game's reset
// falls on 00:00: +(1440 - R) for a reset late in the UTC day, -R for one early in it (R = reset minute).
export function periodOffset(resetMinute) {
  if (!resetMinute) return 0;
  return resetMinute >= 720 ? 1440 - resetMinute : -resetMinute;
}

async function getPeriodOffset(app) {
  if (app.periodOffset == null) {
    const row = await app.db.prepare("SELECT value FROM meta WHERE key = 'game_reset_v1'").first();
    app.periodOffset = periodOffset(resetMinuteOfDay(row ? JSON.parse(row.value) : null));
  }
  return app.periodOffset;
}

export function periodKey(period, at = new Date(), offsetMin = 0) {
  const now = new Date(at.getTime() + offsetMin * 60000);
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
      ? db.prepare('SELECT data, clan_id FROM tasks WHERE deleted = 0 AND clan_id IN (?, 0) ORDER BY clan_id = 0 DESC, created_at DESC').bind(clanId).all()
      : db.prepare('SELECT data, clan_id FROM tasks WHERE deleted = 0 ORDER BY clan_id = 0 DESC, created_at DESC').all()
  ]);
  clans.push(GLOBAL_CLAN);
  if (app.isSuper) perms[0] = { role: 'super', giveaways: false, tasks: true };
  const offset = await getPeriodOffset(app);

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
    t.periodKey = periodKey(t.period, new Date(), offset);
    t.canManage = manager;
    t.myStatus = null;
    items.push(t);
  }

  if (app.user && items.length) {
    const mine = await db.prepare('SELECT task_id, period_key, status FROM task_claims WHERE user_id = ?').bind(app.user.id).all();
    const byTask = new Map(mine.results.map(c => [c.task_id + '|' + c.period_key, c.status]));
    for (const t of items) t.myStatus = byTask.get(t.id + '|' + t.periodKey) || null;
    // Player points tasks of one clan and period stack: points used by one task cannot count for another
    const used = await usedPlayerPoints(db, app.user.id);
    for (const t of items) {
      if (t.kind === 'clan_points' && t.scope !== 'clan') {
        // The app compares these with the player's current points (see usedFor)
        t.usedClaims = (used.get(stackKey(t.clanId, t.period, t.periodKey)) || []).filter(c => c.task_id !== t.id).map(c => ({ target: c.target, value: c.value }));
      }
    }
  }

  // Manual tasks waiting for a decision, for the clans this user may review
  let pending = [];
  const reviewClans = Object.keys(perms).filter(id => perms[id].tasks && (!clanId || Number(id) === clanId || Number(id) === 0)).map(Number);
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
  delete perms[0];
  return { items, pending, period_offset_min: offset };
}

function stackKey(clanId, period, key) {
  return `${clanId}|${period}|${key}`;
}

// clan|period|periodKey -> this user's completed player points tasks in that period, with the points they had then
async function usedPlayerPoints(db, userId) {
  const rows = (await db.prepare(
    "SELECT c.task_id, c.period_key, c.data AS claim, t.clan_id, t.data FROM task_claims c JOIN tasks t ON t.id = c.task_id " +
    "WHERE c.user_id = ? AND c.status = 'done' AND json_extract(t.data, '$.kind') = 'clan_points'"
  ).bind(userId).all()).results;
  const used = new Map();
  for (const r of rows) {
    const t = JSON.parse(r.data);
    if (t.scope === 'clan') continue;
    const k = stackKey(Number(r.clan_id), t.period, r.period_key);
    if (!used.has(k)) used.set(k, []);
    used.get(k).push({ task_id: r.task_id, target: Number(t.target) || 0, value: Number(JSON.parse(r.claim || '{}').value) || 0 });
  }
  return used;
}

// Points used by earlier claims. The game's own day/week may reset at another hour than our UTC period:
// points only grow within one game period, so a claim made with more points than the player has now
// belongs to the previous game period and must not use up today's points.
function usedFor(claims, current) {
  return (claims || []).filter(c => c.value <= current).reduce((sum, c) => sum + c.target, 0);
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
    const clan = await getTaskClan(db, body.clan_id);
    if (!clan) return { error: 'Choose the clan this task belongs to' };
    if (!(await canManageTasks(app, clan.team_id))) return { error: `You cannot create tasks for ${clan.name}`, status: 403 };
    const t = body.task || {};
    const kind = TASK_KINDS.includes(t.kind) ? t.kind : '';
    if (!kind) return { error: 'Choose a task type' };
    if (clan.team_id === 0 && kind === 'clan_points') return { error: 'Points targets need a clan; choose a clan for this task' };
    const title = cleanText(t.title, 120);
    if (!title) return { error: 'Task title is required' };
    const reward = Math.floor(Number(t.reward) || 0);
    if (reward <= 0 || reward > 1000000) return { error: 'Reward must be between 1 and 1,000,000 points' };
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
    const what = kind === 'clan_points' ? `${task.target} PTS (${task.scope === 'clan' ? 'klan toplamı' : 'oyuncu'})` : kind === 'telegram_join' ? `${task.chat} katıl` : 'manuel onay';
    notifyAdmins(app, `📝 <b>Yeni görev</b> • ${esc(clan.name)}\n${who(user)}\n${esc(task.title)} • +${task.reward} Points\n${esc(what)} • ${esc(period)}`);
    return {};
  }

  const task = await getTask(db, body.task_id);
  if (!task) return { error: 'Task not found', status: 404 };

  if (body.action === 'delete') {
    if (!(await canManageTasks(app, task.clanId))) return { error: "You cannot manage this clan's tasks", status: 403 };
    // Soft delete: points already earned stay counted
    await db.prepare('UPDATE tasks SET deleted = 1 WHERE id = ?').bind(task.id).run();
    notifyAdmins(app, `🗑 <b>Görev silindi</b> • ${esc(await clanLabel(db, task.clanId))}\n${who(user)}\n${esc(task.title)}`);
    return {};
  }

  if (body.action === 'review') {
    if (!(await canManageTasks(app, task.clanId))) return { error: "You cannot review this clan's tasks", status: 403 };
    const approve = Boolean(body.approve);
    const res = await db.prepare("UPDATE task_claims SET status = ?, points = ?, decided_at = ? WHERE task_id = ? AND user_id = ? AND period_key = ? AND status = 'pending'")
      .bind(approve ? 'done' : 'rejected', approve ? task.reward : 0, now, task.id, String(body.user_id || ''), String(body.period_key || '')).run();
    if (!res.meta || !res.meta.changes) return { error: 'This request was already handled' };
    notifyAdmins(app, `${approve ? '✅ <b>Görev onaylandı</b>' : '❌ <b>Görev reddedildi</b>'} • ${esc(await clanLabel(db, task.clanId))}\n${who(user)}\n${esc(task.title)}${approve ? ` (+${task.reward} Points)` : ''} → ID <code>${esc(body.user_id)}</code>`);
    return {};
  }

  if (body.action === 'claim') {
    const clan = await getTaskClan(db, task.clanId);
    if (!clan || !clan.tasks_enabled) return { error: 'Tasks are turned off for this clan' };
    const forEveryone = clan.team_id === 0;
    const key = periodKey(task.period, new Date(), await getPeriodOffset(app));
    const existing = await db.prepare('SELECT status FROM task_claims WHERE task_id = ? AND user_id = ? AND period_key = ?').bind(task.id, user.id, key).first();
    if (existing && existing.status === 'done') return { error: 'You already completed this task' + (task.period === 'once' ? '' : ' for this period') };
    if (existing && existing.status === 'pending') return { error: 'Your request is waiting for an admin' };

    // Tasks for everyone need no Pixel World link; clan tasks need a linked member of that clan
    const link = await getLink(db, user.id);
    if (!link && !forEveryone) return { error: 'Link your Pixel World UUID in Profile first' };
    const notMember = { error: `This task is for ${clan.name} members only` };

    let status = 'done';
    const data = { name: displayName(user), uuid: link ? link.uuid : '' };
    if (task.kind === 'clan_points') {
      // Only this period's list is read: one request may build one list at most
      const players = await rankedPlayers(app, PERIOD_RANGE[task.period]);
      let me = players.find(p => p.uuid === link.uuid);
      // The ranking lists only the top ~900 players; anyone below is read from their own player page
      if (!me && task.scope !== 'clan') me = await playerPagePoints(link.uuid, PERIOD_RANGE[task.period]);
      if ((me ? me.team_id : link.team_id) !== task.clanId) return notMember;
      const value = task.scope === 'clan'
        ? players.filter(p => p.team_id === task.clanId).reduce((s, p) => s + p.points, 0)
        : (me ? me.points : 0);
      const usedPts = task.scope === 'clan' ? 0 : usedFor((await usedPlayerPoints(db, user.id)).get(stackKey(task.clanId, task.period, key)), value);
      if (value - usedPts < task.target) {
        return { error: usedPts
          ? `Not reached yet: ${Math.max(0, value - usedPts)} / ${task.target} PTS (${value} earned, ${usedPts} already used by your other tasks)`
          : `Not reached yet: ${value} / ${task.target} PTS` };
      }
      data.value = value;
      data.used_before = usedPts;
    } else if (!forEveryone && (await getMembership(app, link)).team_id !== task.clanId) {
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
    notifyAdmins(app, status === 'done'
      ? `🎯 <b>Görev tamamladı</b>\n${who(user)}\n${esc(task.title)} (+${task.reward} Points) • ${esc(clan.name)}`
      : `⏳ <b>Görev onayı bekliyor</b>\n${who(user)}\n${esc(task.title)} • ${esc(clan.name)}${data.note ? '\nNot: ' + esc(data.note) : ''}`);
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

// ---------------------------------------------------------------- daily announcement

const ANNOUNCE_DEFAULT = { enabled: false, chats: [], to_users: false, image: '', text: '', hour: 12, last_sent: '' };

// An uploaded photo is kept in D1 and served from our own URL, because Telegram fetches photos by URL
async function saveAnnouncementImage(app, value, previous) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v === previous) return v;
  if (/^https:\/\/\S{5,500}$/.test(v)) return v;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= MAX_RECORD_BYTES) {
    await app.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('announce_img', ?)").bind(v).run();
    return `${app.origin}/api/announce-image?v=${Date.now()}`;
  }
  return '';
}

async function serveAnnouncementImage(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'announce_img'").first().catch(() => null);
  const m = row && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(row.value);
  if (!m) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=300' } });
}

// Photo with the text as caption (Telegram allows 1024 caption characters; longer text follows as its own message)
async function sendAnnouncementTo(token, chatId, a, replyMarkup) {
  const call = async (method, params) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...params, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
    });
    return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  };
  if (a.image && a.text.length <= 1024) return call('sendPhoto', { photo: a.image, caption: a.text });
  if (a.image) {
    const photo = await call('sendPhoto', { photo: a.image });
    if (!photo.ok) return photo;
  }
  return call('sendMessage', { text: a.text, disable_web_page_preview: true });
}
// Free Workers plans allow 50 outgoing requests per call, so private messages go out in batches
const BROADCAST_BATCH = 22;

async function getAnnouncement(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'announce_v1'").first();
  try {
    return { ...ANNOUNCE_DEFAULT, ...(row ? JSON.parse(row.value) : {}) };
  } catch (e) {
    return { ...ANNOUNCE_DEFAULT };
  }
}

// Called by the hourly cron and by app visits; the compare-and-swap on meta makes sure it goes out once a day
async function sendDailyAnnouncement(app) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const row = await app.db.prepare("SELECT value FROM meta WHERE key = 'announce_v1'").first();
  if (!row) return { sent: false };
  const a = { ...ANNOUNCE_DEFAULT, ...JSON.parse(row.value) };
  if (!a.enabled || !a.text || (!a.chats.length && !a.to_users) || a.last_sent === today || now.getUTCHours() < a.hour) return { sent: false };
  const claimed = await app.db.prepare("UPDATE meta SET value = ? WHERE key = 'announce_v1' AND value = ?")
    .bind(JSON.stringify({ ...a, last_sent: today }), row.value).run();
  if (!claimed.meta || !claimed.meta.changes) return { sent: false };
  if (a.to_users) await startBroadcast(app, a, today);
  await postAnnouncement(app, a);
  return { sent: true };
}

async function postAnnouncement(app, a) {
  const token = app.env.BOT_TOKEN;
  if (!token) return a.chats.map(chat => ({ chat, ok: false, error: 'BOT_TOKEN is not set' }));
  return Promise.all(a.chats.map(async chat => {
    try {
      const data = await sendAnnouncementTo(token, chat, a, null);
      return data.ok ? { chat, ok: true } : { chat, ok: false, error: data.description || 'Telegram error' };
    } catch (e) {
      return { chat, ok: false, error: 'Telegram unreachable' };
    }
  }));
}

// Private messages to everyone who used the bot or the app, sent in batches by /api/cron/daily
async function startBroadcast(app, a, date) {
  const state = { date, text: a.text, image: a.image || '', cursor: 0, sent: 0, failed: 0, done: false };
  await app.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('announce_bc', ?)").bind(JSON.stringify(state)).run();
}

async function broadcastStatus(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'announce_bc'").first();
  const total = await db.prepare('SELECT COUNT(*) AS n FROM users_seen WHERE blocked = 0').first();
  const state = row ? JSON.parse(row.value) : null;
  return { users: total ? Number(total.n) : 0, date: state ? state.date : '', sent: state ? state.sent : 0, failed: state ? state.failed : 0, done: state ? state.done : true };
}

async function continueBroadcast(app) {
  const db = app.db;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'announce_bc'").first();
  if (!row) return { done: true };
  const state = JSON.parse(row.value);
  if (state.done) return { done: true };
  const batch = (await db.prepare('SELECT rowid AS rid, user_id FROM users_seen WHERE rowid > ? AND blocked = 0 ORDER BY rowid LIMIT ?')
    .bind(state.cursor, BROADCAST_BATCH).all()).results;
  const next = { ...state, cursor: batch.length ? batch[batch.length - 1].rid : state.cursor, done: batch.length < BROADCAST_BATCH };
  // Claim this batch first, so two calls never message the same people
  const claimed = await db.prepare("UPDATE meta SET value = ? WHERE key = 'announce_bc' AND value = ?").bind(JSON.stringify(next), row.value).run();
  if (!claimed.meta || !claimed.meta.changes) return { done: false };

  const token = app.env.BOT_TOKEN;
  const keyboard = { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: `${app.origin}/` } }]] };
  let sent = 0;
  let failed = 0;
  const blocked = [];
  await Promise.all(batch.map(async u => {
    try {
      const data = await sendAnnouncementTo(token, u.user_id, state, keyboard);
      if (data.ok) sent++;
      else {
        failed++;
        // 403: the user blocked the bot or never started it
        if (data.error_code === 403) blocked.push(u.user_id);
      }
    } catch (e) {
      failed++;
    }
  }));
  if (blocked.length) {
    await db.batch(blocked.map(id => db.prepare('UPDATE users_seen SET blocked = 1 WHERE user_id = ?').bind(id)));
  }
  // Counters are best effort; the cursor above is what prevents double messages
  const cur = await db.prepare("SELECT value FROM meta WHERE key = 'announce_bc'").first();
  if (cur) {
    const st = JSON.parse(cur.value);
    await db.prepare("UPDATE meta SET value = ? WHERE key = 'announce_bc' AND value = ?")
      .bind(JSON.stringify({ ...st, sent: st.sent + sent, failed: st.failed + failed }), cur.value).run();
  }
  return { done: next.done, sent, failed };
}

async function cronDaily(app) {
  const daily = await sendDailyAnnouncement(app);
  const broadcast = await continueBroadcast(app);
  return { sent: daily.sent, broadcast };
}

// ---------------------------------------------------------------- activity messages

// Telegram ids already recorded in this worker instance, so a returning user costs no write
const seenUsers = new Set();

async function noteFirstVisit(app) {
  const u = app.user;
  if (seenUsers.has(u.id)) return;
  const res = await app.db.prepare('INSERT OR IGNORE INTO users_seen (user_id, data, first_seen) VALUES (?, ?, ?)')
    .bind(u.id, JSON.stringify({ username: u.username, first_name: u.first_name }), Date.now()).run();
  seenUsers.add(u.id);
  if (res.meta && res.meta.changes) {
    const total = await app.db.prepare('SELECT COUNT(*) AS n FROM users_seen').first();
    notifyAdmins(app, `🆕 <b>Uygulamaya yeni giriş</b>\n${who(u)}\nToplam kullanıcı: ${total ? total.n : '?'}`);
  }
}

// Sends a short message from the bot to the main admin(s); never slows down or breaks the user's request.
// The main admin's own actions are not reported.
function notifyAdmins(app, html, always = false) {
  const token = app.env.BOT_TOKEN;
  if (!token || (!always && (!app.user || app.notifyIds.includes(app.user.id)))) return;
  const send = Promise.all(app.notifyIds.map(chatId => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(() => null)));
  if (app.ctx && app.ctx.waitUntil) app.ctx.waitUntil(send);
}

async function clanLabel(db, teamId) {
  if (Number(teamId) === 0) return 'Herkes';
  const c = await db.prepare('SELECT name FROM clans WHERE team_id = ?').bind(Number(teamId)).first();
  return c ? c.name : '#' + teamId;
}

function who(user) {
  const name = esc(user.first_name || user.username || 'Player');
  return `👤 <a href="tg://user?id=${encodeURIComponent(user.id)}">${name}</a>${user.username ? ' @' + esc(user.username) : ''} • ID <code>${esc(user.id)}</code>`;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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
