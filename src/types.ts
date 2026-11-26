/**
 * Shared types. Kept dependency-free so both the Worker and the node test
 * runner can use them.
 */

export interface Env {
  DB: D1Database;
  ADS: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ADS_BASE_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  STATS_TIMEZONE: string;
  CLICK_SECRET?: string;
  IP_SALT?: string;
  ACCESS_DEV_TOKEN?: string;
}

export interface SiteRow {
  id: number;
  name: string;
  domain: string;
  notes: string;
  active: number;
  created_at?: string;
  updated_at?: string;
}

export interface ZoneRow {
  id: number;
  name: string;
  slug: string | null;
  site_id: number | null;
  width: number;
  height: number;
  auto_height: number;
  mode: 'iframe' | 'inline';
  page_allow: string;
  page_block: string;
  fallback_html: string;
  active: number;
  created_at?: string;
  updated_at?: string;
}

export interface CampaignRow {
  id: number;
  name: string;
  advertiser: string;
  priority: number;
  weight: number;
  starts_at: string;
  ends_at: string;
  imp_cap: number;
  click_cap: number;
  page_allow: string;
  page_block: string;
  status: 'active' | 'paused' | 'draft' | 'finished';
  created_at?: string;
  updated_at?: string;
}

export interface BannerRow {
  id: number;
  campaign_id: number;
  name: string;
  type: 'image' | 'html' | 'text';
  image_key: string;
  image_mime: string;
  image_bytes: number;
  width: number;
  height: number;
  alt: string;
  html: string;
  target_url: string;
  weight: number;
  status: 'active' | 'paused' | 'draft';
  created_at?: string;
  updated_at?: string;
}

export interface StatsRow {
  banner_id: number;
  zone_id: number;
  day: string;
  impressions: number;
  clicks: number;
}
