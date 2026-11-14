/**
 * Types for the Worker tests: the real bindings plus the test-only migration
 * array injected by `vitest.worker.config.ts`.
 */

import type { Env as WorkerEnv } from "../../src/worker/env";

interface D1Migration {
  name: string;
  queries: string[];
}

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
