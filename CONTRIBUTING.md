# Contributing

Thanks for considering a contribution. This project is small on purpose: one Worker, one client bundle, one shared physics engine.

## Ground rules

1. **No secrets, ever.** No tokens, account ids, personal data, absolute local paths, or `.dev.vars` content in commits. Run `git diff --cached` before every commit.
2. **One source of truth for physics.** Solar geometry and palette maths live in `src/shared/`. Do not reimplement them in the client or the Worker.
3. **The Worker is authoritative.** Validation, rate limiting, weather ingestion, metadata stripping and persistence belong on the server. The client may pre-compute for latency but must not be trusted.
4. **No third-party runtime requests.** Fonts, CSS and JS are bundled and self-hosted.

## Local setup

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

All four must pass. CI runs the same commands; the deploy job only runs on `main`.

## What to change where

| Change | Location |
|---|---|
| Solar or palette maths | `src/shared/solar.ts`, `src/shared/palette.ts` (+ unit test) |
| New API route | `src/worker/routes/`, wired in `src/worker/index.ts` |
| UI behaviour | `src/client/features/` |
| Schema | a new file in `migrations/` (additive; never edit an applied migration) |
| Dependencies or bindings | `wrangler.jsonc` + `docs/OPERATIONS.md` |

## Style

- TypeScript strict; no `any` without a comment explaining why.
- Prefer small pure functions in `src/shared/` and thin I/O wrappers at the edges.
- Client DOM writes go through `textContent` or escaped templates; never inject API strings with `innerHTML`.
- Accessibility is a requirement, not a nice-to-have: labels, keyboard paths, focus handling, 44 px targets, and `prefers-reduced-motion`.

## Reporting bugs

Use the issue templates. Include the viewport, browser, the request id from the failing response if there is one, and what you expected.
