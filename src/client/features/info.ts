/**
 * Project info dialog: about, technology, privacy and release notes.
 * Content is static markup; the only dynamic value is the API version.
 */

import { qs, registerAction, setText } from "../lib/dom";
import { ModalController } from "../lib/dom";
import { store } from "../state";

export class InfoFeature {
  private readonly modal: ModalController;
  private readonly version = qs("#info-version");

  constructor() {
    const root = qs<HTMLElement>("#info-modal");
    if (!root) throw new Error("#info-modal is missing");
    this.modal = new ModalController(root, { initialFocus: "[data-action='close-info']" });

    registerAction("open-info", (element) => this.open(element));
    registerAction("close-info", () => this.modal.hide());

    registerAction("scroll-info", (element) => {
      const id = element.dataset.section;
      if (!id) return;
      const target = qs<HTMLElement>(`#${cssEscape(id)}`, root);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    store.subscribeKey("config", (config) => this.paintVersion(config?.version));
  }

  private open(trigger?: HTMLElement | null): void {
    this.paintVersion(store.state.config?.version);
    this.modal.show(trigger);
  }

  private paintVersion(version: string | undefined): void {
    setText(this.version, "v1.0.0");
    if (version) this.version?.setAttribute("title", `Build ${version}`);
  }
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
