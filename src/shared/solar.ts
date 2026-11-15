/**
 * Solar geometry shared by the Worker (authoritative API) and the browser
 * (zero-latency scrubbing). Pure functions only: no DOM, no runtime globals.
 *
 * Algorithm: NOAA / Jean Meeus low-precision solar coordinates. Accuracy is
 * better than ~0.02 degrees for the century around J2000, which is far below
 * what a colour engine needs.
 */

export interface SolarPosition {
  /** Degrees above the horizon. Negative below it. */
  elevation: number;
  /** Degrees clockwise from true north, 0-360. */
  azimuth: number;
  /** 90 - elevation. */
  zenith: number;
}

export interface SunTimes {
  /** UTC instants; null during polar day/night. */
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  goldenHourStart: Date | null;
  goldenHourEnd: Date | null;
}

export const BUCHAREST = {
  name: "Bucharest",
  country: "Romania",
  lat: 44.4268,
  lon: 26.1025,
  timezone: "Europe/Bucharest",
  slug: "bucharest-romania",
} as const;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;

/** Julian centuries since J2000.0. */
function julianCentury(date: Date): number {
  return (date.getTime() / MS_PER_DAY + 2440587.5 - 2451545) / 36525;
}

interface SolarCoordinates {
  declination: number;
  rightAscension: number;
  equationOfTime: number;
}

function solarCoordinates(date: Date): SolarCoordinates {
  const t = julianCentury(date);
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 +
    0.00256 * Math.cos(omega * RAD);

  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) * DEG;

  const y = Math.tan((obliquity * RAD) / 2) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLongitude * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 * eccentricity * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLongitude * RAD) -
      0.5 * y * y * Math.sin(4 * meanLongitude * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  // Right ascension, normalised to [0, 360).
  const rightAscension =
    ((Math.atan2(Math.cos(obliquity * RAD) * Math.sin(apparentLongitude * RAD), Math.cos(apparentLongitude * RAD)) * DEG) + 360) % 360;

  return { declination, rightAscension, equationOfTime };
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Solar position for a latitude/longitude and a UTC instant. */
export function getSolarPosition(lat: number, lon: number, date: Date): SolarPosition {
  const phi = lat * RAD;
  const coords = solarCoordinates(date);
  const dec = coords.declination * RAD;

  // Greenwich mean sidereal time, then local hour angle.
  const d = date.getTime() / MS_PER_DAY + 2440587.5 - 2451545;
  const gmst = normalizeDegrees(280.46061837 + 360.98564736629 * d);
  const hourAngle = normalizeDegrees(gmst + lon) - coords.rightAscension;

  const h = hourAngle * RAD;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)) * DEG;
  const azimuth =
    normalizeDegrees(Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) * DEG + 180);

  return {
    elevation: round(elevation, 3),
    azimuth: round(azimuth, 3),
    zenith: round(90 - elevation, 3),
  };
}

/**
 * Sunrise, sunset, solar noon and the golden-hour window for the UTC day that
 * contains `date`. Uses the standard -0.833 degree refraction horizon and
 * +6 degrees for golden hour.
 */
export function getSunTimes(lat: number, lon: number, date: Date): SunTimes {
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const noon = solarNoon(lat, lon, dayStart);
  const coords = solarCoordinates(noon);
  const declination = coords.declination * RAD;
  const phi = lat * RAD;

  const hourAngleFor = (altitude: number): number | null => {
    const cosH =
      (Math.sin(altitude * RAD) - Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
    if (cosH > 1 || cosH < -1) return null;
    return Math.acos(cosH) * DEG;
  };

  const eventTime = (altitude: number, afternoon: boolean): Date | null => {
    const hourAngle = hourAngleFor(altitude);
    if (hourAngle === null) return null;
    const minutes = 720 + 4 * (hourAngle * (afternoon ? 1 : -1) - lon) - coords.equationOfTime;
    return new Date(dayStart.getTime() + minutes * 60_000);
  };

  return {
    sunrise: eventTime(-0.833, false),
    sunset: eventTime(-0.833, true),
    solarNoon: noon,
    goldenHourStart: eventTime(6, false),
    goldenHourEnd: eventTime(-0.833, true),
  };
}

function solarNoon(lat: number, lon: number, dayStart: Date): Date {
  // Equation of time at local noon, then correct once for the actual instant.
  const guess = new Date(dayStart.getTime() + (720 - 4 * lon) * 60_000);
  const eot = solarCoordinates(guess).equationOfTime;
  return new Date(dayStart.getTime() + (720 - 4 * lon - eot) * 60_000);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Coarse human phase for the sun's altitude, used for labels and grouping. */
export function phaseForElevation(elevation: number): string {
  if (elevation > 20) return "Solar Day";
  if (elevation > 5) return "Afternoon";
  if (elevation >= -1) return "Golden Hour";
  if (elevation >= -6) return "Sunset";
  if (elevation >= -12) return "Dusk";
  return "Night";
}
