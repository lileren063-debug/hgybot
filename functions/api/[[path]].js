// Cloudflare Pages Function: everything under /api on hgybot.pages.dev
//   /api/clans/5/members -> pw.game (needs the PW_COOKIE secret on this Pages project)
//   anything else        -> the existing data API (mrktsticker.alwaysdata.net)

import { handleClanMembers } from '../../worker/hegemony-members-worker.js';

const UPSTREAM_API = 'https://mrktsticker.alwaysdata.net/api';

export async function onRequest(context) {
  const { request, env } = context;

  const clanRes = await handleClanMembers(request, env, context);
  if (clanRes) return clanRes;

  const url = new URL(request.url);
  const upstreamUrl = UPSTREAM_API + url.pathname.replace(/^\/api/, '') + url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cookie');

  return fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  });
}
