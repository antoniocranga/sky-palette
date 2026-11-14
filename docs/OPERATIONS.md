# Operations

Everything needed to run Sky Palette in production. Two control planes: **Cloudflare** (compute, data, bot protection) and **GitHub** (source, CI, deploys).

---

## 1. Cloudflare dashboard

### 1.1 R2 (photo storage)

R2 must be enabled once per account before any R2 API call or deploy works.

1. Dashboard → **R2** → **Enable R2** (accept the terms). No card is required for the free tier.
2. **Create bucket** → name `sky-photos` → location hint **EEUR** (or Automatic).
3. Keep the bucket **private**. Do not enable the `r2.dev` public URL; photos are streamed through `GET /api/photos/*` so the Worker controls access and caching.
4. Verify: `npx wrangler r2 bucket list` prints `sky-photos`.

#### R2 settings: what to enable and what to leave alone

| Setting | For this project | Why |
|---|---|---|
| **Public development URL (`r2.dev`)** | **Off** | It bypasses the Worker, exposes every object to the internet, and bills egress. The app serves photos through the Worker. |
| **Custom domains** (e.g. `photos.skypalette.app`) | **None** | A public hostname cannot enforce "pending review" or future access rules. If you later want a CDN hostname, put it behind a Worker route instead. |
| **CORS policy** | **None** | The browser never talks to R2 directly: uploads and reads are same-origin through `/api/*`. A CORS rule would only widen access. |
| **Object lifecycle rules** | **Keep the default multipart-abort rule** (7 days) | Orphaned multipart uploads are the only garbage this bucket produces. Do **not** add an age-based delete on `photos/` — those are community photos. |
| **Bucket lock rules** | **None** | Locking prevents deleting rejected photos or honouring removal requests. Retention is enforced by the app, not the bucket. |
| **Data access logs / event notifications** | **Off** | Object-level access logs contain client IPs and object keys, which contradicts the zero-IP policy. Use Workers Logs and the `/api/photos/*` request id instead. Revisit only with a redacted Logpush destination. |
| **Local uploads** | **Off** | This is for large uploads from distant clients; our uploads are ≤30 MB and written by the Worker at the edge. |
| **Basin catalog (Iceberg)** | **Off** | It turns object storage into queryable Iceberg tables. Photos and D1 rows are not tabular analytics data; enabling it adds infrastructure for no product value. |

If you ever change the upload model to direct-to-R2 (presigned URLs), you will need a narrow CORS rule:

```json
[{ "AllowedOrigins": ["https://skypalette.app"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

and the Worker must still validate size, type and metadata before issuing the URL.

### 1.2 D1 (database)

The database `sky-palette-db` already exists. Schema is managed only through `migrations/*.sql`.

- CI applies migrations before every production deploy.
- Manual apply: `npm run db:migrate:remote` (or `npx wrangler d1 migrations apply sky-palette-db --remote`).
- Local apply: `npm run db:migrate:local`.
- Inspect: Dashboard → **Workers & Pages → D1 → sky-palette-db → Console**, or `npx wrangler d1 execute sky-palette-db --remote --command "select count(*) from submissions"`.

Never edit tables by hand in production; add a migration.

### 1.3 Turnstile (bot protection on uploads)

1. Dashboard → **Turnstile** → **Add widget**.
2. Name `skypalette.app`, hostnames: `skypalette.app`, `www.skypalette.app`, `localhost`. Widget mode **Managed**. Pre-clearance off.
3. Copy the **Site Key** (public) into `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`. It is served to the browser by `GET /api/config`.
4. Store the **Secret Key** as a Worker secret:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

The Worker verifies every token against Siteverify and rejects with `403` on failure. If the secret is missing the Worker logs a warning and continues, so local dev works without Turnstile — set it in production.

### 1.4 Worker secrets

| Secret | Purpose | How |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | Siteverify | `npx wrangler secret put TURNSTILE_SECRET_KEY` |
| `IP_SALT` | Salt for SHA-256 IP hashes used by upload rate limits | `openssl rand -hex 32` then `npx wrangler secret put IP_SALT` |

Secrets live in Cloudflare, never in git or GitHub. Rotate `IP_SALT` only if you accept that existing rate-limit rows stop matching.

### 1.5 Observability and alerts

`wrangler.jsonc` already enables **Workers Logs** (invocation logs, 100% sampling) and **Workers Traces**. The Worker emits one structured JSON line per request (`palette.computed`, `rate_limit.exceeded`, `request.unhandled`, …).

- Live tail: Dashboard → **Workers & Pages → sky-palette → Logs**.
- Traces: **sky-palette → Observability → Traces**. Use `requestId` / `cf-ray` to correlate.
- Alerts: **Notifications → Add** → *Workers* → **Errors** (and **Usage**) → email/webhook.
- Optional external export: Workers Logpush to R2/S3/Datadog. Do not add an OTLP endpoint by hand; use Workers Traces or Logpush.

### 1.6 Continuous deployment (choose one)

**A. GitHub Actions (configured in this repo, recommended).** Push to `main` → `Validate` job (typecheck, unit, worker integration, build, Playwright) → `Deploy production` job (D1 migrations, `wrangler deploy`, health smoke test). Nothing to click.

**B. Workers Builds (native, no token).** Dashboard → **Workers & Pages → sky-palette → Settings → Build** → **Connect** GitHub, install the Cloudflare GitHub App, select `antoniocranga/sky-palette`, branch `main`:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`
- Node version: 22

Workers Builds does not run D1 migrations, so keep a migration step in GitHub Actions or run it manually. **Do not enable A and B together** — you will deploy twice per push.

### 1.7 Zone settings (skypalette.app)

Dashboard → the zone → **SSL/TLS**:

- Overview: **Full (strict)** is not needed (no origin); Cloudflare terminates TLS at the edge.
- Edge Certificates: **Always Use HTTPS** on, **Automatic HTTPS Rewrites** on, **TLS 1.3** on, **Minimum TLS 1.2**, **HSTS** on with `max-age=15552000; includeSubDomains` (add `preload` only after you are sure).

**Caching → Configuration**: Brotli on, Early Hints on. Add a **Cache Rule**: URI path starts with `/api/` → *Bypass cache*, except `GET /api/palette`, `GET /api/history`, `GET /api/og`, which set their own `Cache-Control` and are safe to cache at the edge.

**Security → WAF → Rate limiting rules** (defense in depth on top of the Worker limiter):

- `/api/submit` — 10 requests / minute / IP → Block for 1 minute.
- `/api/palette` — 120 requests / minute / IP → Managed Challenge.

**Security → Bots**: leave **Bot Fight Mode off**; Turnstile covers the only write endpoint and Bot Fight Mode blocks legitimate link previews.

**DNS**: `skypalette.app` and `www` are Worker custom domains already. Keep them proxied (orange cloud).

### 1.8 Web Analytics (optional, cookie-free)

Dashboard → **Analytics → Web Analytics → Add a site** → `skypalette.app`. If automatic injection does not appear (HTML is served by a Worker), copy the beacon token and add to `index.html`:

```html
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token":"<TOKEN>"}'></script>
```

and extend the CSP in `public/_headers` with `https://static.cloudflareinsights.com` in `script-src` and `connect-src`. The token is public. Leave it disabled if you prefer zero third-party requests; the app works either way.

### 1.9 Releases

A release is one version number in three places: `package.json`, the Cloudflare Worker version tag, and the GitHub release tag. They must agree.

```bash
# 1. Set the version (no git tag yet)
npm version 1.0.0 --no-git-tag-version

# 2. Move the changelog entry from [Unreleased] into [1.0.0]

# 3. Full gate
npm run typecheck && npm test && npm run build && npm run test:e2e

# 4. Deploy, tagging the Worker version
npm run deploy -- --tag v1.0.0 --message "Sky Palette 1.0.0"

# 5. Confirm the API reports the tag
curl -s https://skypalette.app/api/config | grep -o '"version":"[^"]*"'

# 6. After the release commit is on main, create the GitHub release
gh release create v1.0.0 --target main --title "v1.0.0" --notes-file CHANGELOG.md
```

Cloudflare has no separate “release” object: every deploy is an immutable Worker **version**, and `--tag` labels it. Roll back from **Workers & Pages → sky-palette → Deployments** by selecting an earlier version. D1 and R2 have no tags; D1 schema is versioned by `migrations/`.

### 1.10 The stale-build trap

The Vite build writes `.wrangler/deploy/config.json`, which points Wrangler at `dist/worker/`. Consequences:

- `npm run dev` (Vite) is the correct local loop; it serves source.
- `npx wrangler dev` after editing `src/` will serve the **last built** bundle until you run `npm run build`. If a change “does nothing”, this is why.
- `npm run deploy` always rebuilds first, so production is never stale.

### 1.12 Abuse protection

Four layers, cheapest first:

| Layer | Where | Limit | Purpose |
|---|---|---|---|
| Zone rate limit | Cloudflare `http_ratelimit` ruleset | **150 requests / 10 s / IP / colo** on `/api/*` | Absorbs floods before they reach a Worker isolate or D1. Blocked for 10 s. |
| Global API limiter | `API_LIMITER` binding | 600 / min / IP / colo | Per-isolate ceiling on the whole API surface. `/api/health` is exempt so monitoring always works. |
| Per-route limiter | `PALETTE_LIMITER`, `CITIES_LIMITER`, `OG_LIMITER`, `SUBMIT_LIMITER` | 120/60, 60/60, 20/60, 10/60 | Protects upstream weather/geocoding calls and the CPU-heavy OG renderer. |
| Authoritative quota | D1 `rate_limits` | 5 uploads/hour/IP; 2 000 uploads/day globally | Race-free storage protection. One atomic `INSERT … ON CONFLICT … RETURNING` per window. |

The free plan allows **one** rate-limiting rule, a **10-second** period, and a **10-second** mitigation timeout. Those are platform limits, not choices: the single slot is spent on `/api/*` because it covers every endpoint, while the Worker's bindings and D1 quotas do the precise work behind it.

`rate_limits` keys are either fixed action names (`submit:global`) or salted IP digests (`submit:<sha256>`); no raw address is stored. Old windows are pruned off the request path (`ctx.waitUntil(pruneQuotas)`) after a successful upload.

Verify the quotas under load (see `load/README.md`):

```bash
npm run dev
npm run test:load -- --mode palette --concurrency 30 --duration 8
npm run test:load -- --mode upload --concurrency 15 --duration 6
```

The upload run must show exactly **5 accepted (201)**, thousands of **429**, **zero 5xx**, and the `submissions` count must equal 5 — that is the storage guarantee.

The Worker is also protected by Turnstile on `/api/submit` (on by default once `TURNSTILE_SECRET_KEY` exists), a 30 MB body cap, magic-byte validation and metadata stripping. Nothing user-supplied is written to R2 before those checks pass.

### 1.13 Runbook

**Pause uploads immediately** (reads and the gallery stay up):

```bash
npx wrangler secret put UPLOADS_ENABLED   # enter: false
# resume
npx wrangler secret put UPLOADS_ENABLED   # enter: true
```

The check runs before the body is read, so a paused endpoint costs nothing.

**Moderate or delete a submission** (requires the `ADMIN_TOKEN` secret):

```bash
npx wrangler secret put ADMIN_TOKEN        # one long random value
curl -X PATCH https://skypalette.app/api/admin/submissions/<id> \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
curl -X DELETE https://skypalette.app/api/admin/submissions/<id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

`DELETE` removes the D1 row and the R2 object. When `ADMIN_TOKEN` is unset the whole admin surface returns 404.

**Roll back a bad deploy:** Workers & Pages → sky-palette → Deployments → pick the previous version → Deploy. D1 and R2 are not rolled back; migrations are additive only.

**Alerts to configure once:** Workers errors, Workers usage, R2 storage/operations, D1 rows read/written. Notifications → Add.

### 1.14 Deploy checklist (before every release)

- [ ] `npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e` pass locally.
- [ ] `wrangler.jsonc` has no secrets and no local paths.
- [ ] `git diff --cached` shows no `.env`, `.dev.vars`, `.wrangler/`, tokens, or absolute paths.
- [ ] D1 migrations reviewed and additive (no destructive `DROP` without a backup).
- [ ] R2 bucket `sky-photos` exists; bucket stays private.
- [ ] `TURNSTILE_SITE_KEY` set in vars; `TURNSTILE_SECRET_KEY` and `IP_SALT` set as Worker secrets.
- [ ] `GET /api/health` returns `ok: true` after deploy.
- [ ] Mobile check at 393×852: dock visible, no horizontal scroll, modals scroll internally.

---

## 2. GitHub configuration

### 2.1 Repository features

Settings → **General → Features**: Issues **on**, Discussions optional, Wiki off, Projects off. Issues + the existing templates are the intake path; `SECURITY.md` covers vulnerabilities.

### 2.2 Branch protection

Settings → **Branches → Add branch protection rule** for `main`:

- Require a pull request before merging (1 approval; allow the author to approve for solo work).
- Require status checks: **Validate** (`ci-cd.yml`), plus **CodeQL**.
- Require conversation resolution.
- Block force pushes and deletions.

### 2.3 Environment and secrets

Settings → **Environments → New environment → `production`**:

- Deployment branches: **Selected branches → main**.
- Required reviewers: optional; recommended for a public project so a compromised token cannot deploy silently.
- Environment secrets:

| Secret | Value | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Account id from the dashboard URL | Not sensitive, but scoped to the environment |
| `CLOUDFLARE_API_TOKEN` | Scoped token, see below | Never use a Global API Key |

Create the token at **My Profile → API Tokens → Create Token → Custom token**:

- Account → **Workers Scripts: Edit**
- Account → **D1: Edit**
- Account → **R2: Edit** (bucket list + object read/write)
- Zone → **Workers Routes: Edit** (custom domains)
- Zone → **Zone: Read**
- Account resources: the single account; Zone resources: `skypalette.app`.

Do **not** put `TURNSTILE_SECRET_KEY` or `IP_SALT` in GitHub. They are Worker secrets and already live in Cloudflare.

### 2.4 Code security

Settings → **Code security**: Dependabot alerts **on**, Dependabot security updates **on**, Secret scanning **on** (public repos), Private vulnerability reporting **on**. CodeQL runs from `.github/workflows/codeql.yml`.

### 2.5 Local development

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill TURNSTILE_SECRET_KEY, IP_SALT
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

`npm run deploy` builds and deploys from your machine; CI uses the same commands.
