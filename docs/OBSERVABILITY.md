# Observability

Sky Palette emits one structured JSON line per request from `src/worker/lib/http.ts` (`logEvent`). Workers Logs indexes those keys automatically, so every field below is directly usable as a chart dimension or filter. Traces are enabled at 100% sampling in `wrangler.jsonc`.

## Where

Custom Dashboards live at **Analytics & Logs → Dashboards** (account level), not in the Worker's Observability tab. Create a **blank** dashboard; the bundled templates are zone-traffic presets and none fits a Worker-served app.

Retention: Workers Logs and Traces keep roughly **7 days**. Use a 24h or 7d range. Older history lives in D1, not here.

## Log events (the vocabulary every chart uses)

| Event | Emitted by | Useful fields |
|---|---|---|
| `request.completed` | router, every request | `method`, `path`, `status`, `durationMs` |
| `palette.computed` | `/api/palette` | `elevation`, `phase`, `degraded`, `durationMs` |
| `weather.upstream_failed` | weather client | `message`, `lat`, `lon` |
| `submit.accepted` | `/api/submit` | `submissionId`, `width`, `height`, `bytes`, `strippedBytes`, `degraded` |
| `submit.quota_exceeded` | `/api/submit` | `key` (truncated hash), `count` |
| `submit.persist_failed` / `submit.storage_failed` | `/api/submit` | `message` |
| `rate_limit.exceeded` | rate limiter | `key` (truncated hash) |
| `request.unhandled` | router catch-all | `message`, `path`, `stack` |

`level` is `info`, `warn` or `error`. Query strings are redacted from the automatic invocation URL (`redact_query_string: true`), but structured fields above are intact.

## Charts

Dataset for 1–8: **Workers Observability — Logs**. Dataset for 9: **Workers Observability — Traces (OTel)**.

| # | Chart | Type | Metric | Filter | Group by |
|---|---|---|---|---|---|
| 1 | Requests by route | Timeseries | Events | `event = request.completed` | `path` |
| 2 | 5xx error rate | Percentage | numerator `request.completed` + `status >= 500`; denominator `request.completed` | | |
| 3 | Latency p50/p95/p99 | Timeseries | duration p50, p95, p99 | `event = request.completed` | `path` |
| 4 | Slowest routes | Top N | duration p99 | `event = request.completed` | `path` |
| 5 | Weather degraded rate | Percentage | numerator `palette.computed` + `degraded = true`; denominator `palette.computed` | | |
| 6 | Upstream failures | Stat | Events | `event = weather.upstream_failed` | |
| 7 | Upload outcomes | Bar | Events | `event` in (`submit.accepted`, `submit.quota_exceeded`, `submit.persist_failed`, `submit.storage_failed`) | `event` |
| 8 | Unhandled errors | Timeseries | Events | `event = request.unhandled` | `message` |
| 9 | Slowest spans | Top N | duration p95 | — | `transaction name` |

Suggested layout: row 1 = #2, #5, #6 (three stats, the "is anything wrong" row); row 2 = #1 and #3 (traffic and latency); row 3 = #4 and #8; row 4 = #7 and #9.

## Alerts

**Notifications → Add** (Cloudflare Notifications):

- **Workers → Errors** for `sky-palette` — immediate email.
- A rate-limit alert on `/api/submit` is unnecessary at first (Turnstile + the 5/hour D1 quota already bound abuse); revisit if the log shows sustained `submit.quota_exceeded`.

## What each chart is telling you

- #2 rising with #6 flat means a code path is failing, not the weather API.
- #5 rising with #6 means Open-Meteo is down and users are seeing the clear-sky model — the app stays usable, so this is a warning, not an incident.
- #7 dominated by `submit.quota_exceeded` is either abuse or a shared NAT; both are worth knowing before tightening the limit.
- #3 p99 much higher than p95 on `/api/palette` points at Open-Meteo latency, not Worker CPU; `degraded` in #5 tells you whether that request fell back.

## If a field is missing in the picker

Workers Logs only indexes fields that have appeared in persisted logs since the last deploy. Deploy with `observability.logs.persist: true`, hit the route once, then refresh the chart builder. Local `npm run dev` does not feed this data.
