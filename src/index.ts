/**
 * adserver — request router.
 *
 * Public surface (must stay open):
 *   GET /ads.js              drop-in loader
 *   GET /z/<zoneId>.js       zone-bound loader (Revive-style invocation code)
 *   GET /api/serve           ad selection + delivery (iframe doc or JSON)
 *   GET /api/click           signed click redirect
 *   GET /t/imp.gif           1x1 impression beacon (inline zones)
 *   GET /i/<bannerId>        creative image from R2
 *   GET /c/<bannerId>        HTML5 creative document (CSP-sandboxed)
 *   GET /c/fallback/<zoneId> zone fallback document
 *
 * Protected surface (Cloudflare Access + verified JWT):
 *   /admin*         management console (static shell)
 *   /api/admin/*    admin API
 */

import { requireAdmin } from './access.ts';
import { handleAdmin } from './admin.ts';
import { handleCreative, handleFallbackCreative, handleImage } from './assets.ts';
import { getZone } from './db.ts';
import { baseUrlOf, handleServe } from './serve.ts';
import { handleClick, handleImpressionBeacon } from './track.ts';
import type { Env } from './types.ts';
import { error, escapeHtml, json, toInt } from './util.ts';

const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "frame-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let loaderCache: { text: string; at: number } | null = null;

async function loaderBody(env: Env, request: Request): Promise<string> {
  const now = Date.now();
  if (loaderCache && now - loaderCache.at < 60_000) return loaderCache.text;
  const response = await env.ASSETS.fetch(new Request(new URL('/ads.js', request.url).toString()));
  const text = response.ok ? await response.text() : '';
  if (response.ok) loaderCache = { text, at: now };
  return text;
}

function jsResponse(body: string, maxAge: number): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    },
  });
}

async function zoneLoader(env: Env, request: Request, zoneId: number): Promise<Response> {
  const zone = await getZone(env, zoneId);
  if (!zone || !zone.active) return error(404, 'unknown or inactive zone');

  const body = await loaderBody(env, request);
  if (!body) return error(503, 'loader asset missing');

  const prelude =
    `window.__ADSRV_ZONE__=${JSON.stringify({
      id: zone.id,
      name: zone.name,
      width: zone.width,
      height: zone.height,
      mode: zone.mode,
      autoHeight: zone.auto_height === 1,
    })};\n`;

  return jsResponse(prelude + body, 120);
}

/**
 * Local development: a browser navigation cannot set the x-dev-admin-token
 * header, so when the dev bypass is active the shell carries the token in a
 * meta tag that the console reads and replays as a header. This is only ever
 * emitted when ENVIRONMENT === 'dev' and ACCESS_DEV_TOKEN is set.
 */
async function finalizeShell(response: Response, env: Env, devMode: boolean): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', ADMIN_CSP);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.delete('content-length');

  const isHtml = (headers.get('content-type') ?? '').includes('text/html');
  if (devMode && isHtml && env.ACCESS_DEV_TOKEN) {
    const html = await response.text();
    const injected = html.replace(
      '</head>',
      `<meta name="adsrv-dev-token" content="${escapeHtml(env.ACCESS_DEV_TOKEN)}">\n</head>`,
    );
    return new Response(injected, { status: response.status, headers });
  }

  return new Response(response.body, { status: response.status, headers });
}

async function adminShell(request: Request, env: Env): Promise<Response> {
  // In local dev the token bypass governs; otherwise Access already fronts
  // /admin* at the edge and we verify the injected JWT here too, so a
  // mis-scoped edge policy cannot silently expose the console.
  const devMode = env.ENVIRONMENT === 'dev' && Boolean(env.ACCESS_DEV_TOKEN);
  if (!devMode && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const gate = await requireAdmin(request, env);
    if (!gate.ok) return gate.response;
  }

  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return finalizeShell(response, env, devMode);

  // SPA fallback for client routes such as /admin/campaigns
  const index = await env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url).toString()));
  if (!index.ok) return error(404, 'admin console asset missing');
  return finalizeShell(index, env, devMode);
}

function landing(env: Env, request: Request): Response {
  const base = baseUrlOf(env, request);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>adserver</title>
<meta name="robots" content="noindex">
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.25rem;color:#111}
code{background:#f2f4f8;padding:.15rem .4rem;border-radius:4px;font-size:.9em}
h1{margin-bottom:.25rem}p.lead{color:#555;margin-top:0}</style></head>
<body><h1>adserver</h1>
<p class="lead">Self-hosted banner ad server. Zones, campaigns and creatives are managed in the console.</p>
<p><a href="/admin/">Management console</a> (Cloudflare Access) · <a href="/healthz">health</a></p>
<p>Ad tag example:</p>
<p><code>&lt;script async src="${base}/z/1.js"&gt;&lt;/script&gt;</code></p>
</body></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-robots-tag': 'noindex, nofollow',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/healthz') {
    return json({
      ok: true,
      service: 'adserver',
      environment: env.ENVIRONMENT,
      time: new Date().toISOString(),
    });
  }

  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }

  if (path === '/api/admin' || path.startsWith('/api/admin/')) {
    return handleAdmin(request, env, ctx);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return error(405, 'method not allowed');
  }

  if (path === '/api/serve') return handleServe(request, env, ctx);
  if (path === '/api/click') return handleClick(request, env, ctx);
  if (path === '/t/imp.gif') return handleImpressionBeacon(request, env, ctx);

  const imageMatch = /^\/i\/(\d+)$/.exec(path);
  if (imageMatch) return handleImage(request, env, toInt(imageMatch[1], 0));

  const fallbackMatch = /^\/c\/fallback\/(\d+)$/.exec(path);
  if (fallbackMatch) return handleFallbackCreative(request, env, toInt(fallbackMatch[1], 0));

  const creativeMatch = /^\/c\/(\d+)$/.exec(path);
  if (creativeMatch) return handleCreative(request, env, toInt(creativeMatch[1], 0));

  if (path === '/ads.js') {
    const body = await loaderBody(env, request);
    return body ? jsResponse(body, 300) : error(503, 'loader asset missing');
  }

  const zoneMatch = /^\/z\/(\d+)\.js$/.exec(path);
  if (zoneMatch) return zoneLoader(env, request, toInt(zoneMatch[1], 0));

  if (path === '/') return landing(env, request);

  if (path === '/admin' || path.startsWith('/admin/')) return adminShell(request, env);

  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) return asset;
  return error(404, 'not found');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (caught) {
      console.error('adserver: unhandled error', caught);
      return error(500, 'internal error');
    }
  },
};
