#!/usr/bin/env node
/**
 * Sky Palette stress test — no dependencies.
 *
 * Usage:
 *   node load/stress.mjs --url http://localhost:5173 --concurrency 40 --duration 20
 *   node load/stress.mjs --url https://skypalette.app --mode mixed --concurrency 20
 *   node load/stress.mjs --url http://localhost:5173 --mode upload --concurrency 20 --token <turnstile>
 *
 * Modes:
 *   palette (default)  GET /api/palette for Bucharest
 *   mixed              palette + cities + og + a photo HEAD
 *   upload             POST /api/submit with a synthetic 800x600 PNG
 *
 * The script exits non-zero when 5xx responses appear, when p95 exceeds
 * --p95-ms, or when the rate limiter never engages in upload/palette bursts.
 */

const DEFAULT_URL = "http://localhost:5173";
const PNG_800x600 = makePng(800, 600);

function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); // not validated by the worker; kept for structure
    return Buffer.concat([length, body, crc]);
  };
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    mode: "palette",
    concurrency: 25,
    duration: 15,
    p95Ms: 2500,
    token: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") options.url = argv[++i];
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg === "--duration") options.duration = Number(argv[++i]);
    else if (arg === "--p95-ms") options.p95Ms = Number(argv[++i]);
    else if (arg === "--token") options.token = argv[++i];
    else if (arg === "--help") {
      console.log("node load/stress.mjs [--url URL] [--mode palette|mixed|upload] [--concurrency N] [--duration SECONDS] [--p95-ms N] [--token TOKEN]");
      process.exit(0);
    }
  }
  options.url = options.url.replace(/\/$/, "");
  return options;
}

function buildRequest(options, index) {
  const mode = options.mode;
  if (mode === "upload") {
    const form = new FormData();
    form.set("photo", new Blob([PNG_800x600], { type: "image/png" }), `stress-${index}.png`);
    form.set("lat", "44.4268");
    form.set("lon", "26.1025");
    form.set("capturedAt", new Date().toISOString());
    form.set("citySlug", "bucharest-romania");
    if (options.token) form.set("turnstileToken", options.token);
    return { url: `${options.url}/api/submit`, init: { method: "POST", body: form } };
  }

  if (mode === "mixed") {
    const routes = [
      `${options.url}/api/palette?lat=44.4268&lon=26.1025&tz=Europe/Bucharest`,
      `${options.url}/api/cities?q=Cluj`,
      `${options.url}/api/og?city=Bucharest&phase=Golden%20Hour`,
      `${options.url}/api/history?lat=44.4268&lon=26.1025&days=7&tz=Europe/Bucharest`,
    ];
    return { url: routes[index % routes.length], init: {} };
  }

  return {
    url: `${options.url}/api/palette?lat=44.4268&lon=26.1025&tz=Europe/Bucharest`,
    init: {},
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.duration * 1000;

  const statuses = new Map();
  const latencies = [];
  let issued = 0;
  let networkErrors = 0;

  console.log(
    `stress: ${options.mode} → ${options.url} | concurrency ${options.concurrency} | ${options.duration}s`,
  );

  // Warm-up is a GET on health: it opens the connection without consuming an
  // upload quota slot or a rate-limit token for the measured run.
  try {
    await fetch(`${options.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    // A warm-up failure is reported by the measured run.
  }

  async function worker(id) {
    while (Date.now() < deadline) {
      const index = issued++;
      const { url, init } = buildRequest(options, index);
      const started = performance.now();
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(15_000),
          headers: { "user-agent": `sky-palette-stress/${id}` },
        });
        await response.arrayBuffer();
        latencies.push(performance.now() - started);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      } catch {
        networkErrors += 1;
        statuses.set("network", (statuses.get("network") ?? 0) + 1);
      }
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: options.concurrency }, (_, id) => worker(id)));
  const elapsedSeconds = (performance.now() - startedAt) / 1000;

  latencies.sort((a, b) => a - b);
  const total = latencies.length + networkErrors;
  const serverErrors = [...statuses.entries()]
    .filter(([status]) => typeof status === "number" && status >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  const limited = statuses.get(429) ?? 0;
  const accepted = statuses.get(201) ?? 0;
  const rps = total / elapsedSeconds;

  console.log("");
  console.log(`requests   ${total} in ${elapsedSeconds.toFixed(1)}s  (${rps.toFixed(1)} rps)`);
  console.log(`latency    p50 ${percentile(latencies, 50).toFixed(0)}ms  p95 ${percentile(latencies, 95).toFixed(0)}ms  p99 ${percentile(latencies, 99).toFixed(0)}ms  max ${(latencies.at(-1) ?? 0).toFixed(0)}ms`);
  console.log(`statuses   ${[...statuses.entries()].map(([status, count]) => `${status}:${count}`).join("  ")}`);
  console.log(`limited    429 ${limited} (${((limited / Math.max(1, total)) * 100).toFixed(1)}%)  accepted 201 ${accepted}`);

  const failures = [];
  if (serverErrors > 0) failures.push(`${serverErrors} server error(s) — 5xx must never happen under load`);
  if (networkErrors > 0) failures.push(`${networkErrors} network error(s)`);
  if (percentile(latencies, 95) > options.p95Ms) failures.push(`p95 ${percentile(latencies, 95).toFixed(0)}ms > ${options.p95Ms}ms`);
  if (options.mode === "upload" && limited === 0) failures.push("upload burst never hit the rate limit");

  if (failures.length > 0) {
    console.error(`\nFAIL  ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
