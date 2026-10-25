// Telegram bot side of @PWCLANapp: welcome message, commands and the bot's profile texts.
//
//   POST /api/telegram/webhook  Telegram sends chat messages here (checked with a secret derived from BOT_TOKEN)
//   POST /api/telegram/setup    main admin only (signed initData): sets name, descriptions, commands,
//                               menu button and the webhook, in English and Turkish
//
// No extra secret is needed: everything uses the BOT_TOKEN that is already set on the Pages project.

import { verifyInitData } from './hgy-store.js';

const DEFAULT_SUPER_ADMIN_IDS = '1563597048'; // @erenlil, same default as hgy-store.js

const TEXT = {
  en: {
    name: 'Clan Giveaways & Rewards',
    short: 'Join clan giveaways, complete tasks, earn Points and claim rewards from Pixel World clans.',
    description: [
      '🎁 Clan Giveaways & Rewards',
      '',
      'One place for the giveaways and rewards of Pixel World clans.',
      '',
      '🎯 Complete tasks and earn Points',
      '🎁 Join giveaways from every clan',
      '🏆 Spend your Points in the rewards shop',
      '🛡 Link your Pixel World player for clan tasks',
      '',
      'Tap Start to begin.'
    ].join('\n'),
    commands: [
      ['start', 'Open the app'],
      ['giveaways', 'Active giveaways'],
      ['tasks', 'Tasks that earn Points'],
      ['rewards', 'Rewards shop'],
      ['leaderboard', 'Points leaderboard by clan'],
      ['profile', 'Your Points and linked player'],
      ['help', 'How the bot works']
    ],
    menu: 'Open App',
    welcome: name => [
      `👋 Welcome, <b>${name}</b>!`,
      '',
      '<b>Clan Giveaways &amp; Rewards</b> brings together the giveaways and rewards of Pixel World clans.',
      '',
      '🎯 Complete tasks and earn <b>Points</b>',
      '🎁 Join giveaways with your Points',
      '🏆 Claim rewards from the shop',
      '🛡 Link your Pixel World player in Profile to join clan tasks',
      '',
      '⭐ Start with the tasks for everyone: follow @HegemonyGames (+100) and join @hegemonyprivate (+50).',
      '',
      'Tap the button below to open the app.'
    ].join('\n'),
    help: [
      '<b>How it works</b>',
      '',
      '1️⃣ Open the app and finish tasks to earn <b>Points</b>.',
      '2️⃣ Use Points to join giveaways or claim rewards.',
      '3️⃣ Clan tasks and clan-only giveaways need your Pixel World player: link it in Profile.',
      '4️⃣ Giveaway winners are picked by the server when the timer ends, so everyone sees the same result.',
      '',
      'Commands: /giveaways /tasks /rewards /leaderboard /profile'
    ].join('\n'),
    pages: {
      giveaways: '🎁 See the active giveaways of all clans:',
      tasks: '🎯 Finish tasks to earn Points:',
      rewards: '🏆 Spend your Points in the rewards shop:',
      leaderboard: '🏅 Who has the most Points, per clan:',
      profile: '💎 Your Points, clan and linked player:'
    },
    other: 'Tap <b>Open App</b> to use the bot, or send /help.',
    btn: { open: '🚀 Open App', giveaways: '🎁 Giveaways', tasks: '🎯 Tasks', rewards: '🏆 Rewards', leaderboard: '🏅 Leaderboard', profile: '💎 Profile', channel: '📢 @HegemonyGames' }
  },
  tr: {
    name: 'Klan Çekilişleri & Ödüller',
    short: 'Pixel World klanlarının çekilişlerine katıl, görevleri tamamla, Puan kazan ve ödülleri al.',
    description: [
      '🎁 Klan Çekilişleri & Ödüller',
      '',
      'Pixel World klanlarının çekiliş ve ödülleri tek yerde.',
      '',
      '🎯 Görevleri tamamla, Puan kazan',
      '🎁 Tüm klanların çekilişlerine katıl',
      '🏆 Puanlarını ödül mağazasında harca',
      '🛡 Klan görevleri için Pixel World oyuncunu bağla',
      '',
      'Başlamak için Başlat\'a dokun.'
    ].join('\n'),
    commands: [
      ['start', 'Uygulamayı aç'],
      ['giveaways', 'Aktif çekilişler'],
      ['tasks', 'Puan kazandıran görevler'],
      ['rewards', 'Ödül mağazası'],
      ['leaderboard', 'Klanlara göre puan sıralaması'],
      ['profile', 'Puanların ve bağlı oyuncun'],
      ['help', 'Bot nasıl çalışır']
    ],
    menu: 'Uygulamayı Aç',
    welcome: name => [
      `👋 Hoş geldin, <b>${name}</b>!`,
      '',
      '<b>Klan Çekilişleri &amp; Ödüller</b>, Pixel World klanlarının çekiliş ve ödüllerini bir araya getirir.',
      '',
      '🎯 Görevleri tamamla, <b>Puan</b> kazan',
      '🎁 Puanlarınla çekilişlere katıl',
      '🏆 Mağazadan ödül al',
      '🛡 Klan görevleri için Profil\'den Pixel World oyuncunu bağla',
      '',
      '⭐ Herkese açık görevlerle başla: @HegemonyGames\'i takip et (+100), @hegemonyprivate\'a katıl (+50).',
      '',
      'Uygulamayı açmak için aşağıdaki butona dokun.'
    ].join('\n'),
    help: [
      '<b>Nasıl çalışır</b>',
      '',
      '1️⃣ Uygulamayı aç, görevleri bitir ve <b>Puan</b> kazan.',
      '2️⃣ Puanlarınla çekilişlere katıl veya ödül al.',
      '3️⃣ Klan görevleri ve klana özel çekilişler için Profil\'den Pixel World oyuncunu bağla.',
      '4️⃣ Çekiliş süresi bitince kazananı sunucu seçer, herkes aynı sonucu görür.',
      '',
      'Komutlar: /giveaways /tasks /rewards /leaderboard /profile'
    ].join('\n'),
    pages: {
      giveaways: '🎁 Tüm klanların aktif çekilişleri:',
      tasks: '🎯 Görevleri bitir, Puan kazan:',
      rewards: '🏆 Puanlarını ödül mağazasında harca:',
      leaderboard: '🏅 Klanlara göre en çok Puanı olanlar:',
      profile: '💎 Puanların, klanın ve bağlı oyuncun:'
    },
    other: 'Botu kullanmak için <b>Uygulamayı Aç</b>\'a dokun ya da /help yaz.',
    btn: { open: '🚀 Uygulamayı Aç', giveaways: '🎁 Çekilişler', tasks: '🎯 Görevler', rewards: '🏆 Ödüller', leaderboard: '🏅 Sıralama', profile: '💎 Profil', channel: '📢 @HegemonyGames' }
  }
};

const PAGES = ['giveaways', 'tasks', 'rewards', 'leaderboard', 'profile'];

export async function handleTelegram(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '/api/telegram/webhook' && path !== '/api/telegram/setup') return null;
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  if (!env.BOT_TOKEN) return json({ ok: false, error: 'BOT_TOKEN is not set on the server' }, 500);

  if (path === '/api/telegram/webhook') {
    const secret = await webhookSecret(env.BOT_TOKEN);
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return json({ ok: false }, 401);
    const update = await request.json().catch(() => null);
    const reply = update ? buildReply(update, url.origin) : null;
    // Everyone who writes to the bot privately can get the daily broadcast
    const from = reply && update.message.from;
    if (from && env.DB) {
      try {
        await env.DB.prepare('INSERT OR IGNORE INTO users_seen (user_id, data, first_seen) VALUES (?, ?, ?)')
          .bind(String(from.id), JSON.stringify({ username: from.username || '', first_name: from.first_name || '' }), Date.now()).run();
        await env.DB.prepare('UPDATE users_seen SET blocked = 0 WHERE user_id = ?').bind(String(from.id)).run();
      } catch (e) { /* table not created yet: the app creates it on first use */ }
    }
    // Telegram runs a method returned in the webhook response, so no extra request is needed
    return reply ? json(reply) : json({ ok: true });
  }

  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
  const superIds = String(env.SUPER_ADMIN_IDS || DEFAULT_SUPER_ADMIN_IDS).split(',').map(s => s.trim()).filter(Boolean);
  if (!user || !superIds.includes(user.id)) return json({ ok: false, error: 'Only the main admin can do this' }, 403);
  return json(await setupBot(env.BOT_TOKEN, url.origin));
}

export function buildReply(update, origin) {
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return null;
  const t = TEXT[String((msg.from && msg.from.language_code) || '').toLowerCase().startsWith('tr') ? 'tr' : 'en'];
  const m = msg.text.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(\S+))?/i);
  const cmd = m ? m[1].toLowerCase() : '';
  const arg = m && m[2] ? m[2] : '';

  const app = startapp => ({ text: t.btn.open, web_app: { url: startapp ? `${origin}/?startapp=${encodeURIComponent(startapp)}` : `${origin}/` } });
  const pageBtn = p => ({ text: t.btn[p], web_app: { url: `${origin}/?startapp=${p}` } });
  const send = (text, keyboard) => ({
    method: 'sendMessage',
    chat_id: msg.chat.id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });

  if (cmd === 'start') {
    // t.me/PWCLANapp?start=giveaway_xxx style links open the app on that item
    const payload = /^[A-Za-z0-9_-]{1,64}$/.test(arg) ? arg : '';
    const name = escapeHtml(String((msg.from && msg.from.first_name) || 'there').slice(0, 64));
    return send(t.welcome(name), [
      [app(payload)],
      [pageBtn('tasks'), pageBtn('giveaways')],
      [{ text: t.btn.channel, url: 'https://t.me/HegemonyGames' }]
    ]);
  }
  if (cmd === 'help') return send(t.help, [[app('')]]);
  if (PAGES.includes(cmd)) return send(t.pages[cmd], [[pageBtn(cmd)]]);
  return send(t.other, [[app('')]]);
}

async function setupBot(token, origin) {
  const call = async (method, params) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {})
      });
      const data = await res.json().catch(() => ({}));
      return data.ok ? { ok: true, result: data.result } : { ok: false, error: data.description || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: 'Telegram unreachable' };
    }
  };

  const before = await call('getWebhookInfo');
  const steps = [];
  const run = async (label, method, params) => {
    const r = await call(method, params);
    steps.push({ step: label, ok: r.ok, error: r.ok ? undefined : r.error });
  };

  for (const [lang, t] of [['', TEXT.en], ['tr', TEXT.tr]]) {
    const lc = lang ? { language_code: lang } : {};
    const tag = lang ? ' (TR)' : '';
    await run('Name' + tag, 'setMyName', { name: t.name, ...lc });
    await run('Description' + tag, 'setMyDescription', { description: t.description, ...lc });
    await run('Short description' + tag, 'setMyShortDescription', { short_description: t.short, ...lc });
    await run('Commands' + tag, 'setMyCommands', { commands: t.commands.map(([command, description]) => ({ command, description })), ...lc });
  }
  await run('Menu button', 'setChatMenuButton', { menu_button: { type: 'web_app', text: TEXT.en.menu, web_app: { url: `${origin}/` } } });
  await run('Welcome message (webhook)', 'setWebhook', {
    url: `${origin}/api/telegram/webhook`,
    secret_token: await webhookSecret(token),
    allowed_updates: ['message'],
    drop_pending_updates: true
  });

  const previous = before.ok ? before.result.url || '' : '';
  return {
    ok: true,
    all_ok: steps.every(s => s.ok),
    steps,
    previous_webhook: previous && previous !== `${origin}/api/telegram/webhook` ? previous : ''
  };
}

// Stable secret for Telegram's webhook header, derived from the token so no extra secret has to be set
async function webhookSecret(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hgy-webhook:${token}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
