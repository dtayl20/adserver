-- ---------------------------------------------------------------------------
-- Campaign page targeting: a campaign can be limited to a set of page URLs,
-- independent of the zones it is linked to. This is what lets one creative in a
-- shared sidebar slot run only on suburb pages (e.g. /qld/victoria-point) while
-- the other campaigns in the same zone keep serving everywhere.
--
-- Same syntax as zone targeting: hosts, host/path, /path wildcards, or full
-- URLs, one per line. Empty allow = any page.
-- ---------------------------------------------------------------------------

ALTER TABLE campaigns ADD COLUMN page_allow TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN page_block TEXT NOT NULL DEFAULT '';
