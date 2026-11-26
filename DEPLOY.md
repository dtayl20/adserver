# Deploy

Everything runs on Cloudflare. You create the D1 database and the R2 bucket
(both are outside this repo); the rest is config and one deploy.

## 0. Prerequisites

```bash
npm install                       # dev deps: wrangler, typescript, types
npx wrangler login                # or set CLOUDFLARE_API_TOKEN
```

## 1. Create the data store and the bucket

```bash
npx wrangler d1 create adserver
npx wrangler r2 bucket create adserver-creatives
```

`d1 create` prints a `database_id`. Paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "adserver"
database_id = "<the id it printed>"
```

The bucket name must match `[[r2_buckets]].bucket_name` (`adserver-creatives`).
Leave the bucket private — images are proxied through `/i/<id>`.

## 2. Set the variables

In `wrangler.toml` → `[vars]`:

| Var | Value |
|---|---|
| `ADS_BASE_URL` | the origin the tags are served from, e.g. `https://ads.example.com` (no trailing slash) |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` (no scheme) |
| `ACCESS_AUD` | the Access application's **Application Audience (AUD) tag** (step 5) |
| `STATS_TIMEZONE` | defaults to `Australia/Sydney`; controls the reporting day boundary and cap resets |
| `ENVIRONMENT` | `production` |

While `ADS_BASE_URL` still points at `ads.example.com`, the Worker falls back to
the request origin, so tags keep working on `*.workers.dev` before the domain is live.

## 3. Set the secrets

```bash
npx wrangler secret put CLICK_SECRET     # e.g. openssl rand -hex 32
npx wrangler secret put IP_SALT          # e.g. openssl rand -hex 16
```

`CLICK_SECRET` signs click/impression tokens — without it, clicks are not
counted (delivery still works). `IP_SALT` salts the click-dedupe hash.

## 4. Apply the schema and deploy

```bash
npm run db:migrate          # wrangler d1 migrations apply adserver --remote
npx wrangler deploy
```

`npm run db:seed` adds two demo text banners — useful to confirm delivery, then
delete them from the console.

## 5. Protect the console with Cloudflare Access

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

- Application domain: `ads.example.com`
- Paths: `/admin` and `/api/admin` (add both, covering sub-paths)
- Policy: allow → your email (or an email-domain rule)

Then copy the app's **AUD tag** (Overview tab) into `ACCESS_AUD` and
`ACCESS_TEAM_DOMAIN` into the vars, and deploy again:

```bash
npx wrangler deploy
```

Order matters: set `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` **after** the Access app
exists — until then, `/admin` will answer 401 because the Worker cannot verify a
JWT for an app that does not exist yet.

Verify the gate:

```bash
curl -i https://ads.example.com/api/admin/me                 # redirected to Access / 401
curl -i -H "x-adserver-admin: 1" https://ads.example.com/api/admin/me   # must not return data
```

## 6. Custom domain and the tag

Workers → your Worker → Settings → Domains & Routes → add `ads.example.com`.
Then in the console, open **Zones → Tag** for a zone and paste the snippet:

```html
<div id="adsrv-zone-1"></div>
<script async src="https://ads.example.com/z/1.js" data-zone="1" data-target="#adsrv-zone-1"></script>
```

## 7. Recommended edge rules (before paid traffic)

- Rate-limit `/api/serve` and `/api/click` (Cloudflare WAF → Rate limiting rules)
- Cache rule: bypass cache for `/api/*` and `/t/*`
- Optional: block `/admin*` and `/api/admin/*` at the WAF for any country you do
  not administer from

## Operations

| Task | Command |
|---|---|
| Tail live logs | `npm run tail` |
| Apply new migrations | `npm run db:migrate` |
| Roll back code | `npx wrangler rollback` |
| Inspect the DB | `npx wrangler d1 execute adserver --remote --command "SELECT * FROM zones"` |
| Clear daily counters (careful) | `DELETE FROM stats_daily WHERE day = '<yyyy-mm-dd>'` |

## Gotchas

- **`wrangler r2 object put` writes to the LOCAL R2 simulation by default** and reports success either way — it just prints `Use --remote if you want to access the remote instance`. The deployed Worker then 404s on `/i/<id>`. Always pass `--remote` when you mean the real bucket. `wrangler r2 object delete` behaves the same way.
- `wrangler d1 execute` also defaults to local; add `--remote` for the live database (only migrations prompt to confirm).
- If `CLOUDFLARE_API_TOKEN` is set in the environment, wrangler prefers it over an OAuth `wrangler login` session. A D1-scoped token then fails every Workers command with `Authentication error [code: 10000]`, and `wrangler whoami` reports `Failed to automatically retrieve account IDs` even when a valid OAuth session exists. Unset the variable for deploy commands (`Remove-Item Env:CLOUDFLARE_API_TOKEN`), or pin `account_id` in `wrangler.toml`.
- Pasting the real `database_id` into `wrangler.toml` changes the **local** D1 namespace key, so a dev database that was already migrated looks empty and requests fail with `no such table: zones`. Re-run `npm run db:migrate:local` and `npm run db:seed:local` after wiring in the real database id.

## Deploy checklist

- [ ] `wrangler.toml` has the real `database_id`, bucket name and `ADS_BASE_URL`
- [ ] `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` match the Access application
- [ ] `CLICK_SECRET` and `IP_SALT` are set as secrets (not in config)
- [ ] Migration applied (`npm run db:migrate`)
- [ ] `/admin` prompts for Access login
- [ ] `/api/admin/me` returns 401 without the Access session
- [ ] A test zone serves an ad on a real page, and the impression appears in the console
- [ ] Bots are not inflating counts (compare with a `curl` hit — it should not count)
