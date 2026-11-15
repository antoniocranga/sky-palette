import { getPhoto } from "../api";
import { ModalController, copyText, downloadBlob, qs, registerAction, setText, showToast } from "../lib/dom";
import { formatDateShort, formatInstantClock } from "../lib/format";
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
  private current: GalleryPhoto | null = null;

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
  }

  async syncFromUrl(): Promise<void> {
    const id = new URL(window.location.href).searchParams.get("photo");
    if (!id) {
      if (this.modal.isOpen) this.close(false);
      return;
    }
    if (this.modal.isOpen && this.current?.id === id) return;
    const photo = await getPhoto(id);
    if (photo) this.open(photo, false);
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
      const url = new URL(window.location.href);
      url.searchParams.set("photo", photo.id);
      window.history.pushState({ photo: photo.id }, "", url);
    }
    this.modal.show();
  }

  close(updateUrl: boolean): void {
    this.modal.hide();
    this.current = null;
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete("photo");
      window.history.replaceState({}, "", url);
    }
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

  private async share(): Promise<void> {
    if (!this.current) return;
    const photo = this.current;
    const url = `${window.location.origin}/?photo=${encodeURIComponent(photo.id)}`;
    const text = `Sky photo by @${photo.handle} — ${this.cityLabel(photo)}, ${formatDateShort(photo.capturedAt.slice(0, 10))} · ${url}`;
    const copied = await copyText(url);
    if (copied) showToast("Photo link copied");
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `Sky photo by @${photo.handle}`, text, url });
        setText(this.times, "Shared");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    downloadBlob(new Blob([photo.url], { type: "text/plain" }), `sky-photo-${photo.id}.txt`);
    showToast("Photo link copied");
  }
}
