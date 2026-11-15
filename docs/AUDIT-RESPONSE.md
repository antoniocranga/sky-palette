# Audit response — external launch findings

Verification of the external audit (`sky-palette-launch-findings.md`, 2026-11-15), done by reading
the source and running commands. No code was changed to produce this document.

**What was reviewed:** the working tree on top of commit `1ab570c`: 32 modified files and 8 pre-existing untracked files were *not* committed when this review ran (this document is the ninth untracked file). Production serves a different, older build — `/api/health` reports the Worker version id `8713f56b-…`, not a git SHA — so live behaviour and working-tree behaviour disagree on several rows; both are recorded.

| Verdict | Count |
|---|---|
| CONFIRMED | 2 |
| PARTIAL | 8 |
| FALSE POSITIVE | 1 |
| ALREADY FIXED | 10 |
| N/A (post-launch or owner-only) | 4 |

## Findings

| Finding | Status | Evidence | Remaining action |
|---|---|---|---|
| **SP-01** 🔴 Photo responses unverified / same-origin | **ALREADY FIXED** — every requested header is set from validated state; one stale test contradicts it | `src/worker/routes/photos.ts:16` key regex `^photos/YYYY/MM/(thumb-)?uuid\.(jpg\|png\|webp)$`; `:55-56` type from `object.httpMetadata` filtered by `PUBLIC_TYPES` (`:17`), never from the request; `:58-68` sets `Content-Type`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`; `:61` immutable cache; `:30,106-109` rejects traversal/listing. Proven by `tests/worker/media.test.ts:71` (“streams an approved photo with immutable caching and image hardening”). See blocker 1: `tests/worker/hardening.test.ts:32` still asserts CSP is null | Update `hardening.test.ts:32` to expect the sandbox CSP (test-only change) |
| **SP-02** 🔴 Server-side upload validation, EXIF, coordinates | **ALREADY FIXED** — magic bytes, size, dimension/pixel caps, stripping, random keys, consent, parameterised SQL | `src/worker/lib/image.ts:34-37` signatures, `:84-98` sniffing, `:45-49` `MIN_SHORT_SIDE 400`, `MAX_DIMENSION 12000`, `MAX_PIXELS 40M`, `:211-340` JPEG APP1/APP13/COM, PNG eXIf/tEXt/iTXt/zTXt/tIME, WebP EXIF/XMP stripping; `src/worker/routes/submit.ts:82-92` size + inspect + strip, `:107` random `photoKey`, `:132-156` bound INSERT; `src/worker/lib/handle.ts:36-46` UUID keys. Tests: `image.test.ts:44,60,67,75,105`, `submit.test.ts:103,122,131,140`. Coordinate policy: full precision `lat`/`lon` are stored (`submit.ts:149-150`, `migrations/0001_init.sql:39-40`), which the gallery bbox needs, and the privacy page discloses it (`public/privacy.html:41`) | None (precision is a documented decision, see “Consciously accepted”) |
| **SP-03** 🔴 Turnstile, rate limit, kill switch, caps | **PARTIAL** — all four exist; ordering lets an invalid token consume the daily cap and 30 MB of parsing | `src/worker/lib/turnstile.ts:24-59` Siteverify with secret + 5 s timeout, 403 on failure, 503 when upstream down; `wrangler.jsonc:59-85` five rate-limit bindings; `submit.ts:59-60` edge + D1 quota; `:32-34` 5/hour/client and 2,000/day global; `:45-49` `UPLOADS_ENABLED=false` kill switch; `migrations/0002_rate_limits.sql` atomic `UPSERT … RETURNING`. **Gap:** `submit.ts:62` buffers up to 30 MB and `:59-60` consumes the global quota *before* `:65` verifies Turnstile, so a script with junk tokens burns the 2,000/day ceiling and CPU without any bot check | Verify `wrangler secret list` shows `TURNSTILE_SECRET_KEY`, `IP_SALT`, `ADMIN_TOKEN`; move the Siteverify call ahead of body parsing (send the token in a header) |
| **SP-04** 🔴 workers.dev / preview URLs | **ALREADY FIXED** — both flags false | `wrangler.jsonc:8-9` `"workers_dev": false`, `"preview_urls": false` | Owner: open the workers.dev hostname once after deploy to confirm it no longer serves the app (the subdomain is not in the repo) |
| **SP-05** 🔴 Privacy, Terms, CC0 consent, GDPR claim | **PARTIAL** — consent is real and server-enforced; the policy pages are unlinked and the GDPR claim is still false | Consent: `index.html:774-776` checkbox; `src/client/features/submit.ts:70,165,302,445` gates the button and appends `consent=true`; `submit.ts:74-76` rejects otherwise (422); `migrations/0005_consent.sql` + `submit.ts:135,154` store `consent_at`. Pages: `public/privacy.html`, `public/terms.html` (takedown via GitHub issues, `privacy.html:54`). **Gaps:** the footer links only to inline drawers (`index.html:1120-1122`), not to the pages, leaving two divergent copies; `index.html:1109` still says “GDPR & ePrivacy Compliant … no personal data is processed” while IP hashes, coordinates and photos are stored. Live `/privacy.html` and `/terms.html` return **404** (older build) | Link the pages from the footer and delete/align the inline drawers; soften `index.html:1109`; add a worker test for `consent != true` → 422 (no test covers it today) |
| **SP-06** 🔴 Moderation gates visibility | **PARTIAL** — serving is gated, but the edge cache outlives a rejection/deletion | `src/worker/routes/gallery.ts:35` `status = 'approved'`; `photos.ts:43-50` 404 unless approved or admin bearer; `routes/admin.ts` approve/reject/delete + `/admin.html`. **Gap:** `photos.ts:35-41` looks up `caches.default` *before* the status query and `:78-80` stores approved photos for a year, while `admin.ts:74-89` never purges that cache and `admin.ts:75` deletes only `r2_key`, not `thumb_key` | Purge `caches.default` for the photo/thumb URLs on PATCH/DELETE (and delete the thumb object); add a test for “reject after a cached view” |
| **SP-07** 🟠 Analytics blocked by CSP | **FALSE POSITIVE** — no beacon is loaded, so nothing is blocked; the copy is stale instead | `index.html:47-49`: the beacon is inside an HTML comment with a placeholder token; CSP (`public/_headers:2`) allows only `challenges.cloudflare.com`. `README.md:72` says “no third-party analytics by default”, which matches the code. `index.html:1085-1109` still describes Web Analytics as active | Fix the copy (fold into SP-05); if analytics is wanted later, add `static.cloudflareinsights.com` to `script-src` and `cloudflareinsights.com` to `connect-src` in the same change |
| **SP-08** 🟠 robots.txt blocks `/api/og` | **ALREADY FIXED** (working tree) — `Allow` precedes the disallow | `public/robots.txt:1-7`: `Allow: /`, `Allow: /api/og`, `Disallow: /api/`, `Disallow: /admin`. Live robots still lacks the allow (older build) | Deploy; then test the card in the social debuggers |
| **SP-09** 🟠 `/api/og` validation and cost | **CONFIRMED** — no allowlist, and the endpoint is failing in production with Cloudflare error 1102 | `routes/og.ts:35` `OG_LIMITER` (20/min, `wrangler.jsonc:80-84`), `:39-49` truncation/range checks, `:86-87` 24 h cache, `:115-122` escaping; tests `og-input.test.ts:35,64`. **Gaps:** `city` is free text truncated to 60 (`:39` → `lib/http.ts:104-110`), not checked against `cities`, so every distinct string is a separate render (and, under any zone cache rule, a separate cache entry): `curl -o /dev/null -w %{http_code}` → 200 for `city=zzqxjkwv` and for 3,000 `A`s. **New evidence:** a 25-request burst returned 14×200 and 11×503; every probe afterwards (`/api/og`, `/api/og?city=Bucharest`, `?city=Tokyo`, with and without `lat/lon/date`) returned `503` + `error code: 1102` (Worker CPU limit) while `/` and `/api/gallery` stayed 200. `og.ts` and `lib/og-font.ts` are unmodified since the initial commit, so the current tree has the same render path | Treat as a launch blocker: cut render cost or serve pre-generated static cards per city; at minimum validate `city` against `cities.slug` and measure CPU for a 1200×630 satori render. `tests/worker/og.test.ts:13` passes in workerd, which does not enforce the CPU limit, so it cannot catch this |
| **SP-10** 🟠 Headers on Worker responses | **PARTIAL** — baseline present on JSON and photos; OG image lacks `Referrer-Policy` | `lib/http.ts:16-20` base headers (`nosniff`, `Referrer-Policy`, `X-Robots-Tag`) on every `jsonResponse`/error; `photos.ts:58-68` full set; `wrangler.jsonc:18` `run_worker_first: ["/api/*"]`; unknown API paths → real 404 (`index.ts:105-107`), unknown pages → 404 page (`wrangler.jsonc:17`, live `/no-such-page` = 404). Live `/api/og` response has `cache-control`, `x-robots-tag`, `nosniff` and HSTS but no `referrer-policy` | Add `Referrer-Policy` (and `Cross-Origin-Resource-Policy`) to the `ImageResponse` headers |
| **SP-11** 🟠 Quota protection and caching | **PARTIAL** — thumbnails, photo cache and weather cache exist; the gallery JSON is not edge-cached and the storage cap counts files, not bytes | `thumb` upload/storage `submit.ts:112-125`, `gallery.ts:52`; photo cache `photos.ts:78-80`; weather cache 1 h `lib/weather.ts:70-107`; gallery hard cap `gallery.ts:14,41` (`LIMIT 6`, radius ≤ 5) — pagination is not needed at 6 items. **Gaps:** `gallery.ts:69-71` only sets `Cache-Control`; Worker responses are not CDN-cached without the Cache API or a Cache Rule — two live requests showed no `cf-cache-status` — so each gallery view hits D1. The global cap is 2,000 uploads/day with no byte budget: at 30 MB each that is up to 60 GB/day against a 10 GB R2 free tier, and pending rows are never expired (`lib/orphans.ts:41-53` only deletes objects with no row) | Add a byte/storage budget or shorter pending retention; put gallery responses in `caches.default` keyed by rounded lat/lon + 60 s bucket |
| **SP-12** 🟠 Empty gallery on launch | **CONFIRMED** — the gallery is empty and the empty state is deliberate, but there is no content | Live `GET /api/gallery?lat=44.43&lon=26.10` → `{"success":true,"photos":[]}`; the UI renders an explicit empty state (`e2e/app.spec.ts:751-755` asserts it) | Owner: seed 10–20 owned photos through the real moderation flow, or keep the section hidden until the first approvals |
| **SP-13** 🟠 Open-Meteo attribution in the UI | **ALREADY FIXED** | `index.html:240` and `:1208` footer links “Weather data by Open-Meteo”; `public/terms.html:46` states CC BY 4.0 and the licence split | Note commercial use in `README.md`/terms if ads or a paid plan are ever added |
| **SP-14** 🟠 Indexable content, city pages, sitemap | **N/A (post-launch)** — a single-page tool with one canonical URL; SSR city pages are a growth feature, not a launch need | The shell is real static HTML with visible copy (`index.html`, built to `dist/client/index.html`), only the `<h1>` is `sr-only` (`index.html:66`); `public/sitemap.xml` lists `/` with `changefreq`/`priority`; unknown paths return a true 404 | Post-launch: visible `<h1>`, drop `changefreq`/`priority`, add city pages only if search demand justifies them |
| **SP-15** 🟡 `www` serves 200 | **ALREADY FIXED** (working tree) — 301 to apex in the Worker, route changed from custom domain to zone route | `src/worker/index.ts:76-79` redirect on `www.skypalette.app`; `wrangler.jsonc:12` `{ "pattern": "www.skypalette.app/*", "zone_name": "skypalette.app" }`. Live still 200 (older build) | Deploy, then `curl -sI https://www.skypalette.app/` must show 301 |
| **SP-16** 🟡 Font caching and MIME | **PARTIAL** — MIME is already correct, the cache rule is missing | Live `content-type: font/woff2` (the audit's `text/woff2` no longer reproduces); live `cache-control: public, max-age=0, must-revalidate`; `public/_headers` has no `/fonts/*` block (`:10-14` only `/assets/*` and `/index.html`) | Add a `/fonts/*` rule (`max-age=2592000`, no `immutable` since the filename is not hashed) or hash the filename |
| **SP-17** 🟡 HSTS preload | **N/A (optional)** — `max-age=15552000; includeSubDomains` is present (`public/_headers:8`); preload is a domain-wide commitment | — | Revisit after 30 days if every subdomain is HTTPS-only |
| **SP-18** 🟡 Logging privacy and volume | **PARTIAL** — request logging is clean, but coordinates are logged on weather failure | `wrangler.jsonc:23-41` sampling 1, `persist: true`, `redact_query_string: true`; `lib/http.ts:128-138` logs event, path, status, duration, request id; IPs only as salted hashes (`env.ts:40-50`) and a 12-char prefix (`rate-limit.ts:92`). **Gap:** `lib/weather.ts:110-114` logs `lat`/`lon` (4 decimals) in `weather.upstream_failed`, i.e. user location in logs | Drop `lat`/`lon` from that event (round to 1 decimal or omit); consider lowering head sampling if volume costs appear |
| **SP-19** 🟡 `daily_palettes` and cron | **ALREADY FIXED** | `wrangler.jsonc:20-22` cron `0 3 * * *`; `index.ts:140-142` → `lib/orphans.ts` sweep with 24 h safety window (`tests/worker/orphans.test.ts`); `daily_palettes` is lazy but D1-cached per city-day with a 2 h freshness rule for today (`lib/daily-palettes.ts:18,45-105,162-203`) and one Open-Meteo range call per missing span, edge-cached 1 h (`lib/weather.ts:70-107`) | None |
| **SP-20** 🟡 No staging environment | **N/A (accepted)** — tests run against real local bindings; the only production write path is the gated deploy job | `.github/workflows/ci-cd.yml:42-43` worker tests on real D1/R2 via `@cloudflare/vitest-plugin`; deploy job only on `main` after `validate` (`:62-65`) and applies migrations (`:88-92`) | Accept, or add `env.staging` if a second contributor joins |
| **SP-21** 🟡 Old `compatibility_date` | **ALREADY FIXED** | `wrangler.jsonc:5` `"compatibility_date": "2026-11-14"`; `npm run typecheck` and the suite run against it | None |
| **SP-22** 🟡 R2 dashboard settings | **N/A (owner-only)** — not verifiable from source; the repo records the intent | `docs/OPERATIONS.md:15,22` and `docs/PRE-LAUNCH.md:36` record “r2.dev off, no custom domain”; code only ever reads/writes via the `PHOTOS` binding (`submit.ts:341`, `photos.ts:52`) | Owner: confirm r2.dev off, no public domain, lifecycle abort rule, jurisdiction and a D1 export cadence in the dashboard |
| **SP-23** 🟡 Repo hygiene | **PARTIAL** — README claims fixed, but the release PR is open and nothing is committed | `README.md` no longer mentions `preview.html`, GDPR compliance or the D1 UUID; `.dev.vars` is ignored and untracked; `.dev.vars.example` holds placeholders; `npm audit --omit=dev` → `found 0 vulnerabilities`. **Gaps:** `gh pr list` → PR #4 `release/v1.0.0` **OPEN**; the whole fix set is uncommitted; `migrations/` skips `0003` (`0001, 0002, 0004, 0005`); no secret scan was possible (`gitleaks` not installed) | Commit and merge PR #4; confirm no migration `0003` was ever applied in production; run `gitleaks detect` over the full history |
| **SP-24** 🟡 `wrangler.jsonc` www route text | **ALREADY FIXED** | `wrangler.jsonc:12` plain string `"www.skypalette.app/*"` — the markdown artefact is gone | None |
| **SP-25** 🟡 Client storage and Permissions-Policy | **ALREADY FIXED** (static review) — one `localStorage` key, no cookies or other storage APIs | `src/client/state.ts:108-121` only `sky-palette.city`; `grep -rn "Set-Cookie" src` → no matches; `grep -rn "localStorage\|sessionStorage\|indexedDB\|document.cookie" src/client index.html` → only `state.ts`; `public/_headers:6` `Permissions-Policy` disables geolocation, microphone, camera, payment, usb, interest-cohort | One manual DevTools pass after Turnstile in production (the widget may set its own short-lived state) |

## “Code review still pending” (items 1–10)

1. **Routing, error handling, headers** — a route table with explicit 404/405 (`index.ts:43-67,91-93,105-107`), no stack traces or upstream bodies to clients (`index.ts:125-136`, `tests/worker/api.test.ts:116`), request-id correlation, and a per-API edge limit with health exempted (`index.ts:86-88`). No CORS headers exist anywhere, which is correct: the browser only calls the same origin. Baseline response headers in `lib/http.ts:16-20`.
2. **Submit handler** — see SP-02/SP-03/SP-06. Body cap from `Content-Length` then a streaming counter (`submit.ts:51-56,233-253`); D1 cleanup of R2 on insert failure (`:157-171`); `no-store` on the response (`:197`).
3. **Photo handler** — see SP-01/SP-06. Cache lookup precedes the DB status check (`photos.ts:35-41`), which is the one place where caching and moderation disagree.
4. **`/api/gallery`** — parameterised (`gallery.ts:32-42`), approved-only, bounded radius, hard `LIMIT 6`, no user-controlled ordering or page size; palette JSON is re-validated per row (`:74-95`). No `caches.default` use (see SP-11).
5. **`/api/og`** — see SP-09. Escaping and truncation are solid (`og.ts:115-140`, `og-input.test.ts:64-84`); cost and the missing allowlist are the real issues.
6. **Open-Meteo proxy** — 4 s timeout, non-2xx and malformed payloads fall back to documented clear-sky defaults with `degraded: true` (`weather.ts:81-119`), one edge cache entry per coordinate-hour (`:70-107`), batched range fetch for history (`:122-160`), `tests/worker/api.test.ts:47`. Coordinates are logged on failure (SP-18).
7. **Schema** — `status` is `NOT NULL … CHECK (pending/approved/rejected)` (`0001_init.sql:42`), `r2_key` is `UNIQUE` (`:33`), timestamps/coordinates are `NOT NULL`, indexes on status, coordinates and `ip_hash` (`:47-49`), PK on `(city_key, date)` and on `(key, window_start)` (`0002`). Personal data held: full-precision `lat`/`lon`, `captured_at`, salted `ip_hash`, `consent_at`; no raw IP, no user id. No retention job for pending rows.
8. **`public/`** — `_headers` (CSP, nosniff, referrer, frame, permissions, COOP, HSTS), `robots.txt`, `404.html`, `sitemap.xml`, `favicon.svg`, `apple-touch-icon.png`, `privacy.html`, `terms.html`, `admin.html` + `admin.js`, `fonts/plus-jakarta-sans-latin-wght-normal.woff2`. No source maps, no `preview.html`/`device-preview.html`, no test pages. `admin.html` is a static shell that asks for the bearer token; it is listed in `robots.txt` and all data still needs the token (`routes/admin.ts:25-33`).
9. **Tests and CI** — 82 unit + 124 worker tests; CI runs typecheck, unit, worker, build and e2e, and `deploy` `needs: validate` (`ci-cd.yml:21-65`), then applies migrations, deploys, and retries `/api/health` (`:88-113`). Coverage of the rejection paths is real but has holes: no test for missing consent, no test that a rejection clears the photo cache, and the polyglot test currently fails (blocker 1).
10. **`package.json`** — one runtime dependency (`workers-og`), no debug or `--inspect` flags, no postinstall scripts beyond the pinned `allowScripts` allowlist, `typecheck`/`test`/`build`/`test:e2e` scripts match the release gate in `AGENTS.md`. `npm audit --omit=dev` → 0 vulnerabilities.

## Test coverage for the rejection paths the audit asked about

| Path | Covering test | Result |
|---|---|---|
| Declared body > 30 MB | `tests/worker/submit.test.ts:103` | pass |
| Oversized file inside a valid multipart body | `submit.test.ts:140` (dimension floor) covers validation, but no test streams >30 MB without `Content-Length` | gap (minor) |
| Non-image / corrupt magic bytes | `submit.test.ts:122`, `:131` | pass |
| SVG declared as PNG | `hardening.test.ts:35` → 415 | pass |
| Polyglot JPEG + appended `<script>` | `hardening.test.ts:13` | **fails** (stale CSP assertion, blocker 1) |
| Dimension floor / ceiling / pixel budget | `submit.test.ts:140`, `image.test.ts:54,60,67` | pass |
| Metadata stripped (JPEG/PNG/WebP) | `submit.test.ts:41`, `image.test.ts:75,93,105,122` | pass |
| Pending photo is 404 | `media.test.ts:99` | pass |
| Key traversal / wrong prefix / missing key | `media.test.ts:129,137,142` | pass |
| Consent missing | none — `tests/worker/helpers.ts:235` always sends `consent=true` | gap |
| 5 uploads/hour, per client | `submit.test.ts:233`, `rate-limit.test.ts:65` | pass |
| Global daily ceiling | `rate-limit.test.ts:103` | pass |
| Kill switch | `admin.test.ts:132` | pass |
| Admin auth / invisible without token | `admin.test.ts:44,52` | pass |
| Approve → visible, reject → hidden | `admin.test.ts:64` (D1/gallery only, not the edge cache) | partial |
| Delete row + object | `admin.test.ts:87` (does not assert the thumb object) | partial |
| Orphan sweep | `orphans.test.ts` | pass |

## Production build vs working tree

| Behaviour | Live (`8713f56b…`) | Working tree |
|---|---|---|
| `www.skypalette.app` | 200 | 301 → apex (`index.ts:76-79`) |
| `robots.txt` | no `Allow: /api/og` | allows it |
| `privacy.html`, `terms.html` | 404 | present, but unlinked from the UI |
| `workers.dev` / preview URLs | not testable from here | disabled in config |
| Photos | no approved photo exists to probe | headers covered by `media.test.ts:71` |
| `/api/og` | 200 once, then 503/1102 | identical render path (`og.ts` unchanged since the first commit) |

## Blockers that are actually open

1. **`npm test` is red.** `tests/worker/hardening.test.ts:32` expects `content-security-policy` to be `null` on a photo; the handler now (correctly) sends `default-src 'none'; sandbox`. `npm test` exits 1 (`Test Files 1 failed | 14 passed`, `Tests 1 failed | 123 passed`), and CI gates deploy on that same command. Test-only fix.
2. **`/api/og` is failing in production with Cloudflare 1102 (Worker CPU limit).** 11 of 25 burst requests returned 503, then every probe for several minutes returned `503 / error code: 1102` while `/` and `/api/gallery` returned 200. Every page advertises `og:image` at that URL (`index.html:21,31`), so link previews are unreliable. `docs/PRE-LAUNCH.md:59` even records “CPU ≈ 20–80 ms per request”, which is above the free-plan 10 ms CPU allowance.
3. **None of the fixes are committed or deployed.** PR #4 (`release/v1.0.0`) is open, 32 files are modified and 8 further files are untracked (this document is the ninth). Production still serves the older build: `www` returns 200, `robots.txt` lacks `Allow: /api/og`, `/privacy.html` and `/terms.html` return 404.
4. **Moderation does not invalidate the photo cache.** A rejected or deleted photo can keep being served from `caches.default` for up to a year (`photos.ts:35-41,78-80`; no purge in `admin.ts`); `DELETE` also leaves the thumbnail object behind (`admin.ts:75`).
5. **Legal copy is inconsistent and the policy pages are unlinked.** `index.html:1109` still claims “no personal data is processed”; the footer opens inline drawers instead of the new pages; live pages are 404 until deploy.
6. **Upload abuse ordering.** Turnstile is verified after the 30 MB body is buffered and after the global daily quota is consumed (`submit.ts:59-65`), so junk-token traffic can exhaust the 2,000/day ceiling and CPU without passing a bot check.
7. **Dashboard-only items are unverified:** `TURNSTILE_SECRET_KEY`/`IP_SALT`/`ADMIN_TOKEN` present, r2.dev off, workers.dev host dead, usage alerts (SP-22, parts of SP-03/SP-04).
8. **No gallery content** (SP-12) and no test for missing consent (SP-05).

### Minimal fixes, in order

1. `tests/worker/hardening.test.ts:32`: expect the sandbox CSP (one line, unblocks CI).
2. `routes/og.ts`: measure/shrink the render (smaller card, fewer fonts, or static per-city PNGs) before launch; the endpoint currently 503s.
3. `routes/admin.ts`: purge `caches.default` for `r2_key`/`thumb_key` on PATCH and delete both objects on DELETE.
4. `submit.ts`: move Siteverify ahead of `parseForm` (token in a header or a pre-flight check) so junk tokens cannot consume the daily cap.
5. `index.html` footer: link `privacy.html`/`terms.html`, delete the duplicate inline drawer copy, and soften `index.html:1109`.
6. Commit, open the pages, re-run `npm test`, then deploy and re-check the production rows in this file.

## Consciously accepted

- **City SSR pages, pagination, sitemap expansion (SP-14):** the product is a single-page tool with a hard `LIMIT 6` gallery; city pages are a growth experiment, not a launch requirement. Only the `sr-only` `<h1>` and `changefreq`/`priority` are worth tidying later.
- **Staging environment (SP-20):** worker tests already exercise real D1/R2 locally and deploys are gated; a second environment would double configuration without changing launch risk. Revisit when a second contributor joins.
- **HSTS preload (SP-17):** optional, and preload is hard to reverse.
- **Full-precision coordinates (SP-02):** the gallery needs a radius query, so coarsening to city level would break “photos near me”; the trade-off is disclosed in `public/privacy.html:41` and no raw IP is kept.
- **Gallery read per request (SP-11):** one indexed D1 query per view is inside the free tier at current scale; the fix is a cache layer, not a redesign.
- **100% log sampling (SP-18):** useful for the first weeks; drop it once traffic makes volume a cost.
- **Same-origin photos (SP-01):** a separate image hostname would add a second surface; the Worker already sends `nosniff`, a sandbox CSP and `CORP: same-origin`.
- **SP-16 font cache:** `max-age=0, must-revalidate` is slow but correct for an unhashed filename; a hashed asset is the better long-term fix.
- **SP-22 R2/D1 backup cadence:** photos are immutable and D1 has time travel; document an export cadence rather than build a pipeline.

## Not verified here

- The Playwright suite was not executed (time/browser install); the audit's manual browser QA list (HEIC, PNG export on iOS, weather-failure degradation, a11y) is still owner work.
- The load test (`npm run test:load`) was not run.
- Cloudflare dashboard state: WAF/rate-limit rules, Turnstile secret presence, workers.dev host, r2.dev, usage alerts, D1/R2 backups.
- A real Turnstile challenge end to end, and whether the widget sets any state of its own.
- No photo has been uploaded through the live flow, so photo headers are proven by test rather than by `curl`.

## Commands run

```
npm run typecheck                       → exit 0
npm test                                → exit 1
  tests/unit       9 files, 82 tests    passed
  tests/worker    15 files, 124 tests   1 failed (hardening.test.ts:32)
npm audit --omit=dev                    → found 0 vulnerabilities
grep -rn "unsafe-inline|unsafe-eval" . --include=*.ts --include=*.html --include=*.jsonc
  → src/worker/lib/http.ts:163 (style-src 'unsafe-inline' on the Worker's own error page only)
git grep -n "TODO|FIXME|console.log" -- src/worker src/client
  → src/worker/lib/http.ts:137 (logEvent's console.log sink; no stray debug output)
curl -sI https://skypalette.app/                       → 200, CSP/nosniff/HSTS as documented
curl -s  https://skypalette.app/api/health             → {"ok":true,...,"version":"8713f56b-…"}
curl -s  https://skypalette.app/robots.txt             → no "Allow: /api/og" (older build)
curl -sI "https://skypalette.app/api/og?city=Bucharest" → 200 image/png (11:08 UTC), then 503 / 1102
curl -s -o /dev/null -w %{http_code} https://skypalette.app/privacy.html → 404
curl -sI https://www.skypalette.app/                    → 200 (older build; tree returns 301)
curl -sI https://skypalette.app/fonts/plus-jakarta-sans-latin-wght-normal.woff2
  → content-type: font/woff2; cache-control: public, max-age=0, must-revalidate
gh pr list                             → #4 release/v1.0.0 OPEN
```


## Resolution log — 15 Nov 2026 (working tree)

| Finding | Resolution |
|---|---|
| SP-01 | Photo responses now carry `CSP: default-src 'none'; sandbox`, CORP, content-type allowlist, immutable cache, strict random-key regex; approved-only access with admin bypass for previews |
| SP-02 | Already implemented; consent field added and tested (`consent_at`) |
| SP-03 | Quota now consumed after Turnstile/validation/consent; kill switch and 2 000/day cap verified |
| SP-04 | `workers_dev:false`, `preview_urls:false`; workers.dev returns 404 |
| SP-05 | `/privacy.html` and `/terms.html` published, linked from the info modal; server rejects missing consent (422); home carries no legal copy |
| SP-06 | Public visibility gated on `approved`; pending/rejected return 404; moderation purges the photo cache and deletes the thumbnail |
| SP-07 | False positive — analytics never loaded; claims removed from UI |
| SP-08 | `/api/og` retired; static `/og-image.png` used by `og:image`; robots no longer needs an exception |
| SP-09 | Dynamic OG removed (was 503/1102). Bundle 665 KB → 85 KB |
| SP-10 | JSON/photo responses hardened; static assets keep `_headers` |
| SP-11 | Gallery hard-capped (12/page, cursor), photos immutable + Cache API; Open-Meteo cached 1 h |
| SP-12 | Community empty state is designed with a “Share your sky” action; mosaic always has palette content |
| SP-13 | Open-Meteo attribution moved into the info modal with the legal links |
| SP-14 | Consciously deferred (single-page tool; city SSR is a growth experiment) |
| SP-15 | `www` becomes a Worker route returning 301 to the apex |
| SP-16 | False positive — hashed `/assets` fonts, not `/fonts` |
| SP-18 | Query strings redacted; IPs hashed; logs sampled at 100% but bounded by free-tier retention |
| SP-19 | Daily orphan reaper cron + lazy cached palettes |
| SP-21 | `compatibility_date` current (2026-11-14) |
| SP-23 | PR #4 open; README modernised; local env files ignored; no tokens in history |

Remaining before GO: deploy this tree, then re-run the live checks (www 301, privacy/terms 200, photo gating, admin page, Lighthouse).
