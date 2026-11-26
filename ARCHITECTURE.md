# Architecture

## Request flows

### Serving an ad (iframe mode, the default)

```
host page                     adserver worker                     D1 / R2
  |  <script src="/z/3.js">        |                                  |
  |------------------------------->|  zone lookup, loader + zone cfg  |
  |  loader builds slot div        |                                  |
  |  (lazy: waits for viewport)    |                                  |
  |  iframe -> /api/serve?z=3&...  |                                  |
  |------------------------------->|  eligible candidates ----------->|
  |                                |  pick priority band + weight     |
  |                                |  count impression (waitUntil) -->|
  |  ad document (image / text /   |                                  |
  |  HTML5 in a nested frame)      |                                  |
  |<-------------------------------|                                  |
  |  postMessage adsrv:info        |                                  |
  |  (loader records rotation)     |                                  |
  |  click -> /api/click?b=1&t=..  |                                  |
  |------------------------------->|  verify HMAC token               |
  |                                |  count click (deduped) --------> |
  |  302 -> advertiser             |                                  |
  |<-------------------------------|                                  |
```

Impressions are counted when the ad document is served, which — because the
loader is lazy — happens when the slot approaches the viewport. That is
"served when likely seen", not IAB viewability. It is the same compromise
Revive makes by default.

### Inline mode (`data-mode="inline"`)

The loader fetches `/api/serve?format=json` and builds an `<a><img></a>` (or a
text link) directly in the host DOM. Only **image** and **plain-text** creatives
are eligible, so no HTML from the database is ever parsed in the host page.
HTML5 creatives are skipped in this mode.

### Management console

```
browser -> ads.example.com/admin/*        -> Cloudflare Access (edge) -> Worker (verifies JWT too) -> static shell
browser -> ads.example.com/api/admin/*    -> Cloudflare Access (edge) -> Worker verifies JWT -> D1 / R2
```

## Data model

| Table | Purpose |
|---|---|
| `sites` | Publisher website that groups zones (`zones.site_id`) |
| `zones` | Ad slots: size, mode, page allow/block patterns, fallback, active |
| `campaigns` | Booking: priority, weight, schedule, daily caps, status |
| `campaign_zones` | Which campaigns are allowed to serve in which zones |
| `banners` | Creatives: image (R2 key) / html / text, click target, weight, status |
| `stats_daily` | Aggregated impressions + clicks per banner/zone/day |
| `click_dedupe` | One counted click per visitor per banner per day (pruned) |

No request logs, no IPs, no user agents, no cookies. The only visitor-level
value is a salted SHA-256 hash used to deduplicate clicks and discarded the
same day.

## Delivery algorithm

1. A banner is a candidate if `banner.status = active`, its campaign is
   `active`, today is inside the campaign window, it has something to render,
   and neither daily cap is reached.
2. Candidates are grouped into **priority bands**. The numerically lowest
   priority present wins the whole band (Revive semantics: priority outranks
   everything).
3. Inside the winning band, a **weighted random draw** picks the banner.
4. Banners the visitor has just seen are excluded first; if that empties the
   band, the full band is used rather than serving nothing.
5. If nothing is eligible, the zone's fallback HTML is served; if there is no
   fallback, the document tells the loader to collapse the slot.

Daily caps are evaluated against `stats_daily` for the current reporting day
(`STATS_TIMEZONE`, default `Australia/Sydney`), so a cap resets at local midnight.

## Why iframes

An ad server injects third-party markup into someone else's page. Iframes give:

- **Style isolation** — the creative cannot restyle the host page.
- **Script isolation** — HTML5 creatives run with `sandbox="allow-scripts
  allow-popups allow-popups-to-escape-sandbox allow-forms"` and no
  `allow-same-origin`, so their origin is opaque: no cookies, no storage, no
  same-origin requests.
- **Predictable sizing** — the slot is exactly the frame.

The cost is that the host page cannot read the creative (hence the
`postMessage` handshake for rotation state and auto-height) and that HTML5
creatives that need to grow must cooperate.

## Rendering modes

| Zone mode | Creatives allowed | Isolation |
|---|---|---|
| `iframe` (default) | image, html, text | host page sees only a frame |
| `inline` | image, text | image/text injected as elements, nothing parsed as HTML |

## Asset caching

- `/ads.js` and `/z/<id>.js` — `max-age=300`/`120`
- `/i/<id>?v=<key token>` — `max-age=31536000, immutable`; a new upload changes
  the R2 key, so the URL changes and a fresh download is guaranteed
- `/api/serve`, `/api/click`, `/t/imp.gif` — `no-store` (CDN caching would break counting)
- `/c/<id>` (creative) — `max-age=60`

## Extending

- New targeting rule: add a column + a check in `engine.ts` (`isEligible`), then
  surface it in `admin.ts` validation and the console form fields.
- New creative type: extend the `banners.type` CHECK, add a branch in
  `serve.ts#renderDocument`, and keep the sandbox contract (untrusted markup
  never renders in the ad document itself).
- Server-side capping or frequency capping: `stats_daily` and `click_dedupe`
  are the right place; a Durable Object is the alternative if per-visitor state
  must be shared across zones.
