# Sky Palette — Agent Rules

> Applies to every AI agent and human contributor working in this repository.
> This repository is public. Read the security section before writing anything.

## 1. Secrets and privacy (non-negotiable)

Never commit, print, or transmit:

- Cloudflare API tokens, Global API keys, Turnstile secret keys, salts, or passwords.
- Account ids, zone ids, database ids beyond what `wrangler.jsonc` requires to deploy.
- Personal data: real names, personal email addresses, private URLs, absolute local paths.
- Local state: `.env`, `.dev.vars`, `.wrangler/`, `.cloudflare/`, `node_modules/`, `dist/`.

Rules:

- Local secrets go in `.dev.vars` (git-ignored). Only `.dev.vars.example` is committed, with placeholders.
- Production secrets are Worker secrets (`wrangler secret put`), never GitHub variables and never source.
- Client IPs are hashed with `IP_SALT` before use. Never log or store a raw IP, a Turnstile token, or an uploaded file's bytes.
- Before any commit: `git status`, then `git diff --cached` — confirm no secret, no local path, no generated artefact.

## 2. Where code belongs

| Path | Responsibility |
|---|---|
| `src/shared/` | Pure physics and contracts used by **both** Worker and browser: solar geometry, palette engine, colour, timezone math, shared types. No DOM, no `env`. |
| `src/worker/` | Authoritative server: routing, validation, rate limits, weather ingestion, image validation/metadata stripping, D1, R2, Turnstile, logging. |
| `src/client/` | Browser UI. May pre-compute with `src/shared/` for latency; must never be trusted for correctness. |
| `migrations/` | D1 schema, one additive migration per change. |
| `tests/unit`, `tests/worker`, `e2e` | Unit, integration (real bindings) and browser tests. |
| `docs/` | Operations and architecture. |

Do not duplicate solar or palette maths. Change `src/shared/` and both sides update.

## 3. Server-side boundary

The Worker owns and must validate: lat/lon/date/time parsing, rate limiting, Turnstile verification, file type and dimensions, metadata stripping, palette computation, D1 writes, R2 writes, and error sanitisation.

The client may: render, pre-compute a palette for scrubbing, downscale an image before upload (UX only, re-validated by the Worker), and hold ephemeral UI state.

## 4. Data rules

- Prepared statements only: `env.DB.prepare(...).bind(...)`.
- Migrations are additive. Never edit an applied migration; add a new file.
- R2 stays private. Photos are streamed through `GET /api/photos/*`.
- Stored submission status is `pending` until a human reviews it. Do not claim automated moderation in the UI unless it exists.

## 5. Client rules

- No cookies, no sessionStorage, no fingerprinting. One `localStorage` key is allowed: `sky-palette.city`, holding only the chosen city slug (no coordinates, ids, timestamps, or tracking data). Anything else needs a policy change first.
- No third-party runtime requests: bundle fonts, CSS and JS.
- Build DOM from API data with `textContent` or escaped templates, never raw `innerHTML`.
- Accessibility is a review gate: labels, keyboard paths, focus trap in dialogs, 44 px targets, `prefers-reduced-motion`.
- Mobile first: layout in `dvh`, respect safe-area insets, and verify at 393×852.

## 6. Testing and release gate

Every change ships with tests at the right level:

- Pure logic → `tests/unit` (Vitest).
- Routes, D1, R2, Turnstile → `tests/worker` (`@cloudflare/vitest-plugin`, real bindings, mocked upstream).
- User flows, responsive layout, a11y → `e2e` (Playwright + axe).

The authoritative launch checklist is [`docs/PRE-LAUNCH.md`](docs/PRE-LAUNCH.md): every item is marked PASS/FAIL/N-A with evidence, and the 🔴 rows are blockers. Do not deploy a release while any blocker is open.

Minimum gate for every release: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` green; no secrets in `git diff --cached`; migrations reviewed; `/api/health` healthy after deploy; load test shows 0×5xx and the upload quota holds (`npm run test:load`).
