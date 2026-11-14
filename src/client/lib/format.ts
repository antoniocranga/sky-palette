/**
 * Presentation formatters. Pure functions only, so they can be unit tested in
 * Node without a DOM.
 */

import { addDays, clockInZone, isoDayInZone, parseClock, zonedTimeToUtc } from "../../shared/time";
import type { WeatherSnapshot } from "../../shared/types";

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

const UPPER_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** YYYY-MM-DD -> "Nov 14". Date-only strings are anchored at noon UTC. */
export function formatDateShort(isoDate: string): string {
  const date = dateOnlyToUtc(isoDate);
  return date ? SHORT_DATE.format(date) : "—";
}

export function formatDateLong(isoDate: string): string {
  const date = dateOnlyToUtc(isoDate);
  return date ? LONG_DATE.format(date) : "—";
}

/** YYYY-MM-DD -> "NOV 14". */
export function formatDateUpper(isoDate: string): string {
  const date = dateOnlyToUtc(isoDate);
  return date ? UPPER_DATE.format(date).toUpperCase() : "—";
}

export function formatWeekday(isoDate: string): string {
  const date = dateOnlyToUtc(isoDate);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date);
}

function dateOnlyToUtc(isoDate: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const date = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 44.4268 -> "44.4268° N". */
export function formatCoordinate(value: number, axis: "lat" | "lon", digits = 4): string {
  if (!Number.isFinite(value)) return "—";
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(digits)}° ${hemisphere}`;
}

export function formatCoordinates(lat: number, lon: number, digits = 4): string {
  return `${formatCoordinate(lat, "lat", digits)}, ${formatCoordinate(lon, "lon", digits)}`;
}

/** +0.8° / -4.2°. */
export function formatElevation(elevation: number): string {
  if (!Number.isFinite(elevation)) return "—";
  const sign = elevation >= 0 ? "+" : "";
  return `${sign}${elevation.toFixed(1)}°`;
}

export function formatDegrees(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(((value % 360) + 360) % 360)}°`;
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatVisibility(metres: number | undefined): string {
  if (typeof metres !== "number" || !Number.isFinite(metres)) return "—";
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km`;
  return `${Math.round(metres)} m`;
}

/** ISO instant -> local HH:MM in the city's zone. */
export function formatInstantClock(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return clockInZone(date, timeZone);
}

export function timeZoneAbbreviation(timeZone: string, date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      timeZoneName: "short",
    }).formatToParts(date);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** YYYY-MM-DDTHH:mm for a datetime-local input in a specific zone. */
export function toDateTimeLocalValue(date: Date, timeZone: string): string {
  return `${isoDayInZone(date, timeZone)}T${clockInZone(date, timeZone)}`;
}

/** Parse a datetime-local value in a city's zone into an ISO UTC instant. */
export function parseDateTimeLocalValue(value: string, timeZone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  const dateIso = match[1];
  const time = match[2];
  if (!dateIso || !time) return null;
  const clock = parseClock(time);
  if (!clock) return null;
  return zonedTimeToUtc(dateIso, time, timeZone).toISOString();
}

/** The city-local date that contains a UTC instant. */
export function localDayFor(date: Date, timeZone: string): string {
  return isoDayInZone(date, timeZone);
}

/** Local day + hour (13.75) -> UTC instant; 24:00 rolls into the next day. */
export function instantForLocalHour(dateIso: string, hour: number, timeZone: string): Date {
  if (hour >= 24) {
    return zonedTimeToUtc(addDays(dateIso, 1), "00:00", timeZone);
  }
  const totalMinutes = Math.round(Math.min(23 * 60 + 59, Math.max(0, hour * 60)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return zonedTimeToUtc(dateIso, `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`, timeZone);
}

export function weatherLabel(code: number | null | undefined): string {
  if (typeof code !== "number") return "Weather";
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Cloudy";
}

export function weatherSummary(weather: WeatherSnapshot | null | undefined): string {
  if (!weather) return "—";
  return `${formatPercent(weather.cloudCoverLow)} / ${formatPercent(weather.cloudCoverMid)} / ${formatPercent(weather.cloudCoverHigh)}`;
}

/** Lower-case slug for handles: "Buenos Aires" -> "buenos-aires". */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

export function isToday(isoDate: string, timeZone: string, now = new Date()): boolean {
  return isoDayInZone(now, timeZone) === isoDate;
}
