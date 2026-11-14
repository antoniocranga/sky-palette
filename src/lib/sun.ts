/**
 * Sky Palette — Solar Position & Astronomical Calculation Engine
 * 
 * Computes solar elevation, azimuth, and golden-hour intervals based on
 * astronomical equations (Jean Meeus algorithm / SunCalc standard).
 */

export interface SolarPosition {
  elevation: number; // degrees above horizon
  azimuth: number;   // degrees from South (or North standard)
  zenith: number;    // 90 - elevation
}

export interface SolarTimes {
  sunrise: string;
  sunset: string;
  goldenHourStart: string;
  goldenHourEnd: string;
  solarNoon: string;
}

export const BUCHAREST_HQ = {
  name: 'Bucharest HQ',
  lat: 44.4268,
  lon: 26.1025,
  timezone: 'Europe/Bucharest'
};

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Compute solar position for latitude, longitude, and UTC timestamp
 */
export function getSolarPosition(lat: number, lon: number, date: Date): SolarPosition {
  const lw = -lon * RAD;
  const phi = lat * RAD;
  
  // Days since J2000.0
  const d = (date.getTime() / 86400000) - 10957.5;
  
  // Solar coordinates
  const M = (357.5291 + 0.98560028 * d) * RAD;
  const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * RAD;
  const L = M + C + 282.9372 * RAD;
  const dec = Math.asin(Math.sin(L) * Math.sin(23.44 * RAD));
  const ra = Math.atan2(Math.sin(L) * Math.cos(23.44 * RAD), Math.cos(L));

  // Sidereal time
  const th = (280.16 + 360.9856235 * d) * RAD - lw;
  const H = th - ra;

  // Altitude & Azimuth
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));

  const elevationDeg = alt * DEG;
  const azimuthDeg = (az * DEG + 180) % 360;

  return {
    elevation: parseFloat(elevationDeg.toFixed(2)),
    azimuth: parseFloat(azimuthDeg.toFixed(2)),
    zenith: parseFloat((90 - elevationDeg).toFixed(2))
  };
}
