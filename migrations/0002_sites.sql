-- ---------------------------------------------------------------------------
-- Sites: the publisher website a zone lives on. Revive groups inventory this
-- way (websites/affiliates); here one site = one domain, and zones point at it.
-- The site is organisational: serving and targeting stay on the zone, so a
-- site can be added or removed without changing any ad tag.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  domain      TEXT    NOT NULL DEFAULT '',      -- bare host, e.g. localdentists.au
  notes       TEXT    NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);

-- Nullable: existing zones stay valid and simply have no site yet.
-- ON DELETE SET NULL keeps zones (and their tags) alive if a site is removed.
ALTER TABLE zones ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_zones_site ON zones(site_id);
