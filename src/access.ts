/**
 * Cloudflare Access verification.
 *
 * The management console is protected by a Cloudflare Access application in
 * front of this Worker. Access injects `Cf-Access-Jwt-Assertion` on every
 * request it admits — we verify that JWT here (signature against the team's
 * JWKS, plus iss/aud/exp) instead of trusting a header value or a shared key
 * shipped in a browser bundle.
 *
 * Client-supplied Cf-* headers are stripped by Cloudflare, but even if they
 * were not, an unverifiable JWT is rejected.
 */

import type { Env } from './types.ts';
import { error, timingSafeEqual } from './util.ts';

export interface AccessIdentity {
  email: string;
  sub: string;
  /** 'access' = verified Access JWT, 'dev' = local dev bypass. */
  via: 'access' | 'dev';
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface JwksCache {
  teamDomain: string;
  fetchedAt: number;
  keys: Jwk[];
}

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: JwksCache | null = null;

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.teamDomain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(url, { cf: { cacheTtl: 600 } as RequestInitCfProperties });
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { teamDomain, fetchedAt: now, keys };
  return keys;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function signatureBytes(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyJwt(token: string, env: Env): Promise<AccessIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeSegment(headerPart);
  const payload = decodeSegment(payloadPart);
  if (!header || !payload) return null;
  if (header.alg !== 'RS256') return null;

  let keys: Jwk[];
  try {
    keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN);
  } catch {
    return null;
  }
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const jwk = keys.find((k) => k.kid === kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk || jwk.kty !== 'RSA') return null;

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signatureBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp ?? 0);
  const nbf = Number(payload.nbf ?? 0);
  if (!exp || exp + 60 < nowSeconds) return null;
  if (nbf && nbf - 60 > nowSeconds) return null;

  const iss = String(payload.iss ?? '');
  if (iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;

  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud.map(String) : [String(aud ?? '')];
  if (env.ACCESS_AUD && !audiences.includes(env.ACCESS_AUD)) return null;

  const email = String(payload.email ?? '');
  const sub = String(payload.sub ?? '');
  if (!sub && !email) return null;

  return { email, sub, via: 'access' };
}

function devBypass(request: Request, env: Env): AccessIdentity | null {
  if (env.ENVIRONMENT !== 'dev') return null;
  const expected = env.ACCESS_DEV_TOKEN ?? '';
  if (!expected) return null;
  // A browser cannot set a header on an iframe or new-tab navigation, so local
  // dev also accepts the token in the query string. Requires ENVIRONMENT=dev
  // AND a configured ACCESS_DEV_TOKEN, so it cannot apply in production.
  const supplied =
    request.headers.get('x-dev-admin-token') ?? new URL(request.url).searchParams.get('dev_token') ?? '';
  if (!supplied || !timingSafeEqual(supplied, expected)) return null;
  return { email: 'dev@localhost', sub: 'dev', via: 'dev' };
}

/**
 * Gate a request. Returns the identity, or a ready-to-send 401/403 response.
 */
export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<{ ok: true; identity: AccessIdentity } | { ok: false; response: Response }> {
  const bypass = devBypass(request, env);
  if (bypass) return { ok: true, identity: bypass };

  const token = request.headers.get('cf-access-jwt-assertion') ?? '';
  if (!token) {
    return {
      ok: false,
      response: error(401, 'Cloudflare Access authentication required', {
        hint: 'This endpoint must be reached through the Access-protected application.',
      }),
    };
  }

  const identity = await verifyJwt(token, env);
  if (!identity) {
    return { ok: false, response: error(403, 'Invalid Cloudflare Access token') };
  }
  return { ok: true, identity };
}
