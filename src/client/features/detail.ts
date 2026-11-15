/**
 * Day detail: a real scrubber for a chosen history day, its five swatches,
 * sun metrics and nearby community photos.
 *
 * The historical sunset palette comes from /api/history. On open we also ask
 * /api/palette for that instant to obtain weather, then every scrub tick is
 * computed locally from shared solar + palette code.
 */

import { ApiError, getGalleryPage, getPalette } from "../api";
import { openPhotoModal } from "./photo-modal";
import { copyText, isAbortError, prefersReducedMotion, qs, registerAction, setHidden, setText, showToast } from "../lib/dom";
import { formatDateShort, formatDegrees, formatElevation, formatInstantClock, instantForLocalHour, weatherSummary } from "../lib/format";
import { STEPS_PER_DAY, STEP_HOURS, Tape, indexForHour } from "../lib/tape";
import { computePalette } from "../../shared/palette";
import { getSolarPosition, getSunTimes } from "../../shared/solar";
import { clockInZone, fractionalHourInZone, isoDayInZone, parseClock } from "../../shared/time";
import type { DayPalette, GalleryPhoto, Palette, PaletteResponse } from "../../shared/types";
import { SWATCH_LABELS } from "../../shared/types";
import { setScreen, store } from "../state";

const SWATCH_IDS = {
  zenith: "zenith-hex",
  midsky: "midsky-hex",
  horizon: "horizon-hex",
  sunglow: "sunglow-hex",
  cloudtint: "cloudtint-hex",
} as const;

export class DetailFeature {
  private readonly title = qs("#detail-title");
  private readonly sky = qs<HTMLElement>("#sky-renderer");
  private readonly sun = qs<HTMLElement>("#sun-orb");
  private readonly hudTime = qs("#hud-time");
  private readonly hudPhase = qs("#hud-phase-pill");
  private readonly hudMetrics = qs("#hud-solar-metrics");
  private readonly timeDisplay = qs("#detail-ruler-time-display");
  private readonly liveBadge = qs("#detail-live-badge");
  private readonly sunriseLabel = qs("#detail-sunrise");
  private readonly goldenLabel = qs("#detail-golden");
  private readonly sunsetLabel = qs("#detail-sunset");
  private readonly note = qs("#detail-note");
  private readonly photosSection = qs("#detail-photos-section");
  private readonly photosGrid = qs("#detail-photos");
  private readonly photosEmpty = qs("#detail-photos-empty");
  private readonly photosEmptyTitle = qs("#detail-photos-empty-title");
  private readonly photosEmptyNote = qs("#detail-photos-empty-note");
  private readonly photosSentinel = qs("#detail-photos-sentinel");
  private readonly photosSkeleton = qs("#detail-photos-skeleton");
  private readonly scrollTopButton = qs<HTMLButtonElement>("#detail-scroll-top");
  private readonly timelapseButton = qs<HTMLButtonElement>("#timelapse-btn");
  private readonly playIcon = qs("#play-icon");
  private readonly pauseIcon = qs("#pause-icon");
  private readonly tape: Tape;

  private day: DayPalette | null = null;
  private weather: PaletteResponse["weather"] | null = null;
  private sunTimes: PaletteResponse["sunTimes"] | null = null;
  private photos: GalleryPhoto[] = [];
  private controller: AbortController | null = null;
  private galleryController: AbortController | null = null;
  private photoCursor: string | null = null;
  private photosLoading = false;
  private photosError = false;
  private photoChainFrame: number | null = null;
  private galleryGeneration = 0;
  private photoObserver: IntersectionObserver | null = null;
  private scrollTopFrame: number | null = null;
  private currentHour = 16.85;
  private timelapseFrame: number | null = null;
  private playing = false;
  private liveIndexValue: number | null = null;
  private liveTicker: ReturnType<typeof setInterval> | null = null;
  private sourceRect: DOMRect | null = null;
  private flipToken = 0;
  private flipTimers: number[] = [];
  private flipElements: HTMLElement[] = [];

  constructor() {
    this.tape = new Tape({
      viewport: qs<HTMLElement>("#detail-ruler-viewport") ?? document.body,
      tape: qs<HTMLElement>("#detail-ruler-tape") ?? document.body,
      initialIndex: indexForHour(16.85),
      liveDotId: "detail-ruler-live-dot",
      labelForIndex: (index) => formatIndex(index),
      onInput: (_index, hour) => {
        this.currentHour = hour;
        this.applyTime(hour);
      },
      onScrollingChange: (scrolling) => {
        this.timeDisplay?.classList.toggle("is-scrubbing", scrolling);
        if (scrolling) this.stopTimelapse();
      },
    });
    this.tape.setInk("#0B0D12", "rgba(11, 13, 18, 0.22)");
    const detailScreen = qs<HTMLElement>("#screen-detail");
    detailScreen?.addEventListener("scroll", () => this.updateScrollTopButton(), { passive: true });
    this.scrollTopButton?.addEventListener("click", () => this.scrollToTop());
    store.subscribeKey("screen", (screen) => {
      if (screen !== "detail") setHidden(this.scrollTopButton, true);
      else this.updateScrollTopButton();
    });
    if (this.photosSentinel && "IntersectionObserver" in window) {
      this.photoObserver = new IntersectionObserver(
        (entries) => { if (entries.some((entry) => entry.isIntersecting)) void this.loadMorePhotos(); },
        { root: qs("#screen-detail"), rootMargin: "0px 0px 200px 0px" },
      );
      this.photoObserver.observe(this.photosSentinel);
    }

    registerAction("open-day", (element) => {
      const index = Number(element.dataset.index);
      if (Number.isFinite(index)) this.open(index, element);
    });

    registerAction("timelapse", () => this.toggleTimelapse());

    registerAction("detail-jump", (element) => {
      const kind = element.dataset.kind;
      this.jumpTo(kind === "sunrise" ? "sunrise" : kind === "golden" ? "golden" : "sunset");
    });

    registerAction("copy-hex", (element) => {
      const targetId = element.dataset.target;
      if (!targetId) return;
      const value = qs(targetId.startsWith("#") ? targetId : `#${targetId}`)?.textContent?.trim();
      if (!value || value === "—") return;
      void copyText(value).then((ok) => showToast(ok ? `Copied ${value}` : "Could not copy"));
    });

    store.subscribeKey("screen", (screen) => {
      if (screen !== "detail") {
        this.stopTimelapse();
        this.stopLiveTicker();
        this.stopGalleryLoads();
      }
    });
  }

  private updateScrollTopButton(): void {
    const screen = qs<HTMLElement>("#screen-detail");
    const visible = store.state.screen === "detail" && (screen?.scrollTop ?? 0) > 400;
    setHidden(this.scrollTopButton, !visible);
  }

  private scrollToTop(): void {
    const screen = qs<HTMLElement>("#screen-detail");
    if (!screen) return;
    if (prefersReducedMotion()) {
      screen.scrollTop = 0;
      this.updateScrollTopButton();
      return;
    }
    if (this.scrollTopFrame !== null) cancelAnimationFrame(this.scrollTopFrame);
    const start = screen.scrollTop;
    const started = performance.now();
    const duration = 450;
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      screen.scrollTop = start * (1 - eased);
      if (t < 1) this.scrollTopFrame = requestAnimationFrame(step);
      else {
        this.scrollTopFrame = null;
        screen.scrollTop = 0;
        this.updateScrollTopButton();
      }
    };
    this.scrollTopFrame = requestAnimationFrame(step);
  }

  open(index: number, source?: HTMLElement, options: { hour?: number | null } = {}): void {
    const day = store.state.days[index];
    if (!day) {
      showToast("That sky day is no longer available");
      setScreen("gallery");
      return;
    }

    this.day = day;
    this.weather = null;
    this.sunTimes = null;
    this.syncLiveBound();
    this.startLiveTicker();
    this.photos = [];
    setHidden(this.photosSection, false);
    setHidden(this.photosEmpty, true);
    this.photosGrid?.replaceChildren();
    const sourceRect = source?.getBoundingClientRect() ?? null;
    this.cancelFlip();
    this.sourceRect = sourceRect;
    this.stopTimelapse();
    this.controller?.abort();
    this.galleryController?.abort();

    const city = store.state.city;
    setText(this.title, `${formatDateShort(day.date)} · ${city.name}`);
    setHidden(this.note, true);

    const sunset = day.sunset ? parseClock(day.sunset) : null;
    const requestedHour = options.hour;
    const requested =
      typeof requestedHour === "number" && Number.isFinite(requestedHour)
        ? Math.max(0, Math.min(24, requestedHour))
        : sunset
          ? sunset.hours + sunset.minutes / 60
          : 12;
    const hour = Math.min(requested, this.maxHour());
    this.currentHour = hour;
    this.tape.setIndex(indexForHour(hour), { silent: true });
    this.paintDay(day, hour);

    setScreen("detail");
    document.querySelector<HTMLElement>("#screen-detail")?.scrollTo({ top: 0 });
    if (sourceRect) this.playFlip(sourceRect, day);

    void this.loadPalette(hour);
    void this.loadPhotos();
  }

  /**
   * Phase A: the tapped tile scales from its exact rect to fill the screen
   * above a permanently mounted dark scrim. Phase B: the detail fades in while
   * the clone fades out. Both phases use transform/opacity only.
   */
  private playFlip(source: DOMRect, day: DayPalette): void {
    if (prefersReducedMotion()) return;
    const detailScreen = qs<HTMLElement>("#screen-detail");
    if (detailScreen) {
      detailScreen.style.transition = "none";
      detailScreen.style.opacity = "0";
    }

    const token = this.flipToken;
    const scrim = document.createElement("div");
    scrim.className = "detail-flip-scrim";
    scrim.setAttribute("aria-hidden", "true");
    scrim.style.position = "fixed";
    scrim.style.inset = "0";
    scrim.style.zIndex = "44";
    scrim.style.pointerEvents = "none";
    scrim.style.background = "rgba(5, 7, 15, 0)";
    scrim.style.transition = "background 0.22s ease";

    const clone = document.createElement("div");
    clone.className = "detail-flip";
    clone.setAttribute("aria-hidden", "true");
    clone.style.position = "fixed";
    clone.style.left = `${source.left}px`;
    clone.style.top = `${source.top}px`;
    clone.style.width = `${source.width}px`;
    clone.style.height = `${source.height}px`;
    clone.style.zIndex = "46";
    clone.style.pointerEvents = "none";
    clone.style.transformOrigin = "center center";
    clone.style.transform = "none";
    clone.style.borderRadius = "0px";
    clone.style.background = `linear-gradient(90deg, ${day.colors[0]} 0 20%, ${day.colors[1]} 20% 40%, ${day.colors[2]} 40% 60%, ${day.colors[3]} 60% 80%, ${day.colors[4]} 80% 100%)`;
    clone.style.transition =
      "transform 0.22s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease, border-radius 0.22s ease";

    document.body.append(scrim, clone);
    this.flipElements = [scrim, clone];
    this.after(0, () => {
      if (token !== this.flipToken) return;
      scrim.style.background = "rgba(5, 7, 15, 0.82)";
      const scaleX = window.innerWidth / Math.max(1, source.width);
      const scaleY = window.innerHeight / Math.max(1, source.height);
      clone.style.transform = `scale(${scaleX}, ${scaleY})`;
      clone.style.borderRadius = "0px";
    });

    this.after(220, () => {
      if (token !== this.flipToken) return;
      const detail = qs<HTMLElement>("#screen-detail");
      if (detail) {
        detail.style.transition = "opacity 0.18s ease";
        detail.style.opacity = "1";
      }
      clone.style.opacity = "0";
      scrim.style.background = "rgba(5, 7, 15, 0)";
    });

    this.after(430, () => {
      if (token !== this.flipToken) return;
      this.clearFlipVisuals();
    });
  }

  /** Reverse: detail fades out, the clone shrinks into the original tile. */
  backToGallery(): void {
    this.stopGalleryLoads();
    if (prefersReducedMotion()) {
      this.cancelFlip();
      this.stopTimelapse();
      setScreen("gallery");
      return;
    }
    const source = this.sourceRect;
    this.cancelFlip();
    this.stopTimelapse();
    if (!source) {
      setScreen("gallery");
      return;
    }

    const token = this.flipToken;
    const detail = qs<HTMLElement>("#screen-detail");
    const clone = document.createElement("div");
    clone.className = "detail-flip";
    clone.setAttribute("aria-hidden", "true");
    clone.style.position = "fixed";
    clone.style.inset = "0";
    clone.style.zIndex = "46";
    clone.style.pointerEvents = "none";
    clone.style.transformOrigin = "center center";
    clone.style.transform = "none";
    clone.style.borderRadius = "0px";
    clone.style.background =
      qs<HTMLElement>("#sky-renderer")?.style.background ||
      `linear-gradient(90deg, ${this.day?.colors[0] ?? "#090B10"} 0 20%, ${this.day?.colors[1] ?? "#0B0F18"} 20% 40%, ${this.day?.colors[2] ?? "#111726"} 40% 60%, ${this.day?.colors[3] ?? "#1A2233"} 60% 80%, ${this.day?.colors[4] ?? "#1B2334"} 80% 100%)`;
    clone.style.transition =
      "transform 0.22s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease";
    document.body.appendChild(clone);
    this.flipElements = [clone];

    if (detail) {
      detail.style.transition = "opacity 0.14s ease";
      detail.style.opacity = "0";
    }
    setScreen("gallery");

    const scaleX = Math.max(1, source.width) / Math.max(1, window.innerWidth);
    const scaleY = Math.max(1, source.height) / Math.max(1, window.innerHeight);
    const dx = source.left + source.width / 2 - window.innerWidth / 2;
    const dy = source.top + source.height / 2 - window.innerHeight / 2;
    this.after(0, () => {
      if (token !== this.flipToken) return;
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
      clone.style.opacity = "0";
    });
    this.after(330, () => {
      if (token !== this.flipToken) return;
      this.clearFlipVisuals();
    });
  }

  private after(delay: number, callback: () => void): void {
    const timer = window.setTimeout(callback, delay);
    this.flipTimers.push(timer);
  }

  private clearFlipVisuals(): void {
    for (const element of this.flipElements) element.remove();
    this.flipElements = [];
    for (const timer of this.flipTimers) clearTimeout(timer);
    this.flipTimers = [];
    const detail = qs<HTMLElement>("#screen-detail");
    if (detail) {
      detail.style.transition = "";
      detail.style.opacity = "";
    }
  }

  private cancelFlip(): void {
    this.flipToken += 1;
    for (const element of this.flipElements) element.remove();
    this.flipElements = [];
    for (const timer of this.flipTimers) clearTimeout(timer);
    this.flipTimers = [];
    const detail = qs<HTMLElement>("#screen-detail");
    if (detail) {
      detail.style.transition = "";
      detail.style.opacity = "";
    }
  }

  private paintDay(day: DayPalette, hour: number): void {
    const city = store.state.city;
    const instant = instantForLocalHour(day.date, hour, city.timezone);
    const solar = getSolarPosition(city.lat, city.lon, instant);
    setText(this.hudTime, clockInZone(instant, city.timezone));
    setText(this.hudPhase, day.phase);
    setText(this.hudMetrics, `Sun elevation: ${formatElevation(solar.elevation)} · Azimuth: ${formatDegrees(solar.azimuth)}`);
    setText(this.timeDisplay, clockInZone(instant, city.timezone));
    this.paintSwatches(day.colors[0], day.colors[1], day.colors[2], day.colors[3], day.colors[4]);
    this.paintSky(day.colors[0], day.colors[1], day.colors[2], day.colors[3], solar.azimuth, solar.elevation);
    this.updateLiveBadge();

    // Seed the share/route snapshot synchronously so the URL is correct before
    // the weather request resolves (and remains correct if it fails).
    const palette = computePalette({ elevation: solar.elevation });
    store.set({
      share: {
        city,
        palette,
        dateIso: day.date,
        timeLabel: clockInZone(instant, city.timezone),
        phase: palette.phase,
        elevation: solar.elevation,
        azimuth: solar.azimuth,
        cloudLabel: "model",
        mode: "forecast",
        sunsetLabel: day.sunset ?? "—",
      },
    });
  }

  private applyTime(hour: number): void {
    if (!this.day) return;
    const city = store.state.city;
    const instant = instantForLocalHour(this.day.date, hour, city.timezone);
    const solar = getSolarPosition(city.lat, city.lon, instant);
    const palette = computePalette({
      elevation: solar.elevation,
      ...(this.weather
        ? {
            cloudCoverLow: this.weather.cloudCoverLow,
            cloudCoverMid: this.weather.cloudCoverMid,
            cloudCoverHigh: this.weather.cloudCoverHigh,
            visibility: this.weather.visibility,
          }
        : {}),
    });
    const time = clockInZone(instant, city.timezone);

    setText(this.hudTime, time);
    setText(this.hudPhase, palette.phase);
    setText(this.hudMetrics, `Sun elevation: ${formatElevation(solar.elevation)} · Azimuth: ${formatDegrees(solar.azimuth)}`);
    setText(this.timeDisplay, time);
    this.paintSwatches(palette.zenith, palette.midsky, palette.horizon, palette.sunglow, palette.cloudtint);
    this.paintSky(palette.zenith, palette.midsky, palette.horizon, palette.sunglow, solar.azimuth, solar.elevation);
    this.updateLiveBadge();

    const sunTimes = this.sunTimes ?? toSunTimes(getSunTimes(city.lat, city.lon, instant));
    this.paintSunTimes(sunTimes);
    store.set({
      share: {
        city,
        palette,
        dateIso: this.day.date,
        timeLabel: time,
        phase: palette.phase,
        elevation: solar.elevation,
        azimuth: solar.azimuth,
        cloudLabel: this.weather ? weatherSummary(this.weather) : "model",
        mode: "forecast",
        sunsetLabel: sunTimes.sunset ? formatInstantClock(sunTimes.sunset, city.timezone) : "—",
      },
    });
  }

  private paintSunTimes(times: PaletteResponse["sunTimes"]): void {
    const timeZone = store.state.city.timezone;
    setText(this.sunriseLabel, formatInstantClock(times.sunrise, timeZone));
    setText(this.goldenLabel, formatInstantClock(times.goldenHourStart, timeZone));
    setText(this.sunsetLabel, formatInstantClock(times.sunset, timeZone));
  }

  private paintSwatches(
    zenith: string,
    midsky: string,
    horizon: string,
    sunglow: string,
    cloudtint: string,
  ): void {
    const values = { zenith, midsky, horizon, sunglow, cloudtint } as const;
    for (const name of SWATCH_LABELS) {
      const swatch = qs<HTMLElement>(`#swatch-${name}`);
      if (swatch) swatch.style.backgroundColor = values[name];
      setText(qs(`#${SWATCH_IDS[name]}`), values[name].toUpperCase());
    }
  }

  private paintSky(
    zenith: string,
    midsky: string,
    horizon: string,
    sunglow: string,
    azimuth: number,
    elevation: number,
  ): void {
    if (this.sky) {
      this.sky.style.background = `radial-gradient(ellipse 70% 45% at 50% 78%, ${sunglow} 0%, transparent 70%), linear-gradient(180deg, ${zenith} 0%, ${midsky} 48%, ${horizon} 100%)`;
    }
    if (this.sun) {
      const x = 12 + ((azimuth % 360) / 360) * 76;
      const y = 82 - Math.max(0, Math.min(90, elevation)) * 0.72;
      this.sun.style.left = `${x}%`;
      this.sun.style.top = `${y}%`;
      this.sun.style.background = sunglow;
      this.sun.style.opacity = elevation > -8 ? "0.4" : "0";
    }
  }

  private async loadPalette(hour: number): Promise<void> {
    if (!this.day) return;
    const city = store.state.city;
    const day = this.day;
    this.controller = new AbortController();
    try {
      const at = instantForLocalHour(day.date, hour, city.timezone);
      const response = await getPalette(
        { lat: city.lat, lon: city.lon, at, timeZone: city.timezone },
        { signal: this.controller.signal, retry: () => void this.loadPalette(this.currentHour) },
      );
      if (this.day !== day) return;
      this.weather = response.weather;
      this.sunTimes = response.sunTimes;
      this.updateJumpState();
      setHidden(this.note, true);
      this.applyTime(this.currentHour);
    } catch (error) {
      if (isAbortError(error) || (error instanceof ApiError && error.code === "aborted")) return;
      if (this.day !== day) return;
      const message =
        error instanceof ApiError && error.code === "network"
          ? "Live weather unavailable — showing the history palette. Scrubbing uses the clear-sky model."
          : "Weather for this instant is unavailable — showing the history palette.";
      setText(this.note, message);
      setHidden(this.note, false);
    }
  }

  private async loadPhotos(): Promise<void> {
    const city = store.state.city;
    const generation = ++this.galleryGeneration;
    this.cancelPhotoChain();
    this.photosError = false;
    this.photosLoading = false;
    if (this.photosSkeleton) setHidden(this.photosSkeleton, false);
    if (this.photosGrid) setHidden(this.photosGrid, true);
    if (this.photosEmpty) setHidden(this.photosEmpty, true);
    if (this.photosSentinel) setHidden(this.photosSentinel, true);
    this.galleryController?.abort();
    const controller = new AbortController();
    this.galleryController = controller;
    this.photoCursor = null;
    this.photos = [];
    try {
      const page = await getGalleryPage(city.lat, city.lon, null, 6, {
        signal: controller.signal,
        retry: () => void this.loadPhotos(),
      });
      if (generation !== this.galleryGeneration) return;
      this.photos = this.uniquePhotos(page.photos);
      this.photoCursor = page.nextCursor ?? null;
      this.renderPhotos();
    } catch (error) {
      if (generation !== this.galleryGeneration || isAbortError(error)) return;
      if (error instanceof ApiError && error.code === "aborted") return;
      this.photos = [];
      this.renderPhotos("error");
    } finally {
      if (generation === this.galleryGeneration) {
        if (this.photosSkeleton) setHidden(this.photosSkeleton, true);
        this.schedulePhotoChain();
      }
    }
  }

  private async loadMorePhotos(): Promise<void> {
    if (store.state.screen !== "detail") return;
    if (!this.photoCursor || this.photosLoading || this.photosError) return;
    const generation = this.galleryGeneration;
    const cursor = this.photoCursor;
    this.photosLoading = true;
    this.cancelPhotoChain();
    if (this.photosSkeleton) setHidden(this.photosSkeleton, false);
    if (this.photosSentinel) setHidden(this.photosSentinel, false);
    const city = store.state.city;
    this.galleryController = new AbortController();
    try {
      const page = await getGalleryPage(city.lat, city.lon, cursor, 6, {
        signal: this.galleryController.signal,
        retry: () => void this.loadMorePhotos(),
      });
      if (generation !== this.galleryGeneration) return;
      this.photos = this.uniquePhotos([...this.photos, ...page.photos]);
      const next = page.nextCursor ?? null;
      this.photoCursor = next === cursor ? null : next;
      this.renderPhotos();
    } catch (error) {
      if (generation !== this.galleryGeneration) return;
      if (isAbortError(error) || (error instanceof ApiError && error.code === "aborted")) return;
      this.photosError = true;
    } finally {
      if (generation !== this.galleryGeneration) return;
      this.photosLoading = false;
      if (this.photosSkeleton) setHidden(this.photosSkeleton, true);
      if (this.photosSentinel) setHidden(this.photosSentinel, !this.photoCursor);
      if (!this.photosError) this.schedulePhotoChain();
    }
  }

  private cancelPhotoChain(): void {
    if (this.photoChainFrame !== null) cancelAnimationFrame(this.photoChainFrame);
    this.photoChainFrame = null;
  }

  /** One more frame is needed because the observer will not re-fire while it stays intersecting. */
  private schedulePhotoChain(): void {
    if (this.photoChainFrame !== null) return;
    this.photoChainFrame = requestAnimationFrame(() => {
      this.photoChainFrame = null;
      if (store.state.screen !== "detail") return;
      if (!this.photoCursor || this.photosLoading || this.photosError) return;
      if (!this.sentinelInRange()) return;
      void this.loadMorePhotos();
    });
  }

  private sentinelInRange(): boolean {
    const sentinel = this.photosSentinel;
    const screen = qs<HTMLElement>("#screen-detail");
    if (!sentinel || sentinel.hidden || !screen) return false;
    const sentinelRect = sentinel.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    return sentinelRect.bottom >= screenRect.top && sentinelRect.top <= screenRect.bottom + 200;
  }

  private stopGalleryLoads(): void {
    this.galleryGeneration += 1;
    this.cancelPhotoChain();
    this.galleryController?.abort();
    this.galleryController = null;
    this.photosLoading = false;
    if (this.photosSkeleton) setHidden(this.photosSkeleton, true);
  }

  private uniquePhotos(photos: GalleryPhoto[]): GalleryPhoto[] {
    const seen = new Set<string>();
    return photos.filter((photo) => {
      if (!photo.id || seen.has(photo.id)) return false;
      seen.add(photo.id);
      return typeof photo.url === "string" && photo.url.length > 0;
    });
  }

  private photoCityLabel(photo: GalleryPhoto): string | null {
    const slug = photo.citySlug;
    if (!slug) return null;
    const current = store.state.city;
    // The API returns a slug, not a display name. Only use a label we can be
    // certain about; otherwise the tile shows just the contributor tag.
    return slug === current.slug ? current.name : null;
  }

  private renderPhotos(state: "ready" | "error" = "ready"): void {
    if (!this.photosGrid) return;
    if (this.photosSkeleton) setHidden(this.photosSkeleton, true);
    this.photosGrid.replaceChildren();
    setHidden(this.photosSection, false);

    if (this.photos.length === 0) {
      setHidden(this.photosEmpty, false);
      setHidden(this.photosGrid, true);
      if (this.photosSentinel) setHidden(this.photosSentinel, true);
      setText(
        this.photosEmptyTitle,
        state === "error"
          ? "Community photos are unavailable right now"
          : "No skies for this day yet. Be the first. New photos appear after a quick review.",
      );
      setText(
        this.photosEmptyNote,
        state === "error"
          ? "The gallery could not be reached. Try again, or share a sky photo of your own."
          : "Share a photo of this sky and it can appear here after review.",
      );
      return;
    }

    setHidden(this.photosEmpty, true);
    setHidden(this.photosGrid, false);
    if (this.photosSentinel) setHidden(this.photosSentinel, !this.photoCursor);

    this.photos.forEach((photo) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "photo-tile";
      tile.dataset.photoId = photo.id;

      const image = document.createElement("img");
      image.className = "photo-tile-img";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = photo.thumbUrl || photo.url;
      image.width = photo.width;
      image.height = photo.height;
      image.alt = `Sky photo by @${photo.handle}, ${formatDateShort(photo.capturedAt.slice(0, 10))}`;
      const shade = document.createElement("span");
      shade.className = "photo-tile-shade";
      const copy = document.createElement("span");
      copy.className = "photo-tile-copy";
      const time = document.createElement("span");
      time.className = "photo-tile-time";
      time.textContent = formatInstantClock(photo.capturedAt, store.state.city.timezone);
      const location = document.createElement("span");
      location.className = "photo-tile-location";
      const cityLabel = this.photoCityLabel(photo);
      if (cityLabel) {
        const city = document.createElement("span");
        city.className = "photo-tile-city";
        city.textContent = cityLabel;
        location.appendChild(city);
      }
      const tag = document.createElement("span");
      tag.className = "photo-tile-tag";
      tag.textContent = `@${photo.handle}`;
      location.appendChild(tag);
      copy.append(time, location);
      tile.append(image, shade, copy);
      tile.addEventListener("click", () => openPhotoModal(photo));
      this.photosGrid?.appendChild(tile);
    });
  }

  private dayRelation(): "past" | "today" | "future" {
    if (!this.day) return "past";
    const today = isoDayInZone(new Date(), store.state.city.timezone);
    if (this.day.date === today) return "today";
    return this.day.date < today ? "past" : "future";
  }

  private liveIndexNow(): number {
    const quarter = Math.floor(fractionalHourInZone(new Date(), store.state.city.timezone) / STEP_HOURS);
    return Math.max(0, Math.min(STEPS_PER_DAY, quarter));
  }

  private maxHour(): number {
    const relation = this.dayRelation();
    if (relation === "future") return 0;
    if (relation === "past") return 24;
    return this.liveIndexNow() * STEP_HOURS;
  }

  /** Keep the detail ruler's reachable end aligned with real time on today. */
  private syncLiveBound(): void {
    if (!this.day) return;
    const relation = this.dayRelation();
    const live = relation === "today" ? this.liveIndexNow() : null;
    const max = relation === "today" ? live ?? 0 : relation === "future" ? 0 : STEPS_PER_DAY;
    this.liveIndexValue = live;
    this.tape.setMaxIndex(max);
    this.tape.setLiveIndex(live);
    if (this.currentHour > max * STEP_HOURS + 0.001) {
      this.currentHour = max * STEP_HOURS;
      this.tape.setIndex(max, { silent: true });
      this.paintDay(this.day, this.currentHour);
    }
    this.updateJumpState();
    this.updateLiveBadge();
  }

  private updateLiveBadge(): void {
    const live = this.liveIndexValue;
    const atLive =
      live !== null &&
      this.dayRelation() === "today" &&
      Math.abs(this.currentHour - live * STEP_HOURS) < 0.01;
    setHidden(this.liveBadge, !atLive);
  }

  private updateJumpState(): void {
    const bound = this.maxHour();
    for (const kind of ["sunrise", "golden", "sunset"] as const) {
      const button = qs<HTMLButtonElement>(`[data-action="detail-jump"][data-kind="${kind}"]`);
      if (!button) continue;
      const target = this.jumpHour(kind);
      const disabled = target !== null && target > bound + 0.001;
      button.setAttribute("aria-disabled", disabled ? "true" : "false");
      button.classList.toggle("is-disabled", disabled);
    }
  }

  private jumpHour(kind: "sunrise" | "golden" | "sunset"): number | null {
    if (!this.day) return null;
    const city = store.state.city;
    const sunTimes = this.sunTimes;
    if (kind === "sunrise") {
      if (sunTimes?.sunrise) return fractionalHourInZone(new Date(sunTimes.sunrise), city.timezone);
      const noon = instantForLocalHour(this.day.date, 12, city.timezone);
      const times = getSunTimes(city.lat, city.lon, noon);
      return times.sunrise ? fractionalHourInZone(new Date(times.sunrise), city.timezone) : null;
    }
    if (kind === "sunset") {
      const clock = this.day.sunset ? parseClock(this.day.sunset) : null;
      if (clock) return clock.hours + clock.minutes / 60;
      return sunTimes?.sunset ? fractionalHourInZone(new Date(sunTimes.sunset), city.timezone) : null;
    }
    if (sunTimes?.goldenHourStart) return fractionalHourInZone(new Date(sunTimes.goldenHourStart), city.timezone);
    const clock = this.day.sunset ? parseClock(this.day.sunset) : null;
    return clock ? Math.max(0, clock.hours + clock.minutes / 60 - 1) : null;
  }

  private jumpTo(kind: "sunrise" | "golden" | "sunset"): void {
    const hour = this.jumpHour(kind);
    if (hour === null || hour > this.maxHour() + 0.001) return;
    this.tape.scrollToHour(hour, true);
  }

  private startLiveTicker(): void {
    if (this.liveTicker !== null) return;
    this.liveTicker = setInterval(() => {
      if (store.state.screen === "detail") this.syncLiveBound();
    }, 60_000);
  }

  private stopLiveTicker(): void {
    if (this.liveTicker !== null) clearInterval(this.liveTicker);
    this.liveTicker = null;
  }

  private toggleTimelapse(): void {
    if (this.playing) {
      this.stopTimelapse();
      return;
    }
    if (!this.day) return;
    const bound = this.maxHour();
    if (this.currentHour >= bound - 0.001) return;
    this.playing = true;
    this.timelapseButton?.setAttribute("aria-pressed", "true");
    this.timelapseButton?.setAttribute("aria-label", "Pause timelapse");
    this.playIcon?.classList.add("hidden");
    this.pauseIcon?.classList.remove("hidden");

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = reduced ? 0.25 : 0.025;
    const tick = (): void => {
      if (!this.playing) return;
      const next = this.currentHour + step;
      if (next >= bound) {
        this.currentHour = bound;
        this.tape.setIndex(indexForHour(bound), { silent: true });
        this.applyTime(bound);
        this.stopTimelapse();
        return;
      }
      this.currentHour = next;
      this.tape.setIndex(indexForHour(next), { silent: true });
      this.applyTime(next);
      this.timelapseFrame = requestAnimationFrame(tick);
    };
    this.timelapseFrame = requestAnimationFrame(tick);
  }

  private stopTimelapse(): void {
    if (this.timelapseFrame !== null) cancelAnimationFrame(this.timelapseFrame);
    this.timelapseFrame = null;
    this.playing = false;
    this.timelapseButton?.setAttribute("aria-pressed", "false");
    this.timelapseButton?.setAttribute("aria-label", "Play timelapse");
    this.playIcon?.classList.remove("hidden");
    this.pauseIcon?.classList.add("hidden");
  }
}

function formatIndex(index: number): string {
  const total = Math.max(0, Math.min(96, Math.round(index)));
  if (total === 96) return "24:00";
  const hours = Math.floor(total / 4);
  const minutes = (total % 4) * 15;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function toSunTimes(times: ReturnType<typeof getSunTimes>): PaletteResponse["sunTimes"] {
  return {
    sunrise: times.sunrise?.toISOString() ?? null,
    sunset: times.sunset?.toISOString() ?? null,
    goldenHourStart: times.goldenHourStart?.toISOString() ?? null,
    goldenHourEnd: times.goldenHourEnd?.toISOString() ?? null,
  };
}
