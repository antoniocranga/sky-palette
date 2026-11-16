-- Reverse-geocoded place names, keyed by a ~1 km grid cell. Keeping the answer
-- in D1 means repeat uploads never touch the upstream geocoder.
CREATE TABLE IF NOT EXISTS geo_cache (
  lat_key REAL NOT NULL,
  lon_key REAL NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lat_key, lon_key)
);

CREATE INDEX IF NOT EXISTS geo_cache_created_idx ON geo_cache (created_at);
