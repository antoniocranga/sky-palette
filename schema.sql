-- Sky Palette D1 Database Schema
-- Database UUID: 5e1c6b54-4020-4e9b-a5d5-0cea27498741
-- Region: EEUR (Eastern Europe / Bucharest)

-- 1. Cities (Curated global cities table ~44,000 cities with coordinates & timezones)
CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  country_code TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  timezone TEXT NOT NULL,
  population INTEGER DEFAULT 0,
  slug TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cities_name ON cities(name);
CREATE INDEX IF NOT EXISTS idx_cities_slug ON cities(slug);
CREATE INDEX IF NOT EXISTS idx_cities_country ON cities(country_code);
CREATE INDEX IF NOT EXISTS idx_cities_coords ON cities(lat, lon);

-- 2. Community Photo Submissions (Crowdsourced real-sky calibration photos)
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  zenith TEXT NOT NULL,
  midsky TEXT NOT NULL,
  horizon TEXT NOT NULL,
  sunglow TEXT NOT NULL,
  cloudtint TEXT NOT NULL,
  contributor_handle TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submissions_city_id ON submissions(city_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions(timestamp);

-- 3. Daily Computed Historical Palettes (Cached archive for gallery scrub & analytics)
CREATE TABLE IF NOT EXISTS daily_palettes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  zenith TEXT NOT NULL,
  midsky TEXT NOT NULL,
  horizon TEXT NOT NULL,
  sunglow TEXT NOT NULL,
  cloudtint TEXT NOT NULL,
  weather_code INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(city_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_palettes_city_date ON daily_palettes(city_id, date);
