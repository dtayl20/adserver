# Setup

Run the whole thing locally in about two minutes, then deploy it when you are happy.

Everything is Cloudflare-native: a Worker, a D1 database and an R2 bucket.
Locally those are simulated by `wrangler dev`, so **no Cloudflare account is needed to try it**.

---

## 1. Local quick start

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/dtayl20/adserver.git
cd adserver
npm install
cp .dev.vars.example .dev.vars     # dev-only secrets, safe defaults already in the file
npm run db:migrate:local           # creates the local D1 schema
npm run db:seed:local              # optional: demo site, zone, campaign and banners
npm run dev                        # wrangler dev on http://localhost:8787
```

Open <http://localhost:8787/admin>.

When `ENVIRONMENT=dev`, the Worker injects the `ACCESS_DEV_TOKEN` from
`.dev.vars` into the console shell, so you are signed in automatically —
no Cloudflare Access, no login screen. That path is compiled out of any
production build because `ENVIRONMENT` is `production` there.

### Try a tag

Create a zone in the console, then drop the script tag on any page:

```html
<div id="slot-1"></div>
<script async src="http://localhost:8787/z/1.js" data-target="#slot-1"></script>
```

---

## 2. What runs where

| Piece | Local | Production |
|---|---|---|
| Router | `wrangler dev` | Worker on a custom domain |
| Database | local D1 (SQLite in `.wrangler/`) | D1 `adserver` |
| Creatives | local R2 | R2 `adserver-creatives` |
| Admin auth | `ACCESS_DEV_TOKEN` header injection | Cloudflare Access JWT, verified in the Worker |
| Secrets | `.dev.vars` | `wrangler secret put` |

---

## 3. Configuration

```toml
[vars]
ENVIRONMENT       = "production"          # "dev" locally enables the dev admin token
ADS_BASE_URL      = "https://ads.example.com"
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUD        = "<Access application AUD tag>"
STATS_TIMEZONE    = "Australia/Brisbane"  # day boundary for caps and reports
```

Secrets (never in `wrangler.toml`):

| Secret | Purpose | If missing |
|---|---|---|
| `CLICK_SECRET` | signs click/impression tokens | clicks are not counted |
| `IP_SALT` | salts the visitor hash used for click dedupe | dedupe degrades |
| `ACCESS_DEV_TOKEN` | local-only admin bypass | console unusable locally |

Generate them with `openssl rand -hex 32`.

---

## 4. Deploy

Full walkthrough, including the Access application and custom domain:
**[DEPLOY.md](DEPLOY.md)**.

Short version:

```bash
npx wrangler login
npx wrangler d1 create adserver           # paste the id into wrangler.toml
npx wrangler r2 bucket create adserver-creatives
npm run db:migrate
npx wrangler secret put CLICK_SECRET
npx wrangler secret put IP_SALT
npm run deploy
```

Then create the Access application for `/manage*` and `/api/admin/*`, and put its
AUD tag in `wrangler.toml`. See [SECURITY.md](SECURITY.md) for the threat model.

---

## 5. Verify it worked

```bash
npm test          # delivery engine unit tests
npm run typecheck # tsc --noEmit
curl -s http://localhost:8787/api/serve?zone=1
```

In production, load a page with a tag and confirm an impression lands in
`/admin → Reporting`.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Console returns 401 locally | `ENVIRONMENT` is not `dev` | set `ENVIRONMENT=dev` in `.dev.vars` |
| Images 404 | R2 bucket name mismatch | bucket must equal `[[r2_buckets]].bucket_name` |
| Clicks not counting | `CLICK_SECRET` unset | `wrangler secret put CLICK_SECRET` |
| Admin works on workers.dev but not the domain | Access AUD mismatch | re-copy the AUD tag from the Access app |
