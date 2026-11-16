# Changelog

All notable changes to Sky Palette are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Community gallery**: three tiles per row at every width, vertical infinite scroll, hour-first tiles with `city` / `@handle` meta, brightness-only hover, and a zoom-in transition into the photo modal.
- **Detail ruler**: follows the live sky like Home — today's tape stops at the current quarter-hour with a live checkpoint and badge; past days keep the full 00:00–24:00 range, and timelapse and phase jumps clamp to the bound.
- **Share modal**: paper-airplane dock icon, scroll-to-top button matched to the Share button, fields share one typography, and closing no longer flashes the card.
- **Footer**: one sentence with inline Privacy Policy, Terms and a Protected explanation instead of a separate row.
- **Submit drum**: the hour, minute and day wheels are transform-driven with 1:1 dragging, correct momentum, 40 px snapping and a rubber-band at both ends; the pill keeps the location typography and the tag pencil sits on the same inset as the search icon.
- **Resilience**: skeleton rows during the first gallery load and every append; the offline toast carries a retry button and survives unrelated successful requests.
- **iPhone**: the page tint follows the screen on `theme-color`, `html` and `body` — a single theme-color meta so light-mode devices stop overriding it, a route-aware value before first paint, and the document background continuing the horizon glow under the browser chrome.
- **Submit dialog**: the upload action is a real footer pinned to the card edge, so scrolled swatches can never appear beneath it.

### Fixed

- The strip around an open dialog now uses the scrim composited over the active screen instead of a fixed dark default, removing the dark band above the dimmed white detail screen on iPhone Safari.
- Photo GPS now resolves through a server-side reverse geocoder (OpenStreetMap Nominatim, cached in D1) instead of the sparse search cache, so a point in Constanța no longer reports a village 18 km inland; a cached city is only trusted within 3 km and the fallback radius dropped from 100 km to 15 km.
- Uploads read `DateTimeOriginal` from EXIF (JPEG, PNG and WebP) and fill the day and time pills, not just GPS; photos older than the seven-day wheel keep their own day.
- Gallery pagination stopped after the second page when the sentinel stayed inside the scroller.
- Contributor handles were truncated in three-column tiles.
- A magenta artefact could appear under the colour preview while a photo loaded; the blurred hex placeholders are back, drawn without live text so the spell-checker cannot underline them.
- The upload card kept a dashed outline after the borderless card was requested.

## [1.0.0] - 2026-11-14

First public release. The preview-stage single-file mock is replaced by a working, tested application.

### Added

- **Worker API**: `GET /api/palette`, `GET /api/history`, `GET /api/cities`, `POST /api/submit`, `GET /api/photos/*`, `GET /api/gallery`, `GET /api/og`, `GET /api/config`, `GET /api/health`.
- **Shared physics engine** (`src/shared/`): solar position and rise/set times, a C1-continuous five-swatch palette model, WCAG colour maths and timezone conversion — imported by both the Worker and the browser, so scrubbing and API responses cannot drift.
- **Real data everywhere**: Open-Meteo forecast and archive ingestion with edge caching, geocoding-backed city search, and per-day sunset palettes cached in D1.
- **Photo pipeline**: Turnstile verification, magic-byte and dimension validation, server-side metadata stripping (JPEG/PNG/WebP), private R2 storage streamed through the Worker, D1 quota of 5 uploads/hour per hashed IP.
- **Dynamic social cards**: `/api/og` renders real 1200×630 PNGs with bundled fonts.
- **D1 migrations** for `cities`, `submissions`, `daily_palettes`.
- **Observability**: structured JSON logs per request, Workers Logs and Traces at 100% sampling, Issues detection, query-string redaction.
- **Test suite**: 36 unit tests, 79 Worker integration tests against real D1/R2, Playwright end-to-end at iPhone 15 Pro, iPad and desktop with axe accessibility checks.
- **Release engineering**: Vite + `@cloudflare/vite-plugin` build, GitHub Actions (typecheck → tests → build → Playwright → D1 migrations → deploy → health check), CodeQL, Dependabot, `docs/OPERATIONS.md` and `docs/OBSERVABILITY.md`.

### Changed

- Rebuilt the client as typed modules (`src/client/`) with delegated events, no inline handlers and no third-party runtime requests; fonts and CSS are bundled.
- Mobile layout now uses `dvh` with safe-area insets and scrollable dialogs; the iPhone 15 Pro viewport no longer crops.
- Palette scrubbing computes locally at frame rate and reconciles with the server only when the drag settles.
- CI/CD no longer relies on a Python deploy payload; deployment is `wrangler deploy` after migrations.
- `/api/config` reports the deploy tag (for example `v1.0.0`) instead of an opaque version id.

### Fixed

- Night skies no longer wash out to mid-grey under cloud cover; clouds and haze interpolate toward a dark target after sunset.
- Wall-clock times are converted through the city's IANA zone instead of being treated as UTC.
- Weather sampling uses the hourly point nearest the requested instant, not a fixed midday index.
- Raw IP addresses are never stored or logged; only salted SHA-256 hashes reach D1.

### Security

- Upgraded `satori` to 0.63.2 and pinned `fflate` 0.7.5; `npm audit` reports 0 vulnerabilities.
- Added CSP, HSTS, `X-Frame-Options`, `Permissions-Policy` and immutable asset caching via `public/_headers`.
- OG inputs are length-limited, escaped, and dates are validated against the real calendar.
- Error responses expose a short message and a request id only; stack traces stay in Workers Logs.

### Removed

- The hardcoded city/palette dataset, mock submit handler and fake share links.
- The Tailwind CDN script, Google Fonts requests and the hand-written OTLP exporter.
- `schema.sql`, `scripts/generate_deploy_payload.py` and the preview-only files.

[Unreleased]: https://github.com/antoniocranga/sky-palette/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/antoniocranga/sky-palette/releases/tag/v1.0.0
