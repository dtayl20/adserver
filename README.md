# adserver

A self-hosted, Revive-style banner ad server on Cloudflare: **Workers + D1 + R2**,
with the management console locked behind **Cloudflare Access**.

> **New here?** [SETUP.md](SETUP.md) runs the whole thing locally in about two
> minutes — no Cloudflare account needed. [DEPLOY.md](DEPLOY.md) covers
> production, [ARCHITECTURE.md](ARCHITECTURE.md) the design, [SECURITY.md](SECURITY.md)
> the threat model.

Drop a script tag on any site and it renders a banner from a zone you control:

```html
<div id="slot-1"></div>
<script async src="https://ads.example.com/z/1.js" data-target="#slot-1"></script>
```

## What it does

**Delivery**
- Sites: group zones by publisher website, with traffic rolled up per site
- Zones (ad slots) with fixed or fluid size, per-page targeting (`allow`/`block` patterns), fallback HTML
- Campaigns with priority (0 wins), weight (share of voice), start/end dates and per-day impression/click caps
- Banners: image (stored in R2), HTML5 creative, or plain text
- Impression counted at serve time; clicks counted once per visitor per banner per day
- Rotation: a visitor does not see the same banner back to back (loader keeps a short local history)
- Lazy loading: the slot is only fetched when it scrolls near the viewport
- Optional auto-height (`postMessage`) for creative that grows
- Revive-style macros in creatives: `{{CLICK_URL}}`, `{{CACHEBUSTER}}`, `{{AD_WIDTH}}`, `{{AD_HEIGHT}}`, `{{ZONE_ID}}`, `{{BANNER_ID}}`, `{{PAGE_URL}}`

**Reporting** — impressions, clicks, CTR by day, banner, campaign, zone and site; CSV export.

**Safety** — creatives run in a sandboxed frame, click redirects are signed and
never accept a request-supplied destination, the admin API verifies the
Cloudflare Access JWT itself. See [SECURITY.md](SECURITY.md).

## Layout

```
src/
  index.ts     router (public endpoints, admin console, assets)
  engine.ts    pure delivery logic — priority bands, weights, targeting, macros
  serve.ts     /api/serve — selection, macro + document rendering
  track.ts     /api/click, /t/imp.gif
  assets.ts    /i/<id> image from R2, /c/<id> sandboxed HTML5 creative
  admin.ts     /api/admin/* (Access-gated CRUD + reports)
  access.ts    Cloudflare Access JWT verification (RS256 against the team JWKS)
  db.ts        all SQL
  util.ts      escaping, hashing, HMAC tokens, day keys
public/
  ads.js       the drop-in loader (also served zone-bound at /z/<id>.js)
  admin/       management console (no build step)
migrations/    D1 schema
seeds/demo.sql local demo data
test/          node:test suite for the engine
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars          # set ACCESS_DEV_TOKEN
npm run db:migrate:local
npm run db:seed:local
npm run dev                             # http://localhost:8787
```

`wrangler dev` runs local D1 and R2 — no Cloudflare resources needed. With
`ENVIRONMENT=dev` and `ACCESS_DEV_TOKEN` set, the console works without
Cloudflare Access.

Smoke test a zone:

```bash
curl -i "http://localhost:8787/api/serve?z=1&w=728&h=90"
curl -s "http://localhost:8787/z/1.js" | head -3
```

## Tests

```bash
npm test          # node:test — delivery engine, targeting, macros
npm run typecheck # optional, needs npm install
```

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version: create the D1 database and R2
bucket, paste the ids into `wrangler.toml`, set `ADS_BASE_URL`,
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, add the two secrets, run the migration,
deploy, then create the Access application for `/admin*` and `/api/admin/*`.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — request flows, data model, why iframes
- [SECURITY.md](SECURITY.md) — threat model and the controls in place
- [DEPLOY.md](DEPLOY.md) — step-by-step deployment
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — pasting tags into real sites
- [CHANGELOG.md](CHANGELOG.md)

## Known limits (deliberate, for v0.1)

- No separate hostname for creatives yet — the ad document and the admin console
  share an origin. The sandbox model makes this safe today; a second hostname is
  the clean upgrade (see SECURITY.md).
- Per-visitor caps are client-side (localStorage on the host page). Server-side
  capping is global per day.
- No video/rich-media zones, no A/B testing, no advertiser self-serve portal,
  no geo targeting, no IAB viewability measurement.
- Statistics are aggregated per day; there is no raw event log.
