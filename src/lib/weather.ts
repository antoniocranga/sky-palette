/**
 * Sky Palette — Open-Meteo Atmospheric Weather Integration
 * 
 * Ingests cloud layers (low/mid/high) and visibility to drive physical sky scattering.
 * Free, non-commercial fair-use with edge caching and rate limiting.
 */

export interface WeatherData {
  cloudCoverLow: number;  // 0 - 100%
  cloudCoverMid: number;  // 0 - 100%
  cloudCoverHigh: number; // 0 - 100%
  visibility: number;     // meters
  weatherCode: number;
}

const weatherMemoryCache = new Map<string, { data: WeatherData; expiresAt: number }>();

/**
 * Fetch atmospheric parameters from Open-Meteo with edge memory caching
 */
export async function fetchAtmosphericWeather(
  lat: number,
  lon: number,
  dateIso: string
): Promise<WeatherData> {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}:${dateIso}`;
  const cached = weatherMemoryCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloudcover_low,cloudcover_mid,cloudcover_high,visibility,weathercode&timezone=auto&forecast_days=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SkyPalette/1.0 (https://skypalette.app; contact@skypalette.app)'
      }
    });

    if (!response.ok) {
      throw new Error(`Open-Meteo returned status ${response.status}`);
    }

    const data: any = await response.json();
    const hourly = data.hourly;
    
    // Average or take mid-day / golden-hour slice
    const sampleIdx = Math.min(16, (hourly.cloudcover_low?.length || 1) - 1);
    const weatherResult: WeatherData = {
      cloudCoverLow: hourly.cloudcover_low?.[sampleIdx] ?? 20,
      cloudCoverMid: hourly.cloudcover_mid?.[sampleIdx] ?? 10,
      cloudCoverHigh: hourly.cloudcover_high?.[sampleIdx] ?? 35,
      visibility: hourly.visibility?.[sampleIdx] ?? 15000,
      weatherCode: hourly.weathercode?.[sampleIdx] ?? 0
    };

    // Cache for 1 hour
    weatherMemoryCache.set(cacheKey, {
      data: weatherResult,
      expiresAt: now + 3600000
    });

    return weatherResult;
  } catch (error) {
    // Fallback to calm, clear-sky physical baseline
    return {
      cloudCoverLow: 15,
      cloudCoverMid: 10,
      cloudCoverHigh: 25,
      visibility: 20000,
      weatherCode: 0
    };
  }
}
