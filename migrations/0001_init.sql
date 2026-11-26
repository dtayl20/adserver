-- adserver schema — Cloudflare D1 (SQLite)
-- Apply: npm run db:migrate   (remote)  |  npm run db:migrate:local (local)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Zones: a placement on a site/page. One zone = one ad slot.
-- The tag pasted into the page points at a zone id (/z/<id>.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  slug          TEXT    UNIQUE,                 -- optional human handle, /z/<id>.js works regardless
  width         INTEGER NOT NULL DEFAULT 728,   -- 0 = fluid width
  height        INTEGER NOT NULL DEFAULT 90,    -- 0 = auto height (iframe asks parent to resize)
  auto_height   INTEGER NOT NULL DEFAULT 0,     -- 1 = postMessage resize to parent
  mode          TEXT    NOT NULL DEFAULT 'iframe'
                CHECK (mode IN ('iframe', 'inline')),
  page_allow    TEXT    NOT NULL DEFAULT '',    -- newline list of patterns; empty = any page
  page_block    TEXT    NOT NULL DEFAULT '',    -- newline list of patterns; match = no ad
  fallback_html TEXT    NOT NULL DEFAULT '',    -- served when nothing is eligible
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Campaigns: an advertiser's booking. Priority decides precedence,
-- weight decides share-of-voice within the same priority (Revive model).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  advertiser  TEXT    NOT NULL DEFAULT '',
  priority    INTEGER NOT NULL DEFAULT 5,       -- 0 = highest, 10 = lowest
  weight      INTEGER NOT NULL DEFAULT 1,       -- share-of-voice within a priority band
  starts_at   TEXT    NOT NULL DEFAULT '',      -- '' = no start bound (YYYY-MM-DD or ISO)
  ends_at     TEXT    NOT NULL DEFAULT '',      -- '' = no end bound
  imp_cap     INTEGER NOT NULL DEFAULT 0,       -- max impressions per day, 0 = uncapped
  click_cap   INTEGER NOT NULL DEFAULT 0,       -- max clicks per day, 0 = uncapped
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'draft', 'finished')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_zones (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  zone_id     INTEGER NOT NULL REFERENCES zones(id)     ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, zone_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_zones_zone ON campaign_zones(zone_id);

-- ---------------------------------------------------------------------------
-- Banners = creatives. type image -> R2 object, html -> HTML5 creative,
-- text -> plain text link. Click target is stored here and never taken from
-- the request, so /api/click cannot be used as an open redirect.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banners (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'image'
             CHECK (type IN ('image', 'html', 'text')),
  image_key  TEXT    NOT NULL DEFAULT '',        -- R2 object key
  image_mime TEXT    NOT NULL DEFAULT '',
  image_bytes INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 728,
  height     INTEGER NOT NULL DEFAULT 90,
  alt        TEXT    NOT NULL DEFAULT '',
  html       TEXT    NOT NULL DEFAULT '',        -- HTML5 / text payload, supports {{MACROS}}
  target_url TEXT    NOT NULL DEFAULT '',
  weight     INTEGER NOT NULL DEFAULT 1,
  status     TEXT    NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'paused', 'draft')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_banners_campaign ON banners(campaign_id);

-- ---------------------------------------------------------------------------
-- Aggregated reporting. One row per banner/zone/day keeps D1 writes small and
-- makes report queries trivial. No raw request log and no IP/UA storage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stats_daily (
  banner_id   INTEGER NOT NULL,
  zone_id     INTEGER NOT NULL,
  day         TEXT    NOT NULL,                  -- YYYY-MM-DD in STATS_TIMEZONE
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (banner_id, zone_id, day)
);
CREATE INDEX IF NOT EXISTS idx_stats_daily_day ON stats_daily(day);

-- Click dedupe: one counted click per visitor per banner per day.
CREATE TABLE IF NOT EXISTS click_dedupe (
  visitor_hash TEXT    NOT NULL,
  banner_id    INTEGER NOT NULL,
  day          TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (visitor_hash, banner_id, day)
);
CREATE INDEX IF NOT EXISTS idx_click_dedupe_day ON click_dedupe(day);
