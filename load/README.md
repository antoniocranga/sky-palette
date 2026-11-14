# Stress tests

Dependency-free load generator for the API. It measures throughput and latency,
counts status codes, and fails when 5xx responses appear or p95 exceeds the
threshold.

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run test:load -- --url http://localhost:5173 --concurrency 40 --duration 20
npm run test:load -- --url http://localhost:5173 --mode upload --concurrency 20 --duration 10
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://localhost:5173` | Base URL |
| `--mode` | `palette` | `palette`, `mixed` (palette + cities + og + history) or `upload` |
| `--concurrency` | `25` | Parallel workers |
| `--duration` | `15` | Seconds |
| `--p95-ms` | `2500` | Fail above this p95 |
| `--token` | empty | Turnstile token for `upload` against production |

`upload` mode sends a synthetic 800×600 PNG (the server validates the header,
not the pixels). Against production it also needs a valid Turnstile token, and
the shared egress IP will exhaust the 5/hour per-client quota almost
immediately — that is the protection working, not a failed test.

Interpretation:

- **429s in `upload`** are expected and required; the script fails if a burst
  never hits the limit.
- **5xx** are a failure. A 429 is a correct answer under load.
- Compare before/after a change on the same machine; absolute RPS is dominated
  by the network path, not the Worker.

For concurrency correctness (not throughput), see
`tests/worker/rate-limit.test.ts`: it fires 20 parallel uploads and asserts that
exactly five reach R2.
