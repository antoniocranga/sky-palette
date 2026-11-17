import { getPhoto, getPhotoByHandle } from "../api";
import { ModalController, copyText, qs, registerAction, setText, showToast } from "../lib/dom";
import { formatDateShort, formatInstantClock } from "../lib/format";
import {
  PHOTO_ID_PARAM,
  PHOTO_TAG_PARAM,
  normalizeHandle,
  parsePhotoDeepLink,
  photoTagUrl,
} from "../lib/photo-link";
import type { GalleryPhoto } from "../../shared/types";
import { store } from "../state";

let instance: PhotoModal | null = null;

export function openPhotoModal(photo: GalleryPhoto): void {
  instance?.open(photo, true);
}

export class PhotoModal {
  private readonly modal: ModalController;
  private readonly image = qs<HTMLImageElement>("#photo-modal-image");
  private readonly handle = qs("#photo-modal-handle");
  private readonly city = qs("#photo-modal-city");
  private readonly times = qs("#photo-modal-times");
  private readonly swatches = qs("#photo-modal-swatches");
  private readonly hexes = qs("#photo-modal-hexes");
  private readonly shareButton = qs<HTMLButtonElement>("#photo-share");
  private current: GalleryPhoto | null = null;
  private sharing = false;

  constructor() {
    const root = qs<HTMLElement>("#photo-modal");
    if (!root) throw new Error("#photo-modal is missing");
    this.modal = new ModalController(root, { initialFocus: "[data-action='close-photo']" });
    instance = this;
    registerAction("close-photo", () => this.close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.modal.isOpen) return;
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
      },
      true,
    );
    registerAction("share-photo", () => void this.share());
    registerAction("copy-photo-link", () => void this.copyLink());
  }

  /**
   * Resolve `?tag=<handle>` (current share links) or `?photo=<id>` (legacy).
   * The lookup goes through `/api/photo`, so a deep link works without the
   * community grid being loaded first.
   */
  async syncFromUrl(): Promise<void> {
    const deepLink = parsePhotoDeepLink(window.location.search);
    if (!deepLink.handle && !deepLink.id) {
      if (this.modal.isOpen) this.close(false);
      return;
    }
    if (this.modal.isOpen) {
      if (deepLink.handle && normalizeHandle(this.current?.handle ?? "") === deepLink.handle) return;
      if (!deepLink.handle && deepLink.id && this.current?.id === deepLink.id) return;
    }

    const photo = deepLink.handle
      ? await getPhotoByHandle(deepLink.handle)
      : deepLink.id
        ? await getPhoto(deepLink.id)
        : null;
    if (!photo) return;

    // The URL may have changed while the lookup was in flight.
    const latest = parsePhotoDeepLink(window.location.search);
    if (deepLink.handle && normalizeHandle(latest.handle ?? "") !== deepLink.handle) return;
    if (!deepLink.handle && latest.id !== deepLink.id) return;
    this.open(photo, false);
  }

  open(photo: GalleryPhoto, push: boolean): void {
    this.current = photo;
    const city = this.cityLabel(photo);
    if (this.image) {
      this.image.src = photo.url;
      this.image.alt = `Sky photo by @${photo.handle}, ${city}`;
    }
    setText(this.handle, `@${photo.handle}`);
    setText(this.city, city);
    setText(
      this.times,
      `Captured ${formatDateShort(photo.capturedAt.slice(0, 10))} ${formatInstantClock(photo.capturedAt, store.state.city.timezone)} · Uploaded ${formatDateShort((photo.createdAt || photo.capturedAt).slice(0, 10))}`,
    );
    this.paintSwatches(photo);
    if (push) {
      const handle = this.tagFor(photo);
      const url = new URL(window.location.href);
      url.searchParams.delete(PHOTO_ID_PARAM);
      url.searchParams.set(PHOTO_TAG_PARAM, handle);
      window.history.pushState({ [PHOTO_TAG_PARAM]: handle }, "", url);
    }
    this.modal.show();
  }

  close(updateUrl: boolean): void {
    this.modal.hide();
    this.current = null;
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete(PHOTO_TAG_PARAM);
      url.searchParams.delete(PHOTO_ID_PARAM);
      window.history.replaceState({}, "", url);
    }
  }

  private tagFor(photo: GalleryPhoto): string {
    return normalizeHandle(photo.handle) ?? photo.handle.replace(/^@+/, "").toLowerCase();
  }

  private cityLabel(photo: GalleryPhoto): string {
    if (photo.citySlug) {
      return photo.citySlug
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" · ");
    }
    return store.state.city.name;
  }

  private paintSwatches(photo: GalleryPhoto): void {
    const colors = [photo.palette.zenith, photo.palette.midsky, photo.palette.horizon, photo.palette.sunglow, photo.palette.cloudtint];
    if (this.swatches) {
      this.swatches.replaceChildren(
        ...colors.map((color) => {
          const box = document.createElement("span");
          box.className = "h-10 rounded-lg";
          box.style.backgroundColor = color;
          return box;
        }),
      );
    }
    if (this.hexes) {
      this.hexes.replaceChildren(
        ...colors.map((color) => {
          const label = document.createElement("span");
          label.textContent = color.toUpperCase();
          return label;
        }),
      );
    }
  }

  /**
   * Native share sheet with the handle link, never a file download and never
   * a pre-emptive copy. A cancelled sheet is completely silent; only a missing
   * or rejecting Web Share API falls back to copying the link.
   */
  private async share(): Promise<void> {
    if (!this.current || this.sharing) return;
    const photo = this.current;
    const handle = this.tagFor(photo);
    const url = photoTagUrl(window.location.origin, handle);
    const title = `Sky photo by @${handle}`;
    const text = `${title} — ${this.cityLabel(photo)}, ${formatDateShort(photo.capturedAt.slice(0, 10))}`;

    if (typeof navigator.share === "function") {
      this.setSharing(true);
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (error) {
        if (isShareAbort(error)) return;
      } finally {
        this.setSharing(false);
      }
    }

    const copied = await copyText(url);
    showToast(copied ? "Link copied" : "Could not copy the link");
  }

  private async copyLink(): Promise<void> {
    if (!this.current) return;
    const url = photoTagUrl(window.location.origin, this.tagFor(this.current));
    const copied = await copyText(url);
    showToast(copied ? "Link copied" : "Could not copy the link");
  }

  private setSharing(active: boolean): void {
    this.sharing = active;
    if (!this.shareButton) return;
    this.shareButton.disabled = active;
    this.shareButton.setAttribute("aria-busy", active ? "true" : "false");
  }
}

function isShareAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
