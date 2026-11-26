/**
 * Admin API — /api/admin/*
 *
 * Two independent gates on every request:
 *   1. Cloudflare Access JWT (verified signature/iss/aud/exp) — authentication.
 *   2. `x-adserver-admin: 1` header — a CSRF-style guard, because a browser
 *      form (or any blind cross-site POST) cannot set custom headers.
 * Neither substitutes for the other. See SECURITY.md.
 */

import { requireAdmin, type AccessIdentity } from './access.ts';
import {
  allCampaignZoneLinks,
  campaignZoneIds,
  getBanner,
  getCampaign,
  getSite,
  getZone,
  listBanners,
  listCampaigns,
  listSites,
  listZones,
  pruneClickDedupe,
  statsRows,
  totalsByDay,
  totalsByGroup,
} from './db.ts';
import { handleBannerPreview } from './assets.ts';
import { baseUrlOf, handleServe } from './serve.ts';
import type { Env } from './types.ts';
import { boolInt, clampInt, dayKey, error, json, safeUrl, toInt, toStr } from './util.ts';

const MAX_HTML_CHARS = 200_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type Params = Record<string, string>;
type Handler = (ctx: {
  request: Request;
  env: Env;
  identity: AccessIdentity;
  params: Params;
  url: URL;
  ctx: ExecutionContext;
}) => Promise<Response>;

// ---------------------------------------------------------------- validation

class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

function requireName(value: unknown, field = 'name'): string {
  const name = toStr(value, 200).trim();
  if (!name) fail(`${field} is required`);
  return name;
}

function optionalDate(value: unknown, field: string): string {
  const raw = toStr(value, 40).trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}(T[0-9:.+-Zz]*)?$/.test(raw)) fail(`${field} must be YYYY-MM-DD or ISO-8601`);
  return raw;
}

function requireTargetUrl(value: unknown): string {
  const url = safeUrl(value);
  if (!url) fail('target_url must be a valid http(s) URL');
  return url;
}

/**
 * Site domains are labels, not routing: accept a bare host or a full URL and
 * store one canonical host. Empty is allowed, because a site can be created
 * before its domain is decided.
 */
function normalizeDomain(value: unknown): string {
  let raw = toStr(value, 300).trim().toLowerCase();
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      fail('domain must be a host such as example.com');
    }
  }
  raw = raw.replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) && raw !== 'localhost') {
    fail('domain must be a host such as example.com');
  }
  return raw;
}

/** A zone's site is optional; 0/null means "no site yet". */
async function siteIdFrom(env: Env, value: unknown): Promise<number> {
  const id = clampInt(value, 0, 1e9, 0);
  if (!id) return 0;
  if (!(await getSite(env, id))) fail('unknown site_id');
  return id;
}

function limitedHtml(value: unknown, field: string): string {
  const html = String(value ?? '');
  if (html.length > MAX_HTML_CHARS) fail(`${field} is too large (max ${MAX_HTML_CHARS} characters)`);
  return html;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const raw = toStr(value, 40).trim() as T;
  if (!allowed.includes(raw)) fail(`${field} must be one of: ${allowed.join(', ')}`);
  return raw;
}

/** Path id: never clamp a bad value into a real record. */
function paramId(value: unknown): number {
  const id = toInt(value, 0);
  if (id < 1) fail('invalid id');
  return id;
}

/**
 * Targeting patterns are matched as hosts unless they start with `/` (path) or
 * `http(s)://` (full URL). A bare word such as `blog` therefore matches nothing
 * at all — which used to be accepted silently, leaving a zone that never serves.
 */
function validateTargeting(value: unknown, field: string): string {
  const raw = toStr(value, 4000);
  for (const line of raw.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)) {
    const isUrl = /^https?:\/\//i.test(line);
    const isPath = line.startsWith('/');
    const isHost = line.includes('.') || line.includes('*') || line === 'localhost';
    if (!isUrl && !isPath && !isHost) {
      fail(
        `${field}: "${line}" is neither a host (example.com) nor a path (/blog*), so it would match nothing`,
      );
    }
  }
  return raw;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) fail('expected application/json body');
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body must be a JSON object');
    return body as Record<string, unknown>;
  } catch (caught) {
    if (caught instanceof ValidationError) throw caught;
    fail('invalid JSON body');
  }
}

// ------------------------------------------------------------------- helpers

function snippetFor(env: Env, request: Request, zone: { id: number; name: string; width: number; height: number }): string {
  const base = baseUrlOf(env, request);
  return [
    `<!-- adserver zone #${zone.id} — ${zone.name} (${zone.width}x${zone.height}) -->`,
    `<div id="adsrv-zone-${zone.id}"></div>`,
    `<script async src="${base}/z/${zone.id}.js" data-zone="${zone.id}" data-target="#adsrv-zone-${zone.id}"></script>`,
  ].join('\n');
}

/**
 * Some routes are loaded directly by the browser (an iframe document or a new
 * tab), which cannot send the x-adserver-admin header. They are exempt from the
 * CSRF guard but still require the verified Access identity — and they live on
 * /api/admin so Cloudflare Access injects the JWT the browser cannot.
 */
const CSRF_EXEMPT = [/^\/api\/admin\/preview$/, /^\/api\/admin\/banner-preview\/\d+$/];

async function guard(
  request: Request,
  env: Env,
  pathname: string,
): Promise<{ ok: true; identity: AccessIdentity } | { ok: false; response: Response }> {
  const exempt = CSRF_EXEMPT.some((pattern) => pattern.test(pathname));
  if (!exempt && request.headers.get('x-adserver-admin') !== '1') {
    return {
      ok: false,
      response: error(400, 'missing x-adserver-admin header', {
        hint: 'The management console sends this on every call; it blocks blind cross-site requests.',
      }),
    };
  }
  return requireAdmin(request, env);
}

// --------------------------------------------------------------------- reads

const me: Handler = async ({ env, identity, request }) => json({
  ok: true,
  identity,
  environment: env.ENVIRONMENT,
  baseUrl: baseUrlOf(env, request),
  accessConfigured: Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
  clickSecretConfigured: Boolean(env.CLICK_SECRET),
});

const overview: Handler = async ({ env, url }) => {
  const days = clampInt(url.searchParams.get('days'), 1, 90, 14);
  const tz = env.STATS_TIMEZONE || 'Australia/Sydney';
  const today = dayKey(new Date(), tz);
  const start = dayKey(new Date(Date.now() - (days - 1) * 86400000), tz);

  const [byDay, byBanner, byZone, bySite, zones, banners, campaigns, sites] = await Promise.all([
    totalsByDay(env, start, today),
    totalsByGroup(env, start, today, 'banner'),
    totalsByGroup(env, start, today, 'zone'),
    totalsByGroup(env, start, today, 'site'),
    listZones(env),
    listBanners(env),
    listCampaigns(env),
    listSites(env),
  ]);

  const sum = (rows: Array<{ impressions: number; clicks: number }>) =>
    rows.reduce(
      (acc, row) => ({ impressions: acc.impressions + row.impressions, clicks: acc.clicks + row.clicks }),
      { impressions: 0, clicks: 0 },
    );

  const period = sum(byDay);
  const todayRow = byDay.find((row) => row.day === today) ?? { day: today, impressions: 0, clicks: 0 };

  // Opportunistic housekeeping — keeps the dedupe table small without a cron.
  if (Math.random() < 0.02) {
    const cutoff = dayKey(new Date(Date.now() - 7 * 86400000), tz);
    await pruneClickDedupe(env, cutoff).catch(() => undefined);
  }

  return json({
    ok: true,
    range: { from: start, to: today, days, timezone: tz },
    today: todayRow,
    period,
    byDay,
    byBanner,
    byZone,
    bySite,
    counts: { zones: zones.length, campaigns: campaigns.length, banners: banners.length, sites: sites.length },
  });
};

const stats: Handler = async ({ env, url }) => {
  const tz = env.STATS_TIMEZONE || 'Australia/Sydney';
  const to = toStr(url.searchParams.get('to'), 10) || dayKey(new Date(), tz);
  const from =
    toStr(url.searchParams.get('from'), 10) || dayKey(new Date(Date.now() - 29 * 86400000), tz);
  const group = oneOf(url.searchParams.get('group') ?? 'banner', ['banner', 'campaign', 'zone', 'site'] as const, 'group');

  const [byDay, byGroup, rows] = await Promise.all([
    totalsByDay(env, from, to),
    totalsByGroup(env, from, to, group),
    statsRows(env, from, to),
  ]);
  return json({ ok: true, range: { from, to, timezone: tz }, group, byDay, byGroup, rows });
};

const zonesList: Handler = async ({ env, request }) => {
  const [zones, campaigns, links] = await Promise.all([
    listZones(env),
    listCampaigns(env),
    allCampaignZoneLinks(env),
  ]);
  return json({
    ok: true,
    zones: zones.map((zone) => ({
      ...zone,
      snippet: snippetFor(env, request, zone),
      campaigns: links.filter((l) => l.zone_id === zone.id).map((l) => l.campaign_id),
    })),
    campaigns,
  });
};

const sitesList: Handler = async ({ env }) => {
  const [sites, zones] = await Promise.all([listSites(env), listZones(env)]);
  return json({
    ok: true,
    sites: sites.map((site) => ({
      ...site,
      zoneIds: zones.filter((zone) => zone.site_id === site.id).map((zone) => zone.id),
    })),
    zones: zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      width: zone.width,
      height: zone.height,
      site_id: zone.site_id,
    })),
  });
};

const campaignsList: Handler = async ({ env }) => {
  const [campaigns, links, banners] = await Promise.all([
    listCampaigns(env),
    allCampaignZoneLinks(env),
    listBanners(env),
  ]);
  return json({
    ok: true,
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      zoneIds: links.filter((l) => l.campaign_id === campaign.id).map((l) => l.zone_id),
      bannerCount: banners.filter((b) => b.campaign_id === campaign.id).length,
    })),
    zones: (await listZones(env)).map((z) => ({ id: z.id, name: z.name, width: z.width, height: z.height })),
  });
};

const bannersList: Handler = async ({ env, url }) => {
  const campaignId = clampInt(url.searchParams.get('campaign'), 0, 1e9, 0);
  const banners = await listBanners(env, campaignId || undefined);
  return json({ ok: true, banners, campaigns: await listCampaigns(env) });
};

const zoneSnippet: Handler = async ({ env, request, params }) => {
  const zone = await getZone(env, paramId(params.id));
  if (!zone) return error(404, 'unknown zone');
  return json({ ok: true, zoneId: zone.id, snippet: snippetFor(env, request, zone) });
};

/**
 * Zone preview, wrapped in the ad document the site would actually receive.
 * Deliberately re-dispatches to the public renderer with preview=1 (so nothing
 * is counted) and omits the page URL, so a zone can be previewed regardless of
 * its allow/block list.
 */
const zonePreview: Handler = async ({ request, env, ctx, url }) => {
  const zoneId = clampInt(url.searchParams.get('z'), 0, 1e9, 0);
  if (!zoneId) return error(400, 'missing zone id (?z=)');

  const target = new URL('/api/serve', url.origin);
  target.searchParams.set('z', String(zoneId));
  target.searchParams.set('preview', '1');
  for (const key of ['w', 'h', 'resize']) {
    const value = url.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }

  return handleServe(
    new Request(target.toString(), { method: 'GET', headers: request.headers }),
    env,
    ctx,
    { adminVerified: true },
  );
};

const bannerPreview: Handler = async ({ request, env, params }) =>
  handleBannerPreview(request, env, paramId(params.id));

// -------------------------------------------------------------------- writes

const createZone: Handler = async ({ request, env }) => {
  const body = await readJson(request);
  const name = requireName(body.name, 'name');
  const slug = toStr(body.slug, 80).trim() || null;
  const width = clampInt(body.width, 0, 4000, 728);
  const height = clampInt(body.height, 0, 4000, 90);
  const siteId = await siteIdFrom(env, body.site_id);

  const result = await env.DB
    .prepare(
      `INSERT INTO zones (name, slug, width, height, auto_height, mode, page_allow, page_block, fallback_html, active, site_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      name,
      slug,
      width,
      height,
      boolInt(body.auto_height),
      oneOf(body.mode ?? 'iframe', ['iframe', 'inline'] as const, 'mode'),
      validateTargeting(body.page_allow, 'page_allow'),
      validateTargeting(body.page_block, 'page_block'),
      limitedHtml(body.fallback_html, 'fallback_html'),
      body.active === undefined ? 1 : boolInt(body.active),
      siteId || null,
    )
    .run();

  const id = Number((result.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
  return json({ ok: true, id }, { status: 201 });
};

const updateZone: Handler = async ({ request, env, params }) => {
  const id = paramId(params.id);
  const existing = await getZone(env, id);
  if (!existing) return error(404, 'unknown zone');
  const body = await readJson(request);
  // An absent field preserves the current site; an explicit empty value clears it.
  const siteId =
    body.site_id === undefined ? existing.site_id : (await siteIdFrom(env, body.site_id)) || null;

  await env.DB
    .prepare(
      `UPDATE zones
          SET name = ?1, slug = ?2, width = ?3, height = ?4, auto_height = ?5, mode = ?6,
              page_allow = ?7, page_block = ?8, fallback_html = ?9, active = ?10, site_id = ?11,
              updated_at = datetime('now')
        WHERE id = ?12`,
    )
    .bind(
      requireName(body.name, 'name'),
      toStr(body.slug, 80).trim() || null,
      clampInt(body.width, 0, 4000, 728),
      clampInt(body.height, 0, 4000, 90),
      boolInt(body.auto_height),
      oneOf(body.mode ?? 'iframe', ['iframe', 'inline'] as const, 'mode'),
      validateTargeting(body.page_allow, 'page_allow'),
      validateTargeting(body.page_block, 'page_block'),
      limitedHtml(body.fallback_html, 'fallback_html'),
      body.active === undefined ? 1 : boolInt(body.active),
      siteId,
      id,
    )
    .run();

  return json({ ok: true, id, siteId });
};

const deleteZone: Handler = async ({ env, params }) => {
  const id = paramId(params.id);
  await env.DB.prepare('DELETE FROM campaign_zones WHERE zone_id = ?1').bind(id).run();
  const result = await env.DB.prepare('DELETE FROM zones WHERE id = ?1').bind(id).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (!changes) return error(404, 'unknown zone');
  return json({ ok: true, id });
};

// --------------------------------------------------------------------- sites

const createSite: Handler = async ({ request, env }) => {
  const body = await readJson(request);
  const result = await env.DB
    .prepare('INSERT INTO sites (name, domain, notes, active) VALUES (?1, ?2, ?3, ?4)')
    .bind(
      requireName(body.name, 'name'),
      normalizeDomain(body.domain),
      toStr(body.notes, 2000),
      body.active === undefined ? 1 : boolInt(body.active),
    )
    .run();

  const id = Number((result.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
  return json({ ok: true, id }, { status: 201 });
};

const updateSite: Handler = async ({ request, env, params }) => {
  const id = paramId(params.id);
  if (!(await getSite(env, id))) return error(404, 'unknown site');
  const body = await readJson(request);

  await env.DB
    .prepare(
      `UPDATE sites
          SET name = ?1, domain = ?2, notes = ?3, active = ?4, updated_at = datetime('now')
        WHERE id = ?5`,
    )
    .bind(
      requireName(body.name, 'name'),
      normalizeDomain(body.domain),
      toStr(body.notes, 2000),
      body.active === undefined ? 1 : boolInt(body.active),
      id,
    )
    .run();

  return json({ ok: true, id });
};

const deleteSite: Handler = async ({ env, params }) => {
  const id = paramId(params.id);
  // Zones and their tags survive; they just stop belonging to a site.
  const detached = await env.DB
    .prepare('UPDATE zones SET site_id = NULL, updated_at = datetime(\'now\') WHERE site_id = ?1')
    .bind(id)
    .run();
  const result = await env.DB.prepare('DELETE FROM sites WHERE id = ?1').bind(id).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (!changes) return error(404, 'unknown site');
  const zonesDetached = Number((detached.meta as { changes?: number } | undefined)?.changes ?? 0);
  return json({ ok: true, id, zonesDetached });
};

async function replaceCampaignZones(
  env: Env,
  campaignId: number,
  zoneIds: unknown,
): Promise<number[] | null> {
  // `undefined`/`null` means the caller did not send the field at all: leave the
  // existing links ALONE. Clearing them would silently unlink the campaign from
  // every zone, so it stops serving with nothing visible to explain why.
  // An empty array is an explicit "no zones" and does clear.
  if (zoneIds === undefined || zoneIds === null) return null;
  // Accept an array, a single id, or nothing — a lone checked box in the console
  // used to arrive as a bare number and silently link no zone at all.
  const list = Array.isArray(zoneIds) ? zoneIds : zoneIds === '' ? [] : [zoneIds];
  const wanted = [...new Set(list.map((value) => clampInt(value, 0, 1e9, 0)).filter((value) => value > 0))].slice(0, 200);
  const existing = await listZones(env);
  const valid = new Set(existing.map((zone) => zone.id));
  const ids = wanted.filter((id) => valid.has(id));

  await env.DB.prepare('DELETE FROM campaign_zones WHERE campaign_id = ?1').bind(campaignId).run();
  for (const zoneId of ids) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO campaign_zones (campaign_id, zone_id) VALUES (?1, ?2)')
      .bind(campaignId, zoneId)
      .run();
  }
  return ids;
}

const createCampaign: Handler = async ({ request, env }) => {
  const body = await readJson(request);
  const result = await env.DB
    .prepare(
      `INSERT INTO campaigns (name, advertiser, priority, weight, starts_at, ends_at, imp_cap, click_cap, page_allow, page_block, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      requireName(body.name, 'name'),
      toStr(body.advertiser, 200),
      clampInt(body.priority, 0, 10, 5),
      clampInt(body.weight, 1, 1000, 1),
      optionalDate(body.starts_at, 'starts_at'),
      optionalDate(body.ends_at, 'ends_at'),
      clampInt(body.imp_cap, 0, 100_000_000, 0),
      clampInt(body.click_cap, 0, 100_000_000, 0),
      validateTargeting(body.page_allow, 'page_allow'),
      validateTargeting(body.page_block, 'page_block'),
      oneOf(body.status ?? 'active', ['active', 'paused', 'draft', 'finished'] as const, 'status'),
    )
    .run();

  const id = Number((result.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
  // A brand-new campaign has nothing to preserve, so an absent field means "no zones".
  const zoneIds = (await replaceCampaignZones(env, id, body.zoneIds ?? [])) ?? [];
  return json({ ok: true, id, zoneIds }, { status: 201 });
};

const updateCampaign: Handler = async ({ request, env, params }) => {
  const id = paramId(params.id);
  if (!(await getCampaign(env, id))) return error(404, 'unknown campaign');
  const body = await readJson(request);

  await env.DB
    .prepare(
      `UPDATE campaigns
          SET name = ?1, advertiser = ?2, priority = ?3, weight = ?4, starts_at = ?5,
              ends_at = ?6, imp_cap = ?7, click_cap = ?8, page_allow = ?9, page_block = ?10,
              status = ?11, updated_at = datetime('now')
        WHERE id = ?12`,
    )
    .bind(
      requireName(body.name, 'name'),
      toStr(body.advertiser, 200),
      clampInt(body.priority, 0, 10, 5),
      clampInt(body.weight, 1, 1000, 1),
      optionalDate(body.starts_at, 'starts_at'),
      optionalDate(body.ends_at, 'ends_at'),
      clampInt(body.imp_cap, 0, 100_000_000, 0),
      clampInt(body.click_cap, 0, 100_000_000, 0),
      validateTargeting(body.page_allow, 'page_allow'),
      validateTargeting(body.page_block, 'page_block'),
      oneOf(body.status ?? 'active', ['active', 'paused', 'draft', 'finished'] as const, 'status'),
      id,
    )
    .run();

  // Visible in `wrangler tail`, so a save carrying no zone field is obvious.
  console.log('campaign update', id, 'zoneIds payload:', JSON.stringify(body.zoneIds ?? null));
  const zoneIds = (await replaceCampaignZones(env, id, body.zoneIds)) ?? (await campaignZoneIds(env, id));
  return json({ ok: true, id, zoneIds });
};

const deleteCampaign: Handler = async ({ env, params }) => {
  const id = paramId(params.id);
  const banners = await listBanners(env, id);
  for (const banner of banners) {
    if (banner.image_key) await env.ADS.delete(banner.image_key).catch(() => undefined);
  }
  const result = await env.DB.prepare('DELETE FROM campaigns WHERE id = ?1').bind(id).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (!changes) return error(404, 'unknown campaign');
  return json({ ok: true, id, removedBanners: banners.length });
};

const createBanner: Handler = async ({ request, env }) => {
  const body = await readJson(request);
  const campaignId = clampInt(body.campaign_id, 1, 1e9, 0);
  if (!(await getCampaign(env, campaignId))) return error(400, 'unknown campaign_id');
  const type = oneOf(body.type ?? 'image', ['image', 'html', 'text'] as const, 'type');

  const result = await env.DB
    .prepare(
      `INSERT INTO banners (campaign_id, name, type, width, height, alt, html, target_url, weight, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      campaignId,
      requireName(body.name, 'name'),
      type,
      clampInt(body.width, 0, 4000, 728),
      clampInt(body.height, 0, 4000, 90),
      toStr(body.alt, 300),
      type === 'image' ? '' : limitedHtml(body.html, 'html'),
      requireTargetUrl(body.target_url),
      clampInt(body.weight, 1, 1000, 1),
      oneOf(body.status ?? 'active', ['active', 'paused', 'draft'] as const, 'status'),
    )
    .run();

  const id = Number((result.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
  return json({ ok: true, id }, { status: 201 });
};

const updateBanner: Handler = async ({ request, env, params }) => {
  const id = paramId(params.id);
  const existing = await getBanner(env, id);
  if (!existing) return error(404, 'unknown banner');
  const body = await readJson(request);
  const campaignId = clampInt(body.campaign_id ?? existing.campaign_id, 1, 1e9, 0);
  if (!(await getCampaign(env, campaignId))) return error(400, 'unknown campaign_id');
  const type = oneOf(body.type ?? existing.type, ['image', 'html', 'text'] as const, 'type');

  await env.DB
    .prepare(
      `UPDATE banners
          SET campaign_id = ?1, name = ?2, type = ?3, width = ?4, height = ?5, alt = ?6,
              html = ?7, target_url = ?8, weight = ?9, status = ?10, updated_at = datetime('now')
        WHERE id = ?11`,
    )
    .bind(
      campaignId,
      requireName(body.name ?? existing.name, 'name'),
      type,
      clampInt(body.width ?? existing.width, 0, 4000, existing.width),
      clampInt(body.height ?? existing.height, 0, 4000, existing.height),
      toStr(body.alt ?? existing.alt, 300),
      type === 'image' ? '' : limitedHtml(body.html ?? existing.html, 'html'),
      requireTargetUrl(body.target_url ?? existing.target_url),
      clampInt(body.weight ?? existing.weight, 1, 1000, existing.weight),
      oneOf(body.status ?? existing.status, ['active', 'paused', 'draft'] as const, 'status'),
      id,
    )
    .run();

  return json({ ok: true, id });
};

const deleteBanner: Handler = async ({ env, params }) => {
  const id = paramId(params.id);
  const banner = await getBanner(env, id);
  if (banner?.image_key) await env.ADS.delete(banner.image_key).catch(() => undefined);
  const result = await env.DB.prepare('DELETE FROM banners WHERE id = ?1').bind(id).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (!changes) return error(404, 'unknown banner');
  return json({ ok: true, id });
};

/** Sniff real image bytes — never trust the declared content type. */
function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return null;
}

const uploadCreative: Handler = async ({ request, env, params }) => {
  const id = paramId(params.id);
  const banner = await getBanner(env, id);
  if (!banner) return error(404, 'unknown banner');
  if (banner.type !== 'image') return error(400, 'banner is not an image banner');

  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('multipart/form-data')) fail('expected multipart/form-data');

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) fail('missing file field');
  if (file.size === 0) fail('empty file');
  if (file.size > MAX_IMAGE_BYTES) fail(`image is larger than ${MAX_IMAGE_BYTES} bytes`);
  if (file.type && !ALLOWED_IMAGE_MIME.has(file.type)) {
    fail(`unsupported type ${file.type}; use png, jpeg, gif or webp`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(bytes);
  if (!sniffed || !ALLOWED_IMAGE_MIME.has(sniffed)) {
    fail('file is not a valid png, jpeg, gif or webp image');
  }

  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[sniffed];
  const key = `banners/${id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;

  await env.ADS.put(key, bytes, {
    httpMetadata: { contentType: sniffed, cacheControl: 'public, max-age=31536000, immutable' },
  });

  if (banner.image_key) await env.ADS.delete(banner.image_key).catch(() => undefined);

  await env.DB
    .prepare(
      `UPDATE banners SET image_key = ?1, image_mime = ?2, image_bytes = ?3, updated_at = datetime('now')
        WHERE id = ?4`,
    )
    .bind(key, sniffed, bytes.byteLength, id)
    .run();

  return json({ ok: true, id, key, mime: sniffed, bytes: bytes.byteLength });
};

// ------------------------------------------------------------------- routing

export const adminRoutes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/admin\/me$/, me],
  ['GET', /^\/api\/admin\/overview$/, overview],
  ['GET', /^\/api\/admin\/stats$/, stats],

  ['GET', /^\/api\/admin\/zones$/, zonesList],
  ['POST', /^\/api\/admin\/zones$/, createZone],
  ['PUT', /^\/api\/admin\/zones\/(?<id>\d+)$/, updateZone],
  ['DELETE', /^\/api\/admin\/zones\/(?<id>\d+)$/, deleteZone],
  ['GET', /^\/api\/admin\/zones\/(?<id>\d+)\/snippet$/, zoneSnippet],
  ['GET', /^\/api\/admin\/preview$/, zonePreview],
  ['GET', /^\/api\/admin\/banner-preview\/(?<id>\d+)$/, bannerPreview],

  ['GET', /^\/api\/admin\/sites$/, sitesList],
  ['POST', /^\/api\/admin\/sites$/, createSite],
  ['PUT', /^\/api\/admin\/sites\/(?<id>\d+)$/, updateSite],
  ['DELETE', /^\/api\/admin\/sites\/(?<id>\d+)$/, deleteSite],

  ['GET', /^\/api\/admin\/campaigns$/, campaignsList],
  ['POST', /^\/api\/admin\/campaigns$/, createCampaign],
  ['PUT', /^\/api\/admin\/campaigns\/(?<id>\d+)$/, updateCampaign],
  ['DELETE', /^\/api\/admin\/campaigns\/(?<id>\d+)$/, deleteCampaign],

  ['GET', /^\/api\/admin\/banners$/, bannersList],
  ['POST', /^\/api\/admin\/banners$/, createBanner],
  ['PUT', /^\/api\/admin\/banners\/(?<id>\d+)$/, updateBanner],
  ['DELETE', /^\/api\/admin\/banners\/(?<id>\d+)$/, deleteBanner],
  ['POST', /^\/api\/admin\/banners\/(?<id>\d+)\/creative$/, uploadCreative],
];

export async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const gate = await guard(request, env, url.pathname);
  if (!gate.ok) return gate.response;

  for (const [method, pattern, handler] of adminRoutes) {
    if (method !== request.method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    try {
      return await handler({
        request,
        env,
        identity: gate.identity,
        params: (match.groups ?? {}) as Params,
        url,
        ctx,
      });
    } catch (caught) {
      if (caught instanceof ValidationError) return error(400, caught.message);
      throw caught;
    }
  }
  return error(404, 'no such admin endpoint');
}
