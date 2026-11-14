/**
 * City search used by the home bar and the gallery modal.
 *
 * Requests are debounced by 250 ms and abortable. Keyboard navigation follows
 * the combobox pattern (Arrow keys, Enter, Escape).
 */

import { searchCities, type ApiError } from "../api";
import { qs, isAbortError, showToast } from "../lib/dom";
import {
  cityQueryLabel,
  setCity,
  setScreen,
  toAppCity,
  writeCityToUrl,
  writeStoredCitySlug,
  type AppCity,
  type ScreenName,
} from "../state";
import type { City } from "../../shared/types";

let searchSequence = 0;

export interface CitySearchOptions {
  input: HTMLInputElement;
  dropdown: HTMLElement;
  tone?: "dark" | "light";
  /** Submit-location search only fills its field; it must not move the app city. */
  commitToApp?: boolean;
  destination?: ScreenName | null;
  onSelect?: (city: AppCity) => void;
  onOpen?: () => void;
}

export class CitySearch {
  private readonly input: HTMLInputElement;
  private readonly dropdown: HTMLElement;
  private readonly options: CitySearchOptions;
  private readonly listId: string;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private results: City[] = [];
  private activeIndex = -1;
  private open = false;
  private readonly onInputBound = (): void => this.handleInput();
  private readonly onKeyDownBound = (event: KeyboardEvent): void => this.handleKeyDown(event);
  private readonly onDropdownClickBound = (event: Event): void => this.handleDropdownClick(event);
  private readonly onDocumentPointerBound = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.input.contains(target) || this.dropdown.contains(target)) return;
    this.close();
  };

  constructor(options: CitySearchOptions) {
    this.options = options;
    this.input = options.input;
    this.dropdown = options.dropdown;
    this.listId = options.dropdown.id || `city-list-${++searchSequence}`;
    options.dropdown.id = this.listId;
    this.input.setAttribute("aria-controls", this.listId);
    this.input.setAttribute("aria-expanded", "false");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");

    this.input.addEventListener("input", this.onInputBound);
    this.input.addEventListener("keydown", this.onKeyDownBound);
    this.input.addEventListener("focus", () => {
      this.options.onOpen?.();
      if (this.results.length > 0 && !this.open) this.renderResults();
    });
    this.dropdown.addEventListener("click", this.onDropdownClickBound);
    document.addEventListener("pointerdown", this.onDocumentPointerBound, { passive: true });
  }

  reset(): void {
    this.abort();
    this.results = [];
    this.activeIndex = -1;
    this.close();
    this.input.value = "";
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  private handleInput(): void {
    const query = this.input.value.trim();
    this.options.onOpen?.();
    this.abort();

    if (query.length < 2) {
      this.results = [];
      this.activeIndex = -1;
      this.close();
      return;
    }

    this.timer = setTimeout(() => {
      void this.runSearch(query);
    }, 250);
  }

  private async runSearch(query: string): Promise<void> {
    this.controller = new AbortController();
    this.activeIndex = -1;
    this.open = true;
    this.input.setAttribute("aria-expanded", "true");
    this.dropdown.classList.remove("hidden");
    this.renderMessage("Searching cities…", true);

    try {
      const results = await searchCities(query, { signal: this.controller.signal });
      if (this.input.value.trim() !== query) return;
      this.results = results;
      // No row pre-highlight: the first option stays neutral until hover/keyboard.
      this.activeIndex = -1;
      this.renderResults();
    } catch (error) {
      if (isAbortError(error) || (error instanceof DOMException && error.name === "AbortError")) return;
      const apiError = error as ApiError;
      if (apiError.code === "aborted") return;
      this.results = [];
      this.activeIndex = -1;
      this.renderError(apiError.code === "network" ? "City search is offline." : "City search is unavailable.");
    }
  }

  private renderResults(): void {
    this.dropdown.replaceChildren();
    this.open = true;
    this.dropdown.classList.remove("hidden");
    this.input.setAttribute("aria-expanded", "true");

    if (this.results.length === 0) {
      this.renderMessage("No cities match that search.", false);
      return;
    }

    const dark = this.options.tone !== "light";
    this.results.forEach((city, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.id = `${this.listId}-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", index === this.activeIndex ? "true" : "false");
      row.dataset.index = String(index);
      row.className =
        "w-full min-h-11 text-left px-3 py-2 flex items-center gap-3 transition-colors " +
        (index === this.activeIndex
          ? dark
            ? "bg-white text-black"
            : "bg-neutral-900 text-white"
          : dark
            ? "text-white hover:bg-white/10"
            : "text-neutral-800 hover:bg-neutral-100");

      const chip = document.createElement("span");
      chip.className = dark
        ? "w-8 h-8 rounded-full bg-white/10 text-white/75 flex items-center justify-center shrink-0"
        : "w-8 h-8 rounded-full bg-neutral-100 text-neutral-500 flex items-center justify-center shrink-0";
      chip.appendChild(pinIcon());

      const left = document.createElement("span");
      left.className = "min-w-0 flex-1";
      const name = document.createElement("span");
      name.className = "block text-xs font-semibold truncate";
      name.textContent = city.name;
      const meta = document.createElement("span");
      meta.className = "block text-[10px] font-mono truncate opacity-70";
      const postal = (city as City & { postalCode?: string | null }).postalCode;
      const detail = [city.admin1, city.country, postal].filter(Boolean).join(" · ");
      meta.textContent = detail || "Sky";
      left.append(name, meta);

      const arrow = document.createElement("span");
      arrow.className = "shrink-0 opacity-55";
      arrow.setAttribute("aria-hidden", "true");
      arrow.appendChild(arrowIcon());

      row.append(chip, left, arrow);
      row.addEventListener("pointerenter", () => {
        this.activeIndex = index;
        this.syncActiveOption();
      });
      this.dropdown.appendChild(row);
    });

    this.syncActiveOption();
  }

  private renderMessage(message: string, loading: boolean): void {
    this.dropdown.replaceChildren();
    const row = document.createElement("div");
    row.className =
      this.options.tone === "light"
        ? "px-4 py-3 text-xs text-neutral-500 flex items-center gap-2"
        : "px-4 py-3 text-xs text-white/70 flex items-center gap-2";
    if (loading) {
      const dot = document.createElement("span");
      dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse";
      dot.setAttribute("aria-hidden", "true");
      row.appendChild(dot);
    }
    const text = document.createElement("span");
    text.textContent = message;
    row.appendChild(text);
    this.dropdown.appendChild(row);
    this.input.removeAttribute("aria-activedescendant");
  }

  private renderError(message: string): void {
    this.dropdown.replaceChildren();
    const row = document.createElement("div");
    row.className =
      this.options.tone === "light"
        ? "px-4 py-3 text-xs text-neutral-700 flex items-center justify-between gap-3"
        : "px-4 py-3 text-xs text-white/80 flex items-center justify-between gap-3";
    const text = document.createElement("span");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className =
      this.options.tone === "light"
        ? "min-h-11 px-3 rounded-full bg-black text-white text-[11px] font-semibold"
        : "min-h-11 px-3 rounded-full bg-white text-black text-[11px] font-semibold";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      const query = this.input.value.trim();
      if (query.length >= 2) void this.runSearch(query);
    });
    row.append(text, retry);
    this.dropdown.appendChild(row);
    this.open = true;
    this.dropdown.classList.remove("hidden");
    this.input.setAttribute("aria-expanded", "true");
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.open) {
      if (event.key === "ArrowDown") {
        this.options.onOpen?.();
        if (this.results.length === 0) this.handleInput();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.moveActive(-1);
        break;
      case "Enter": {
        const city = this.results[this.activeIndex] ?? this.results[0];
        if (city) {
          event.preventDefault();
          this.choose(city);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.close();
        break;
      case "Tab":
        this.close();
        break;
      default:
        break;
    }
  }

  private moveActive(delta: number): void {
    if (this.results.length === 0) return;
    this.activeIndex = (this.activeIndex + delta + this.results.length) % this.results.length;
    this.syncActiveOption();
    const active = qs<HTMLElement>(`#${cssEscape(this.listId)}-option-${this.activeIndex}`);
    active?.scrollIntoView({ block: "nearest" });
  }

  private syncActiveOption(): void {
    const rows = Array.from(this.dropdown.querySelectorAll<HTMLElement>("[role=option]"));
    rows.forEach((row, index) => {
      const active = index === this.activeIndex;
      row.setAttribute("aria-selected", active ? "true" : "false");
      const dark = this.options.tone !== "light";
      row.classList.toggle(dark ? "bg-white" : "bg-neutral-900", active);
      row.classList.toggle(dark ? "text-black" : "text-white", active);
      if (dark) row.classList.toggle("text-white", !active);
      else row.classList.toggle("text-neutral-800", !active);
    });
    const active = rows[this.activeIndex];
    if (active && active.id) {
      this.input.setAttribute("aria-activedescendant", active.id);
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  private handleDropdownClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row) return;
    const index = Number(row.dataset.index);
    const city = this.results[index];
    if (city) this.choose(city);
  }

  private choose(city: City): void {
    const appCity = toAppCity(city);
    this.close();
    this.input.value = cityQueryLabel(appCity);
    if (this.options.commitToApp !== false) {
      writeCityToUrl(appCity.slug, null);
      setCity(appCity);
      writeStoredCitySlug(appCity.slug);
      showToast(`Sky set to ${appCity.name}`);
    }
    this.options.onSelect?.(appCity);
  }

  close(): void {
    this.open = false;
    this.dropdown.classList.add("hidden");
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.dropdown.replaceChildren();
    this.results = [];
    this.activeIndex = -1;
    this.abort();
  }

  private abort(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}

function pinIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "w-4 h-4");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
  );
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "10");
  circle.setAttribute("r", "3");
  svg.append(path, circle);
  return svg;
}

function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "w-4 h-4");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "5");
  line.setAttribute("y1", "12");
  line.setAttribute("x2", "18");
  line.setAttribute("y2", "12");
  const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyline.setAttribute("points", "12 6 18 12 12 18");
  svg.append(line, polyline);
  return svg;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/**
 * Resolve a free-text suggestion through the API and apply it. Used by the
 * "Suggested" and "Popular skies" buttons, which must not carry hardcoded
 * coordinates.
 */
export async function selectCityFromQuery(query: string, destination: ScreenName | null = null): Promise<void> {
  try {
    const results = await searchCities(query);
    const city = results[0];
    if (!city) {
      showToast(`No sky found for “${query}”`);
      return;
    }
    const appCity = toAppCity(city);
    writeCityToUrl(appCity.slug, null);
    setCity(appCity);
    writeStoredCitySlug(appCity.slug);
    showToast(`Sky set to ${appCity.name}`);
    if (destination) {
      setScreen(destination);
    }
  } catch (error) {
    const apiError = error as ApiError;
    showToast(apiError.code === "network" ? "City search is offline" : "Could not switch city");
  }
}
