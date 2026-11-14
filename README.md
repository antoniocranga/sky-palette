# Sky Palette

> **Physical sky color engine and solar architecture calculating real-time 5-swatch atmospheric palettes from astronomical sun angles and meteorological cloud dynamics.**

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![Zero Cookies](https://img.shields.io/badge/Telemetry-Zero%20Cookies-emerald.svg?style=flat-square)](#privacy--telemetry)
[![Cloudflare Native](https://img.shields.io/badge/Stack-Cloudflare%20Native-F38020.svg?style=flat-square)](#architecture--cloud-infrastructure)
[![Domain](https://img.shields.io/badge/Domain-skypalette.app-black.svg?style=flat-square)](https://skypalette.app)

---

## 🌌 Overview

**Sky Palette** turns the atmosphere above any city into a shareable 5-swatch color palette (*Zenith, Mid-Sky, Horizon, Sun Glow, Cloud Tint*). It merges **physics-based atmospheric scattering simulation** (Preetham / Hosek-Wilkie models) with **real-time Open-Meteo cloud-cover dynamics** and **crowdsourced community sky photographs**.

- **Clean, Unobstructed Horizon:** A pure physical sky gradient without distracting top logos or banners.
- **Bucharest HQ Time Anchor:** Anchored at Bucharest (`44.4268° N, 26.1025° E`), displaying real-time local sun elevation and azimuth.
- **Refined Autocomplete Search:** Borderless black floating search pill with city-first title hierarchy, supporting global cities and postal/ZIP codes with dynamic twin-pill geometry matching when a single result is found.
- **Jog-Dial Step Scrubber:** Discrete 15-minute time stepping with circled pill geometry (`border-radius: 9999px`), continuous $C^1$ Hermite contrast adaptation (black on day, white on night), emerald live time dot, and iOS momentum physics with elastic rubber-band boundaries.
- **15-Day Sunset Mosaic:** Fullscreen zero-scroll gallery displaying the historical golden-hour palette transitions across the past 15 days.
- **Atmospheric Telemetry Cards:** Strava-style visual cards displaying solar elevation, azimuth, cloud cover, and hex swatches with one-click PNG export.
- **Privacy-First Contribution:** Client-side EXIF extraction, automated computer vision sky heuristic check, and anonymous handles with zero accounts or tracking.

---

## ⚡ Architecture & Cloud Infrastructure

Sky Palette runs on a **100% Cloudflare Native Stack**, operating completely within Cloudflare's free tier ($0/month) with zero inactivity pausing:

```
┌────────────────────────────────────────────────────────┐
│           Client Browser (HTML5 / Canvas / CSS)        │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
   Static Assets & Pages          API / Submissions
               │                           │
┌──────────────▼───────────────────────────▼─────────────┐
│                 Cloudflare Workers & Pages             │
│            Custom Domain: skypalette.app               │
├──────────────────────────┬─────────────────────────────┤
│  Cloudflare D1 (SQLite)  │  Cloudflare R2 Storage      │
│  UUID: 5e1c6b54-4020...  │  Bucket: sky-photos         │
│  Region: EEUR (Bucharest)│  Zero Egress Bandwidth      │
├──────────────────────────┼─────────────────────────────┤
│  Cloudflare Turnstile    │  Cloudflare Web Analytics   │
│  Bot Verification        │  0 Cookies · Aggregate RUM  │
└──────────────────────────┴─────────────────────────────┘
```

| Component | Technology | Free Tier Allocation |
|---|---|---|
| **Edge Compute** | Cloudflare Workers / Pages | 100,000 requests/day |
| **Database** | Cloudflare D1 (Serverless SQLite) | 5,000,000 reads/day · 100,000 writes/day · 5 GB |
| **Object Storage** | Cloudflare R2 | 10 GB storage · 10M reads/month · **$0 egress fees** |
| **Bot Protection** | Cloudflare Turnstile | Unlimited free bot protection |
| **Telemetry** | Cloudflare Web Analytics | 100% cookie-free aggregate Real User Monitoring |
| **Weather Feed** | Open-Meteo API | Free non-commercial API (CC BY 4.0) |

---

## 🗄️ Database Schema

The database is deployed live on Cloudflare D1 in region **EEUR** (`sky-palette-db`, UUID `5e1c6b54-4020-4e9b-a5d5-0cea27498741`):

- `cities`: ~44,000 global cities with coordinates, timezones, and URL slugs.
- `submissions`: Community photos with EXIF capture time, coordinates, 5 extracted swatches, R2 keys, and moderation status.
- `daily_palettes`: Pre-computed and cached historical golden-hour palettes.

See [`schema.sql`](schema.sql) for full SQLite definitions and covering indexes.

---

## 🚀 Quick Start (Prototype Preview)

To explore the interactive prototype with full responsive previews:

```bash
# Clone the repository
git clone https://github.com/antoniocranga/sky-palette.git
cd sky-palette

# Start local preview server (Python 3)
python3 -m http.server 4321

# Open in browser
open http://localhost:4321/preview.html
# Or open responsive device preview harness (iPhone 15 Pro, Pixel 8, iPad Pro)
open http://localhost:4321/device-preview.html
```

---

## 🔒 Privacy & Telemetry

Sky Palette is committed to strict data minimalism:
- **Zero Cookies:** No cookies or client-side session trackers.
- **Zero Fingerprinting:** No canvas hashes, audio signatures, or persistent device identifiers.
- **Zero Accounts:** Fully anonymous photo submissions and palette exploration.
- **Privacy-First Analytics:** Cloudflare Web Analytics processes aggregate performance metrics without recording IP addresses. 100% GDPR and ePrivacy compliant without cookie banners.

---

## 📜 Licenses & Attribution

- **Codebase:** [MIT License](LICENSE) © 2026 Antonio Cranga.
- **Community Photographs:** Dedicated to the Public Domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
- **Atmospheric Weather Data:** Courtesy of [Open-Meteo](https://open-meteo.com/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Design Philosophy:** Unslopped methodology based on Damir Sokolovsky ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
