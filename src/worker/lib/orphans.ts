/**
 * Orphan reaper.
 *
 * A submission writes the R2 object first and the D1 row second. If the isolate
 * dies in between, the object has no row and is unreachable from the app but
 * still billed. This sweep compares the bucket against the table and deletes
 * objects with no row, with a safety window so an in-flight upload is never
 * touched.
 *
 * Runs from the daily cron trigger. Keys are logged as counts only.
 */

import { logEvent } from "./http";
import type { Env } from "../env";

const PREFIX = "photos/";
const SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 500;

export interface ReapResult {
  scanned: number;
  deleted: number;
  skippedYoung: number;
  failed: number;
}

export async function reapOrphans(env: Pick<Env, "DB" | "PHOTOS">, now = new Date()): Promise<ReapResult> {
  const result: ReapResult = { scanned: 0, deleted: 0, skippedYoung: 0, failed: 0 };
  if (!env.PHOTOS) return result;

  const known = new Set<string>();
  const { results } = await env.DB.prepare("SELECT r2_key, thumb_key FROM submissions")
    .all<{ r2_key: string; thumb_key: string | null }>();
  for (const row of results ?? []) {
    known.add(row.r2_key);
    if (row.thumb_key) known.add(row.thumb_key);
  }

  let cursor: string | undefined;
  for (;;) {
    const listed = await env.PHOTOS.list({ prefix: PREFIX, cursor, limit: LIST_LIMIT });
    for (const object of listed.objects) {
      result.scanned += 1;
      if (known.has(object.key)) continue;

      const age = now.getTime() - object.uploaded.getTime();
      if (age < SAFETY_WINDOW_MS) {
        result.skippedYoung += 1;
        continue;
      }

      try {
        await env.PHOTOS.delete(object.key);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }

    if (listed.truncated) cursor = listed.cursor;
    else break;
    if (!cursor) break;
  }

  logEvent("info", "orphans.reaped", { ...result });
  return result;
}
