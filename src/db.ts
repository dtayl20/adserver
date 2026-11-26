/**
 * Data layer. All SQL lives here; every value is a bound parameter.
 */

import type { BannerRow, CampaignRow, Env, SiteRow, StatsRow, ZoneRow } from './types.ts';
import type { Candidate } from './engine.ts';

export function timezoneOf(env: Env): string {
  return env.STATS_TIMEZONE || 'Australia/Sydney';
}

// ---------------------------------------------------------------------- zones

export async function getZone(env: Env, id: number): Promise<ZoneRow | null> {
  return env.DB.prepare('SELECT * FROM zones WHERE id = ?1').bind(id).first<ZoneRow>();
}

export async function listZones(env: Env): Promise<ZoneRow[]> {
  const result = await env.DB.prepare('SELECT * FROM zones ORDER BY id').all<ZoneRow>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------- sites

export async function getSite(env: Env, id: number): Promise<SiteRow | null> {
  return env.DB.prepare('SELECT * FROM sites WHERE id = ?1').bind(id).first<SiteRow>();
}

export async function listSites(env: Env): Promise<SiteRow[]> {
  const result = await env.DB.prepare('SELECT * FROM sites ORDER BY name, id').all<SiteRow>();
  return result.results ?? [];
}

// ------------------------------------------------------------------ campaigns

export async function getCampaign(env: Env, id: number): Promise<CampaignRow | null> {
  return env.DB.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first<CampaignRow>();
}

export async function listCampaigns(env: Env): Promise<CampaignRow[]> {
  const result = await env.DB.prepare('SELECT * FROM campaigns ORDER BY priority, id').all<CampaignRow>();
  return result.results ?? [];
}

export async function campaignZoneIds(env: Env, campaignId: number): Promise<number[]> {
  const result = await env.DB
    .prepare('SELECT zone_id FROM campaign_zones WHERE campaign_id = ?1')
    .bind(campaignId)
    .all<{ zone_id: number }>();
  return (result.results ?? []).map((row) => row.zone_id);
}

export async function allCampaignZoneLinks(env: Env): Promise<Array<{ campaign_id: number; zone_id: number }>> {
  const result = await env.DB
    .prepare('SELECT campaign_id, zone_id FROM campaign_zones')
    .all<{ campaign_id: number; zone_id: number }>();
  return result.results ?? [];
}

// -------------------------------------------------------------------- banners

export async function getBanner(env: Env, id: number): Promise<BannerRow | null> {
  return env.DB.prepare('SELECT * FROM banners WHERE id = ?1').bind(id).first<BannerRow>();
}

export async function listBanners(env: Env, campaignId?: number): Promise<BannerRow[]> {
  const statement = campaignId
    ? env.DB.prepare('SELECT * FROM banners WHERE campaign_id = ?1 ORDER BY id').bind(campaignId)
    : env.DB.prepare('SELECT * FROM banners ORDER BY id');
  const result = await statement.all<BannerRow>();
  return result.results ?? [];
}

// ------------------------------------------------------------------ selection

interface CandidateRow {
  id: number;
  campaign_id: number;
  campaign_name: string;
  name: string;
  type: 'image' | 'html' | 'text';
  image_key: string;
  html: string;
  target_url: string;
  width: number;
  height: number;
  alt: string;
  weight: number;
  priority: number;
  imp_cap: number;
  click_cap: number;
  page_allow: string;
  page_block: string;
  campaign_impressions: number;
  campaign_clicks: number;
  status: string;
  campaign_status: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Every banner linked to the zone whose campaign is live today, with the
 * campaign's impressions/clicks so far today so daily caps can be applied.
 * Daily aggregates only — one row per campaign, so this stays cheap.
 */
export async function listCandidates(
  env: Env,
  zoneId: number,
  day: string,
): Promise<Candidate[]> {
  const result = await env.DB
    .prepare(
      `SELECT b.id                AS id,
              b.campaign_id       AS campaign_id,
              c.name              AS campaign_name,
              b.name              AS name,
              b.type              AS type,
              b.image_key         AS image_key,
              b.html              AS html,
              b.target_url        AS target_url,
              b.width             AS width,
              b.height            AS height,
              b.alt               AS alt,
              b.weight            AS weight,
              c.priority          AS priority,
              c.imp_cap           AS imp_cap,
              c.click_cap         AS click_cap,
              c.page_allow        AS page_allow,
              c.page_block        AS page_block,
              COALESCE(cs.impressions, 0) AS campaign_impressions,
              COALESCE(cs.clicks, 0)      AS campaign_clicks,
              b.status            AS status,
              c.status            AS campaign_status,
              c.starts_at         AS starts_at,
              c.ends_at           AS ends_at
         FROM banners b
         JOIN campaigns c      ON c.id = b.campaign_id
         JOIN campaign_zones z ON z.campaign_id = c.id AND z.zone_id = ?1
    LEFT JOIN (SELECT b2.campaign_id        AS campaign_id,
                      SUM(s.impressions)    AS impressions,
                      SUM(s.clicks)         AS clicks
                 FROM stats_daily s
                 JOIN banners b2 ON b2.id = s.banner_id
                WHERE s.day = ?2
             GROUP BY b2.campaign_id) cs ON cs.campaign_id = c.id
        WHERE b.status = 'active'
          AND c.status = 'active'
          AND (c.starts_at = '' OR substr(c.starts_at, 1, 10) <= ?2)
          AND (c.ends_at   = '' OR substr(c.ends_at,   1, 10) >= ?2)`,
    )
    .bind(zoneId, day)
    .all<CandidateRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    name: row.name,
    type: row.type,
    imageKey: row.image_key,
    html: row.html,
    targetUrl: row.target_url,
    width: row.width,
    height: row.height,
    alt: row.alt,
    weight: row.weight,
    priority: row.priority,
    impCap: row.imp_cap,
    clickCap: row.click_cap,
    pageAllow: row.page_allow,
    pageBlock: row.page_block,
    campaignImpressions: row.campaign_impressions,
    campaignClicks: row.campaign_clicks,
    status: row.status,
    campaignStatus: row.campaign_status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  }));
}

// ------------------------------------------------------------------- counting

export async function recordImpression(
  env: Env,
  bannerId: number,
  zoneId: number,
  day: string,
  count = 1,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO stats_daily (banner_id, zone_id, day, impressions, clicks)
       VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT(banner_id, zone_id, day)
       DO UPDATE SET impressions = impressions + ?4`,
    )
    .bind(bannerId, zoneId, day, count)
    .run();
}

/**
 * Counts a click at most once per visitor per banner per day.
 * Returns true when this click was counted.
 */
export async function recordClick(
  env: Env,
  bannerId: number,
  zoneId: number,
  day: string,
  visitorHash: string,
): Promise<boolean> {
  const inserted = await env.DB
    .prepare('INSERT OR IGNORE INTO click_dedupe (visitor_hash, banner_id, day) VALUES (?1, ?2, ?3)')
    .bind(visitorHash, bannerId, day)
    .run();
  const changes = Number((inserted.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changes === 0) return false;

  await env.DB
    .prepare(
      `INSERT INTO stats_daily (banner_id, zone_id, day, impressions, clicks)
       VALUES (?1, ?2, ?3, 0, 1)
       ON CONFLICT(banner_id, zone_id, day)
       DO UPDATE SET clicks = clicks + 1`,
    )
    .bind(bannerId, zoneId, day)
    .run();
  return true;
}

/** Housekeeping for the dedupe table — safe to call at any time. */
export async function pruneClickDedupe(env: Env, beforeDay: string): Promise<void> {
  await env.DB.prepare('DELETE FROM click_dedupe WHERE day < ?1').bind(beforeDay).run();
}

// ------------------------------------------------------------------ reporting

export interface DayTotals {
  day: string;
  impressions: number;
  clicks: number;
}

export async function totalsByDay(env: Env, fromDay: string, toDay: string): Promise<DayTotals[]> {
  const result = await env.DB
    .prepare(
      `SELECT day, SUM(impressions) AS impressions, SUM(clicks) AS clicks
         FROM stats_daily
        WHERE day >= ?1 AND day <= ?2
     GROUP BY day
     ORDER BY day`,
    )
    .bind(fromDay, toDay)
    .all<DayTotals>();
  return result.results ?? [];
}

export interface GroupTotals {
  key: number;
  label: string;
  impressions: number;
  clicks: number;
}

export async function totalsByGroup(
  env: Env,
  fromDay: string,
  toDay: string,
  group: 'banner' | 'campaign' | 'zone' | 'site',
): Promise<GroupTotals[]> {
  const map = {
    banner: {
      join: 'JOIN banners b ON b.id = s.banner_id',
      key: 's.banner_id',
      label: "b.name || ' (' || b.type || ')'",
    },
    campaign: {
      join: `JOIN banners b ON b.id = s.banner_id
             JOIN campaigns c ON c.id = b.campaign_id`,
      key: 'b.campaign_id',
      label: "c.name || ' · ' || c.advertiser",
    },
    zone: {
      join: 'JOIN zones z ON z.id = s.zone_id',
      key: 's.zone_id',
      label: 'z.name',
    },
    site: {
      join: `JOIN zones z ON z.id = s.zone_id
             LEFT JOIN sites si ON si.id = z.site_id`,
      key: 'COALESCE(z.site_id, 0)',
      label: "COALESCE(si.name, 'Unassigned')",
    },
  }[group];

  const result = await env.DB
    .prepare(
      `SELECT ${map.key} AS key,
              ${map.label} AS label,
              SUM(s.impressions) AS impressions,
              SUM(s.clicks) AS clicks
         FROM stats_daily s
         ${map.join}
        WHERE s.day >= ?1 AND s.day <= ?2
     GROUP BY ${map.key}
     ORDER BY impressions DESC
        LIMIT 200`,
    )
    .bind(fromDay, toDay)
    .all<GroupTotals>();
  return result.results ?? [];
}

export async function statsRows(env: Env, fromDay: string, toDay: string): Promise<StatsRow[]> {
  const result = await env.DB
    .prepare('SELECT * FROM stats_daily WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC LIMIT 2000')
    .bind(fromDay, toDay)
    .all<StatsRow>();
  return result.results ?? [];
}
