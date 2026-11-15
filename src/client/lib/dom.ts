/**
 * Minimal DOM helpers shared by every feature.
 *
 * No framework, no virtual DOM: the page is server-rendered markup and these
 * helpers only update the parts a feature owns. Strings from API responses are
 * always written with textContent.
 */

export type ActionHandler = (element: HTMLElement, event: Event) => void;
export type ChangeHandler = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, event: Event) => void;

const actionHandlers = new Map<string, ActionHandler>();
const changeHandlers = new Map<string, ChangeHandler>();

let bound = false;

export function registerAction(name: string, handler: ActionHandler): void {
  if (actionHandlers.has(name)) {
    console.warn(`[Sky Palette] action "${name}" registered twice`);
  }
  actionHandlers.set(name, handler);
}

export function registerChange(name: string, handler: ChangeHandler): void {
  changeHandlers.set(name, handler);
}

/** One delegated click listener and one delegated change listener for the page. */
export function bindGlobalActions(): void {
  if (bound) return;
  bound = true;

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const element = target.closest<HTMLElement>("[data-action]");
      if (!element) return;
      const name = element.dataset.action;
      if (!name) return;
      const handler = actionHandlers.get(name);
      if (!handler) return;
      if (element instanceof HTMLAnchorElement) event.preventDefault();
      try {
        handler(element, event);
      } catch (error) {
        console.warn(`[Sky Palette] action "${name}" failed`, error);
      }
    },
    { passive: false },
  );

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
      return;
    }
    const element = target.closest<HTMLElement>("[data-change]");
    if (!element) return;
    const name = element.dataset.change;
    if (!name) return;
    const handler = changeHandlers.get(name);
    if (!handler) return;
    try {
      handler(target, event);
    } catch (error) {
      console.warn(`[Sky Palette] change "${name}" failed`, error);
    }
  });
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function must<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = qs<T>(selector, root);
  if (!element) throw new Error(`[Sky Palette] missing element: ${selector}`);
  return element;
}

export function setText(element: Element | null, value: string): void {
  if (element) element.textContent = value;
}

export function setHidden(element: Element | null, hidden: boolean): void {
  if (element instanceof HTMLElement) element.hidden = hidden;
}

export function toggleClass(element: Element | null, name: string, enabled: boolean): void {
  if (element) element.classList.toggle(name, enabled);
}

export function clear(element: Element | null): void {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/* -------------------------------------------------------------------------- */
/* Toast + clipboard                                                          */
/* -------------------------------------------------------------------------- */

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, durationMs = 2400): void {
  const toast = qs("#toast");
  const label = qs("#toast-msg");
  if (!toast || !label) return;
  label.textContent = message;
  toast.classList.add("is-visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
  }, durationMs);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* -------------------------------------------------------------------------- */
/* Focus-trapped dialog                                                       */
/* -------------------------------------------------------------------------- */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export class ModalController {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly initialSelector: string | undefined;
  private restoreFocus: HTMLElement | null = null;
  private open = false;

  constructor(root: HTMLElement, options: { initialFocus?: string } = {}) {
    this.root = root;
    this.card = qs<HTMLElement>(".modal-card", root) ?? root;
    this.initialSelector = options.initialFocus;
    this.card.tabIndex = -1;
    this.root.setAttribute("aria-hidden", "true");
    this.root.inert = true;
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(trigger?: HTMLElement | null): void {
    if (this.open) return;
    this.open = true;
    this.restoreFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.root.classList.add("is-open");
    this.root.setAttribute("aria-hidden", "false");
    this.root.inert = false;
    this.card.inert = false;
    this.card.removeAttribute("aria-hidden");

    // iOS Safari can keep a stale transformed/clipped layer after a previous
    // close. Clear animation leftovers, drop any descendant inert state and
    // force one synchronous layout so the reopened subtree is repainted.
    for (const property of ["transform", "opacity", "display", "visibility", "filter", "backdrop-filter", "will-change", "contain"]) {
      this.card.style.removeProperty(property);
    }
    for (const element of qsa<HTMLElement>("[inert]", this.card)) element.inert = false;
    void this.card.offsetHeight;
    this.card.scrollTop = 0;
    this.root.scrollTop = 0;
    for (const body of qsa<HTMLElement>(".modal-body", this.card)) {
      // iOS Safari sometimes paints the header but leaves an overflow scroller
      // blank after reopening. Toggle it once per open to force a fresh layer.
      body.style.display = "none";
      void body.offsetHeight;
      body.style.display = "block";
      body.scrollTop = 0;
    }

    document.addEventListener("keydown", this.onKeyDown);
    this.card.addEventListener("focusout", this.onFocusOut);
    requestAnimationFrame(() => {
      const target =
        (this.initialSelector ? qs<HTMLElement>(this.initialSelector, this.root) : null) ??
        qs<HTMLElement>(FOCUSABLE, this.card) ??
        this.card;
      target.focus({ preventScroll: true });
    });
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("is-open");
    this.root.setAttribute("aria-hidden", "true");
    this.root.inert = true;
    document.removeEventListener("keydown", this.onKeyDown);
    this.card.removeEventListener("focusout", this.onFocusOut);
    if (this.restoreFocus && this.restoreFocus.isConnected) {
      this.restoreFocus.focus({ preventScroll: true });
    }
    this.restoreFocus = null;
  }

  private readonly onFocusOut = (event: FocusEvent): void => {
    if (!this.open) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.card.contains(next)) return;
    window.setTimeout(() => {
      if (!this.open || this.card.contains(document.activeElement)) return;
      const first = qsa<HTMLElement>(FOCUSABLE, this.card).find(
        (element) => !element.hasAttribute("hidden") && element.offsetParent !== null,
      );
      (first ?? this.card).focus({ preventScroll: true });
    }, 0);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
      return;
    }

    if (event.key !== "Tab") return;

    const focusables = qsa<HTMLElement>(FOCUSABLE, this.card).filter(
      (element) => !element.hasAttribute("hidden") && element.offsetParent !== null,
    );
    if (focusables.length === 0) {
      event.preventDefault();
      this.card.focus({ preventScroll: true });
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!first || !last) return;

    if (!this.card.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
