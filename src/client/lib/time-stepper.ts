/**
 * Inline time drum used by the submit form.
 *
 * The two segment buttons stay as the field summary; tapping either opens a
 * transform-driven wheel (hour, minute, day) inside the field wrapper. No
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

interface ColumnState {
  element: HTMLElement;
  track: HTMLElement;
  items: HTMLElement[];
  offset: number;
}

interface DragState {
  startY: number;
  startOffset: number;
  lastOffset: number;
  lastTime: number;
  velocity: number;
  moved: number;
}

const ITEM_HEIGHT = 40;
const RUBBER_BAND = 0.35;
const FLING_DISTANCE = 80;
const FLING_VELOCITY = 0.9;
const FLING_PROJECTION_MS = 180;
const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export class TimeStepper {
  readonly root: HTMLElement;
  private readonly hourButton: HTMLElement;
  private readonly minuteButton: HTMLElement;
  private readonly onChange: TimeStepperOptions["onChange"];
  private readonly onDayChange: TimeStepperOptions["onDayChange"];
  private readonly wheel: HTMLElement;
  private readonly columns = new Map<WheelKey, ColumnState>();
  private readonly animations = new Map<WheelKey, number>();
  private readonly pending = new Map<WheelKey, { index: number; commit: boolean }>();
  private readonly drags = new Map<WheelKey, DragState>();
  private readonly suppressClick = new Map<WheelKey, number>();
  private days: TimeWheelDay[] = [];
  private dayValue = "";
  private dayLabel = "Today";
  private dayAriaLabel = "today";
  private dayAria = "";
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
    if (this.open) {
      this.snapToIndex("hour", this.hours);
      this.snapToIndex("minute", this.minutes);
    }
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
    if (this.open) this.snapToIndex("day", this.indexFor("day"));
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
    for (const [key, pending] of [...this.pending]) {
      this.stopAnimation(key);
      this.setOffset(key, -pending.index * ITEM_HEIGHT);
      if (pending.commit) this.commit(key, pending.index);
    }
    this.pending.clear();
    for (const key of [...this.animations.keys()]) this.stopAnimation(key);
    for (const entry of this.columns.values()) entry.element.classList.remove("is-dragging");
    this.drags.clear();
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
    const entry: ColumnState = { element: column, track, items: [], offset: 0 };
    this.columns.set(key, entry);
    this.fillColumn(entry, values, key);
    column.addEventListener("keydown", (event) => this.onWheelKey(event, key));
    column.addEventListener("pointerdown", (event) => this.onDragStart(key, event));
    column.addEventListener("pointermove", (event) => this.onDragMove(key, event));
    column.addEventListener("pointerup", (event) => this.onDragEnd(key, event));
    column.addEventListener("pointercancel", (event) => this.onDragEnd(key, event));
  }

  private fillColumn(entry: ColumnState, values: TimeWheelDay[], key: WheelKey): void {
    entry.track.replaceChildren();
    entry.items = values.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "time-wheel-item";
      button.setAttribute("role", "option");
      button.dataset.value = item.value;
      button.dataset.index = String(index);
      button.textContent = item.label;
      button.addEventListener("click", () => {
        if ((this.suppressClick.get(key) ?? 0) > performance.now()) return;
        this.animateToIndex(key, index, true);
      });
      entry.track.appendChild(button);
      return button;
    });
    entry.offset = this.offsetForIndex(this.indexFor(key));
    entry.track.style.transform = `translate3d(0, ${entry.offset}px, 0)`;
  }

  private openWheel(key: WheelKey): void {
    const wasOpen = this.open;
    this.open = true;
    this.wheel.hidden = false;
    this.root.setAttribute("aria-expanded", "true");
    if (!wasOpen) {
      document.addEventListener("pointerdown", this.onDocumentPointer, true);
      document.addEventListener("keydown", this.onDocumentKey, true);
    }
    this.paintWheel();
    requestAnimationFrame(() => {
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

  private offsetForIndex(index: number): number {
    return -index * ITEM_HEIGHT;
  }

  private minOffset(key: WheelKey): number {
    const entry = this.columns.get(key);
    const count = entry?.items.length ?? 1;
    return -Math.max(0, count - 1) * ITEM_HEIGHT;
  }

  private rubberBand(key: WheelKey, raw: number): number {
    if (raw > 0) return raw * RUBBER_BAND;
    const min = this.minOffset(key);
    if (raw < min) return min + (raw - min) * RUBBER_BAND;
    return raw;
  }

  private setOffset(key: WheelKey, offset: number): void {
    const entry = this.columns.get(key);
    if (!entry) return;
    entry.offset = offset;
    entry.track.style.transform = `translate3d(0, ${offset}px, 0)`;
    const count = entry.items.length;
    if (count === 0) return;
    const nearest = clamp(Math.round(-offset / ITEM_HEIGHT), 0, count - 1);
    entry.items.forEach((item, index) => {
      const distance = Math.min(4, Math.abs(index - nearest));
      const selected = distance === 0;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.tabIndex = selected ? 0 : -1;
      item.style.opacity = selected ? "1" : String(Math.max(0.22, 0.62 - (distance - 1) * 0.12));
      item.style.transform = `scale(${selected ? 1 : Math.max(0.82, 1 - distance * 0.045)})`;
    });
  }

  private snapToIndex(key: WheelKey, index: number): void {
    const count = this.columns.get(key)?.items.length ?? 0;
    if (count === 0) return;
    const clamped = clamp(index, 0, count - 1);
    this.stopAnimation(key);
    this.pending.delete(key);
    this.setOffset(key, -clamped * ITEM_HEIGHT);
  }

  private animateToIndex(key: WheelKey, index: number, commit: boolean): void {
    const entry = this.columns.get(key);
    if (!entry || entry.items.length === 0) return;
    const clamped = clamp(index, 0, entry.items.length - 1);
    const target = -clamped * ITEM_HEIGHT;
    this.pending.set(key, { index: clamped, commit });
    if (reducedMotion()) {
      this.stopAnimation(key);
      this.setOffset(key, target);
      this.pending.delete(key);
      if (commit) this.commit(key, clamped);
      return;
    }
    const distance = Math.abs(target - entry.offset);
    const duration = 280 + Math.min(140, distance * 0.6);
    this.animateOffset(key, target, duration, () => {
      this.pending.delete(key);
      if (commit) this.commit(key, clamped);
    });
  }

  private animateOffset(key: WheelKey, target: number, duration: number, done?: () => void): void {
    this.stopAnimation(key);
    const entry = this.columns.get(key);
    if (!entry) {
      done?.();
      return;
    }
    const start = entry.offset;
    if (Math.abs(target - start) < 0.5) {
      this.setOffset(key, target);
      done?.();
      return;
    }
    const started = performance.now();
    const frame = (now: number): void => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.setOffset(key, start + (target - start) * eased);
      if (t < 1) {
        this.animations.set(key, requestAnimationFrame(frame));
        return;
      }
      this.animations.delete(key);
      this.setOffset(key, target);
      done?.();
    };
    this.animations.set(key, requestAnimationFrame(frame));
  }

  private stopAnimation(key: WheelKey): void {
    const frame = this.animations.get(key);
    if (frame !== undefined) cancelAnimationFrame(frame);
    this.animations.delete(key);
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
      this.onDayChange?.(day.value);
    }
  }

  private onDragStart(key: WheelKey, event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const entry = this.columns.get(key);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopAnimation(key);
    this.suppressClick.delete(key);
    entry.element.classList.add("is-dragging");
    entry.element.setPointerCapture?.(event.pointerId);
    entry.element.focus({ preventScroll: true });
    const now = performance.now();
    this.drags.set(key, {
      startY: event.clientY,
      startOffset: entry.offset,
      lastOffset: entry.offset,
      lastTime: now,
      velocity: 0,
      moved: 0,
    });
  }

  private onDragMove(key: WheelKey, event: PointerEvent): void {
    const drag = this.drags.get(key);
    const entry = this.columns.get(key);
    if (!drag || !entry) return;
    event.preventDefault();
    event.stopPropagation();
    const dy = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    const next = this.rubberBand(key, drag.startOffset + dy);
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    const sample = (next - drag.lastOffset) / dt;
    drag.velocity = drag.velocity * 0.3 + sample * 0.7;
    drag.lastOffset = next;
    drag.lastTime = now;
    this.setOffset(key, next);
  }

  private onDragEnd(key: WheelKey, event: PointerEvent): void {
    const drag = this.drags.get(key);
    const entry = this.columns.get(key);
    if (!drag || !entry) return;
    event.preventDefault();
    event.stopPropagation();
    this.drags.delete(key);
    entry.element.classList.remove("is-dragging");
    try {
      entry.element.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released by the browser
    }
    const count = entry.items.length;
    if (count === 0) return;
    const idle = performance.now() - drag.lastTime;
    const velocity = idle > 90 ? 0 : drag.velocity;
    const rawIndex = -entry.offset / ITEM_HEIGHT;
    const travelled = entry.offset - drag.startOffset;
    let index = clamp(
      travelled < -1 ? Math.floor(rawIndex) : travelled > 1 ? Math.ceil(rawIndex) : Math.round(rawIndex),
      0,
      count - 1,
    );

    if (event.type !== "pointercancel" && drag.moved < 3) {
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".time-wheel-item");
      const rowIndex = row ? Number(row.dataset.index) : Number.NaN;
      if (Number.isFinite(rowIndex)) index = clamp(rowIndex, 0, count - 1);
      this.suppressClick.set(key, performance.now() + 300);
    } else if (drag.moved >= FLING_DISTANCE && Math.abs(velocity) >= FLING_VELOCITY) {
      const projected = entry.offset + velocity * FLING_PROJECTION_MS;
      index = clamp(Math.round(-projected / ITEM_HEIGHT), 0, count - 1);
    }
    this.animateToIndex(key, index, true);
  }

  private onWheelKey(event: KeyboardEvent, key: WheelKey): void {
    const entry = this.columns.get(key);
    const items = entry?.items ?? [];
    const current = this.pending.get(key)?.index ?? this.indexFor(key);
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
    this.animateToIndex(key, clamp(next, 0, items.length - 1), true);
  }

  private onFieldKey(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (!this.open) this.openWheel("hour");
    }
  }

  private paint(): void {
    this.hourButton.textContent = pad(this.hours);
    this.minuteButton.textContent = pad(this.minutes);
    this.hourButton.setAttribute("aria-label", `Hour ${pad(this.hours)}`);
    this.minuteButton.setAttribute("aria-label", `Minute ${pad(this.minutes)}`);
    this.root.setAttribute("aria-expanded", this.open ? "true" : "false");
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
      this.stopAnimation(key);
      this.pending.delete(key);
      if (entry.items.length > 0) {
        const index = clamp(this.indexFor(key), 0, entry.items.length - 1);
        this.setOffset(key, -index * ITEM_HEIGHT);
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

