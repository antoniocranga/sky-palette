-- Atomic abuse quotas.
--
-- Cloudflare's RateLimit bindings are per-colo and eventually consistent, which
-- is fine for floods but not for a strict "5 uploads per hour" rule or a global
-- daily storage cap. This table is the authoritative counter: one row per
-- key/window, incremented with a single UPSERT ... RETURNING so concurrent
-- requests cannot read the same count and both pass.
--
-- privacy: keys contain only salted SHA-256 digests or fixed action names.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
