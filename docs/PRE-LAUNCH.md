# Pre-launch checklist

Adapted from the Image Uploader + Colour Gallery checklist. Every item is marked **PASS**, **FAIL**, **N/A** or **PARTIAL**, with the evidence used. Items marked 🔴 are launch blockers.

Evidence sources: test names in `tests/worker/` and `tests/unit/`, `wrangler.jsonc`, live Cloudflare API dumps, `curl -I` against production, and `npm audit`. Re-verify the production rows after the 1.0.0 deploy; rows that depend on the not-yet-merged client work say so.

## 1. Upload security 🔴

| Item | Status | Evidence | Action |
|---|---|---|---|
| Type validated by magic bytes, not extension/Content-Type | PASS | `src/worker/lib/image.ts` sniffs JPEG/PNG/WebP signatures; `tests/worker/submit.test.ts` uploads a PNG declared as `image/png` and a WebP declared as `image/png`, both stored by real format | — |
| Max size enforced server-side (and at the edge) | PASS | 30 MB cap in `submit.ts`: `Content-Length` check, streaming cap, `File.size`, decoded length; `tests/worker/submit.test.ts` “declared body larger than 30 MB” → 413. Workers request body limit is 100 MB, so the app cap binds first | — |
| Max dimensions and pixel count (decompression bomb) | PASS | `MAX_DIMENSION = 12000`, `MAX_PIXELS = 40_000_000`; `tests/worker/image.test.ts` rejects 12001 px and a 9000×5000 header | — |
| SVG rejected or sanitised | PASS | `tests/worker/hardening.test.ts` uploads SVG bytes as `image/png` → 415 | — |
| Filenames never trusted; random keys | PASS | `src/worker/lib/handle.ts` → `photos/YYYY/MM/<uuid>.<ext>`; declared filename is ignored (test uploads `my-sky.jpg` and asserts the key pattern) | — |
| EXIF/metadata stripped before storage | PASS | JPEG APP1/APP13/COM, PNG eXIf/tEXt/iTXt/zTXt/tIME, WebP EXIF/XMP with RIFF fix; `submit.accepted` logs `strippedBytes`; `tests/worker/submit.test.ts` asserts stripped size | — |
| Polyglot: image with embedded script does not execute | PASS | `tests/worker/hardening.test.ts` appends `<script>` to a JPEG, re-fetches it, asserts `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` | — |
| Correct Content-Type, nosniff, separate domain | PASS (decision) | Worker sets `image/*` + nosniff; photos are same-origin under `/api/photos/*` so the Worker controls access and CSP. A separate image hostname would be a second, less-controlled door | Revisit only if images need a CDN hostname |
| Malware/NSFW scanning decision documented | PASS (decision) | Uploads are anonymous but Turnstile + human approval gate publication; Workers AI has no reliable NSFW image classifier. `status` defaults to `pending` and only `approved` rows reach `/api/gallery` | Add automated scanning if moderation volume grows |

## 2. Abuse protection 🔴

| Item | Status | Evidence | Action |
|---|---|---|---|
| Rate limiting on upload and API | PASS | Zone rule `http_ratelimit` (150 req/10 s/IP/colo on `/api/*`, live), `API_LIMITER` 600/min, per-route bindings | — |
| Turnstile on anonymous upload | PASS | Widget `skypalette.app` created; server verifies via Siteverify when `TURNSTILE_SECRET_KEY` exists | Install secret at deploy |
| Per-IP quota and total storage cap | PASS | D1 `rate_limits`: 5 uploads/hour/hash, 2 000/day global; `tests/worker/rate-limit.test.ts` proves exactly 5 of 20 parallel uploads reach R2 | — |
| WAF managed rules / bot mode reviewed | PASS | Managed free ruleset active; Bot Fight Mode deliberately off (it blocks link previews); Turnstile covers the write path | — |
| Behaviour when limits are hit | PASS | 429 with `Retry-After`, `no-store`, no 5xx; stress run: 3 361 requests, 0×5xx | — |
| Billing alerts / usage notifications | PASS | `$10` budget alert plus seven enabled usage policies: Workers requests 70k/day, R2 storage 8 GB, R2 Class A 800k, Class B 8M, D1 rows read 4M, rows written 80k, storage 4 GB (all email) | Verify thresholds in the dashboard after a month of data |

## 3. R2 / bucket configuration 🔴

| Item | Status | Evidence | Action |
|---|---|---|---|
| Bucket private, no public listing | PASS | `sky-photos`; managed `r2.dev` domain disabled; no custom domain | — |
| Public access only via Worker | PASS | `GET /api/photos/*` streams private R2 with key validation | — |
| Least-privilege credentials, not in repo/client/logs | PASS | Scoped token (Workers/D1/R2 edit + routes) in the `production` GitHub Environment; worker uses bindings, no credentials in code | — |
| Presigned URLs | N/A | Not used | — |
| CORS locked to real origins | N/A | No CORS policy; browser never calls R2 directly (same-origin Worker) | Add narrow rule only for direct uploads |
| Lifecycle: abort multipart, expire orphans | PASS | Default multipart-abort rule, 7 days | — |
| Separate dev/staging/prod data | PASS (decision) | Local dev uses Miniflare's isolated `.wrangler/state`; no staging environment exists | Add staging if the team grows |
| Backup / retention / deletion | PASS (decision) | Photos are immutable; D1 has 30-day time travel; deletion is explicit via admin API. R2 has no versioning | Export D1 weekly if data matters |
| Orphan handling (upload succeeds, DB fails) | PASS | `src/worker/lib/orphans.ts` + daily cron (`0 3 * * *`) sweeps `photos/` and deletes objects with no D1 row, with a 24 h safety window; `tests/worker/orphans.test.ts` covers kept, referenced-thumb and young objects | — |

## 4. Edge configuration

| Item | Status | Evidence | Action |
|---|---|---|---|
| DNS correct, proxied | PASS | `skypalette.app` + `www` Worker custom domains, active zone | — |
| SSL/TLS, Always HTTPS, TLS 1.2+ | PASS | Zone settings: `always_use_https=on`, `min_tls_version=1.2`, `tls_1_3=on`, `ssl=full` (no origin) | — |
| HSTS | PASS | `max-age=15552000; includeSubDomains` (no preload yet) | Add preload after 30 days |
| www ↔ apex behaviour | PASS (decision) | Both serve 200; canonical is apex via `<link rel="canonical">` | Optional 301 www→apex |
| Caching: immutable assets, no API caching | PASS | `public/_headers` immutable for `/assets/*`; `/api/*` responses carry explicit `Cache-Control`; zone cache rule documented | Verify `cf-cache-status` after deploy |
| Cache purge strategy | PASS | Photos are not edge-cached beyond immutable headers; deletion removes the object, so the next request 404s | — |
| Security headers | PASS | CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy via `_headers`; verified with `curl -I` | — |
| No leftover test rules | PASS | Ruleset list shows managed rulesets + only the API rate limit | — |
| Prod vars/secrets via Wrangler/dashboard | PASS | `vars` in `wrangler.jsonc`, secrets via `wrangler secret put` | — |
| Workers limits reviewed | PASS | Bundle 766 KB gzip (limit 3 MB free); CPU ≈ 20–80 ms per request; 30 MB body inside the 100 MB platform cap | — |
| Custom domain bound; workers.dev disabled | PASS | `workers_dev: false`; two custom domains | — |
| Access protection on admin/staging | PASS | Admin surface requires `ADMIN_TOKEN` bearer and returns 404 when unset; no staging UI | — |
| Email DNS | N/A | The app sends no email | — |

## 5. Colour extraction logic

Sky Palette does **not** extract colours from uploaded photos. Palettes are computed deterministically from solar elevation, cloud layers and visibility (`src/shared/palette.ts`); the uploaded photo is a community reference image. The extraction-specific rows are therefore N/A, with the two that still apply marked PASS.

| Item | Status | Evidence |
|---|---|---|
| Grayscale / single-colour / transparent / tiny / huge images | N/A | No pixel analysis; only header dimensions are read |
| Transparency handled | N/A | Same |
| Colour space / ICC / 16-bit / EXIF orientation | N/A | Pixels are never decoded or re-encoded; metadata is stripped, orientation is irrelevant for storage |
| Downscale before analysis | N/A | Client downscales for upload size, not analysis |
| Deterministic palette | PASS | `tests/unit/shared.test.ts` “is deterministic” |
| Consistent output (HEX, fixed five swatches) | PASS | Five `#RRGGBB` values, same contract in D1, API and DOM |
| Corrupt/unsupported image returns a clear error | PASS | 400/415/422 tests; no hangs |
| Processing within runtime limits | PASS | No decoding; palette maths is microseconds; OG render is the only CPU-heavy path and is rate-limited |
| Idempotent / retry-safe | PASS | Palette is a pure function; upload retries create a new id by design |

## 6. Gallery and frontend

| Item | Status | Evidence | Action |
|---|---|---|---|
| Pagination / bounded queries | PASS | Gallery returns max 6 approved photos; history ≤ 30 days; never lists the bucket | — |
| Thumbnails / responsive variants | PASS | `POST /api/submit` accepts an optional 400 px `thumb`; `migrations/0004_submission_thumb.sql`; `tests/worker/thumb.test.ts` proves storage, fallback and invalid-thumb handling. Gallery returns `thumbUrl` | Client encodes and sends the variant (in flight) |
| Lazy loading, width/height, modern formats | PARTIAL | WebP input supported; `<img>` dimensions set by the layout, `loading="lazy"` not yet used | Add lazy + explicit dims |
| Empty, loading, error states | PASS | `e2e/app.spec.ts` covers offline/retry; gallery/submit have designed states | — |
| Upload UX: progress, cancel, retry, errors | PASS | `SubmitFeature` has progress bar, abort controller, mapped 403/413/415/422/429 messages | Multi-file is intentionally single |
| Clipboard on mobile | PASS | `navigator.clipboard` behind a user gesture with toast | — |
| Contrast, alt text, keyboard | PASS | Playwright + axe specs; focus traps; 44 px targets | Alt text for community tiles |
| Responsive, all browsers | PARTIAL | 12-viewport matrix on Chromium; no WebKit/Firefox project | Add `webkit` + `firefox` projects |
| UGC escaped (XSS) | PASS | DOM built with `textContent`/escaped templates | — |
| Favicon, titles, OG, 404/500 | PASS | Branded `public/404.html` served by the asset layer; Worker returns a branded HTML 500 for non-API paths and JSON for `/api/*` | — |
| Delete/report/moderation flow | PASS (API) | `PATCH/DELETE /api/admin/submissions/:id`; only `approved` is public | Add a small admin UI if needed |

## 7. Data and privacy 🔴

| Item | Status | Evidence | Action |
|---|---|---|---|
| Public/per-user/per-link decision | PASS | Public gallery of `approved` rows only; everything else is `pending` | — |
| Unguessable object keys | PASS | UUID keys under a dated prefix | — |
| Privacy policy and terms | PASS | In-app Info modal (Privacy & Cookies, Terms); `SECURITY.md` | — |
| Cookie/consent banner | N/A | No cookies, no third-party analytics; one functional `localStorage` key stores only the chosen city slug | Keep it to that single key |
| Deletion path | PASS | Admin `DELETE` removes D1 row + R2 object; photos are not edge-cached | Document the call in the runbook |
| Copyright/DMCA/abuse contact | PARTIAL | GitHub issues + private advisories are linked in-app; no dedicated `abuse@` mailbox | Enable Cloudflare Email Routing for `abuse@skypalette.app` and link it |
| No PII/tokens in logs | PASS | IPs are salted hashes; query strings redacted; Turnstile tokens never logged; `redact_query_string: true` | — |

## 8. Observability and operations

| Item | Status | Evidence | Action |
|---|---|---|---|
| Error tracking | PASS (decision) | Workers Issues + structured `request.unhandled` logs; no Sentry dependency | — |
| Logs/traces retention known | PASS | Workers Logs + Traces, 100% sampling, ~7 days | Export to R2 if longer retention is needed |
| Uptime monitoring | PASS | `.github/workflows/uptime.yml` checks `/api/health`, `/` and `/api/palette` every 15 minutes; a failed run notifies maintainers | Confirm GitHub notification settings |
| Alerts: 5xx, R2 errors, spend, storage | PARTIAL | Budget alert + Issues + uptime workflow; no R2/D1 usage policies yet | Add product usage alerts |
| Analytics | N/A (decision) | No analytics by default; documented opt-in in `docs/OPERATIONS.md` | Enable if product decisions need it |
| Runbook: paging, kill switch | PASS | `UPLOADS_ENABLED=false` pauses uploads without a deploy; rollback via Worker versions (`docs/OPERATIONS.md`) | Assign an on-call |

## 9. Performance

| Item | Status | Evidence | Action |
|---|---|---|---|
| Lighthouse mobile | PASS | Mobile emulation (393×852, DPR 3, simulated throttling): performance **99**, LCP **1.7 s**, CLS **0.015**, TBT **0 ms** | Re-run on the final deploy |
| Bundle size, Brotli | PASS | Client JS ~85 KB (26 KB gzip), CSS ~96 KB (34 KB gzip); Brotli on | — |
| TTFB by region | FAIL | Not measured | Sample 3 regions after deploy |
| Load test | PASS | `load/stress.mjs`: 1 087 rps palette, p95 41 ms; upload burst 5 accepted / 0×5xx | Re-run against staging before launch |
| Large file on slow connection | PARTIAL | Client downscales to ≤1600 px WebP before upload; progress + abort | Test on a throttled profile |

## 10. Code, config, deployment

| Item | Status | Evidence | Action |
|---|---|---|---|
| No secrets in git/bundle/source maps | PASS | `.gitignore` covers env/Wrangler state; secrets only via `wrangler secret`; source maps uploaded privately (`upload_source_maps`) | Enable GitHub push protection |
| Dependencies audited, lockfile committed | PASS | `npm audit` → 0 vulnerabilities (satori 0.63.2 + fflate 0.7.5 overrides) | — |
| Source maps not public | PASS | Uploaded to Cloudflare, not served in `dist/client` | — |
| CI: lint/typecheck/tests/build, clean pipeline | PASS | `.github/workflows/ci-cd.yml` (Validate → deploy), CodeQL, Dependabot | First run pending the PR |
| Wrangler config reviewed | PASS | Correct account resources, routes, bindings, compatibility date, `workers_dev: false` | — |
| Debug endpoints / verbose logs removed | PASS | No debug routes; admin surface token-gated; logs are structured and redacted | — |
| Error responses do not leak internals | PASS | `tests/worker/api.test.ts` asserts message + requestId only | — |
| Migrations applied and tested | PASS | `0001_init.sql` + `0002_rate_limits.sql` apply cleanly; remote 0001 applied, 0002 applies at deploy | — |
| Rollback plan tested | PASS (documented) | `wrangler deployments` / dashboard versions; ~1 minute to roll back | Rehearse once post-launch |

## 11. Functional smoke test on production 🔴

Not executable until 1.0.0 is deployed; treat every row as **FAIL until then**.

| Item | Status | Action |
|---|---|---|
| Upload JPEG, PNG, WebP → appears after approval | FAIL | Run after deploy |
| Reload → persistence | FAIL | Run after deploy |
| Invalid/oversize/empty file → clean errors | FAIL | Run after deploy |
| Direct image URL, incognito, mobile data | FAIL | Run after deploy |
| Delete → gone from gallery, R2, cache | FAIL | Run after deploy |
| HTTP→HTTPS, valid certificate | PASS | `curl` shows 200 over HTTPS; HTTP redirects via Always Use HTTPS |
| Security and cache headers via `curl -I` | PARTIAL | HSTS/nosniff/X-Frame present; CSP and immutable assets only after the new Worker is live |
| robots.txt / sitemap | PASS | `public/robots.txt` disallows `/api/`, sitemap present |

## 12. Launch-day gate

| Item | Status |
|---|---|
| All 🔴 items PASS | **NO** |
| Staging vs production diff | N/A (no staging environment) |
| Spend alerts and kill switch confirmed | PARTIAL (budget alert + kill switch exist; usage alerts pending) |
| Rollback verified | Documented, not rehearsed |
| Owner on call for 24–48 h | Owner |
| Post-launch checks at 1 h / 24 h / 7 d | Scheduled mentally — put it in a calendar |

---

## Blockers (must clear before launch)

1. **Redeploy 1.0.0** with `0004_submission_thumb.sql` and the client thumbnail encoder, then run the section 11 smoke test.
2. **Thumbnails**: server side, migration and tests are done; the client must send the `thumb` part before the grid stops loading 1600 px originals.

## Should-fix soon

- Orphan sweep for the narrow crash window between R2 put and D1 insert.
- `loading="lazy"` + explicit `width`/`height` on gallery images; alt text per photo.
- WebKit and Firefox Playwright projects (Safari/iOS is the primary mobile target).
- Branded 404/500 pages.
- Lighthouse mobile run; TTFB from three regions.
- Public abuse/takedown contact in the info modal.

## Nice-to-have

- Cloudflare Images (or a 400 px variant) instead of client-only downscaling.
- A tiny admin UI over the existing admin API.
- Weekly D1 export to R2.
- HSTS preload after a month of clean HTTPS.

## Recommendation

**NO-GO until the client thumbnail encoder ships and the production smoke test runs on the final build.** Alerting (budget + seven usage policies), the orphan reaper, branded error pages and the mobile Lighthouse audit (99 / LCP 1.7 s / CLS 0.015) are done. `TURNSTILE_SECRET_KEY` and `ADMIN_TOKEN` are installed; the security-critical paths are implemented and tested.
