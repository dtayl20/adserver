/**
 * Small shared helpers. No Cloudflare imports — this file is also used by the
 * node test runner.
 */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, { status });
}

/** Escape for HTML text and quoted-attribute contexts. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http/https URLs are ever emitted or redirected to. */
export function safeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** Calendar day (YYYY-MM-DD) in the given IANA timezone. */
export function dayKey(when: Date = new Date(), timeZone = 'Australia/Sydney'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

export function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

export function toStr(value: unknown, maxLength = 2000): string {
  return String(value ?? '').slice(0, maxLength);
}

export function boolInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const s = String(value ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes' ? 1 : 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlDecode(value));
}

const encoder = new TextEncoder();

/** HMAC-SHA256, returned as a base64url string. */
export async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare for tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Signed token binding a banner/zone/day (and purpose) to a secret, so clicks
 * and impression beacons cannot be forged for arbitrary creatives.
 * Returns a 22-char slice — plenty for this use and cheap to compute.
 */
export async function signedToken(
  purpose: 'click' | 'imp',
  bannerId: number,
  zoneId: number,
  day: string,
  secret: string,
): Promise<string> {
  if (!secret) return '';
  const value = await hmacSign(`${purpose}:${bannerId}:${zoneId}:${day}`, secret);
  return value.slice(0, 22);
}

/** 1x1 transparent GIF. */
export const TRANSPARENT_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

/** Conservative bot filter — bots are served ads, just not counted. */
const BOT_PATTERN =
  /(bot|crawler|spider|crawl|slurp|bingpreview|headlesschrome|phantomjs|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegrambot|python-requests|curl\/|wget|go-http-client|axios|okhttp|scrapy|semrush|ahrefs|mj12|dotbot|petalbot|bytespider)/i;

export function looksLikeBot(userAgent: string): boolean {
  const ua = String(userAgent ?? '');
  if (!ua) return true; // no UA at all = not a human
  return BOT_PATTERN.test(ua);
}
