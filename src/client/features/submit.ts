/**
 * Submit flow.
 *
 * The browser downscales the photo for UX, but the Worker re-validates type,
 * dimensions, strips metadata and checks Turnstile. Nothing here is trusted by
 * the server. Turnstile is loaded only when the dialog opens.
 */

import { ApiError, getConfig, getLocation, submitPhoto, type LocationMatch } from "../api";
import { isAbortError, qs, registerAction, registerChange, setHidden, setText, showToast } from "../lib/dom";
import { TimeStepper } from "../lib/time-stepper";
import { CitySearch } from "./search";
import { formatBytes, formatCoordinate, formatDateShort, parseDateTimeLocalValue, slugify, toDateTimeLocalValue } from "../lib/format";
import { readExifGps } from "../lib/exif";
import { MAX_UPLOAD_BYTES, detectImageFormat, formatMegabytes, validateImage } from "../lib/image-validation";
import { rgbToHex, type Rgb } from "../lib/color";
import { store, type AppCity } from "../state";
import { ModalController } from "../lib/dom";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  appearance?: "always" | "execute" | "interaction-only";
  size?: "normal" | "compact" | "flexible";
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const MAX_EDGE = 1600;
const THUMB_EDGE = 400;
const THUMB_MAX_BYTES = 2 * 1024 * 1024;

let turnstilePromise: Promise<TurnstileApi> | null = null;

export class SubmitFeature {
  private readonly modal: ModalController;
  private readonly form = qs<HTMLFormElement>("#submit-form");
  private readonly fileInput = qs<HTMLInputElement>("#sky-file-input");
  private readonly uploadEmpty = qs("#upload-empty");
  private readonly uploadPreview = qs("#upload-preview");
  private readonly previewImage = qs<HTMLImageElement>("#submit-preview-image");
  private readonly fileName = qs("#submit-file-name");
  private readonly fileMeta = qs("#submit-file-meta");
  private readonly location = qs<HTMLInputElement>("#submit-location-input");
  private readonly locationDropdown = qs<HTMLElement>("#submit-location-dropdown");
  private readonly fromPhotoBadge = qs("#from-photo-badge");
  private readonly photoHint = qs("#photo-location-hint");
  private readonly dateInput = qs<HTMLInputElement>("#submit-date-input");
  private readonly dateTrigger = qs<HTMLButtonElement>("#submit-date-trigger");
  private readonly datePopover = qs("#submit-date-popover");
  private readonly stepper: TimeStepper;
  private readonly locationSearch: CitySearch;
  private readonly paletteEmpty = qs("#submit-palette-empty");
  private readonly paletteResult = qs("#submit-palette-result");
  private readonly handleLabel = qs("#contributor-handle");
  private readonly colorStatus = qs("#submit-color-status");
  private readonly submitButton = qs<HTMLButtonElement>("#submit-btn");
  private readonly submitLabel = qs("#submit-btn-label");
  private readonly progress = qs("#submit-progress");
  private readonly progressBar = qs<HTMLElement>("#submit-progress-bar");
  private readonly progressText = qs("#submit-progress-text");
  private readonly progressPercent = qs("#submit-progress-percent");
  private readonly errorBox = qs("#submit-error");
  private readonly errorText = qs("#submit-error-text");
  private readonly errorMeta = qs("#submit-error-meta");
  private readonly success = qs("#submit-success");
  private readonly successHandle = qs("#submit-success-handle");
  private readonly turnstileBox = qs("#turnstile-box");
  private readonly turnstileContainer = qs<HTMLElement>("#turnstile-container");
  private readonly turnstileState = qs("#turnstile-state");
  private readonly botStatus = qs("#bot-status");
  private readonly botStatusLabel = qs("#bot-status-label");
  private readonly turnstileSpinner = qs("#turnstile-spinner");
  private readonly turnstileNote = qs("#turnstile-note");

  private preparedFile: File | null = null;
  private preparedThumb: File | null = null;
  private capturedValue = "";
  private captureDate = "";
  private submitSlug = "";
  private submitLat = 0;
  private submitLon = 0;
  private fileToken = 0;
  private photoLookup: AbortController | null = null;
  private pendingPhotoLocation: PhotoLocation | null = null;
  private previewUrl: string | null = null;
  private handle = "";
  private turnstileToken: string | null = null;
  private widgetId: string | null = null;
  private verificationReady = false;
  private submitting = false;
  private submitted = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressValue = 0;
  private abortController: AbortController | null = null;

  constructor() {
    const root = qs<HTMLElement>("#submit-modal");
    if (!root) throw new Error("#submit-modal is missing");
    this.modal = new ModalController(root, { initialFocus: "#sky-file-input" });

    this.stepper = new TimeStepper(qs<HTMLElement>("#submit-time-stepper") ?? document.body, {
      onChange: () => this.syncCapturedValue(),
    });
    this.locationSearch = new CitySearch({
      input: this.location ?? document.createElement("input"),
      dropdown: this.locationDropdown ?? document.createElement("div"),
      tone: "light",
      commitToApp: false,
      onSelect: (city) => {
        this.setSubmitCity(city);
        requestAnimationFrame(() => this.location?.focus({ preventScroll: true }));
      },
    });

    registerAction("open-submit", (element) => this.open(element));
    registerAction("close-submit", () => this.modal.hide());
    registerAction("randomize-handle", () => {
      this.handle = generateHandle(store.state.city.name);
      setText(this.handleLabel, this.handle);
      showToast("New anonymous handle");
    });
    registerAction("submit-reset", () => {
      this.resetForm();
    });
    registerAction("toggle-capture-date", () => this.toggleCaptureDate());
    registerAction("close-capture-date", () => this.closeCaptureDate());
    registerAction("apply-capture-date", () => this.applyCaptureDate());
    registerAction("use-photo-location", () => {
      if (this.pendingPhotoLocation) this.applyPhotoLocation(this.pendingPhotoLocation);
    });

    registerChange("sky-file", (input) => {
      if (input instanceof HTMLInputElement) void this.handleFile(input.files?.[0] ?? null);
    });

    this.form?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    this.setSubmitCity(store.state.city);
    this.setCapturedAt(toDateTimeLocalValue(new Date(), store.state.city.timezone));

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.datePopover || this.datePopover.hidden) return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (this.datePopover.contains(target) || this.dateTrigger?.contains(target)) return;
        this.closeCaptureDate();
      },
      { passive: true },
    );

    store.subscribeKey("config", (config) => {
      if (this.modal.isOpen) {
        this.setupTurnstile();
      }
    });
  }

  open(trigger?: HTMLElement | null): void {
    const city = store.state.city;
    if (this.submitted) this.resetForm();
    this.setSubmitCity(city);
    this.setCapturedAt(toDateTimeLocalValue(new Date(), city.timezone));
    if (!this.handle) {
      this.handle = generateHandle(city.name);
    }
    setText(this.handleLabel, this.handle);
    setHidden(this.errorBox, true);
    this.setupTurnstile();
    this.modal.show(trigger);
  }

  private setupTurnstile(): void {
    if (this.turnstileToken) {
      this.setVerificationState("ready", "Verified.");
      return;
    }
    void this.ensureVerification();
  }

  private async ensureVerification(): Promise<void> {
    if (!this.turnstileContainer) return;

    let config = store.state.config;
    if (!config) {
      try {
        config = await getConfig();
        store.set({ config });
      } catch {
        this.setVerificationState("unavailable", "Bot protection could not load. Reload the page and try again.");
        return;
      }
    }

    const siteKey = config.turnstileSiteKey;
    if (!siteKey) {
      this.turnstileContainer.replaceChildren();
      this.setVerificationState("unavailable", "Bot protection is not configured, so submissions are disabled.");
      return;
    }

    if (this.turnstileToken) {
      this.setVerificationState("ready", "Verified.");
      this.syncSubmitButton();
      return;
    }

    if (this.widgetId && this.turnstileContainer.childElementCount > 0 && window.turnstile) {
      this.turnstileToken = null;
      try {
        window.turnstile.reset(this.widgetId);
      } catch {
        // the widget may have been removed
      }
      this.setVerificationState("waiting", "Complete the bot check.");
      return;
    }

    this.setVerificationState("loading", "Loading the bot check…");
    try {
      const api = await loadTurnstileScript();
      if (!window.turnstile) throw new Error("Turnstile unavailable");
      this.turnstileContainer.replaceChildren();
      this.widgetId = api.render(this.turnstileContainer, {
        sitekey: siteKey,
        theme: "light",
        appearance: "interaction-only",
        size: "compact",
        callback: (token) => {
          this.turnstileToken = token;
          this.setVerificationState("ready", "Verified.");
          this.syncSubmitButton();
        },
        "expired-callback": () => {
          this.turnstileToken = null;
          this.setVerificationState("waiting", "Verification expired. Complete the check again.");
          this.syncSubmitButton();
        },
        "error-callback": () => {
          this.turnstileToken = null;
          this.setVerificationState("unavailable", "Verification failed to load. Reload the page and try again.");
          this.syncSubmitButton();
        },
      });
    } catch {
      this.setVerificationState(
        "unavailable",
        "The bot check was blocked. Allow challenges.cloudflare.com and reopen this dialog.",
      );
    }
  }

  private setVerificationState(state: "waiting" | "loading" | "ready" | "unavailable", note: string): void {
    this.verificationReady = state === "ready";
    if (this.turnstileState) this.turnstileState.textContent = state;
    setHidden(this.turnstileSpinner, state !== "loading");
    setText(
      this.botStatusLabel,
      state === "loading" ? "Checking…" : state === "unavailable" ? "Check failed" : "Protected",
    );
    if (this.botStatus) this.botStatus.dataset.state = state;
    setText(this.turnstileNote, state === "unavailable" ? note : "");
    setHidden(this.turnstileNote, state !== "unavailable");
    if (this.turnstileBox) {
      this.turnstileBox.dataset.state = state;
    }
    this.syncSubmitButton();
  }

  private syncSubmitButton(): void {
    if (!this.submitButton) return;
    const hasKey = Boolean(store.state.config?.turnstileSiteKey);
    const canSubmit =
      !this.submitting &&
      !this.submitted &&
      this.verificationReady &&
      store.state.config !== null &&
      Boolean(this.preparedFile) &&
      Boolean(this.capturedValue) &&
      (!hasKey || Boolean(this.turnstileToken));
    this.submitButton.disabled = !canSubmit;
    setText(this.submitLabel, this.submitting ? "Submitting…" : "Submit for review");
  }

  private async handleFile(file: File | null): Promise<void> {
    const token = ++this.fileToken;
    this.photoLookup?.abort();
    this.photoLookup = null;
    this.clearPhotoLocation();
    setHidden(this.errorBox, true);
    if (!file) {
      this.clearPreparedFile();
      this.syncSubmitButton();
      return;
    }

    let decoded: DecodedImage | null = null;
    try {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!detectImageFormat(head)) {
        this.rejectFile("That file is not a supported image — choose a JPEG, PNG or WebP.");
        return;
      }

      // Format and size are rejected before we ever decode pixels.
      const precheck = validateImage({ size: file.size, header: head, width: 1, height: 1 });
      if (!precheck.ok && precheck.code !== "dimensions") {
        this.rejectFile(precheck.message);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        this.rejectFile(`That photo is ${formatMegabytes(file.size)} — the limit is 30 MB.`);
        return;
      }

      decoded = await decodeImage(file);
      if (token !== this.fileToken) return;
      const validation = validateImage({
        size: file.size,
        header: head,
        width: decoded.width,
        height: decoded.height,
      });
      if (!validation.ok) {
        this.rejectFile(validation.message);
        return;
      }

      await this.autofillLocationFromPhoto(file, token);
      if (token !== this.fileToken) return;
      setText(this.fileMeta, "Optimising…");
      const prepared = await preparePhoto(file, decoded.source, decoded.width, decoded.height);
      if (prepared.file.size > MAX_UPLOAD_BYTES) {
        this.rejectFile(`That photo is ${formatMegabytes(prepared.file.size)} after encoding — the limit is 30 MB.`);
        return;
      }

      this.preparedFile = prepared.file;
      this.preparedThumb = prepared.thumb;
      this.revokePreview();
      this.previewUrl = URL.createObjectURL(prepared.file);
      if (this.previewImage) this.previewImage.src = this.previewUrl;
      setText(this.fileName, file.name);
      setText(
        this.fileMeta,
        `${prepared.width} × ${prepared.height} · ${formatBytes(prepared.file.size)} WebP · ${formatBytes(file.size)} original`,
      );
      setHidden(this.uploadEmpty, true);
      setHidden(this.uploadPreview, false);
      this.paintPalette(prepared.colors);
      setHidden(this.paletteEmpty, true);
      setHidden(this.paletteResult, false);
      setHidden(this.colorStatus, true);
      setHidden(this.errorBox, true);
      this.syncSubmitButton();
    } catch {
      this.rejectFile("That image could not be read. Try a JPEG, PNG or WebP.");
    } finally {
      decoded?.release();
    }
  }

  /** Invalid selection: drop any previous valid image and keep submit disabled. */
  private rejectFile(message: string): void {
    this.clearPreparedFile();
    if (this.fileInput) this.fileInput.value = "";
    this.showError(message, "");
    this.syncSubmitButton();
  }

  private clearPreparedFile(): void {
    this.preparedFile = null;
    this.preparedThumb = null;
    this.revokePreview();
    if (this.previewImage) this.previewImage.removeAttribute("src");
    setHidden(this.uploadEmpty, false);
    setHidden(this.uploadPreview, true);
    setHidden(this.paletteEmpty, false);
    setHidden(this.paletteResult, true);
    setText(this.colorStatus, "Awaiting photo");
    setText(this.fileMeta, "—");
    setText(this.fileName, "—");
  }

  private paintPalette(colors: [string, string, string, string, string]): void {
    colors.forEach((color, index) => {
      const swatch = qs<HTMLElement>(`#submit-swatch-${index}`);
      if (swatch) swatch.style.backgroundColor = color;
      setText(qs(`#submit-color-${index}`), color);
    });
  }

  private async submit(): Promise<void> {
    if (this.submitting || this.submitted) return;
    setHidden(this.errorBox, true);
    setHidden(this.success, true);

    if (!this.preparedFile) {
      this.showError("Choose a sky photo first.", "");
      return;
    }

    const capturedIso = parseDateTimeLocalValue(this.capturedValue, store.state.city.timezone);
    if (!capturedIso) {
      this.showError("Choose a valid capture date and time.", "");
      return;
    }

    if (store.state.config?.turnstileSiteKey && !this.turnstileToken) {
      this.showError("Finish the bot check before submitting.", "");
      return;
    }

    const formData = new FormData();
    formData.append("photo", this.preparedFile, this.preparedFile.name);
    if (this.preparedThumb) formData.append("thumb", this.preparedThumb, this.preparedThumb.name);
    formData.append("lat", String(this.submitLat));
    formData.append("lon", String(this.submitLon));
    formData.append("capturedAt", capturedIso);
    formData.append("turnstileToken", this.turnstileToken ?? "");
    formData.append("citySlug", this.submitSlug || store.state.city.slug);

    this.submitting = true;
    this.abortController = new AbortController();
    this.syncSubmitButton();
    this.startProgress();

    try {
      const response = await submitPhoto(formData, { signal: this.abortController.signal });
      this.finishProgress();
      this.submitted = true;
      setHidden(this.progress, true);
      setHidden(this.errorBox, true);
      setText(this.successHandle, response.handle || this.handle);
      setHidden(this.success, false);
      setHidden(this.submitButton, true);
      showToast("Photo submitted · pending review");
    } catch (error) {
      this.finishProgress();
      setHidden(this.progress, true);
      if (isAbortError(error)) return;
      this.handleSubmitError(error);
      if (error instanceof ApiError && error.status === 403) {
        this.resetTurnstile();
      }
      this.syncSubmitButton();
    } finally {
      this.submitting = false;
      this.abortController = null;
      if (!this.submitted) this.syncSubmitButton();
    }
  }

  private handleSubmitError(error: unknown): void {
    if (!(error instanceof ApiError)) {
      this.showError("Could not submit the photo. Try again.", "");
      return;
    }

    let message = "Could not submit the photo. Try again.";
    if (error.status === 403) message = "Bot verification failed. Complete the check and submit again.";
    else if (error.status === 429) message = "Too many submissions from this connection. Try again later.";
    else if (error.status === 413) message = "The photo is too large for the server. Choose a smaller photo.";
    else if (error.status === 400) message = "The server rejected this photo or capture time. Check the photo and try again.";
    else if (error.status >= 500) message = "The sky service had a problem. Your photo was not accepted; try again.";
    else if (error.code === "network") message = "No network connection. Your photo was not uploaded.";
    else if (error.code === "timeout") message = "The upload timed out. Try again on a better connection.";

    this.showError(message, error.requestId ? `Request ${error.requestId}` : "");
  }

  private showError(message: string, meta: string): void {
    setText(this.errorText, message);
    setText(this.errorMeta, meta);
    setHidden(this.errorBox, false);
    this.errorBox?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private startProgress(): void {
    this.progressValue = 8;
    setHidden(this.progress, false);
    this.updateProgress("Preparing upload…");
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (this.progressValue >= 88) return;
      this.progressValue = Math.min(88, this.progressValue + Math.max(1, (90 - this.progressValue) * 0.12));
      this.updateProgress(this.progressValue > 60 ? "Checking the sky…" : "Uploading photo…");
    }, 450);
  }

  private updateProgress(label: string): void {
    setText(this.progressText, label);
    setText(this.progressPercent, `${Math.round(this.progressValue)}%`);
    if (this.progressBar) this.progressBar.style.width = `${Math.round(this.progressValue)}%`;
  }

  private finishProgress(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    this.progressValue = 100;
    this.updateProgress("Done");
  }

  private async autofillLocationFromPhoto(file: File, token: number): Promise<void> {
    const gps = await readExifGps(file);
    if (!gps || token !== this.fileToken) return;

    this.photoLookup?.abort();
    this.photoLookup = new AbortController();
    let match: LocationMatch | null = null;
    try {
      match = await getLocation(gps.lat, gps.lon, { signal: this.photoLookup.signal });
    } catch {
      return;
    }
    if (token !== this.fileToken) return;

    const fallbackLabel = `${formatCoordinate(gps.lat, "lat", 2)}, ${formatCoordinate(gps.lon, "lon", 2)}`;
    const location: PhotoLocation = match
      ? {
          label: `${match.city.name}, ${match.city.country}`,
          slug: match.city.slug,
          lat: match.city.lat,
          lon: match.city.lon,
        }
      : {
          label: fallbackLabel,
          slug: store.state.city.slug,
          lat: gps.lat,
          lon: gps.lon,
        };
    this.pendingPhotoLocation = location;

    const current = this.location?.value.trim() ?? "";
    const appLabel = `${store.state.city.name}, ${store.state.city.country}`;
    if (!current || current === appLabel) {
      this.applyPhotoLocation(location);
    } else {
      setHidden(this.photoHint, false);
      setHidden(this.fromPhotoBadge, true);
    }
  }

  private applyPhotoLocation(location: PhotoLocation): void {
    this.submitSlug = location.slug;
    this.submitLat = location.lat;
    this.submitLon = location.lon;
    if (this.location) this.location.value = location.label;
    setHidden(this.fromPhotoBadge, false);
    setHidden(this.photoHint, true);
    this.pendingPhotoLocation = null;
  }

  private clearPhotoLocation(): void {
    this.pendingPhotoLocation = null;
    setHidden(this.fromPhotoBadge, true);
    setHidden(this.photoHint, true);
  }

  private setSubmitCity(city: AppCity): void {
    this.clearPhotoLocation();
    this.submitSlug = city.slug;
    this.submitLat = city.lat;
    this.submitLon = city.lon;
    if (this.location) this.location.value = `${city.name}, ${city.country}`;
  }

  private setCapturedAt(value: string): void {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) {
      setText(this.dateTrigger, "Choose date");
      return;
    }
    const [, date = "", hour = "00", minute = "00"] = match;
    this.captureDate = date;
    this.stepper.setValue(Number(hour), Number(minute));
    if (this.dateInput) this.dateInput.value = date;
    setText(this.dateTrigger, formatDateShort(date));
    this.syncCapturedValue();
  }

  private syncCapturedValue(): void {
    const hour = String(this.stepper.hour).padStart(2, "0");
    const minute = String(this.stepper.minute).padStart(2, "0");
    if (this.captureDate) this.capturedValue = `${this.captureDate}T${hour}:${minute}`;
    this.syncSubmitButton();
  }

  private toggleCaptureDate(): void {
    if (!this.datePopover) return;
    const open = this.datePopover.hidden;
    this.datePopover.hidden = !open;
    this.dateTrigger?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (this.dateInput && this.captureDate) this.dateInput.value = this.captureDate;
      this.dateInput?.focus({ preventScroll: true });
    }
  }

  private closeCaptureDate(): void {
    if (!this.datePopover) return;
    this.datePopover.hidden = true;
    this.dateTrigger?.setAttribute("aria-expanded", "false");
  }

  private applyCaptureDate(): void {
    const date = this.dateInput?.value ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.showError("Choose a valid capture date.", "");
      return;
    }
    this.captureDate = date;
    setText(this.dateTrigger, formatDateShort(date));
    this.syncCapturedValue();
    this.closeCaptureDate();
    this.dateTrigger?.focus({ preventScroll: true });
  }

  private resetTurnstile(): void {
    this.turnstileToken = null;
    if (window.turnstile && this.widgetId) {
      try {
        window.turnstile.reset(this.widgetId);
      } catch {
        // widget may already be gone
      }
    }
    this.setVerificationState("waiting", "Complete the bot check again.");
  }

  private resetForm(): void {
    this.submitted = false;
    this.submitting = false;
    this.preparedFile = null;
    this.preparedThumb = null;
    this.revokePreview();
    if (this.previewImage) this.previewImage.removeAttribute("src");
    setHidden(this.uploadEmpty, false);
    setHidden(this.uploadPreview, true);
    setHidden(this.progress, true);
    setHidden(this.errorBox, true);
    setHidden(this.success, true);
    setHidden(this.submitButton, false);
    if (this.fileInput) this.fileInput.value = "";
    if (this.progressBar) this.progressBar.style.width = "0%";
    setText(this.progressPercent, "0%");
    for (let index = 0; index < 5; index += 1) {
      const swatch = qs<HTMLElement>(`#submit-swatch-${index}`);
      if (swatch) swatch.style.backgroundColor = "";
      setText(qs(`#submit-color-${index}`), "—");
    }
    setHidden(this.paletteResult, true);
    setHidden(this.paletteEmpty, false);
    setHidden(this.colorStatus, false);
    setText(this.colorStatus, "Awaiting photo");
    setText(this.fileName, "—");
    setText(this.fileMeta, "—");
    this.handle = generateHandle(store.state.city.name);
    setText(this.handleLabel, this.handle);
    this.photoLookup?.abort();
    this.photoLookup = null;
    this.clearPhotoLocation();
    this.setSubmitCity(store.state.city);
    this.setCapturedAt(toDateTimeLocalValue(new Date(), store.state.city.timezone));
    this.closeCaptureDate();
    this.locationSearch.close();
    this.resetTurnstile();
    this.syncSubmitButton();
  }

  private revokePreview(): void {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Image preparation                                                          */
/* -------------------------------------------------------------------------- */

interface PhotoLocation {
  label: string;
  slug: string;
  lat: number;
  lon: number;
}

interface PreparedPhoto {
  file: File;
  thumb: File | null;
  width: number;
  height: number;
  colors: [string, string, string, string, string];
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // fall through to <img>: some browsers cannot decode a format via bitmap
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.decoding = "async";
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Image decode failed"));
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function preparePhoto(
  _file: File,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<PreparedPhoto> {
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(source, 0, 0, width, height);

  const blob = await encodeCanvas(canvas, 0.85);
  const actualType = blob.type && /^image\/(webp|png|jpeg)$/.test(blob.type) ? blob.type : "image/jpeg";
  const extension = actualType === "image/webp" ? "webp" : actualType === "image/png" ? "png" : "jpg";
  const prepared = new File([blob], `sky-${Date.now()}.${extension}`, { type: actualType, lastModified: Date.now() });

  let thumb: File | null = null;
  if (Math.max(sourceWidth, sourceHeight) > THUMB_EDGE) {
    const thumbScale = THUMB_EDGE / Math.max(sourceWidth, sourceHeight);
    const thumbWidth = Math.max(1, Math.round(sourceWidth * thumbScale));
    const thumbHeight = Math.max(1, Math.round(sourceHeight * thumbScale));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    const thumbContext = thumbCanvas.getContext("2d");
    if (thumbContext) {
      thumbContext.drawImage(source, 0, 0, thumbWidth, thumbHeight);
      const thumbBlob = await encodeCanvas(thumbCanvas, 0.8);
      if (thumbBlob.size <= THUMB_MAX_BYTES) {
        const thumbType = thumbBlob.type && /^image\/(webp|png|jpeg)$/.test(thumbBlob.type) ? thumbBlob.type : "image/jpeg";
        const thumbExtension = thumbType === "image/webp" ? "webp" : thumbType === "image/png" ? "png" : "jpg";
        thumb = new File([thumbBlob], `sky-thumb-${Date.now()}.${thumbExtension}`, {
          type: thumbType,
          lastModified: Date.now(),
        });
      }
    }
  }

  return {
    file: prepared,
    thumb,
    width,
    height,
    colors: extractColors(canvas),
  };
}

function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Could not encode image"))), "image/webp", quality);
  });
}

function extractColors(source: HTMLCanvasElement): [string, string, string, string, string] {
  const sample = document.createElement("canvas");
  sample.width = 30;
  sample.height = 25;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return ["#1F2937", "#374151", "#6B7280", "#9CA3AF", "#E5E7EB"];
  context.drawImage(source, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;

  const bands = 5;
  const colors: string[] = [];
  for (let band = 0; band < bands; band += 1) {
    const startY = Math.floor((band * sample.height) / bands);
    const endY = Math.max(startY + 1, Math.floor(((band + 1) * sample.height) / bands));
    const sum: Rgb = { r: 0, g: 0, b: 0 };
    let count = 0;
    for (let y = startY; y < endY; y += 1) {
      for (let x = 0; x < sample.width; x += 1) {
        const offset = (y * sample.width + x) * 4;
        const alpha = pixels[offset + 3] ?? 255;
        if (alpha < 16) continue;
        sum.r += pixels[offset] ?? 0;
        sum.g += pixels[offset + 1] ?? 0;
        sum.b += pixels[offset + 2] ?? 0;
        count += 1;
      }
    }
    colors.push(count > 0 ? rgbToHex({ r: sum.r / count, g: sum.g / count, b: sum.b / count }) : "#9CA3AF");
  }

  return [colors[0] ?? "#111827", colors[1] ?? "#374151", colors[2] ?? "#9CA3AF", colors[3] ?? "#D1D5DB", colors[4] ?? "#F3F4F6"];
}

/* -------------------------------------------------------------------------- */
/* Turnstile loader                                                           */
/* -------------------------------------------------------------------------- */

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstilePromise) return turnstilePromise;

  turnstilePromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-sky-turnstile]");
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.skyTurnstile = "true";
      document.head.appendChild(script);
    }

    const timer = setTimeout(() => {
      turnstilePromise = null;
      reject(new Error("Turnstile timed out"));
    }, 8000);

    const finish = (): void => {
      clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile missing"));
    };

    if (window.turnstile) {
      finish();
      return;
    }
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      script.remove();
      turnstilePromise = null;
      reject(new Error("Turnstile blocked"));
    }, { once: true });
  });

  return turnstilePromise;
}

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

function generateHandle(cityName: string): string {
  const stem = slugify(cityName).split("-")[0] || "sky";
  const bytes = new Uint8Array(2);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else {
    bytes[0] = Math.floor(Math.random() * 256);
    bytes[1] = Math.floor(Math.random() * 256);
  }
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 3);
  return `sky-${stem}-${suffix}`;
}

export { extractColors, generateHandle, preparePhoto };
