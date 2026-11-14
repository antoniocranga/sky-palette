/** URL grammar for shareable sky state. Pure parse/serialize helpers. */

export type RouteView = "home" | "gallery" | "detail";
export type RouteInterval = 7 | 15 | 30;

export interface AppRoute {
  city: string | null;
  view: RouteView | null;
  day: string | null;
  time: string | null;
  interval: RouteInterval | null;
}

export const DEFAULT_INTERVAL: RouteInterval = 15;
const INTERVALS: readonly number[] = [7, 15, 30];

export function isValidDay(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidTime(value: string | null | undefined): value is string {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) && (hours ?? 99) <= 23 && (minutes ?? 99) <= 59;
}

export function parseRoute(search: string): AppRoute {
  const params = new URLSearchParams(search);
  const cityValue = params.get("city")?.trim() ?? "";
  const city = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(cityValue) ? cityValue : null;

  const viewValue = params.get("view");
  const explicitView: RouteView | null =
    viewValue === "home" || viewValue === "gallery" || viewValue === "detail" ? viewValue : null;

  const dayValue = params.get("day");
  const day = isValidDay(dayValue) ? dayValue : null;
  const timeValue = params.get("time");
  const time = isValidTime(timeValue) ? timeValue : null;

  const intervalValue = params.get("interval");
  const intervalNumber = intervalValue === null ? Number.NaN : Number(intervalValue);
  const interval = INTERVALS.includes(intervalNumber) ? (intervalNumber as RouteInterval) : null;

  // A day implies detail only when no explicit valid view is present.
  const view = explicitView ?? (day ? "detail" : null);

  return { city: city || null, view, day, time, interval };
}

export interface SerializeRouteInput {
  city: string | null;
  view: RouteView | null;
  day?: string | null;
  time?: string | null;
  interval?: RouteInterval | null;
}

/** Stable parameter order: city, view, day, time, interval. */
export function serializeRoute(input: SerializeRouteInput): string {
  const params = new URLSearchParams();
  if (input.city) params.set("city", input.city);
  if (input.view) params.set("view", input.view);
  if (input.day) params.set("day", input.day);
  if (input.time) params.set("time", input.time);
  if (input.interval) params.set("interval", String(input.interval));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
