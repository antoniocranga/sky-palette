/**
 * Tiny observable store for cross-feature state. The only persisted value is
 * the chosen city slug in `sky-palette.city`: no cookies, no sessionStorage,
 * no identifiers and no tracking data.
 */

import type { DayPalette, Palette } from "../shared/types";
import type { City } from "../shared/types";
import { BUCHAREST } from "../shared/solar";
import type { AppConfig } from "./api";
import { serializeRoute, type RouteInterval, type RouteView } from "./lib/route";

export type ScreenName = "home" | "gallery" | "detail";
export type LoadStatus = "idle" | "loading" | "ready" | "error" | "degraded";

export interface AppCity {
  slug: string;
  name: string;
  country: string;
  countryCode: string | null;
  admin1: string | null;
  lat: number;
  lon: number;
  timezone: string;
}

export interface ShareSnapshot {
  city: AppCity;
  palette: Palette;
  dateIso: string;
  timeLabel: string;
  phase: string;
  elevation: number;
  azimuth: number;
  cloudLabel: string;
  mode: "live" | "forecast";
  sunsetLabel: string;
}

export interface AppState {
  city: AppCity;
  screen: ScreenName;
  config: AppConfig | null;
  days: DayPalette[];
  daysStatus: LoadStatus;
  daysRequested: number;
  share: ShareSnapshot | null;
}

export const DEFAULT_CITY: AppCity = {
  slug: BUCHAREST.slug,
  name: BUCHAREST.name,
  country: BUCHAREST.country,
  countryCode: "RO",
  admin1: null,
  lat: BUCHAREST.lat,
  lon: BUCHAREST.lon,
  timezone: BUCHAREST.timezone,
};

export function toAppCity(city: City): AppCity {
  return {
    slug: city.slug,
    name: city.name,
    country: city.country,
    countryCode: city.countryCode,
    admin1: city.admin1,
    lat: city.lat,
    lon: city.lon,
    timezone: city.timezone,
  };
}

export function cityQueryLabel(city: AppCity): string {
  return city.admin1 && city.admin1 !== city.name ? `${city.name}, ${city.admin1}` : city.name;
}

export function cityLabelWithCountry(city: AppCity): string {
  return city.country ? `${city.name}, ${city.country}` : city.name;
}

/** `?city=<slug>` on first paint, otherwise the Bucharest HQ default. */
export function citySlugFromUrl(search = window.location.search): string | null {
  const params = new URLSearchParams(search);
  const slug = params.get("city");
  return slug && slug.trim() ? slug.trim() : null;
}

const CITY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/** A slug safe to send through the city lookup, or null when malformed. */
export function normalizeCitySlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return CITY_SLUG.test(trimmed) ? trimmed : null;
}

/**
 * Boot precedence: URL `?city=` wins, then the stored preference, then the
 * default. A malformed stored value is ignored rather than sent to the API.
 */
export function preferredCitySlug(search: string, stored: string | null): string | null {
  return normalizeCitySlug(citySlugFromUrl(search)) ?? normalizeCitySlug(stored);
}

const CITY_STORAGE_KEY = "sky-palette.city";

/** The only persisted preference: the chosen city slug. */
export function readStoredCitySlug(): string | null {
  try {
    const value = window.localStorage.getItem(CITY_STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function writeStoredCitySlug(slug: string): void {
  try {
    window.localStorage.setItem(CITY_STORAGE_KEY, slug);
  } catch {
    // private mode / storage unavailable: silently keep the session choice
  }
}

export function writeCityToUrl(slug: string, dateIso?: string | null): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("city", slug);
    if (dateIso) url.searchParams.set("day", dateIso);
    else url.searchParams.delete("day");
    url.hash = "";
    window.history.replaceState({}, "", url);
  } catch {
    // URL construction failure must never break the page
  }
}

export function shareUrlFor(city: AppCity, dateIso?: string | null): string {
  const base = store.state.config?.appUrl || window.location.origin;
  const state = store.state;
  const view: RouteView = state.screen;
  const day = view === "detail" ? (dateIso ?? state.share?.dateIso ?? null) : null;
  const time = view === "detail" || view === "home" ? (state.share?.timeLabel ?? null) : null;
  const interval = (state.daysRequested || 15) as RouteInterval;
  try {
    return new URL(serializeRoute({ city: city.slug, view, day, time, interval }), base).toString();
  } catch {
    return window.location.origin;
  }
}

type Listener = (state: AppState, previous: AppState) => void;

class Store {
  private current: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.current = initial;
  }

  get state(): AppState {
    return this.current;
  }

  set(patch: Partial<AppState>): void {
    const previous = this.current;
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.current, previous);
      } catch (error) {
        console.warn("[Sky Palette] state listener failed", error);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeKey<K extends keyof AppState>(key: K, listener: (value: AppState[K], previous: AppState[K]) => void): () => void {
    return this.subscribe((state, previous) => {
      if (state[key] !== previous[key]) listener(state[key], previous[key]);
    });
  }
}

export const store = new Store({
  city: DEFAULT_CITY,
  screen: "home",
  config: null,
  days: [],
  daysStatus: "idle",
  daysRequested: 15,
  share: null,
});

export function setCity(city: AppCity): void {
  const previous = store.state.city;
  if (previous.slug === city.slug && previous.lat === city.lat && previous.lon === city.lon) return;
  store.set({
    city,
    days: [],
    daysStatus: "idle",
    share: null,
  });
}

export function setScreen(screen: ScreenName): void {
  if (store.state.screen !== screen) store.set({ screen });
}
