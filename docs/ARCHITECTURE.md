# Architecture

## Shape

```
                    ┌──────────────────────────────┐
  browser  ───────► │  Worker  src/worker/index.ts │
                    └──────┬───────────┬───────────┘
                           │           │
             src/shared ───┘           ├── D1 (cities, submissions, daily_palettes)
        (solar + palette)              ├── R2 (photos, private)
                                        ├── Open-Meteo (forecast + archive)
                                        └── Turnstile Siteverify

  src/client ── imports the same src/shared modules for 60 fps scrubbing
```

Vite builds two environments from one config: the client (`dist/client`, hashed assets, `index.html`) and the Worker (`src/worker/index.ts`). Wrangler serves `dist/client` through the `ASSETS` binding; `run_worker_first: ["/api/*"]` guarantees API requests reach the Worker before the asset layer.

## Request paths

**Palette.** `GET /api/palette?lat&lon&at&tz` → validate → hash IP + native rate limit → fetch the Open-Meteo hourly sample nearest `at` (edge-cached, with a clear-sky fallback) in parallel with `getSolarPosition` → `computePalette` → JSON with `requestId` and a short `Cache-Control`.

**Scrubbing.** The client never calls the API per frame. It converts wall-clock time in the city's zone to a UTC instant (`zonedTimeToUtc`), computes solar elevation (`getSolarPosition`) and the palette (`computePalette`) synchronously, and paints CSS gradients. When the drag settles it refetches once to pick up real weather.

**History.** `GET /api/history` computes one palette per day at local sunset from a single Open-Meteo range request, caches each day in `daily_palettes`, and only fetches missing dates. The gallery reads this, so a cold city costs one upstream request.

**Upload.** `POST /api/submit` → Turnstile → hourly per-IP-hash count in D1 → magic-byte and dimension validation → metadata strip (JPEG APPn/COM, PNG eXIf/tEXt/iTXt/zTXt/tIME, WebP EXIF/XMP with RIFF size fix) → R2 `photos/YYYY/MM/<uuid>.<ext>` → D1 row with a server-computed palette → `pending` status.

## Why these choices

- **Shared physics.** The preview stage had two different palettes (a client table and a server band model). One module removes the drift and makes the client's optimistic render testable against the server.
- **C1 interpolation.** Anchor colours across solar elevation are blended with a cubic Hermite spline and a smooth low-sun window for cloud warmth. Adjacent scrub steps cannot jump; a unit test enforces ≤3 RGB units per 0.05° step.
- **Timezone first.** "16:51 in Bucharest" is an instant, not a UTC string. All conversions go through `Intl` and are tested across DST boundaries.
- **Native platform features over custom code.** Native rate-limit bindings, Workers Logs/Traces, Vite plugin, D1 migrations. The old hand-written OTLP exporter and python deploy payload are gone.
- **Honest states.** Weather fallback is labelled (`X-Weather-Source: fallback`); submissions are `pending`; the UI shows loading, empty and error states rather than canned data.

## Data model

- `cities` — geocoding cache keyed by slug (name + country), with coordinates and IANA zone.
- `submissions` — one row per accepted photo: R2 key, dimensions, capture time, server-computed palette JSON, salted IP hash, `pending|approved|rejected`.
- `daily_palettes` — per city/day sunset palette cache, primary key `(city_key, date)`.

## Testing layers

| Layer | Tool | What it proves |
|---|---|---|
| Unit | Vitest (node) | solar accuracy, palette continuity, colour contrast, timezone math |
| Worker | `@cloudflare/vitest-plugin` | routes against real D1 + R2 with mocked upstream: status codes, caching, limits, 404/405/400, metadata stripping |
| E2E | Playwright + axe | real DOM flows at 393×852, 820×1180, 1440×900; no overflow; dialogs; submit; share download; no serious a11y violations |
