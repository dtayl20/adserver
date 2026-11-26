/**
 * Click redirects + impression beacons.
 *
 * Security properties:
 *  - The destination comes from the database (banners.target_url), never from
 *    the request, so this cannot be used as an open redirect.
 *  - Clicks carry an HMAC token binding banner/zone/day. A bad token still
 *    redirects the visitor (never break a paid click) but is not counted.
 *  - Clicks are counted once per visitor per banner per day; the visitor id is
 *    a salted hash — no IP or user agent is stored.
 */

import { getBanner, recordClick, recordImpression, timezoneOf } from './db.ts';
import type { Env } from './types.ts';
import {
  TRANSPARENT_GIF,
  dayKey,
  safeUrl,
  sha256Hex,
  signedToken,
  timingSafeEqual,
  toInt,
} from './util.ts';

async function visitorHash(request: Request, env: Env, day: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  const salt = env.IP_SALT ?? 'adserver';
  return (await sha256Hex(`${ip}|${userAgent}|${salt}|${day}`)).slice(0, 32);
}

/**
 * Tokens are minted per day, so a creative cached across midnight must still
 * verify: accept today's token or yesterday's.
 */
async function tokenIsValid(
  purpose: 'click' | 'imp',
  bannerId: number,
  zoneId: number,
  supplied: string,
  env: Env,
  now: Date,
): Promise<boolean> {
  const secret = env.CLICK_SECRET ?? '';
  if (!secret) return false;
  if (!supplied) return false;
  const tz = timezoneOf(env);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const expected = [
    await signedToken(purpose, bannerId, zoneId, dayKey(now, tz), secret),
    await signedToken(purpose, bannerId, zoneId, dayKey(yesterday, tz), secret),
  ];
  return expected.some((value) => value && timingSafeEqual(value, supplied));
}

export async function handleClick(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const bannerId = toInt(url.searchParams.get('b'), 0);
  const zoneId = toInt(url.searchParams.get('z'), 0);
  const token = url.searchParams.get('t') ?? '';
  const now = new Date();

  if (!bannerId) {
    return new Response('Missing banner id', { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const banner = await getBanner(env, bannerId);
  const destination = safeUrl(banner?.target_url ?? '');
  if (!banner || !destination) {
    return new Response('Unknown or unwrapped banner', {
      status: 404,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const valid = await tokenIsValid('click', bannerId, zoneId, token, env, now);
  if (valid && !(await isBot(request))) {
    const day = dayKey(now, timezoneOf(env));
    const hash = await visitorHash(request, env, day);
    ctx.waitUntil(
      recordClick(env, bannerId, zoneId, day, hash).catch(() => {
        /* counting must never break the redirect */
      }),
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: destination,
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      // Never leak the referring page to the advertiser beyond the origin-less
      // no-referrer default; clicks carry no visitor identifiers.
      'referrer-policy': 'no-referrer',
    },
  });
}

async function isBot(request: Request): Promise<boolean> {
  const ua = request.headers.get('user-agent') ?? '';
  if (!ua) return true;
  return /(bot|crawler|spider|slurp|headless|lighthouse|monitor|python-requests|curl\/|wget)/i.test(ua);
}

export async function handleImpressionBeacon(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const bannerId = toInt(url.searchParams.get('b'), 0);
  const zoneId = toInt(url.searchParams.get('z'), 0);
  const token = url.searchParams.get('t') ?? '';
  const now = new Date();

  if (bannerId && (await tokenIsValid('imp', bannerId, zoneId, token, env, now))) {
    if (!(await isBot(request))) {
      const day = dayKey(now, timezoneOf(env));
      ctx.waitUntil(
        recordImpression(env, bannerId, zoneId, day).catch(() => {
          /* ignore */
        }),
      );
    }
  }

  return new Response(TRANSPARENT_GIF, {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'content-length': String(TRANSPARENT_GIF.byteLength),
    },
  });
}
