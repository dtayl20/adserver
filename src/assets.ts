/**
 * Creative assets: images (R2) and HTML5 creative documents.
 *
 * The HTML5 creative document is deliberately hostile to its own content:
 *   Content-Security-Policy: sandbox allow-scripts allow-popups ... 
 * puts the document in an opaque origin even when it is opened directly in a
 * tab, so a creative can never read ad-server cookies, call the admin API, or
 * touch the host page. The parent page additionally frames it with a sandbox
 * attribute (no allow-same-origin).
 */

import { requireAdmin } from './access.ts';
import { getBanner, getZone } from './db.ts';
import { applyMacros } from './engine.ts';
import type { Env } from './types.ts';
import { clampInt, error, escapeHtml, toInt, toStr } from './util.ts';

const CREATIVE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: 'self'",
  "font-src https: data:",
  "media-src https: data:",
  "connect-src https:",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms',
].join('; ');

function creativeHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': CREATIVE_CSP,
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    ...extra,
  };
}

/** Serve a banner image from R2. Long-lived cache only when versioned. */
export async function handleImage(request: Request, env: Env, bannerId: number): Promise<Response> {
  const banner = await getBanner(env, bannerId);
  if (!banner || !banner.image_key) return error(404, 'no image for banner');

  const object = await env.ADS.get(banner.image_key);
  if (!object) return error(404, 'creative not found in bucket');

  const versioned = new URL(request.url).searchParams.has('v');
  const headers = new Headers();
  headers.set('content-type', banner.image_mime || object.httpMetadata?.contentType || 'image/png');
  headers.set('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  if (object.httpEtag) headers.set('etag', object.httpEtag);

  return new Response(object.body, { headers });
}

function clickUrlFromQuery(url: URL, bannerId: number, zoneId: number): string {
  const token = url.searchParams.get('t') ?? '';
  return `/api/click?b=${bannerId}&z=${zoneId}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
}

/** HTML5 creative document (banner.type === 'html'), macros applied. */
export async function handleCreative(request: Request, env: Env, bannerId: number): Promise<Response> {
  const url = new URL(request.url);
  const banner = await getBanner(env, bannerId);
  if (!banner) return error(404, 'unknown banner');
  if (banner.type !== 'html' || !banner.html.trim()) return error(404, 'banner has no HTML creative');

  const zoneId = toInt(url.searchParams.get('z'), 0);
  const macros = {
    CLICK_URL: clickUrlFromQuery(url, banner.id, zoneId),
    BANNER_ID: banner.id,
    ZONE_ID: zoneId,
    CAMPAIGN_ID: banner.campaign_id,
    CACHEBUSTER: Date.now(),
    AD_WIDTH: toInt(url.searchParams.get('w'), banner.width),
    AD_HEIGHT: toInt(url.searchParams.get('h'), banner.height),
    PAGE_URL: toStr(url.searchParams.get('u'), 500),
  };

  return new Response(applyMacros(banner.html, macros), { headers: creativeHeaders() });
}

/** Zone fallback HTML, rendered in the same isolated way as a creative. */
export async function handleFallbackCreative(
  request: Request,
  env: Env,
  zoneId: number,
): Promise<Response> {
  const url = new URL(request.url);
  const zone = await getZone(env, zoneId);
  if (!zone || !zone.fallback_html.trim()) return error(404, 'no fallback for zone');

  const macros = {
    CLICK_URL: '',
    BANNER_ID: 0,
    ZONE_ID: zone.id,
    CAMPAIGN_ID: 0,
    CACHEBUSTER: Date.now(),
    AD_WIDTH: clampInt(url.searchParams.get('w'), 0, 4000, zone.width),
    AD_HEIGHT: clampInt(url.searchParams.get('h'), 0, 4000, zone.height),
    PAGE_URL: toStr(url.searchParams.get('u'), 500),
  };

  return new Response(applyMacros(zone.fallback_html, macros), { headers: creativeHeaders() });
}

/** Admin-only: preview a banner creative or an image with no macros applied. */
export async function handleBannerPreview(request: Request, env: Env, bannerId: number): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const banner = await getBanner(env, bannerId);
  if (!banner) return error(404, 'unknown banner');

  if (banner.type === 'text') {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Preview</title><body style="margin:0;font:600 15px/1.4 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#f4f6fb;color:#0b3d91;text-align:center;padding:16px;box-sizing:border-box">${escapeHtml(
        banner.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      )}</body>`,
      { headers: creativeHeaders({ 'cache-control': 'no-store' }) },
    );
  }
  if (banner.type === 'image') {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Preview</title><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:transparent"><img src="/i/${banner.id}" alt="" style="max-width:100%"></body>`,
      { headers: creativeHeaders({ 'cache-control': 'no-store' }) },
    );
  }
  return handleCreative(request, env, bannerId);
}
