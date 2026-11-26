# Changelog

Newest first.

## 2026-10-20 — Sites

- **Campaign page targeting** (migration `0003_campaign_targeting`): `campaigns.page_allow` / `page_block` filter a campaign by the host page URL before selection, so one campaign in a shared zone can run suburb-only while other campaigns keep serving everywhere. Campaign form exposes both fields, same pattern syntax as zones.
- Set campaign 3 (Dental Scout) to the eight state path prefixes (`/queensland/*`, `/new-south-wales/*`, …). Verified: 10/10 clinic and state-page serves excluded banner 7; `/queensland/victoria-point` alternated banner 6 and 7.
- Auto-height ad documents now use `min-height:100%`, so a short creative centres vertically in its frame instead of sitting at the top.
- Added `sites` (migration `0002_sites`) and `zones.site_id`: a site groups the ad slots on one website, mirroring Revive's publisher/website layer. Zones remain the serving unit, so existing tags are unchanged.
- Admin console: new **Sites** nav view (create/edit/delete, per-site zone list, 14-day impressions/clicks/CTR), site picker in the zone form, Site column on the zones table, and `site` as a report group.
- Site deletion detaches its zones rather than deleting them; deleting a zone leaves its site intact.
- Verified locally: migration applies, sites CRUD works, zone assignment round-trips, and `stats?group=site` rolls zone traffic up under the site (40 impressions / 2 clicks in the test).
- Deployed: migration `0002_sites` applied to remote D1, Worker version `b2293809-cb47-4a4d-86a8-4a3037c89d1e` live on the custom domain. Deploy needs the OAuth login, not the D1-scoped `CLOUDFLARE_API_TOKEN` (that token returns "No access to the specified service").
- Fixed: mixed-size campaigns served every banner everywhere, so a 728x90 leaderboard could land in a 250x250 zone. `fitsSlot` now requires the creative to match the slot's aspect ratio (creatives are scaled to the slot); fluid slots stay unrestricted. Deployed as `43454eff-2cee-4d4a-9ea6-309dcecf30b2`.

## 2026-09-14 — v0.1.0 deployed

- Worker `adserver` live on a Workers subdomain (version `9736538d`), with `account_id` pinned in config
- D1 schema applied to the remote database (migration `0001_init`, 6 tables); secrets `CLICK_SECRET` and `IP_SALT` set
- Verified against production: `/healthz`, landing page, `/robots.txt`; unknown zone returns 404; admin API 400 without the CSRF header and 401 without an Access identity
- Full delivery path proved end to end with temporary data, then removed: both banners served (weighted 4/4 across 8 serves), image creative fetched from R2 (`200 image/png`), signed click `302` to the advertiser, counters persisted (3 + 6 impressions, 1 click, 1 dedupe row), all temp rows and the R2 object deleted afterwards
- Deployment gotchas recorded in DEPLOY.md: R2 CLI commands need `--remote` (they silently use the local simulation and report success), and a D1-scoped `CLOUDFLARE_API_TOKEN` masks an OAuth login and breaks Workers commands
- Still to do: Cloudflare Access application for `/admin*` + `/api/admin/*` then set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`; custom domain + `ADS_BASE_URL`; confirm `STATS_TIMEZONE`

## 2026-09-14 — v0.1.0 (initial build)

### Fixed during local verification (before first deploy)

- `listCandidates` aggregated `stats_daily` by a `campaign_id` column that does not exist — the join now goes through `banners`. Caught by running the real request path, not by the unit tests.
- The same query bound three parameters to a two-parameter statement (`Wrong number of parameter bindings`). The unused `nowIso` argument is gone.
- Host+path targeting patterns (`example.com/private*`) were documented but not matched; `matchesPattern` now splits host and path and requires both.
- Local dev console was unusable: a browser navigation cannot send `x-dev-admin-token`. In dev the shell now injects the token as a meta tag that the console replays as a header. Never emitted in production.
- `clampInt` could turn an invalid admin path id into a valid record id; replaced with `paramId`, which rejects anything below 1.

### Verified locally (wrangler dev, local D1 + R2)

- `/api/serve` renders a banner, `/api/click` 302s to the advertiser's stored URL, `/t/imp.gif` returns the pixel
- Impressions and clicks persist to `stats_daily`; a repeated click counts once (`click_dedupe`)
- Bot user agents (curl) are served ads but excluded from counts
- `/api/admin/*` answers 400 without the CSRF header, 401 without a valid identity, 200 with one; `preview=1` is admin-only

- Repo created: Cloudflare Workers + D1 + R2 ad server (Revive-style)
- Delivery:
  - `/z/<id>.js` and `/ads.js` drop-in loader (iframe or inline mode, lazy loading, rotation, per-visitor client-side cap, `postMessage` height/info handshake)
  - `/api/serve` selection: priority bands + weighted share of voice, date windows, per-day impression/click caps, zone page targeting (allow/block patterns), fallback HTML
  - Creative types: image from R2, HTML5 (sandboxed), plain text
  - Macros: `{{CLICK_URL}}`, `{{CACHEBUSTER}}`, `{{AD_WIDTH}}`, `{{AD_HEIGHT}}`, `{{ZONE_ID}}`, `{{BANNER_ID}}`, `{{CAMPAIGN_ID}}`, `{{PAGE_URL}}`
- Tracking: `/api/click` (HMAC-signed, deduped per visitor/banner/day, no open redirect), `/t/imp.gif` beacon, bot filtering, daily aggregates in `stats_daily`
- Admin API `/api/admin/*`: zones, campaigns (+ zone links), banners, image upload with byte sniffing, reports by day/banner/campaign/zone, zone tag snippet
- Console `/admin/`: dashboard with 14-day chart, zones (with preview + tag), campaigns, banners (with preview and upload), report with CSV export — no build step
- Security: Cloudflare Access JWT verified in-Worker (RS256/JWKS/iss/aud/exp), `x-adserver-admin` CSRF guard, sandboxed creative frames plus CSP `sandbox` on creative documents, escaped output, bound SQL, no cookies and no stored IPs
- Tests: `node:test` suite for the delivery engine, targeting patterns and macros
- Docs: README, ARCHITECTURE, SECURITY, DEPLOY, docs/INTEGRATION
