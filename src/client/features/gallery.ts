/**
 * Gallery: a full-bleed mosaic of real /api/history days with 7 / 15 / 30 day
 * intervals, a skeleton while loading and a retryable error state.
 */

import { ApiError, getHistory } from "../api";
import { isAbortError, qs, qsa, setHidden, setText, registerAction } from "../lib/dom";
import { formatCoordinate, formatDateShort } from "../lib/format";
import type { DayPalette } from "../../shared/types";
import { DEFAULT_CITY, store } from "../state";

const INTERVALS = [7, 15, 30] as const;
export type Interval = (typeof INTERVALS)[number];

export class GalleryFeature {
  private readonly grid = qs<HTMLElement>("#day-cards-grid");
  private readonly skeleton = qs("#gallery-skeleton");
  private readonly errorBox = qs("#gallery-error");
  private readonly errorText = qs("#gallery-error-text");
  private readonly empty = qs("#gallery-empty");
  private readonly trigger = qs("#interval-trigger-btn");
  private readonly popover = qs("#interval-popover");
  private readonly main = qs<HTMLElement>("#gallery-main");
  private controller: AbortController | null = null;
  private days: Interval;
  private loadedFor = "";

  constructor(initialDays: Interval = 15) {
    this.days = initialDays;
    this.updateCityBadge();
    registerAction("retry-gallery", () => {
      void this.load(true);
    });

    registerAction("toggle-interval", () => {
      this.togglePopover();
    });

    registerAction("set-days", (element) => {
      const requested = Number(element.dataset.days);
      if (!isInterval(requested)) return;
      this.days = requested;
      this.closePopover();
      this.syncIntervalButtons();
      this.updateLabel();
      void this.load();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!this.popover || this.popover.classList.contains("hidden")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.popover.contains(target) || this.trigger?.contains(target)) return;
      this.closePopover();
    }, { passive: true });

    store.subscribeKey("city", (city) => {
      this.updateCityBadge(city);
      this.loadedFor = "";
      void this.load();
    });
  }

  async useInterval(days: Interval): Promise<void> {
    this.days = days;
    this.loadedFor = "";
    this.syncIntervalButtons();
    this.updateLabel();
    await this.load(true);
  }

  async start(): Promise<void> {
    this.updateCityBadge();
    this.syncIntervalButtons();
    this.updateLabel();
    await this.load();
  }

  private get cityKey(): string {
    return store.state.city.slug;
  }

  async load(force = false): Promise<void> {
    if (!force && this.loadedFor === `${this.cityKey}:${this.days}` && store.state.daysStatus === "ready") {
      this.render(store.state.days);
      return;
    }

    const city = store.state.city;
    this.controller?.abort();
    this.controller = new AbortController();
    store.set({ daysStatus: "loading", daysRequested: this.days });
    setHidden(this.skeleton, false);
    setHidden(this.errorBox, true);
    setHidden(this.empty, true);
    this.grid?.setAttribute("aria-busy", "true");
    this.grid?.replaceChildren();

    try {
      const response = await getHistory(
        { lat: city.lat, lon: city.lon, days: this.days, timeZone: city.timezone },
        { signal: this.controller.signal },
      );
      setHidden(this.skeleton, true);
      this.grid?.setAttribute("aria-busy", "false");
      this.loadedFor = `${city.slug}:${this.days}`;
      store.set({ days: response.days, daysStatus: "ready", daysRequested: this.days });
      this.render(response.days);
    } catch (error) {
      if (isAbortError(error) || (error instanceof ApiError && error.code === "aborted")) return;
      setHidden(this.skeleton, true);
      this.grid?.setAttribute("aria-busy", "false");
      store.set({ days: [], daysStatus: "error" });
      const message =
        error instanceof ApiError && error.code === "network"
          ? "The sky forecast is unreachable. Check your connection and retry."
          : error instanceof ApiError && error.code === "timeout"
            ? "The forecast service timed out. Retry in a moment."
            : "The forecast service could not build this mosaic.";
      setText(this.errorText, message);
      setHidden(this.errorBox, false);
      this.grid?.replaceChildren();
    }
  }

  private render(days: DayPalette[]): void {
    if (!this.grid) return;
    this.grid.replaceChildren();

    if (days.length === 0) {
      setHidden(this.empty, false);
      this.grid.style.minHeight = "0";
      return;
    }

    setHidden(this.empty, true);
    this.grid.dataset.days = String(this.days);
    const rows: [number, number, number] =
      this.days === 7 ? [4, 2, 1] : this.days === 30 ? [10, 6, 5] : [8, 5, 3];
    this.grid.style.setProperty("--grid-rows", String(rows[0]));
    this.grid.style.setProperty("--grid-rows-sm", String(rows[1]));
    this.grid.style.setProperty("--grid-rows-md", String(rows[2]));

    days.forEach((day, index) => {
      this.grid?.appendChild(this.createTile(day, index));
    });
  }

  private createTile(day: DayPalette, index: number): HTMLButtonElement {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "day-tile";
    tile.dataset.action = "open-day";
    tile.dataset.index = String(index);

    const bands = document.createElement("div");
    bands.className = "day-tile-bands";
    bands.setAttribute("aria-hidden", "true");
    for (const color of day.colors) {
      const band = document.createElement("span");
      band.style.backgroundColor = safeColor(color);
      bands.appendChild(band);
    }
    tile.appendChild(bands);

    const shade = document.createElement("div");
    shade.className = "day-tile-shade";
    shade.setAttribute("aria-hidden", "true");
    tile.appendChild(shade);

    const copy = document.createElement("div");
    copy.className = "day-tile-copy";
    const left = document.createElement("div");
    left.className = "min-w-0";
    const date = document.createElement("div");
    date.className = "day-tile-date";
    date.textContent = formatDateShort(day.date);
    const meta = document.createElement("div");
    meta.className = "day-tile-meta truncate";
    const sunsetLabel = day.sunset ? day.sunset : "—";
    meta.textContent = `${sunsetLabel} · ${day.phase}`;
    left.append(date, meta);

    copy.append(left);
    tile.appendChild(copy);
    return tile;
  }

  private updateCityBadge(city = store.state.city): void {
    const country = city.countryCode ?? city.country;
    const badge = qs("#gallery-city-badge");
    const label = city.slug === DEFAULT_CITY.slug ? city.name : `${city.name} · ${country}`;
    setText(badge, label);
    badge?.setAttribute("title", `${label} · ${formatCoordinate(city.lat, "lat", 1)}`);
    // Keep the visible city text inside the button's accessible name.
    qs("#gallery-location-btn")?.setAttribute("aria-label", `Change gallery location, ${label}`);
  }

  private togglePopover(): void {
    if (!this.popover) return;
    const willOpen = this.popover.classList.contains("hidden");
    this.popover.classList.toggle("hidden", !willOpen);
    this.trigger?.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) {
      const active = qs<HTMLElement>(`#int-btn-${this.days}`);
      active?.focus({ preventScroll: true });
    }
  }

  private closePopover(): void {
    this.popover?.classList.add("hidden");
    this.trigger?.setAttribute("aria-expanded", "false");
  }

  private syncIntervalButtons(): void {
    for (const interval of INTERVALS) {
      const button = qs<HTMLElement>(`#int-btn-${interval}`);
      if (!button) continue;
      const active = interval === this.days;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.classList.toggle("bg-white", active);
      button.classList.toggle("text-black", active);
      button.classList.toggle("font-semibold", active);
      button.classList.toggle("text-white/70", !active);
    }
  }

  private updateLabel(): void {
    setText(qs("#current-interval-label"), `${this.days}-Day Mosaic`);
    setText(qs("#current-interval-label-mobile"), `${this.days}D`);
  }
}

function isInterval(value: number): value is Interval {
  return (INTERVALS as readonly number[]).includes(value);
}

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
function safeColor(value: string): string {
  return HEX.test(value) ? value : "#1F2937";
}

// Keep the element query list typed and referenced for future counts.
void qsa;
