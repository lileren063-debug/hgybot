// Cloudflare Pages Function: everything under /api on hgybot.pages.dev
//   /api/clans/5/members -> public clan-players ranking (no login needed),
//                           or pw.game directly when a PW_AUTHORIZATION / PW_COOKIE secret is set
//   anything else        -> the existing data API (mrktsticker.alwaysdata.net)

import { handleClanMembers } from '../../worker/hegemony-members-worker.js';
import { handleClanMembersFromUpstream } from '../../worker/hegemony-from-upstream.js';

const UPSTREAM_API = 'https://mrktsticker.alwaysdata.net/api';

export async function onRequest(context) {
  const { request, env } = context;

  const clanRes = (env.PW_AUTHORIZATION || env.PW_COOKIE)
    ? await handleClanMembers(request, env, context)
    : await handleClanMembersFromUpstream(request, env, context);
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
