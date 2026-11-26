# Security

Security is treated as the primary constraint on this project. This file records the
threat model and exactly which control answers each risk, so future changes can
be checked against it.

## Two surfaces with opposite requirements

| Surface | Exposure | Rule |
|---|---|---|
| Delivery (`/ads.js`, `/z/*`, `/api/serve`, `/api/click`, `/t/imp.gif`, `/i/*`, `/c/*`) | public, must work for anonymous visitors on third-party sites | never require auth; never trust input |
| Management (`/admin*`, `/api/admin/*`) | private | Cloudflare Access **and** in-Worker JWT verification |

## Controls

### 1. Admin authentication — verified Access JWT, not a shared key

Cloudflare Access fronts the console at the edge. The Worker does not trust the
fact that a request arrived; it verifies the `Cf-Access-Jwt-Assertion` header:

- signature against the team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), RS256 only
- `iss` must equal the configured team domain
- `aud` must contain the configured `ACCESS_AUD`
- `exp` / `nbf` enforced (60s clock skew)

Client-supplied `Cf-*` headers are stripped by Cloudflare; even if one were not,
an unsigned JWT is rejected. This is real authentication — unlike a key embedded
in a client bundle, which is only a deterrent.

`/admin/*` (the static shell) is checked too, whenever `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` are set, so a mis-scoped edge policy cannot silently expose the console.

Local development uses `ENVIRONMENT=dev` plus `ACCESS_DEV_TOKEN`; the bypass is
impossible in production because it requires `ENVIRONMENT === 'dev'`.

### 2. CSRF-style protection on the admin API

Every admin call must also carry `x-adserver-admin: 1`. A browser form or a
blind cross-site request cannot set custom headers, so this blocks the naive
CSRF class even if the Access cookie is present. The console sends it
automatically. It is a second gate, not a substitute for the JWT.

### 3. Creative isolation (the big one)

An ad server executes third-party content inside other people's pages, and
admins upload that content. Three layers of containment:

1. **Never parse untrusted markup in the ad document.** The `/api/serve`
   document contains only our own HTML: an escaped text string, an `<img>`, or a
   nested `<iframe>`. Zone fallback HTML and HTML5 creatives both render inside
   that nested frame, never inline.
2. **Nested creative frames are sandboxed** with
   `allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms` and
   **no `allow-same-origin`** → opaque origin: no cookies, no storage, no
   same-origin fetches, no top navigation.
3. **The creative document itself carries `Content-Security-Policy: sandbox …`**
   so even when `/c/<id>` is opened directly in a tab (not framed) it still runs
   in an opaque origin and cannot reach the admin API with the viewer's Access
   session.

Images are served from our domain (`/i/<id>`), so creatives cannot point the
browser at an arbitrary remote script via `img-src` chains; creative documents
get a restrictive `Permissions-Policy` and `Referrer-Policy: no-referrer`.

### 4. No open redirect

`/api/click` takes only a banner id. The destination is read from
`banners.target_url` in the database and re-validated as `http(s)` when written
and when used. A request cannot supply a URL.

### 5. Click and impression integrity

Clicks carry an HMAC-SHA256 token over `click:<bannerId>:<zoneId>:<day>` with
`CLICK_SECRET`. A forged or missing token still redirects the visitor (never
break a real click) but is not counted. Tokens are minted per day and both today
and yesterday are accepted, so a creative cached across midnight does not lose
clicks. Impression beacons use the same scheme with the `imp` purpose.

### 6. Upload validation

- Multipart only, single `file` field, 2 MB ceiling
- Declared MIME must be png/jpeg/gif/webp **and** the bytes are sniffed
  independently — the declared type is never trusted
- SVG is refused (script-carrying vector)
- Objects are stored under `banners/<id>/<timestamp>-<random>.<ext>`; replacing a
  creative deletes the previous object
- R2 needs no public access: images are proxied through `/i/<id>`

### 7. Injection

- Every SQL statement uses bound parameters; no string interpolation of values
- All HTML output is escaped (`escapeHtml` covers text and quoted attributes)
- Text creatives have tags stripped and are escaped before rendering
- `Content-Type: application/json` is required for admin JSON bodies and the
  payload must be a plain object

### 8. Abuse and noise

- Known bots/crawlers are served ads but excluded from counts (`looksLikeBot`),
  so client-reported numbers are not inflated by scanners
- Clicks are deduplicated per visitor per banner per day, using a salted
  SHA-256 of IP+UA that expires with the day and is never stored raw
- Daily caps limit what one campaign can spend, per zone/day
- The dedupe table is pruned opportunistically; nothing sensitive accumulates

### 9. Headers

- `/admin*`: `X-Frame-Options: DENY`, strict CSP
  (`script-src 'self'`, `frame-ancestors 'none'`), `no-store`, `noindex`
- ad documents: `frame-ancestors *` (they are meant to be framed), `script-src
  'unsafe-inline'` limited to our own measurement script, `img-src 'self' https: data:`
- `X-Robots-Tag: noindex, nofollow` on ad and creative responses; `/robots.txt`
  disallows everything
- `Cache-Control: no-store` on serve/click/beacon so intermediaries cannot
  cache ads or drop counts

## Privacy

No cookies are set. No IP addresses, user agents, or page URLs are stored. The
only visitor-scoped value is a salted hash kept for the current day to
deduplicate clicks; rotating `IP_SALT` invalidates all of them. Publisher pages
are not logged.

If this ever serves EU/UK traffic at scale, revisit: GDPR/ePrivacy consent for
ad delivery and a documented legal basis. Today's design stores nothing about a
person, which is the strongest position available.

## Known residual risks and the upgrade path

1. **Creatives share a hostname with the console.** The sandbox layers above
   make this safe as built, but the clean fix is serving creatives and the ad
   document from a second hostname (e.g. `ads-cdn.example.com`) with no Access
   application. Recommended before HTML5 creatives are sold to third parties.
2. **An admin-authored creative is trusted-ish.** An admin can store anything in
   a creative; it runs sandboxed, but treat creative upload access as
   privileged.
3. **No rate limiting in the Worker.** Cloudflare's WAF/rate-limiting rules are
   the right layer for `/api/serve` and `/api/click` floods. Add a rule before
   running paid traffic.
4. **Per-visitor caps are client-side.** A determined visitor can bypass them by
   clearing storage. Server-side capping needs per-visitor state (Durable
   Object).
5. **`CLICK_SECRET` / `IP_SALT` are only as good as their handling.** Set them
   with `wrangler secret put`, never in `wrangler.toml`, and rotate by
   re-issuing (tokens are per day, so rotation costs at most a day of clicks).

## Review checklist for changes

- Does this endpoint belong to the public or protected surface, and is it gated accordingly?
- Is any new value interpolated into SQL, HTML, a URL, or a redirect?
- Does untrusted markup reach a document that has our origin?
- Is anything new persisted about a visitor?
- Are new secrets in `wrangler secret`, not config?
