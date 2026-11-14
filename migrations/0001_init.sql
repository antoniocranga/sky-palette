-- Sky Palette — initial D1 schema.
--
-- Additive only: never edit an applied migration, add the next one.
-- Every statement is idempotent so a fresh local database and an existing
-- production database converge on the same shape.
--
-- privacy: submissions never store a raw IP, only a salted SHA-256 digest.

-- Cities resolved from the Open-Meteo geocoder. Used for autocomplete and as
-- the join key for photo submissions and cached daily palettes.
CREATE TABLE IF NOT EXISTS cities (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  country_code TEXT,
  admin1 TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  timezone TEXT NOT NULL,
  population INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cities_name ON cities(name);
CREATE INDEX IF NOT EXISTS idx_cities_coords ON cities(lat, lon);

-- Community photo submissions. Photos live in R2 (`sky-photos`) and are only
-- served through GET /api/photos/*; the bucket stays private.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  city_slug TEXT,
  handle TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  palette_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_coords ON submissions(lat, lon);
CREATE INDEX IF NOT EXISTS idx_submissions_ip ON submissions(ip_hash, created_at);

-- One palette per city-day at local sunset. city_key is the coordinate key
-- rounded to two decimals ("44.43,26.10") so nearby requests share a row.
CREATE TABLE IF NOT EXISTS daily_palettes (
  city_key TEXT NOT NULL,
  date TEXT NOT NULL,
  phase TEXT NOT NULL,
  swatches_json TEXT NOT NULL,
  weather_code INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (city_key, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_palettes_date ON daily_palettes(date);
