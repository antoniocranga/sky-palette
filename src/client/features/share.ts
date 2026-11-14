/**
 * Share sheet: four card styles previewed in the DOM and composed for real on
 * a 1080 × 1350 canvas, plus a 1080 × 1920 Story variant. Both PNGs are
 * pre-rendered off the interaction path so the primary action can hand a File
 * to the native share sheet inside the tap handler.
 */

import { copyText, downloadBlob, qs, qsa, registerAction, setText, showToast } from "../lib/dom";
import {
  formatCoordinate,
  formatCoordinates,
  formatDateLong,
  formatDateUpper,
  formatElevation,
} from "../lib/format";
import { CARD_SIZE, STORY_LAYOUT, STORY_SIZE, sharePngFilename, storyContent } from "../lib/share-card";
import { computePalette } from "../../shared/palette";
import { getSolarPosition, getSunTimes } from "../../shared/solar";
import { clockInZone, fractionalHourInZone, isoDayInZone } from "../../shared/time";
import type { Palette } from "../../shared/types";
import { cityLabelWithCountry, shareUrlFor, store, type ShareSnapshot } from "../state";
import { ModalController } from "../lib/dom";

type CardStyle = "studio" | "telemetry" | "horizon" | "monolith";
type SocialPlatform = "x" | "facebook" | "whatsapp" | "telegram";
type NativeOutcome = "shared" | "cancelled" | "unsupported" | "error";

const STYLES: CardStyle[] = ["studio", "telemetry", "horizon", "monolith"];
const SOCIALS: SocialPlatform[] = ["x", "facebook", "whatsapp", "telegram"];

const SANS = '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';
const SERIF = '"Playfair Display", Georgia, serif';

const INSTAGRAM_TEXT = "My sky right now — Sky Palette";
const FALLBACK_TOAST = "Story card saved — open Instagram and add it to your Story.";
const SOCIAL_FALLBACK_TOAST = "Card downloaded — attach it to your post.";

export class ShareFeature {
  private readonly modal: ModalController;
  private readonly root: HTMLElement;
  private readonly canvas = qs<HTMLCanvasElement>("#share-canvas");
  private readonly status = qs("#share-status");
  private style: CardStyle = "studio";
  private snapshot: ShareSnapshot | null = null;
  private cardBlob: Blob | null = null;
  private storyBlob: Blob | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private prepareToken = 0;
  private sharing = false;

  constructor() {
    const modalRoot = qs<HTMLElement>("#share-modal");
    if (!modalRoot) throw new Error("#share-modal is missing");
    this.root = modalRoot;
    this.modal = new ModalController(modalRoot, { initialFocus: "#btn-style-studio" });

    registerAction("open-share", (element) => this.open(element));
    registerAction("close-share", () => this.modal.hide());
    registerAction("card-style", (element) => {
      const style = element.dataset.style;
      if (style && isCardStyle(style)) this.setStyle(style);
    });
    registerAction("copy-link", () => {
      void this.copyLink();
    });
    registerAction("download-card", () => {
      void this.download();
    });
    registerAction("share-card", () => {
      void this.shareCard();
    });
    registerAction("share-instagram", () => {
      void this.shareInstagram();
    });
    registerAction("share-social", (element) => {
      const platform = element.dataset.platform;
      if (platform && isSocial(platform)) void this.shareSocial(platform);
    });

    store.subscribeKey("share", () => {
      if (!this.modal.isOpen) return;
      this.snapshot = store.state.share ?? this.snapshot ?? fallbackSnapshot();
      this.renderPreview(this.snapshot);
      this.schedulePrepare();
    });
  }

  open(trigger?: HTMLElement | null): void {
    this.snapshot = store.state.share ?? fallbackSnapshot();
    this.cardBlob = null;
    this.storyBlob = null;
    this.renderPreview(this.snapshot);
    this.setStyle(this.style);
    setText(this.status, "");
    this.syncControls();
    this.modal.show(trigger);
    this.schedulePrepare();
  }

  private setStyle(style: CardStyle): void {
    this.style = style;
    for (const candidate of STYLES) {
      const card = qs<HTMLElement>(`#card-variant-${candidate}`, this.root);
      card?.classList.toggle("is-active", candidate === style);
      const button = qs<HTMLElement>(`#btn-style-${candidate}`, this.root);
      if (!button) continue;
      const active = candidate === style;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.classList.toggle("bg-black", active);
      button.classList.toggle("text-white", active);
      button.classList.toggle("shadow-sm", active);
      button.classList.toggle("text-neutral-600", !active);
    }
    if (this.modal.isOpen) this.schedulePrepare();
  }

  private renderPreview(snapshot: ShareSnapshot): void {
    const palette = snapshot.palette;
    const colors = [palette.zenith, palette.midsky, palette.horizon, palette.sunglow, palette.cloudtint];
    colors.forEach((color, index) => {
      for (const swatch of qsa<HTMLElement>(`.swatch-val-${index}`, this.root)) {
        swatch.style.backgroundColor = color;
      }
      for (const label of qsa<HTMLElement>(`.hex-val-${index}`, this.root)) {
        label.textContent = color.toUpperCase();
      }
    });

    setText(qs("#studio-city", this.root), snapshot.city.name.toUpperCase());
    setText(qs("#studio-coords", this.root), formatCoordinates(snapshot.city.lat, snapshot.city.lon));
    setText(qs("#studio-date", this.root), formatDateUpper(snapshot.dateIso));
    setText(qs("#studio-time", this.root), `${snapshot.timeLabel} · ${snapshot.phase}`);

    setText(qs("#telemetry-city", this.root), snapshot.city.name.toUpperCase());
    setText(
      qs("#telemetry-coords", this.root),
      `${formatCoordinates(snapshot.city.lat, snapshot.city.lon, 2)} · ${snapshot.city.country.toUpperCase()}`,
    );
    setText(qs("#telemetry-sunset", this.root), snapshot.sunsetLabel);
    setText(qs("#telemetry-elevation", this.root), formatElevation(snapshot.elevation));
    setText(qs("#telemetry-date", this.root), formatDateUpper(snapshot.dateIso));

    setText(qs("#horizon-title", this.root), `Sky above ${snapshot.city.name}`);
    setText(qs("#horizon-phase", this.root), `${snapshot.phase} · ${snapshot.timeLabel}`);
    setText(qs("#horizon-date", this.root), `${formatDateLong(snapshot.dateIso)} · ${snapshot.timeLabel}`);

    setText(qs("#monolith-city", this.root), snapshot.city.name.toUpperCase());
    setText(
      qs("#monolith-sub", this.root),
      `${formatCoordinate(snapshot.city.lat, "lat", 1)} · ${snapshot.timeLabel} · ${formatDateUpper(snapshot.dateIso)}`,
    );
  }

  /** Re-render both PNGs after a short pause so scrubbing stays responsive. */
  private schedulePrepare(): void {
    const token = ++this.prepareToken;
    this.cardBlob = null;
    this.storyBlob = null;
    this.syncControls();
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      void this.prepare(token);
    }, 120);
  }

  private async prepare(token: number): Promise<void> {
    const snapshot = this.snapshot ?? store.state.share ?? fallbackSnapshot();
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      if (token !== this.prepareToken) return;
      const [card, story] = await Promise.all([
        renderCard(this.style, snapshot, document.createElement("canvas")),
        renderStory(snapshot, document.createElement("canvas")),
      ]);
      if (token !== this.prepareToken) return;
      this.cardBlob = card;
      this.storyBlob = story;
    } catch {
      if (token === this.prepareToken) setText(this.status, "Could not compose the card");
    } finally {
      if (token === this.prepareToken) this.syncControls();
    }
  }

  private syncControls(): void {
    for (const button of qsa<HTMLButtonElement>('#share-native, #share-instagram, [data-action="share-social"]', this.root)) {
      const needsStory = button.id === "share-instagram";
      button.disabled = this.sharing || !(needsStory ? this.storyBlob : this.cardBlob);
    }
    this.root.setAttribute("aria-busy", this.sharing ? "true" : "false");
  }

  private setSharing(value: boolean): void {
    this.sharing = value;
    this.syncControls();
  }

  private async copyLink(): Promise<void> {
    const snapshot = this.snapshot ?? (this.snapshot = store.state.share ?? fallbackSnapshot());
    const url = shareUrlFor(snapshot.city, snapshot.dateIso);
    const ok = await copyText(url);
    showToast(ok ? "Sky link copied" : "Could not copy the link");
    setText(this.status, ok ? "Link copied" : "Copy failed");
  }

  private async download(): Promise<void> {
    const snapshot = this.snapshot ?? store.state.share ?? fallbackSnapshot();
    const blob = this.cardBlob ?? (await this.renderOnDemand(snapshot));
    if (!blob) return;
    downloadBlob(blob, sharePngFilename("card", snapshot.city.slug, snapshot.dateIso));
    setText(this.status, "PNG downloaded");
    showToast("PNG downloaded");
  }

  private async renderOnDemand(snapshot: ShareSnapshot): Promise<Blob | null> {
    setText(this.status, "Composing card…");
    try {
      const blob = await renderCard(this.style, snapshot, this.canvas);
      setText(this.status, "");
      return blob;
    } catch {
      setText(this.status, "Could not compose the card");
      showToast("Could not compose the share card");
      return null;
    }
  }

  /** Primary action: native sheet with the pre-rendered 4:5 card. */
  private async shareCard(): Promise<void> {
    if (this.sharing) return;
    const snapshot = this.snapshot ?? store.state.share ?? fallbackSnapshot();
    const blob = this.cardBlob;
    if (!blob) {
      showToast("Card is still rendering…");
      return;
    }
    const filename = sharePngFilename("card", snapshot.city.slug, snapshot.dateIso);
    const title = `Sky above ${snapshot.city.name}`;
    const text = `${snapshot.phase} · ${snapshot.timeLabel} · ${cityLabelWithCountry(snapshot.city)}`;
    const url = shareUrlFor(snapshot.city, snapshot.dateIso);

    this.setSharing(true);
    try {
      const outcome = await nativeShare(blob, filename, title, `${text}\n${url}`);
      if (outcome === "shared") {
        setText(this.status, "Card shared");
        return;
      }
      if (outcome === "cancelled") {
        setText(this.status, "");
        return;
      }
      downloadBlob(blob, filename);
      setText(this.status, "Card downloaded");
      showToast("Card saved — share it from your photos.");
    } finally {
      this.setSharing(false);
    }
  }

  /** Instagram has no web composer: share the 9:16 story PNG or save it. */
  private async shareInstagram(): Promise<void> {
    if (this.sharing) return;
    const snapshot = this.snapshot ?? store.state.share ?? fallbackSnapshot();
    const blob = this.storyBlob;
    if (!blob) {
      showToast("Story card is still rendering…");
      return;
    }
    const filename = sharePngFilename("story", snapshot.city.slug, snapshot.dateIso);

    this.setSharing(true);
    try {
      const outcome = await nativeShare(blob, filename, "Sky Palette Story", INSTAGRAM_TEXT);
      if (outcome === "shared" || outcome === "cancelled") {
        setText(this.status, outcome === "shared" ? "Story shared" : "");
        return;
      }
      downloadBlob(blob, filename);
      setText(this.status, "Story card saved");
      showToast(FALLBACK_TOAST);
    } finally {
      this.setSharing(false);
    }
  }

  /**
   * X/Facebook/WhatsApp/Telegram: the sheet carries the card image. Without
   * file sharing, save the card first and then open the platform composer so
   * the post is never sent as a bare link.
   */
  private async shareSocial(platform: SocialPlatform): Promise<void> {
    if (this.sharing) return;
    const snapshot = this.snapshot ?? store.state.share ?? fallbackSnapshot();
    const blob = this.cardBlob;
    if (!blob) {
      showToast("Card is still rendering…");
      return;
    }
    const filename = sharePngFilename("card", snapshot.city.slug, snapshot.dateIso);
    const title = `Sky above ${snapshot.city.name}`;
    const text = `Sky above ${snapshot.city.name} · ${snapshot.phase} · ${snapshot.timeLabel}`;
    const url = shareUrlFor(snapshot.city, snapshot.dateIso);

    this.setSharing(true);
    try {
      const outcome = await nativeShare(blob, filename, title, `${text}\n${url}`);
      if (outcome === "shared" || outcome === "cancelled") {
        setText(this.status, outcome === "shared" ? "Card shared" : "");
        return;
      }
      downloadBlob(blob, filename);
      window.open(socialIntent(platform, url, text), "_blank", "noopener,noreferrer");
      setText(this.status, "Card downloaded");
      showToast(SOCIAL_FALLBACK_TOAST);
    } finally {
      this.setSharing(false);
    }
  }
}

function isCardStyle(value: string): value is CardStyle {
  return (STYLES as string[]).includes(value);
}

function isSocial(value: string): value is SocialPlatform {
  return (SOCIALS as string[]).includes(value);
}

function socialIntent(platform: SocialPlatform, url: string, text: string): string {
  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(text);
  switch (platform) {
    case "x":
      return `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`;
    case "facebook":
      return `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;
    case "whatsapp":
      return `https://wa.me/?text=${encodedText}%20${encodedUrl}`;
    case "telegram":
      return `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`;
  }
}

function fallbackSnapshot(): ShareSnapshot {
  const city = store.state.city;
  const now = new Date();
  const solar = getSolarPosition(city.lat, city.lon, now);
  const palette = computePalette({ elevation: solar.elevation });
  const times = getSunTimes(city.lat, city.lon, now);
  return {
    city,
    palette,
    dateIso: isoDayInZone(now, city.timezone),
    timeLabel: clockInZone(now, city.timezone),
    phase: palette.phase,
    elevation: solar.elevation,
    azimuth: solar.azimuth,
    cloudLabel: "model",
    mode: "live",
    sunsetLabel: times.sunset ? clockInZone(times.sunset, city.timezone) : "—",
  };
}

/* -------------------------------------------------------------------------- */
/* Native file share                                                          */
/* -------------------------------------------------------------------------- */

function canShareFile(file: File): boolean {
  try {
    return (
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [file] })
    );
  } catch {
    return false;
  }
}

function isAbort(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

async function nativeShare(blob: Blob, filename: string, title: string, text: string): Promise<NativeOutcome> {
  const file = new File([blob], filename, { type: "image/png" });
  if (!canShareFile(file)) return "unsupported";
  try {
    await navigator.share({ files: [file], title, text });
    return "shared";
  } catch (error) {
    return isAbort(error) ? "cancelled" : "error";
  }
}

/* -------------------------------------------------------------------------- */
/* Canvas composition                                                         */
/* -------------------------------------------------------------------------- */

async function canvasToPng(surface: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    surface.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG encoding failed"));
    }, "image/png");
  });
}

export async function renderCard(style: CardStyle, snapshot: ShareSnapshot, canvas: HTMLCanvasElement | null): Promise<Blob> {
  const surface = canvas ?? document.createElement("canvas");
  surface.width = CARD_SIZE.width;
  surface.height = CARD_SIZE.height;
  const context = surface.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");

  const colors = swatches(snapshot.palette);
  switch (style) {
    case "studio":
      drawStudio(context, snapshot, colors);
      break;
    case "telemetry":
      drawTelemetry(context, snapshot, colors);
      break;
    case "horizon":
      drawHorizon(context, snapshot, colors);
      break;
    case "monolith":
      drawMonolith(context, snapshot, colors);
      break;
  }

  return canvasToPng(surface);
}

/** 1080 × 1920 Story card with the same palette language as the 4:5 card. */
export async function renderStory(snapshot: ShareSnapshot, canvas: HTMLCanvasElement | null): Promise<Blob> {
  const surface = canvas ?? document.createElement("canvas");
  surface.width = STORY_SIZE.width;
  surface.height = STORY_SIZE.height;
  const context = surface.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  drawStory(context, snapshot, swatches(snapshot.palette));
  return canvasToPng(surface);
}

function swatches(palette: Palette): string[] {
  return [palette.zenith, palette.midsky, palette.horizon, palette.sunglow, palette.cloudtint];
}

function drawSwatchRow(
  context: CanvasRenderingContext2D,
  colors: string[],
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 0,
): void {
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.clip();
  const columnWidth = width / colors.length;
  colors.forEach((color, index) => {
    context.fillStyle = color;
    context.fillRect(x + index * columnWidth, y, Math.ceil(columnWidth), height);
  });
  context.restore();
}

function drawHexRow(
  context: CanvasRenderingContext2D,
  colors: string[],
  x: number,
  y: number,
  width: number,
  color: string,
  fontPx = 18,
): void {
  const columnWidth = width / colors.length;
  context.fillStyle = color;
  context.font = `500 ${fontPx}px ${MONO}`;
  context.textAlign = "center";
  colors.forEach((hex, index) => {
    context.fillText(hex.toUpperCase(), x + columnWidth * index + columnWidth / 2, y);
  });
  context.textAlign = "left";
}

function drawStory(context: CanvasRenderingContext2D, snapshot: ShareSnapshot, colors: string[]): void {
  const width = STORY_LAYOUT.width;
  const height = STORY_LAYOUT.height;
  const margin = STORY_LAYOUT.margin;
  const content = storyContent(snapshot);

  context.fillStyle = "#0B0D12";
  context.fillRect(0, 0, width, height);

  const wash = context.createLinearGradient(0, height * 0.42, 0, height);
  wash.addColorStop(0, "rgba(11,13,18,0)");
  wash.addColorStop(0.62, "rgba(56,58,74,0.22)");
  wash.addColorStop(1, "rgba(11,13,18,0)");
  context.fillStyle = wash;
  context.fillRect(0, 0, width, height);

  // Header: wordmark + date, both inside the top safe margin.
  context.fillStyle = "rgba(255,255,255,0.55)";
  context.font = `500 22px ${MONO}`;
  context.fillText(content.eyebrow, margin, 168);
  context.textAlign = "right";
  context.fillText(content.date, width - margin, 168);
  context.textAlign = "left";

  // City, coordinates, local time and phase.
  context.fillStyle = "#FFFFFF";
  context.font = `700 78px ${SANS}`;
  context.fillText(content.city, margin, 286, width - margin * 2);
  context.fillStyle = "rgba(255,255,255,0.55)";
  context.font = `400 24px ${MONO}`;
  context.fillText(content.coords, margin, 342, width - margin * 2);
  context.fillStyle = "rgba(255,255,255,0.9)";
  context.font = `500 30px ${MONO}`;
  context.fillText(`${content.time} · ${content.phase}`, margin, 404, width - margin * 2);

  // Palette field and hex labels.
  drawSwatchRow(context, colors, margin, STORY_LAYOUT.swatchTop, width - margin * 2, STORY_LAYOUT.swatchHeight, 28);
  drawHexRow(context, colors, margin, STORY_LAYOUT.hexBaseline, width - margin * 2, "rgba(255,255,255,0.68)", 22);

  // Telemetry panel: elevation, azimuth, cloud cover, phase.
  const panelY = STORY_LAYOUT.panelTop;
  const panelW = width - margin * 2;
  context.fillStyle = "rgba(255,255,255,0.05)";
  context.beginPath();
  context.roundRect(margin, panelY, panelW, STORY_LAYOUT.panelHeight, 24);
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 2;
  context.stroke();

  content.metrics.forEach((metric, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = column === 0 ? margin + 48 : margin + 468;
    const labelY = panelY + 62 + row * 130;
    const valueY = labelY + 58;
    context.fillStyle = "rgba(255,255,255,0.45)";
    context.font = `400 18px ${MONO}`;
    context.fillText(metric.label, x, labelY);
    context.fillStyle = "#FFFFFF";
    context.font = `600 34px ${MONO}`;
    context.fillText(metric.value, x, valueY, 330);
  });

  // Footer: handle + site.
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(margin, STORY_LAYOUT.footerRule);
  context.lineTo(width - margin, STORY_LAYOUT.footerRule);
  context.stroke();

  context.fillStyle = "rgba(255,255,255,0.75)";
  context.font = `500 22px ${MONO}`;
  context.fillText(content.handle, margin, STORY_LAYOUT.footerBaseline);
  context.textAlign = "right";
  context.fillText(content.site, width - margin, STORY_LAYOUT.footerBaseline);
  context.textAlign = "left";
}

function drawStudio(context: CanvasRenderingContext2D, snapshot: ShareSnapshot, colors: string[]): void {
  const width = CARD_SIZE.width;
  const height = CARD_SIZE.height;
  context.fillStyle = "#FAFAFC";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "#71717A";
  context.font = `500 22px ${MONO}`;
  context.fillText("SKY PALETTE", 80, 120);

  context.fillStyle = "#09090B";
  context.font = `700 78px ${SANS}`;
  context.fillText(snapshot.city.name.toUpperCase(), 80, 250, 700);
  context.fillStyle = "#52525B";
  context.font = `400 26px ${MONO}`;
  context.fillText(formatCoordinates(snapshot.city.lat, snapshot.city.lon), 80, 300);

  // Date pill
  const dateLabel = formatDateUpper(snapshot.dateIso);
  context.font = `500 24px ${MONO}`;
  const pillWidth = context.measureText(dateLabel).width + 56;
  context.fillStyle = "#09090B";
  context.beginPath();
  context.roundRect(width - 80 - pillWidth, 92, pillWidth, 56, 28);
  context.fill();
  context.fillStyle = "#FFFFFF";
  context.textAlign = "center";
  context.fillText(dateLabel, width - 80 - pillWidth / 2, 128);
  context.textAlign = "left";

  drawSwatchRow(context, colors, 80, 430, width - 160, 600, 28);
  drawHexRow(context, colors, 80, 1090, width - 160, "#52525B");

  context.strokeStyle = "rgba(9,9,11,0.10)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(80, 1170);
  context.lineTo(width - 80, 1170);
  context.stroke();

  context.fillStyle = "#3F3F46";
  context.font = `400 22px ${MONO}`;
  context.fillText(`${snapshot.timeLabel} · ${snapshot.phase}`, 80, 1230);
  context.textAlign = "right";
  context.fillStyle = "#09090B";
  context.font = `600 22px ${MONO}`;
  context.fillText("skypalette.app", width - 80, 1230);
  context.textAlign = "left";
}

function drawTelemetry(context: CanvasRenderingContext2D, snapshot: ShareSnapshot, colors: string[]): void {
  const width = CARD_SIZE.width;
  const height = CARD_SIZE.height;
  context.fillStyle = "#0B0D12";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "#34D399";
  context.beginPath();
  context.arc(92, 112, 8, 0, Math.PI * 2);
  context.fill();
  context.font = `500 22px ${MONO}`;
  context.fillText("SOLAR TELEMETRY", 114, 120);

  context.fillStyle = "#FFFFFF";
  context.font = `700 56px ${MONO}`;
  context.fillText(snapshot.city.name.toUpperCase(), 80, 230, width - 160);
  context.fillStyle = "rgba(255,255,255,0.55)";
  context.font = `400 22px ${MONO}`;
  context.fillText(
    `${formatCoordinates(snapshot.city.lat, snapshot.city.lon, 2)} · ${snapshot.city.country.toUpperCase()}`,
    80,
    274,
    width - 160,
  );

  drawSwatchRow(context, colors, 80, 360, width - 160, 400, 16);
  drawHexRow(context, colors, 80, 812, width - 160, "rgba(255,255,255,0.60)");

  // Metrics
  context.fillStyle = "rgba(255,255,255,0.05)";
  context.beginPath();
  context.roundRect(80, 880, width - 160, 190, 20);
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "rgba(255,255,255,0.45)";
  context.font = `400 20px ${MONO}`;
  context.fillText("SUNSET", 124, 936);
  context.fillText("SOLAR ARC", 590, 936);
  context.fillStyle = "#FFFFFF";
  context.font = `700 44px ${MONO}`;
  context.fillText(snapshot.sunsetLabel, 124, 1000);
  context.fillStyle = "#FCD34D";
  context.fillText(formatElevation(snapshot.elevation), 590, 1000);

  context.fillStyle = "rgba(255,255,255,0.45)";
  context.font = `400 20px ${MONO}`;
  context.fillText(formatDateUpper(snapshot.dateIso), 80, 1210);
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.75)";
  context.fillText("skypalette.app", width - 80, 1210);
  context.textAlign = "left";
}

function drawHorizon(context: CanvasRenderingContext2D, snapshot: ShareSnapshot, colors: string[]): void {
  const width = CARD_SIZE.width;
  const height = CARD_SIZE.height;
  context.fillStyle = "#0E111A";
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(width / 2, height + 60, 40, width / 2, height + 60, 900);
  glow.addColorStop(0, "rgba(224,96,56,0.38)");
  glow.addColorStop(0.65, "rgba(224,96,56,0.08)");
  glow.addColorStop(1, "rgba(14,17,26,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(252,211,77,0.65)";
  context.font = `500 20px ${MONO}`;
  context.fillText("ATELIER EXHIBITION", 80, 120);

  context.fillStyle = "#FEF3C7";
  context.font = `italic 600 66px ${SERIF}`;
  context.fillText(`Sky above ${snapshot.city.name}`, 80, 236, width - 160);

  context.fillStyle = "rgba(255,255,255,0.55)";
  context.font = `400 24px ${MONO}`;
  context.fillText(`${snapshot.phase} · ${snapshot.timeLabel}`, 80, 286);

  drawSwatchRow(context, colors, 80, 460, width - 160, 520, 32);
  context.fillStyle = "rgba(253,230,138,0.65)";
  context.font = `400 22px ${MONO}`;
  context.fillText("ZENITH", 80, 1042);
  context.textAlign = "center";
  context.fillText("HORIZON", width / 2, 1042);
  context.textAlign = "right";
  context.fillText("SUN GLOW", width - 80, 1042);
  context.textAlign = "left";

  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(80, 1160);
  context.lineTo(width - 80, 1160);
  context.stroke();

  context.fillStyle = "rgba(254,243,199,0.7)";
  context.font = `400 22px ${MONO}`;
  context.fillText(`${formatDateLong(snapshot.dateIso)} · ${snapshot.timeLabel}`, 80, 1220);
  context.textAlign = "right";
  context.fillText("skypalette.app", width - 80, 1220);
  context.textAlign = "left";
}

function drawMonolith(context: CanvasRenderingContext2D, snapshot: ShareSnapshot, colors: string[]): void {
  const width = CARD_SIZE.width;
  const height = CARD_SIZE.height;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
  drawSwatchRow(context, colors, 0, 0, width, 980);

  context.fillStyle = "#FFFFFF";
  context.font = `700 44px ${SANS}`;
  context.fillText(snapshot.city.name.toUpperCase(), 64, 1090, 700);

  context.fillStyle = "rgba(255,255,255,0.55)";
  context.font = `400 20px ${MONO}`;
  context.fillText(
    `${formatCoordinate(snapshot.city.lat, "lat", 1)} · ${snapshot.timeLabel} · ${formatDateUpper(snapshot.dateIso)}`,
    64,
    1132,
    width - 128,
  );

  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.9)";
  context.font = `500 22px ${MONO}`;
  context.fillText("skypalette.app", width - 64, 1104);
  context.textAlign = "left";
}

export { drawMonolith, drawStudio, drawTelemetry, drawHorizon, drawStory };
