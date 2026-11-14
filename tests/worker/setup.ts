/**
 * Per-file setup: apply the D1 migrations once before the tests in this file.
 * The migration array is injected by `vitest.worker.config.ts`.
 */

import { beforeAll } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
