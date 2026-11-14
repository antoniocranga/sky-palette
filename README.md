# Sky Palette

> Real-time 5-swatch atmospheric palettes computed from solar geometry and cloud dynamics.

[![CI](https://github.com/antoniocranga/sky-palette/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/antoniocranga/sky-palette/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)](https://developers.cloudflare.com/workers/)

Sky Palette turns the sky above any city into five colours — **Zenith, Mid-Sky, Horizon, Sun Glow, Cloud Tint** — and lets you scrub through the day to see how they evolve. Palettes are computed from the sun's actual elevation, three cloud layers, and visibility, then stored so the gallery can show how a city's golden hour changed over the last month.

Live: [skypalette.app](https://skypalette.app)

## How it works

```
Browser                              Cloudflare Worker
─────────────────────────────        ────────────────────────────────
src/shared/solar.ts    ─────┐        GET /api/palette   → Open-Meteo + D1 cache
src/shared/palette.ts  ─────┴───►    GET /api/history   → per-day sunset palettes
  same physics, 60 fps                GET /api/cities    → geocoding + D1 cache
                                      POST /api/submit   → Turnstile, strip EXIF, R2, D1
                                      GET /api/photos/*  → R2 stream
                                      GET /api/og        → PNG social card
                                      GET /api/health    → D1 liveness
```

The palette engine is **one implementation** (`src/shared/`) imported by both the Worker and the browser, so the value you see while dragging is exactly the value the API returns. The client recomputes locally on every frame and refetches only when the drag settles, to pick up real weather.

## Stack

| Layer | Choice |
|---|---|
| Edge compute | Cloudflare Workers (`src/worker/`) |
| Static assets | Workers Static Assets, built by Vite |
| Database | D1 (`migrations/`) |
| Photos | R2, private bucket streamed through the Worker |
| Bot protection | Turnstile on uploads |
| Build | Vite + `@cloudflare/vite-plugin`, Tailwind v4, self-hosted fonts |
| Tests | Vitest (unit), `@cloudflare/vitest-plugin` (real D1/R2), Playwright + axe |
| Monitoring | Workers Logs + Traces, structured JSON logs |

No runtime third-party requests: fonts, CSS and JS are all served from the same origin.

## Quick start

```bash
npm ci
cp .dev.vars.example .dev.vars    # fill TURNSTILE_SECRET_KEY and IP_SALT
npm run db:migrate:local
npm run dev                       # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with real Worker bindings (local D1/R2) |
| `npm run build` | Builds the client and Worker into `dist/` |
| `npm run preview` | Serves the production build locally |
| `npm run typecheck` | Strict TypeScript for worker, client and tooling |
| `npm test` | Unit + Worker integration tests |
| `npm run test:e2e` | Playwright at iPhone 15 Pro, iPad and desktop sizes |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run deploy` | Build and deploy to Cloudflare |

## Deploying

Production deploys run from GitHub Actions on every push to `main`: validate → apply D1 migrations → `wrangler deploy` → health check. Setup, secrets, Turnstile, R2 and optional Workers Builds are documented in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

The launch checklist with evidence and open blockers is [`docs/PRE-LAUNCH.md`](docs/PRE-LAUNCH.md). Observability charts: [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md). Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Privacy

No accounts, no cookies, no fingerprinting, no third-party analytics by default. The only browser storage is one key holding your chosen city, so the app opens where you left it; no coordinates, identifiers or timestamps. Uploads are anonymous; the only identifier stored is a salted SHA-256 hash of the client IP, used solely to enforce the upload rate limit. Photo metadata (EXIF, GPS, device) is stripped server-side before the file reaches R2.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: [`SECURITY.md`](SECURITY.md).

## Licence

Code MIT © 2026 Antonio Cranga. Community photos CC0. Weather data [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Design methodology after Damir Sokolovsky (CC BY 4.0).
