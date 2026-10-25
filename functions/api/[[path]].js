// Cloudflare Pages Function: everything under /api on hgybot.pages.dev
//   /api/clans/:teamId/members -> public clan-players ranking for any clan (no login needed),
//                                 or pw.game directly for HEGEMONY when a PW_AUTHORIZATION / PW_COOKIE secret is set
//   /api/platform, /api/giveaways, /api/rewards, /api/tasks -> our own D1 store (worker/hgy-store.js)
//   /api/telegram/webhook, /api/telegram/setup -> bot welcome message, commands and profile (worker/telegram-bot.js)
//   anything else              -> the existing data API (mrktsticker.alwaysdata.net)

import { handleClanMembers as handleHegemonyFromGame } from '../../worker/hegemony-members-worker.js';
import { handleClanMembers } from '../../worker/clan-points.js';
import { handleStore } from '../../worker/hgy-store.js';
import { handleTelegram } from '../../worker/telegram-bot.js';

const UPSTREAM_API = 'https://mrktsticker.alwaysdata.net/api';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const botRes = await handleTelegram(request, env);
  if (botRes) return botRes;

  const storeRes = await handleStore(request, env, context);
  if (storeRes) return storeRes;

  if ((env.PW_AUTHORIZATION || env.PW_COOKIE) && /^\/api\/clans\/5\/members\/?$/.test(url.pathname)) {
    return handleHegemonyFromGame(request, env, context);
  }
  const clanRes = await handleClanMembers(request, env, context);
  if (clanRes) return clanRes;

  const upstreamUrl = UPSTREAM_API + url.pathname.replace(/^\/api/, '') + url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cookie');
  // The signed Telegram login is for our own API only, never for the third-party data API
  headers.delete('x-telegram-init-data');

  return fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  });
}
