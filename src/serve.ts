/**
 * Ad delivery: /api/serve
 *
 * Two output shapes:
 *   - default: a self-contained HTML document sized for an iframe (safe mode;
 *     any admin-authored HTML runs in a nested sandboxed frame)
 *   - format=json: the data needed to render inline on the host page (image +
 *     plain-text creatives only, so nothing untrusted is ever injected into
 *     the host DOM)
 *
 * Impressions are counted here, at serve time, like Revive does.
 */

import { requireAdmin } from './access.ts';
import { getZone, listCandidates, recordImpression, timezoneOf } from './db.ts';
import { applyMacros, fitsSlot, pageAllowed, selectBanner, type Candidate } from './engine.ts';
import type { Env, ZoneRow } from './types.ts';
import {
  TRANSPARENT_GIF,
  clampInt,
  dayKey,
  escapeHtml,
  error,
  json,
  looksLikeBot,
  signedToken,
  toInt,
  toStr,
} from './util.ts';

const PLACEHOLDER_HOSTS = new Set(['ads.example.com', 'example.com']);

/** Canonical origin for tags/click URLs; falls back to the request origin. */
export function baseUrlOf(env: Env, request: Request): string {
  const configured = String(env.ADS_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (configured.startsWith('http')) {
    try {
      const host = new URL(configured).hostname.toLowerCase();
      if (!PLACEHOLDER_HOSTS.has(host)) return configured;
    } catch {
      /* fall through */
    }
  }
  return new URL(request.url).origin;
}

function assetVersion(key: string): string {
  const last = String(key ?? '').split('/').pop() ?? '';
  return last.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 48);
}

export function imagePath(banner: Pick<Candidate, 'id' | 'imageKey'>): string {
  const version = assetVersion(banner.imageKey);
  return version ? `/i/${banner.id}?v=${encodeURIComponent(version)}` : `/i/${banner.id}`;
}

export async function clickUrlFor(
  env: Env,
  bannerId: number,
  zoneId: number,
  day: string,
  secret: string,
): Promise<string> {
  const token = await signedToken('click', bannerId, zoneId, day, secret);
  return `/api/click?b=${bannerId}&z=${zoneId}${token ? `&t=${token}` : ''}`;
}

async function impressionBeaconFor(
  env: Env,
  bannerId: number,
  zoneId: number,
  day: string,
  secret: string,
): Promise<string> {
  const token = await signedToken('imp', bannerId, zoneId, day, secret);
  return `/t/imp.gif?b=${bannerId}&z=${zoneId}${token ? `&t=${token}` : ''}`;
}

function docHeaders(csp: string): HeadersInit {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': csp,
    // No X-Frame-Options: being framed is the entire point. frame-ancestors *
    // states that intent explicitly.
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  };
}

function noAdDocument(message = 'no ad available'): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Advertisement</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head><body><script>(function(){try{parent.postMessage({type:'adsrv:no-ad'},"*")}catch(e){}})();</script>
<!-- ${escapeHtml(message)} --></body></html>`;
  return new Response(html, {
    headers: docHeaders(
      "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'; form-action 'none'",
    ),
  });
}

interface RenderInput {
  env: Env;
  baseUrl: string;
  zone: ZoneRow;
  banner: Candidate | null;
  fallbackHtml: string;
  pageUrl: string;
  width: number;
  height: number;
  autoHeight: boolean;
  day: string;
  secret: string;
  servePath: string;
}

/**
 * Inline script inside the (trusted) ad document. It tells the loader which
 * banner was served — the host page cannot read it across origins — and, when
 * the zone asks for auto height, keeps resizing the frame as needed.
 */
function docScript(bannerId: number, width: number, height: number, autoHeight: boolean): string {
  const id = Number.isFinite(bannerId) ? Math.max(0, bannerId) : 0;
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const measure = autoHeight
    ? `var last=0;
  function measure(){var m=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0);if(m&&m!==last){last=m;post('adsrv:info',{bannerId:${id},height:m})}}
  if(window.ResizeObserver){try{new ResizeObserver(measure).observe(document.body)}catch(e){}}
  window.addEventListener('load',measure);setTimeout(measure,120);setTimeout(measure,600);`
    : '';
  return `<script>(function(){
  function post(type,payload){try{payload=payload||{};payload.type=type;parent.postMessage(payload,'*')}catch(e){}}
  post('adsrv:info',{bannerId:${id},width:${w},height:${h}});
  ${measure}
})();</script>`;
}

function sandboxedCreativeFrame(src: string, height: number): string {
  const h = height > 0 ? `${height}px` : '100%';
  return `<iframe src="${escapeHtml(src)}" scrolling="no" frameborder="0" style="width:100%;height:${h};border:0;display:block" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" title="Advertisement"></iframe>`;
}

async function renderDocument(input: RenderInput): Promise<Response> {
  const { env, baseUrl, zone, banner, day, secret } = input;
  const frameAncestors = "frame-ancestors *;";
  // 'unsafe-inline' for scripts covers only our own inline measurement script:
  // no admin-authored HTML is ever parsed in this document (creatives and
  // fallbacks render in a nested sandboxed frame).
  const commonCsp = `default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; ${frameAncestors} base-uri 'none'; form-action 'none'`;

  if (!banner) {
    if (input.fallbackHtml) {
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%}</style></head><body>` +
          sandboxedCreativeFrame(
            `/c/fallback/${zone.id}?w=${input.width}&h=${input.height}&u=${encodeURIComponent(input.pageUrl)}`,
            input.height,
          ) +
          docScript(0, input.width, input.height, input.autoHeight) +
          `</body></html>`,
        { headers: docHeaders(commonCsp) },
      );
    }
    return noAdDocument('zone has no eligible banner and no fallback');
  }

  const clickUrl = await clickUrlFor(env, banner.id, zone.id, day, secret);
  const macros = {
    CLICK_URL: `${baseUrl}${clickUrl}`,
    BANNER_ID: banner.id,
    ZONE_ID: zone.id,
    CAMPAIGN_ID: banner.campaignId,
    CACHEBUSTER: Date.now(),
    AD_WIDTH: input.width,
    AD_HEIGHT: input.height,
    PAGE_URL: input.pageUrl,
  };

  let inner = '';
  if (banner.type === 'image') {
    const img = `<img src="${escapeHtml(imagePath(banner))}" alt="${escapeHtml(banner.alt || banner.name)}"${
      input.width > 0 ? ` width="${input.width}"` : ''
    }${input.height > 0 ? ` height="${input.height}"` : ''} style="max-width:100%;height:auto;display:block">`;
    inner = `<a href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener nofollow sponsored">${img}</a>`;
  } else if (banner.type === 'text') {
    const text = applyMacros(banner.html, macros);
    inner = `<a class="t" href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener nofollow sponsored">${escapeHtml(
      text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    )}</a>`;
  } else {
    inner = sandboxedCreativeFrame(
      `/c/${banner.id}?z=${zone.id}&w=${input.width}&h=${input.height}&u=${encodeURIComponent(input.pageUrl)}`,
      input.height,
    );
  }

  const bodyStyle = banner.type === 'html' ? 'display:block' : 'display:flex;align-items:center;justify-content:center';
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Advertisement</title>
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;}
html{height:100%;}
body{${input.autoHeight ? 'min-height:100%;' : 'height:100%;'}}
body{${bodyStyle}}
a.t{font:600 15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0b3d91;text-decoration:none;background:#f4f6fb;border:1px solid #d7deee;border-radius:8px;padding:14px 18px;display:block;text-align:center;max-width:100%;box-sizing:border-box}
a.t:hover{background:#e9eefb}
</style></head><body>${inner}${docScript(banner.id, input.width, input.height, input.autoHeight)}</body></html>`;

  return new Response(html, { headers: docHeaders(commonCsp) });
}

function parseSeen(value: string | null): number[] {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((part) => toInt(part, 0))
    .filter((id) => id > 0)
    .slice(0, 20);
}

export async function handleServe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: { adminVerified?: boolean } = {},
): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const baseUrl = baseUrlOf(env, request);
  const tz = timezoneOf(env);
  const now = new Date();
  const day = dayKey(now, tz);
  const secret = env.CLICK_SECRET ?? '';

  const zoneId = toInt(params.get('z'), 0);
  const format = (params.get('format') ?? '').toLowerCase();
  const inline = format === 'json';

  // Inline callers are a cross-origin fetch from the host page, so every "no ad"
  // outcome must come back as JSON carrying CORS headers. Returning an HTML
  // document here shows up in the browser as an opaque CORS failure instead of
  // the loader quietly collapsing the slot.
  const noAd = (reason: string): Response =>
    inline
      ? json(
          { ok: true, zone: zoneId ? { id: zoneId } : null, banner: null, impUrl: '' },
          { headers: { 'access-control-allow-origin': '*' } },
        )
      : noAdDocument(reason);

  if (!zoneId) {
    if (inline) {
      return json(
        { ok: false, error: 'missing zone id (?z=)' },
        { status: 400, headers: { 'access-control-allow-origin': '*' } },
      );
    }
    return error(400, 'missing zone id (?z=)');
  }

  const preview = params.get('preview') === '1';
  // Preview suppresses counting, so it needs an operator. Callers that have
  // already verified the identity (the Access-protected admin preview route)
  // say so, rather than the check being repeated on a re-dispatched request.
  if (preview && !options.adminVerified) {
    const gate = await requireAdmin(request, env);
    if (!gate.ok) return gate.response;
  }

  const zone = await getZone(env, zoneId);
  if (!zone || !zone.active) return noAd('zone missing or inactive');

  const pageUrl = toStr(params.get('u') || request.headers.get('referer') || '', 500);
  if (pageUrl && !pageAllowed(zone.page_allow, zone.page_block, pageUrl)) {
    return noAd('page not targeted by zone');
  }

  const width = clampInt(params.get('w') ?? zone.width, 0, 4000, zone.width);
  const height = clampInt(params.get('h') ?? zone.height, 0, 4000, zone.height);
  const autoHeight = zone.auto_height === 1 || params.get('resize') === '1';

  let candidates = await listCandidates(env, zoneId, day);
  // A campaign can hold several creative sizes; only the ones shaped like this
  // slot may compete, or a 728x90 leaderboard ends up in a square box.
  candidates = candidates.filter((candidate) => fitsSlot(candidate, width, height));
  // Campaign-level page targeting: applies even when the zone itself is open to
  // every page, so one campaign in a shared slot can be suburb-only. A missing
  // page URL (preview, direct API call) bypasses it, like zone targeting.
  if (pageUrl) {
    candidates = candidates.filter((candidate) =>
      pageAllowed(candidate.pageAllow ?? '', candidate.pageBlock ?? '', pageUrl),
    );
  }
  if (inline) candidates = candidates.filter((c) => c.type !== 'html');

  const seen = parseSeen(params.get('seen'));
  const banner = selectBanner(candidates, {
    rand: Math.random(),
    day,
    recentIds: seen,
  });

  const userAgent = request.headers.get('user-agent') ?? '';
  const countIt = !preview && !looksLikeBot(userAgent);

  if (banner && countIt) {
    ctx.waitUntil(
      recordImpression(env, banner.id, zone.id, day).catch(() => {
        /* counting must never break delivery */
      }),
    );
  }

  if (inline) {
    const payload = banner
      ? {
          ok: true,
          zone: { id: zone.id, name: zone.name, width, height },
          banner: {
            id: banner.id,
            type: banner.type,
            width: banner.width || width,
            height: banner.height || height,
            alt: banner.alt || banner.name,
            text:
              banner.type === 'text'
                ? applyMacros(banner.html, { CACHEBUSTER: Date.now() }).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
                : '',
            imageUrl: banner.type === 'image' ? `${baseUrl}${imagePath(banner)}` : '',
            clickUrl: `${baseUrl}${await clickUrlFor(env, banner.id, zone.id, day, secret)}`,
          },
          impUrl: `${baseUrl}${await impressionBeaconFor(env, banner.id, zone.id, day, secret)}`,
        }
      : { ok: true, zone: { id: zone.id }, banner: null, impUrl: '' };

    return json(payload, {
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  }

  return renderDocument({
    env,
    baseUrl,
    zone,
    banner,
    fallbackHtml: zone.fallback_html,
    pageUrl,
    width,
    height,
    autoHeight,
    day,
    secret,
    servePath: url.pathname + url.search,
  });
}

/** 1x1 transparent pixel used by zones that render inline (no iframe). */
export function transparentPixelResponse(): Response {
  return new Response(TRANSPARENT_GIF, {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'access-control-allow-origin': '*',
      'content-length': String(TRANSPARENT_GIF.byteLength),
    },
  });
}
