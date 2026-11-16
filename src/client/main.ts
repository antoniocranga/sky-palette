import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/playfair-display/latin-600-italic.css";
import "./styles.css";
import "./modal-scrim.css";

import { getCityBySlug, getConfig, searchCities, type AppConfig } from "./api";
import { applyToastTone, bindGlobalActions, qs, registerAction } from "./lib/dom";
import { refreshThemeColor } from "./lib/theme";
import { ModalController } from "./lib/dom";
import { HomeFeature } from "./features/home";
import { GalleryFeature } from "./features/gallery";
import { DetailFeature } from "./features/detail";
import { SubmitFeature } from "./features/submit";
import { ShareFeature } from "./features/share";
import { InfoFeature } from "./features/info";
import { PhotoModal } from "./features/photo-modal";
import { CitySearch, selectCityFromQuery } from "./features/search";
import {
  DEFAULT_CITY,
  preferredCitySlug,
  readStoredCitySlug,
  setCity,
  setScreen,
  store,
  toAppCity,
  type AppCity,
  type ScreenName,
} from "./state";
import { DEFAULT_INTERVAL, parseRoute, serializeRoute, type AppRoute, type RouteInterval } from "./lib/route";
import { parseClock } from "../shared/time";

const SCREEN_IDS: Record<ScreenName, string> = {
  home: "screen-home",
  gallery: "screen-gallery",
  detail: "screen-detail",
};

let galleryModal: ModalController | null = null;
let gallerySearch: CitySearch | null = null;
let hydrating = true;
let replaceTimer: ReturnType<typeof setTimeout> | null = null;

export async function bootstrap(): Promise<void> {
  bindGlobalActions();
  installErrorBoundary();

  const route = parseRoute(window.location.search);
  // Paint the static home shell before any network work. Data-backed text is
  // gated separately, and deep links to gallery/detail stay gated until their
  // data is ready so they never flash the wrong screen.
  const shellIsHome = route.view !== "detail" && route.view !== "gallery";
  if (shellIsHome) document.body.removeAttribute("data-booting");

  const initialCity = await resolveInitialCity();
  store.set({ city: initialCity });

  const home = new HomeFeature();
  const gallery = new GalleryFeature(route.interval ?? DEFAULT_INTERVAL);
  const detail = new DetailFeature();
  new SubmitFeature();
  new ShareFeature();
  new InfoFeature();
  const photoModal = new PhotoModal();

  const galleryModalRoot = qs<HTMLElement>("#gallery-search-modal");
  if (galleryModalRoot) {
    galleryModal = new ModalController(galleryModalRoot, { initialFocus: "#modal-city-search-input" });
    gallerySearch = new CitySearch({
      input: qs<HTMLInputElement>("#modal-city-search-input") ?? document.createElement("input"),
      dropdown: qs<HTMLElement>("#modal-city-dropdown") ?? document.createElement("div"),
      tone: "light",
      onSelect: () => {
        galleryModal?.hide();
      },
    });
  }

  new CitySearch({
    input: qs<HTMLInputElement>("#city-search-input") ?? document.createElement("input"),
    dropdown: qs<HTMLElement>("#city-dropdown") ?? document.createElement("div"),
    onSelect: () => {
      setScreen("home");
    },
  });

  const goGallery = (): void => {
    if (store.state.screen === "detail") {
      detail.backToGallery();
      return;
    }
    if (store.state.screen === "gallery") return;
    // Entering the gallery from Home always restores the default interval.
    if (store.state.daysRequested !== DEFAULT_INTERVAL) void gallery.useInterval(DEFAULT_INTERVAL);
    setScreen("gallery");
  };

  registerAction("nav", (element) => {
    const target = element.dataset.screen;
    if (target === "gallery") {
      goGallery();
      return;
    }
    if (target === "home") {
      if (store.state.screen === "home") home.returnToLive();
      else setScreen("home");
    } else if (target === "detail") {
      setScreen("detail");
    }
  });

  registerAction("gallery", goGallery);

  registerAction("open-gallery-search", (element) => {
    gallerySearch?.reset();
    galleryModal?.show(element);
    requestAnimationFrame(() => gallerySearch?.focus());
  });

  registerAction("close-gallery-search", () => {
    gallerySearch?.close();
    galleryModal?.hide();
  });

  registerAction("pick-city", (element) => {
    const query = element.dataset.query;
    if (!query) return;
    galleryModal?.hide();
    void selectCityFromQuery(query, "gallery");
  });

  registerAction("suggest-city", (element) => {
    const query = element.dataset.query;
    if (!query) return;
    void selectCityFromQuery(query, null);
  });

  store.subscribeKey("screen", () => applyScreen());
  applyScreen();
  refreshThemeColor();
  // The toast pill inverts with the surface behind it; watch screen, modal and
  // home-tone class/attribute changes instead of duplicating that state here.
  new MutationObserver(() => {
    applyToastTone();
    refreshThemeColor();
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-tone"],
    subtree: true,
  });

  // Load the config in parallel; the page renders with defaults if it fails.
  void loadConfig();

  // Start both data loads, but never let /api/palette hold the home shell.
  const dataReady = Promise.allSettled([gallery.start(), home.start()]);
  await dataReady;
  await applyParsedRoute(route, home, gallery, detail);
  document.body.removeAttribute("data-booting");
  hydrating = false;

  installRouteSync();
  // Canonicalise the entry URL before any navigation so Back always returns
  // to an explicit `view=home|gallery|detail`, not the bare document URL.
  writeRoute("replace");
  window.addEventListener("popstate", () => {
    void applyHistoryRoute(home, gallery, detail);
    void photoModal.syncFromUrl();
  });
  void photoModal.syncFromUrl();
}

async function loadConfig(): Promise<AppConfig | null> {
  try {
    const config = await getConfig({ retry: () => void loadConfig() });
    store.set({ config });
    return config;
  } catch {
    store.set({ config: null });
    return null;
  }
}

async function resolveCityBySlug(slug: string): Promise<AppCity | null> {
  if (slug === DEFAULT_CITY.slug || slug === "bucharest") return DEFAULT_CITY;

  // Exact D1 lookup first: "tokyo-japan" must not be sent to the geocoder as
  // "tokyo japan", which returns nothing and used to fall back to Bucharest.
  try {
    const exact = await getCityBySlug(slug);
    if (exact) return toAppCity(exact);
  } catch {
    // endpoint unavailable: the word search below is the compatibility path
  }

  const words = decodeURIComponent(slug).replace(/-/g, " ");
  try {
    const results = await searchCities(words);
    const exact = results.find((city) => city.slug === slug);
    return exact ? toAppCity(exact) : null;
  } catch {
    return null;
  }
}

async function resolveInitialCity(): Promise<AppCity> {
  // URL wins over the stored preference; the preference wins over the default.
  // Hydration never writes the preference: only a deliberate pick persists.
  const slug = preferredCitySlug(window.location.search, readStoredCitySlug());
  if (!slug) return DEFAULT_CITY;
  return (await resolveCityBySlug(slug)) ?? DEFAULT_CITY;
}

/** Apply a parsed route in one pass, for boot and popstate. */
async function applyParsedRoute(
  route: AppRoute,
  home: HomeFeature,
  gallery: GalleryFeature,
  detail: DetailFeature,
): Promise<void> {
  const interval: RouteInterval = route.interval ?? DEFAULT_INTERVAL;

  if (route.city && route.city !== store.state.city.slug) {
    const city = await resolveCityBySlug(route.city);
    if (city) {
      setCity(city);
      await Promise.allSettled([home.load()]);
    }
  }

  if (interval !== store.state.daysRequested) {
    await gallery.useInterval(interval);
  }

  const view = route.view;
  if (view === "detail") {
    const days = store.state.days;
    if (days.length === 0) {
      setScreen("home");
      return;
    }
    const index = route.day ? days.findIndex((day) => day.date === route.day) : 0;
    const resolvedIndex = index >= 0 ? index : 0;
    const clock = route.time ? parseClock(route.time) : null;
    const hour = clock ? clock.hours + clock.minutes / 60 : null;
    detail.open(resolvedIndex, undefined, { hour });
    return;
  }

  if (view === "gallery") {
    setScreen("gallery");
    return;
  }

  setScreen("home");
  if (route.time) home.applyRouteTime(route.time);
}

function currentRoute(): AppRoute {
  const state = store.state;
  const view = state.screen;
  const city = state.city.slug;
  const interval = (state.daysRequested || DEFAULT_INTERVAL) as RouteInterval;

  // `view` is always explicit, and each screen serializes only its own state:
  // Home keeps neither scrub time nor interval, Gallery keeps only interval,
  // Detail keeps day + time + interval. Leaving a screen therefore deletes
  // its parameters instead of leaving stale deep-link state behind.
  if (view === "detail") {
    return {
      city,
      view,
      day: state.share?.dateIso ?? null,
      time: state.share?.timeLabel ?? null,
      interval,
    };
  }
  if (view === "gallery") {
    return { city, view, day: null, time: null, interval };
  }
  return { city, view, day: null, time: null, interval: null };
}

function writeRoute(mode: "push" | "replace"): void {
  if (hydrating) return;
  const path = serializeRoute(currentRoute());
  const photo = new URL(window.location.href).searchParams.get("photo");
  const target = photo ? `${path}${path.includes("?") ? "&" : "?"}photo=${encodeURIComponent(photo)}` : path;
  if (`${window.location.pathname}${window.location.search}` === target) return;
  if (mode === "push") window.history.pushState({}, "", target);
  else window.history.replaceState({}, "", target);
}

function scheduleReplace(): void {
  if (hydrating) return;
  if (replaceTimer) clearTimeout(replaceTimer);
  replaceTimer = setTimeout(() => {
    replaceTimer = null;
    writeRoute("replace");
  }, 300);
}

function installRouteSync(): void {
  store.subscribe((state, previous) => {
    if (hydrating) return;
    if (state.screen !== previous.screen) {
      if (replaceTimer) {
        clearTimeout(replaceTimer);
        replaceTimer = null;
      }
      writeRoute("push");
      return;
    }
    if (state.city !== previous.city || state.daysRequested !== previous.daysRequested || state.share !== previous.share) {
      scheduleReplace();
    }
  });
}

async function applyHistoryRoute(home: HomeFeature, gallery: GalleryFeature, detail: DetailFeature): Promise<void> {
  const route = parseRoute(window.location.search);
  hydrating = true;
  if (replaceTimer) {
    clearTimeout(replaceTimer);
    replaceTimer = null;
  }
  try {
    await applyParsedRoute(route, home, gallery, detail);
  } finally {
    hydrating = false;
  }
}

function applyScreen(): void {
  const screen = store.state.screen;
  for (const [name, id] of Object.entries(SCREEN_IDS) as [ScreenName, string][]) {
    const element = qs<HTMLElement>(`#${id}`);
    if (!element) continue;
    const active = name === screen;
    element.classList.toggle("active", active);
    element.setAttribute("aria-hidden", active ? "false" : "true");
    element.inert = !active;
  }
  document.body.dataset.screen = screen;

  const backdrop = qs<HTMLElement>("#sky-backdrop");
  if (backdrop) {
    if (screen === "detail") backdrop.style.background = "#FFFFFF";
    else if (screen === "gallery") backdrop.style.background = "#090B10";
    // Home owns its painted palette: leaving it alone here avoids overwriting
    // the gradient that HomeFeature wrote for this same navigation.
  }

  const homeButton = qs("#nav-btn-home");
  const galleryButton = qs("#nav-btn-gallery");
  setDockState(homeButton, screen === "home");
  setDockState(galleryButton, screen === "gallery" || screen === "detail");

  const detailScreen = qs<HTMLElement>("#screen-detail");
  if (screen === "detail") detailScreen?.scrollTo({ top: 0 });

  const active = document.activeElement;
  const activeScreen = active instanceof Element ? active.closest(".app-screen") : null;
  if (activeScreen && activeScreen !== qs("#screen-" + screen)) {
    const focusTarget =
      screen === "home"
        ? qs<HTMLElement>("#city-search-input")
        : screen === "gallery"
          ? qs<HTMLElement>("#interval-trigger-btn")
          : qs<HTMLElement>('#screen-detail [data-action="nav"][data-screen="gallery"]');
    focusTarget?.focus({ preventScroll: true });
  }
}

function setDockState(button: Element | null, active: boolean): void {
  if (!button) return;
  button.classList.toggle("bg-white", active);
  button.classList.toggle("text-black", active);
  button.classList.toggle("font-semibold", active);
  button.classList.toggle("shadow-md", active);
  button.classList.toggle("text-white/70", !active);
  button.classList.toggle("hover:text-white", !active);
  button.classList.toggle("hover:bg-white/10", !active);
  if (active) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
}

function installErrorBoundary(): void {
  window.addEventListener("error", (event) => {
    event.preventDefault();
    console.warn("[Sky Palette] A client exception was contained.");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    console.warn("[Sky Palette] An async operation was contained.");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
} else {
  void bootstrap();
}

export { SCREEN_IDS, applyScreen };
