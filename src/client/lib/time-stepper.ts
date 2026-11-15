/**
 * Inline time drum used by the submit form.
 *
 * The two segment buttons stay as the field summary; tapping either opens a
 * vertical scroll-snap drum (hour, minute, day) inside the field wrapper. No
 * modal or native time input is involved.
 */

export interface TimeWheelDay {
  value: string;
  label: string;
}

export interface TimeStepperOptions {
  onChange?: (hours: number, minutes: number) => void;
  onDayChange?: (date: string) => void;
  initialHour?: number;
  initialMinute?: number;
  initialDay?: string;
}

type WheelKey = "hour" | "minute" | "day";

const ITEM_HEIGHT = 40;
const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export class TimeStepper {
  readonly root: HTMLElement;
  private readonly hourButton: HTMLElement;
  private readonly minuteButton: HTMLElement;
  private readonly onChange: TimeStepperOptions["onChange"];
  private readonly onDayChange: TimeStepperOptions["onDayChange"];
  private readonly wheel: HTMLElement;
  private readonly columns = new Map<WheelKey, { element: HTMLElement; items: HTMLElement[] }>();
  private readonly scrollLocks = new Map<WheelKey, ReturnType<typeof setTimeout>>();
  private readonly dragging = new Map<
    WheelKey,
    { startY: number; startTop: number; lastY: number; lastTime: number; velocity: number; moved: number; track: HTMLElement }
  >();
  private days: TimeWheelDay[] = [];
  private dayValue = "";
  private dayLabel = "Today";
  private dayAriaLabel = "today";
  private dayAria = "";
  private selected: "hour" | "minute" = "hour";
  private hours: number;
  private minutes: number;
  private open = false;

  constructor(root: HTMLElement, options: TimeStepperOptions = {}) {
    this.root = root;
    this.onChange = options.onChange;
    this.onDayChange = options.onDayChange;
    this.hours = clamp(options.initialHour ?? new Date().getHours(), 0, 23);
    this.minutes = clamp(options.initialMinute ?? new Date().getMinutes(), 0, 59);
    this.dayValue = options.initialDay ?? todayIso();

    this.hourButton = root.querySelector<HTMLElement>("[data-time-hour]") ?? missingButton("hour");
    this.minuteButton = root.querySelector<HTMLElement>("[data-time-minute]") ?? missingButton("minute");

    this.wheel = document.createElement("div");
    this.wheel.id = "submit-time-wheel";
    this.wheel.className = "time-wheel";
    this.wheel.hidden = true;
    this.wheel.setAttribute("role", "group");
    this.wheel.setAttribute("aria-label", "Capture time and day");
    const host = root.parentElement ?? root;
    host.appendChild(this.wheel);
    this.buildColumn("hour", "Hour", Array.from({ length: 24 }, (_, value) => ({ value: String(value), label: pad(value) })));
    this.buildColumn("minute", "Minute", Array.from({ length: 60 }, (_, value) => ({ value: String(value), label: pad(value) })));
    this.buildColumn("day", "Day", []);
    this.setDays(this.days, this.dayValue);

    root.tabIndex = 0;
    root.setAttribute("role", "button");
    root.setAttribute("aria-haspopup", "listbox");
    root.setAttribute("aria-expanded", "false");
    root.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("#submit-date-trigger")) return;
      this.selected = "hour";
      this.paint();
      this.openWheel("hour");
    });
    root.addEventListener("keydown", (event) => this.onFieldKey(event));

    this.paint();
    this.paintWheel();
  }

  get hour(): number {
    return this.hours;
  }

  get minute(): number {
    return this.minutes;
  }

  get date(): string {
    return this.dayValue;
  }

  get isOpen(): boolean {
    return this.open;
  }

  setValue(hours: number, minutes: number): void {
    this.hours = clamp(Math.round(hours), 0, 23);
    this.minutes = clamp(Math.round(minutes), 0, 59);
    this.paint();
    this.paintWheel();
  }

  setDays(days: TimeWheelDay[], selected?: string): void {
    this.days = days.length > 0 ? days : [{ value: selected ?? todayIso(), label: formatDay(selected ?? todayIso()) }];
    this.dayValue = selected && this.days.some((day) => day.value === selected) ? selected : (this.days[0]?.value ?? todayIso());
    const dayColumn = this.columns.get("day");
    if (dayColumn) this.fillColumn(dayColumn, this.days, "day");
    this.paintWheel();
  }

  setDayAria(label: string): void {
    this.dayAria = label;
    this.paint();
  }

  setDay(value: string): void {
    if (!this.days.some((day) => day.value === value)) return;
    this.dayValue = value;
    this.paintWheel();
  }

  setDayLabel(label: string, ariaLabel: string): void {
    this.dayLabel = label;
    this.dayAria = ariaLabel;
    this.dayAriaLabel = ariaLabel;
    this.paint();
  }

  setDisabled(disabled: boolean): void {
    this.root.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (disabled) this.closeWheel();
  }

  closeWheel(): void {
    if (!this.open) return;
    this.open = false;
    this.wheel.hidden = true;
    document.removeEventListener("pointerdown", this.onDocumentPointer, true);
    document.removeEventListener("keydown", this.onDocumentKey, true);
    this.root.setAttribute("aria-expanded", "false");
  }

  private buildColumn(key: WheelKey, label: string, values: TimeWheelDay[]): void {
    const column = document.createElement("div");
    column.className = "time-wheel-column";
    column.setAttribute("role", "listbox");
    column.setAttribute("aria-label", label);
    column.tabIndex = 0;
    column.dataset.wheel = key;
    const track = document.createElement("div");
    track.className = "time-wheel-track";
    column.appendChild(track);
    this.wheel.appendChild(column);
    const entry = { element: column, items: [] as HTMLElement[] };
    this.columns.set(key, entry);
    this.fillColumn(entry, values, key);
    column.addEventListener("scroll", () => this.onScroll(key), { passive: true });
    column.addEventListener("keydown", (event) => this.onWheelKey(event, key));
    column.addEventListener("pointerdown", (event) => this.onDragStart(key, event));
    column.addEventListener("pointermove", (event) => this.onDragMove(key, event));
    column.addEventListener("pointerup", (event) => this.onDragEnd(key, event));
    column.addEventListener("pointercancel", (event) => this.onDragEnd(key, event));
  }

  private fillColumn(entry: { element: HTMLElement; items: HTMLElement[] }, values: TimeWheelDay[], key: WheelKey): void {
    const track = entry.element.firstElementChild ?? entry.element;
    track.replaceChildren();
    entry.items = values.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "time-wheel-item";
      button.setAttribute("role", "option");
      button.dataset.value = item.value;
      button.dataset.index = String(index);
      button.textContent = item.label;
      button.addEventListener("click", () => this.scrollToIndex(key, index, true));
      track.appendChild(button);
      return button;
    });
  }

  private openWheel(key: "hour" | "minute"): void {
    this.open = true;
    this.wheel.hidden = false;
    this.root.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.onDocumentPointer, true);
    document.addEventListener("keydown", this.onDocumentKey, true);
    requestAnimationFrame(() => {
      for (const name of ["hour", "minute", "day"] as const) {
        this.scrollToIndex(name, this.indexFor(name), false);
      }
      this.paintWheel();
      this.columns.get(key)?.element.focus({ preventScroll: true });
    });
  }

  private readonly onDocumentPointer = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.wheel.contains(target) || this.root.contains(target)) return;
    this.closeWheel();
  };

  private readonly onDocumentKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.open) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeWheel();
    this.hourButton.focus({ preventScroll: true });
  };

  private indexFor(key: WheelKey): number {
    if (key === "hour") return this.hours;
    if (key === "minute") return this.minutes;
    return Math.max(0, this.days.findIndex((day) => day.value === this.dayValue));
  }

  private valueFor(key: WheelKey): string {
    if (key === "hour") return String(this.hours);
    if (key === "minute") return String(this.minutes);
    return this.dayValue;
  }

  private scrollToIndex(key: WheelKey, index: number, smooth: boolean): void {
    const entry = this.columns.get(key);
    if (!entry) return;
    const track = entry.element.firstElementChild;
    if (track instanceof HTMLElement) track.style.transform = "";
    const clamped = clamp(index, 0, Math.max(0, entry.items.length - 1));
    const existing = this.scrollLocks.get(key);
    if (existing) clearTimeout(existing);
    this.scrollLocks.set(
      key,
      setTimeout(() => this.scrollLocks.delete(key), smooth && !reducedMotion() ? 520 : 0),
    );
    entry.element.scrollTo({ top: clamped * ITEM_HEIGHT, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
    this.commit(key, clamped);
  }

  private onScroll(key: WheelKey): void {
    if (this.scrollLocks.has(key) || this.dragging.has(key)) return;
    const entry = this.columns.get(key);
    if (!entry) return;
    const index = clamp(Math.round(entry.element.scrollTop / ITEM_HEIGHT), 0, Math.max(0, entry.items.length - 1));
    this.commit(key, index);
  }

  private commit(key: WheelKey, index: number): void {
    if (key === "hour") {
      if (this.hours === index) return;
      this.hours = index;
      this.paint();
      this.onChange?.(this.hours, this.minutes);
    } else if (key === "minute") {
      if (this.minutes === index) return;
      this.minutes = index;
      this.paint();
      this.onChange?.(this.hours, this.minutes);
    } else {
      const day = this.days[index];
      if (!day || day.value === this.dayValue) return;
      this.dayValue = day.value;
      this.paintWheel();
      this.onDayChange?.(day.value);
    }
  }

  private onDragStart(key: WheelKey, event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const entry = this.columns.get(key);
    const track = entry?.element.firstElementChild;
    if (!entry || !(track instanceof HTMLElement)) return;
    this.scrollLocks.delete(key);
    for (const timer of this.scrollLocks.values()) clearTimeout(timer);
    this.scrollLocks.clear();
    this.dragging.set(key, {
      startY: event.clientY,
      startTop: entry.element.scrollTop,
      lastY: event.clientY,
      lastTime: performance.now(),
      velocity: 0,
      moved: 0,
      track,
    });
    entry.element.setPointerCapture?.(event.pointerId);
  }

  private onDragMove(key: WheelKey, event: PointerEvent): void {
    const drag = this.dragging.get(key);
    const entry = this.columns.get(key);
    if (!drag || !entry) return;
    event.preventDefault();
    const dy = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    drag.velocity = (drag.lastY - event.clientY) / dt;
    drag.lastY = event.clientY;
    drag.lastTime = now;
    const maxTop = Math.max(0, (entry.items.length - 1) * ITEM_HEIGHT);
    const desired = drag.startTop - dy;
    if (desired < 0) {
      entry.element.scrollTop = 0;
      drag.track.style.transform = `translateY(${desired * 0.35}px)`;
    } else if (desired > maxTop) {
      entry.element.scrollTop = maxTop;
      drag.track.style.transform = `translateY(${(desired - maxTop) * 0.35}px)`;
    } else {
      entry.element.scrollTop = desired;
      drag.track.style.transform = "";
    }
    const index = clamp(Math.round(entry.element.scrollTop / ITEM_HEIGHT), 0, entry.items.length - 1);
    this.commit(key, index);
  }

  private onDragEnd(key: WheelKey, event: PointerEvent): void {
    const drag = this.dragging.get(key);
    const entry = this.columns.get(key);
    if (!drag || !entry) return;
    this.dragging.delete(key);
    drag.track.style.transform = "";
    entry.element.releasePointerCapture?.(event.pointerId);
    const maxTop = Math.max(0, (entry.items.length - 1) * ITEM_HEIGHT);
    const projected = entry.element.scrollTop - drag.velocity * 180;
    const index = clamp(Math.round(projected / ITEM_HEIGHT), 0, Math.max(0, entry.items.length - 1));
    this.scrollToIndex(key, index, true);
    if (drag.moved < 3) {
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".time-wheel-item");
      const rowIndex = row ? Number(row.dataset.index) : Number.NaN;
      if (Number.isFinite(rowIndex)) this.scrollToIndex(key, rowIndex, true);
    }
    void maxTop;
  }

  private onWheelKey(event: KeyboardEvent, key: WheelKey): void {
    const entry = this.columns.get(key);
    const items = entry?.items ?? [];
    const current = this.indexFor(key);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = current - 1;
        break;
      case "ArrowDown":
        next = current + 1;
        break;
      case "PageUp":
        next = current - 5;
        break;
      case "PageDown":
        next = current + 5;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const order: WheelKey[] = ["hour", "minute", "day"];
        const at = order.indexOf(key);
        const nextKey = order[(at + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length];
        this.columns.get(nextKey ?? "hour")?.element.focus({ preventScroll: true });
        event.preventDefault();
        return;
      }
      case "Escape":
        this.closeWheel();
        this.hourButton.focus({ preventScroll: true });
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    this.scrollToIndex(key, clamp(next, 0, items.length - 1), true);
  }

  private onFieldKey(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (!this.open) {
        this.selected = "hour";
        this.paint();
        this.openWheel("hour");
      }
    }
  }

  private paint(): void {
    this.hourButton.textContent = pad(this.hours);
    this.minuteButton.textContent = pad(this.minutes);
    this.hourButton.setAttribute("aria-label", `Hour ${pad(this.hours)}`);
    this.minuteButton.setAttribute("aria-label", `Minute ${pad(this.minutes)}`);
    this.root.setAttribute("aria-expanded", this.open ? "true" : "false");
    this.hourButton.classList.toggle("is-selected", this.selected === "hour");
    this.minuteButton.classList.toggle("is-selected", this.selected === "minute");
    this.root.dataset.value = `${pad(this.hours)}:${pad(this.minutes)}`;
    const spoken = `${pad(this.hours)}:${pad(this.minutes)}${this.dayAria ? `, ${this.dayAria}` : ""}`;
    this.root.setAttribute("aria-label", `Capture time, ${spoken}`);
    this.root.setAttribute("aria-valuetext", spoken);
    const day = this.root.querySelector<HTMLElement>("#submit-time-day");
    if (day) day.textContent = ` · ${this.dayLabel}`;
  }

  private paintWheel(): void {
    for (const key of ["hour", "minute", "day"] as const) {
      const entry = this.columns.get(key);
      if (!entry) continue;
      const value = this.valueFor(key);
      entry.items.forEach((item, index) => {
        const selected = item.dataset.value === value || (key === "day" && !value && index === 0);
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-selected", selected ? "true" : "false");
        item.tabIndex = selected ? 0 : -1;
      });
      const selectedIndex = Math.max(0, this.indexFor(key));
      if (this.open) {
        entry.element.scrollTop = selectedIndex * ITEM_HEIGHT;
      }
    }
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function missingButton(name: string): HTMLButtonElement {
  throw new Error(`[Sky Palette] time stepper is missing its ${name} button`);
}
