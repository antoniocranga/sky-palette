/**
 * Home: the live sky, its readout and the 24-hour scrubber.
 *
 * Every drag tick is computed locally with the shared solar + palette engines,
 * so the gradient follows the finger with no network. When the ruler settles we
 * refresh `/api/palette` for that instant to pick up real weather.
 */

import { ApiError, getPalette } from "../api";
import { isAbortError, qs, registerAction, setHidden, setText } from "../lib/dom";
import { formatElevation, formatPercent, instantForLocalHour, timeZoneAbbreviation, weatherSummary } from "../lib/format";
import { HOME_CONTROL_PALETTES, nextHomeToneAt, rulerTextColor, type HomeTone } from "../lib/contrast";
import { hexToRgb } from "../lib/color";
import { Tape, indexForHour } from "../lib/tape";
import { computePalette } from "../../shared/palette";
import { getSolarPosition, getSunTimes } from "../../shared/solar";
import { clockInZone, fractionalHourInZone, isoDayInZone, parseClock } from "../../shared/time";
import type { Palette, PaletteResponse } from "../../shared/types";
import { store, type AppCity } from "../state";

export class HomeFeature {
  private readonly screen: HTMLElement;
  private readonly hero = qs<HTMLElement>("#main-home");
  private readonly backdrop = qs<HTMLElement>("#sky-backdrop");
  private readonly tape: Tape;
  private readonly clock = qs("#bucharest-clock");
  private readonly cityLabel = qs("#home-city-label");
  private readonly liveDot = qs("#home-live-dot");
  private readonly phase = qs("#home-phase");
  private readonly elevation = qs("#home-elevation");
  private readonly azimuth = qs("#home-azimuth");
  private readonly sunrise = qs("#home-sunrise");
  private readonly sunset = qs("#home-sunset");
  private readonly clouds = qs("#home-clouds");
  private readonly errorBox = qs("#home-error");
  private readonly errorText = qs("#home-error-text");
  private readonly timeDisplay = qs("#ruler-time-display");

  private controller: AbortController | null = null;
  private palette: Palette | null = null;
  private weather: PaletteResponse["weather"] | null = null;
  private dayIso = "";
  private liveHour = 12;
  private currentHour = 12;
  private userScrubbed = false;
  private tone: HomeTone = "dark";
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFetchedKey = "";
  private hasLoaded = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.screen = qs<HTMLElement>("#screen-home") ?? document.body;
    this.dayIso = isoDayInZone(new Date(), store.state.city.timezone);
    this.liveHour = fractionalHourInZone(new Date(), store.state.city.timezone);
    this.currentHour = this.liveHour;

    this.tape = new Tape({
      viewport: qs<HTMLElement>("#ruler-viewport") ?? document.body,
      tape: qs<HTMLElement>("#ruler-tape") ?? document.body,
      initialIndex: indexForHour(this.liveHour),
      liveIndex: this.liveIndex(),
      maxIndex: this.liveIndex(),
      labelForIndex: (index) => formatHourIndex(index),
      onInput: (index, hour) => {
        this.currentHour = hour;
        this.userScrubbed = true;
        this.applyTime(hour, "scrub");
      },
      onSettle: (index, hour) => {
        this.currentHour = hour;
        this.scheduleFetch(hour);
      },
      onScrollingChange: (scrolling) => {
        this.timeDisplay?.classList.toggle("is-scrubbing", scrolling);
        if (scrolling && this.fetchTimer) {
          clearTimeout(this.fetchTimer);
          this.fetchTimer = null;
        }
      },
    });

    this.tape.setLiveIndex(this.liveIndex());
    this.tape.setMaxIndex(this.liveIndex());
    // Paint a synchronous clear-sky model before any network request: the
    // neutral #090b10 layer must never be the final home background.
    this.applyTime(this.currentHour, "model");
    this.paintLiveClock();
    this.clockTimer = setInterval(() => this.paintLiveClock(), 15_000);
    void this.clockTimer;

    registerAction("retry-home", () => {
      if (!this.hasLoaded) {
        void this.load();
      } else {
        this.scheduleFetch(this.currentHour, true);
      }
    });

    store.subscribeKey("screen", (screen) => {
      if (screen === "home") this.applyTime(this.currentHour, this.hasLoaded ? "scrub" : "model");
    });

    store.subscribeKey("city", (city) => {
      this.dayIso = isoDayInZone(new Date(), city.timezone);
      this.liveHour = fractionalHourInZone(new Date(), city.timezone);
      this.lastFetchedKey = "";
      this.userScrubbed = false;
      this.hasLoaded = false;
      setText(this.clock, "");
      this.weather = null;
      this.palette = null;
      this.currentHour = this.liveHour;
      this.tape.setIndex(indexForHour(this.liveHour), { silent: true });
      this.tape.setLiveIndex(this.liveIndex());
      this.tape.setMaxIndex(this.liveIndex());
      this.paintLiveClock();
      this.updateChrome(city);
      this.applyTime(this.liveHour, "model");
      void this.load();
    });

    this.updateChrome(store.state.city);
  }

  async start(): Promise<void> {
    await this.load();
  }

  /** Apply a shared `HH:MM` without ever passing the live bound. */
  /** Tap Home while already Home: spring the tape back to the live step. */
  returnToLive(): void {
    const target = this.liveIndex();
    if (this.tape.isSettledAt(target)) return;
    this.currentHour = target * 0.25;
    this.userScrubbed = false;
    this.tape.setIndex(target, { animate: true });
  }

  applyRouteTime(value: string | null): void {
    if (!value) return;
    const clock = parseClock(value);
    if (!clock) return;
    const requested = clock.hours + clock.minutes / 60;
    const maxHour = this.liveIndex() * 0.25;
    const hour = Math.max(0, Math.min(requested, maxHour));
    this.userScrubbed = true;
    this.currentHour = hour;
    this.tape.setIndex(indexForHour(hour), { silent: true });
    this.applyTime(hour, "scrub");
    this.scheduleFetch(hour, true);
  }

  private updateChrome(city: AppCity): void {
    setText(this.cityLabel, city.name);
    document.title = `${city.name} — Sky Palette`;
    this.paintLiveClock();
  }

  private liveIndex(): number {
    const quarter = Math.floor(fractionalHourInZone(new Date(), store.state.city.timezone) / 0.25);
    return Math.max(0, Math.min(96, quarter));
  }

  /** The header clock is always the city's wall clock, never the scrubber. */
  private paintLiveClock(): void {
    const city = store.state.city;
    const now = new Date();
    const clock = clockInZone(now, city.timezone);
    const abbreviation = timeZoneAbbreviation(city.timezone, now);
    setText(this.clock, abbreviation ? `${clock} ${abbreviation}` : clock);
    const live = this.liveIndex();
    this.tape.setLiveIndex(live);
    this.tape.setMaxIndex(live);
    if (this.hasLoaded) this.applyLiveBadge(this.currentHour);
  }

  /** One tone for the whole home cluster: location line, search and chips. */
  private applyControlTone(palette: Palette): void {
    const screenRect = this.screen.getBoundingClientRect();
    const anchor = qs<HTMLElement>("#screen-home .home-ink")?.getBoundingClientRect();
    const fraction =
      screenRect.height > 0 && anchor
        ? Math.min(1, Math.max(0, (anchor.top + anchor.height / 2 - screenRect.top) / screenRect.height))
        : 0.42;
    const tone = nextHomeToneAt(palette, fraction, this.tone);
    this.tone = tone;
    this.screen.dataset.tone = tone;
    const control = HOME_CONTROL_PALETTES[tone];
    const clusterInk = control.suggestInk;
    this.screen.style.setProperty("--home-ink-top", clusterInk);
    this.screen.style.setProperty("--home-ink-bottom", clusterInk);
    this.screen.style.setProperty("--home-suggest-ink", clusterInk);
    const zenith = hexToRgb(palette.zenith);
    const sunglow = hexToRgb(palette.sunglow);
    // Fade to the same colour at zero alpha: fading to `transparent` would
    // interpolate through transparent black and paint a grey band on bright skies.
    document.body.style.setProperty("--home-scrim-top", `rgba(${zenith.r}, ${zenith.g}, ${zenith.b}, 0.92)`);
    document.body.style.setProperty("--home-scrim-top-end", `rgba(${zenith.r}, ${zenith.g}, ${zenith.b}, 0)`);
    document.body.style.setProperty("--home-scrim-bottom", `rgba(${sunglow.r}, ${sunglow.g}, ${sunglow.b}, 0.92)`);
    document.body.style.setProperty("--home-scrim-bottom-end", `rgba(${sunglow.r}, ${sunglow.g}, ${sunglow.b}, 0)`);
    const style = this.screen.style;
    style.setProperty("--home-control-surface", control.surface);
    style.setProperty("--home-control-ink", control.surfaceInk);
    style.setProperty("--home-control-placeholder", control.placeholder);
    style.setProperty("--home-control-focus", control.focusRing);
    style.setProperty("--home-control-suggest", control.suggestInk);
    style.setProperty("--home-info-surface", control.infoSurface);
    style.setProperty("--home-info-ink", control.infoInk);
    style.setProperty("--home-mode-live", control.modeLive);
    style.setProperty("--home-mode-forecast", control.modeForecast);
    style.setProperty("--home-mode-border", control.modeBorder);
  }

  private applyLiveBadge(hour: number): void {
    const atLive =
      Math.floor(hour / 0.25) === this.liveIndex() &&
      isoDayInZone(new Date(), store.state.city.timezone) === this.dayIso;
    setHidden(this.liveDot, !atLive);
  }

  async load(): Promise<void> {
    const city = store.state.city;
    this.controller?.abort();
    this.controller = new AbortController();
    setHidden(this.errorBox, true);

    try {
      const response = await getPalette(
        { lat: city.lat, lon: city.lon, at: new Date(), timeZone: city.timezone },
        { signal: this.controller.signal },
      );
      this.weather = response.weather;
      this.palette = response.palette;
      this.dayIso = isoDayInZone(new Date(), city.timezone);
      this.liveHour = fractionalHourInZone(new Date(), city.timezone);
      this.lastFetchedKey = fetchKey(this.dayIso, indexForHour(this.liveHour));
      this.hasLoaded = true;
      this.tape.setLiveIndex(this.liveIndex());
      this.tape.setMaxIndex(this.liveIndex());
      this.paintLiveClock();

      if (!this.userScrubbed) {
        this.currentHour = this.liveHour;
        this.tape.setIndex(indexForHour(this.liveHour), { silent: true });
      }

      setHidden(this.errorBox, true);
      this.applyTime(this.currentHour, "server");
    } catch (error) {
      if (isAbortError(error) || (error instanceof ApiError && error.code === "aborted")) return;
      this.hasLoaded = true;
      this.paintLiveClock();
      this.showError(error instanceof ApiError ? error : new ApiError("The sky service could not answer."));
      this.applyTime(this.currentHour, "model");
    }
  }

  private scheduleFetch(hour: number, force = false): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    const key = fetchKey(this.dayIso, indexForHour(hour));
    if (!force && key === this.lastFetchedKey) {
      setHidden(this.errorBox, true);
      this.applyLiveBadge(hour);
      return;
    }
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      void this.fetchForHour(hour);
    }, 300);
  }

  private async fetchForHour(hour: number): Promise<void> {
    const city = store.state.city;
    const key = fetchKey(this.dayIso, indexForHour(hour));
    if (key === this.lastFetchedKey) return;

    this.controller?.abort();
    this.controller = new AbortController();

    try {
      const instant = instantForLocalHour(this.dayIso, hour, city.timezone);
      const response = await getPalette(
        { lat: city.lat, lon: city.lon, at: instant, timeZone: city.timezone },
        { signal: this.controller.signal },
      );
      if (fetchKey(this.dayIso, indexForHour(this.currentHour)) !== key) return;
      this.weather = response.weather;
      this.palette = response.palette;
      this.lastFetchedKey = key;
      this.hasLoaded = true;
      setHidden(this.errorBox, true);
      this.applyTime(hour, "server");
    } catch (error) {
      if (isAbortError(error) || (error instanceof ApiError && error.code === "aborted")) return;
      if (fetchKey(this.dayIso, indexForHour(this.currentHour)) !== key) return;
      this.showError(error instanceof ApiError ? error : new ApiError("The sky service could not answer."));
      this.applyTime(hour, "model");
    }
  }

  private applyTime(hour: number, source: "server" | "model" | "scrub"): void {
    const city = store.state.city;
    const instant = instantForLocalHour(this.dayIso, hour, city.timezone);
    const solar = getSolarPosition(city.lat, city.lon, instant);
    const palette =
      this.weather && this.palette
        ? computePalette({
            elevation: solar.elevation,
            cloudCoverLow: this.weather.cloudCoverLow,
            cloudCoverMid: this.weather.cloudCoverMid,
            cloudCoverHigh: this.weather.cloudCoverHigh,
            visibility: this.weather.visibility,
          })
        : computePalette({ elevation: solar.elevation });
    this.palette = palette;

    const gradient = `radial-gradient(ellipse 90% 40% at 50% 70%, ${palette.sunglow} 0%, transparent 65%), linear-gradient(180deg, ${palette.zenith} 0%, ${palette.midsky} 40%, ${palette.horizon} 72%, ${palette.sunglow} 100%)`;
    if (this.backdrop) this.backdrop.style.background = gradient;
    this.screen.style.setProperty("--sky-zenith", palette.zenith);
    this.screen.style.setProperty("--sky-midsky", palette.midsky);
    this.screen.style.setProperty("--sky-horizon", palette.horizon);
    this.screen.style.setProperty("--sky-sunglow", palette.sunglow);

    const clock = clockInZone(instant, city.timezone);
    setText(this.timeDisplay, clock);

    const rulerInk = rulerTextColor(palette);
    this.screen.style.setProperty("--ruler-ink", rulerInk);
    this.tape.setTone(rulerInk === "#FFFFFF" ? "dark" : "light");
    this.applyControlTone(palette);

    setText(this.phase, palette.phase);
    setText(this.elevation, formatElevation(solar.elevation));
    setText(this.azimuth, `${Math.round(solar.azimuth)}°`);

    const sunTimes = getSunTimes(city.lat, city.lon, instant);
    setText(this.sunrise, sunTimes.sunrise ? clockInZone(sunTimes.sunrise, city.timezone) : "—");
    setText(this.sunset, sunTimes.sunset ? clockInZone(sunTimes.sunset, city.timezone) : "—");
    setText(this.clouds, this.weather ? `${formatPercent(this.weather.cloudCoverLow)}/${formatPercent(this.weather.cloudCoverMid)}/${formatPercent(this.weather.cloudCoverHigh)}` : "model");

    this.applyLiveBadge(hour);
    if (this.hero) this.hero.dataset.skyReady = "true";

    store.set({
      share: {
        city,
        palette,
        dateIso: this.dayIso,
        timeLabel: clock,
        phase: palette.phase,
        elevation: solar.elevation,
        azimuth: solar.azimuth,
        cloudLabel: this.weather ? weatherSummary(this.weather) : "model",
        mode: Math.floor(hour / 0.25) === this.liveIndex() ? "live" : "forecast",
        sunsetLabel: sunTimes.sunset ? clockInZone(sunTimes.sunset, city.timezone) : "—",
      },
    });
  }

  private showError(error: ApiError): void {
    const message =
      error.code === "network"
        ? "Live weather is unreachable. Showing the clear-sky model; values update when the connection returns."
        : error.code === "timeout"
          ? "The sky service took too long. Showing the clear-sky model."
          : "Live weather could not be loaded. Showing the clear-sky model.";
    setText(this.errorText, message);
    setHidden(this.errorBox, false);
  }
}

function formatHourIndex(index: number): string {
  const total = Math.max(0, Math.min(96, Math.round(index)));
  if (total === 96) return "24:00";
  const hours = Math.floor(total / 4);
  const minutes = (total % 4) * 15;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function fetchKey(dayIso: string, index: number): string {
  return `${dayIso}:${index}`;
}

// Exported for unit tests.
export { fetchKey, formatHourIndex };
