/**
 * Compact HH : MM stepper used by the submit form.
 *
 * Two segment buttons (hour, minute) with a clear selected state, 44 px tap
 * targets, ArrowUp/ArrowDown on each segment, ArrowLeft/Right to move between
 * segments and natural Tab order. No native `input[type=time]` is involved.
 */

export interface TimeStepperOptions {
  onChange?: (hours: number, minutes: number) => void;
  initialHour?: number;
  initialMinute?: number;
}

export class TimeStepper {
  readonly root: HTMLElement;
  private readonly hourButton: HTMLButtonElement;
  private readonly minuteButton: HTMLButtonElement;
  private readonly increaseButton: HTMLButtonElement;
  private readonly decreaseButton: HTMLButtonElement;
  private readonly onChange: TimeStepperOptions["onChange"];
  private selected: "hour" | "minute" = "hour";
  private hours: number;
  private minutes: number;

  constructor(root: HTMLElement, options: TimeStepperOptions = {}) {
    this.root = root;
    this.onChange = options.onChange;
    this.hours = clamp(options.initialHour ?? new Date().getHours(), 0, 23);
    this.minutes = clamp(options.initialMinute ?? new Date().getMinutes(), 0, 59);

    this.hourButton = root.querySelector<HTMLButtonElement>("[data-time-hour]") ?? missingButton("hour");
    this.minuteButton = root.querySelector<HTMLButtonElement>("[data-time-minute]") ?? missingButton("minute");
    this.increaseButton =
      root.querySelector<HTMLButtonElement>("[data-time-increase]") ?? missingButton("increase");
    this.decreaseButton =
      root.querySelector<HTMLButtonElement>("[data-time-decrease]") ?? missingButton("decrease");

    this.hourButton.addEventListener("click", () => this.select("hour"));
    this.minuteButton.addEventListener("click", () => this.select("minute"));
    this.hourButton.addEventListener("focus", () => this.select("hour", false));
    this.minuteButton.addEventListener("focus", () => this.select("minute", false));
    this.increaseButton.addEventListener("click", () => this.step(this.selected, 1));
    this.decreaseButton.addEventListener("click", () => this.step(this.selected, -1));
    this.hourButton.addEventListener("keydown", (event) => this.onSegmentKey(event, "hour"));
    this.minuteButton.addEventListener("keydown", (event) => this.onSegmentKey(event, "minute"));

    this.paint();
  }

  get hour(): number {
    return this.hours;
  }

  get minute(): number {
    return this.minutes;
  }

  setValue(hours: number, minutes: number): void {
    this.hours = clamp(Math.round(hours), 0, 23);
    this.minutes = clamp(Math.round(minutes), 0, 59);
    this.paint();
  }

  setDisabled(disabled: boolean): void {
    for (const button of [this.hourButton, this.minuteButton, this.increaseButton, this.decreaseButton]) {
      button.disabled = disabled;
    }
  }

  private select(unit: "hour" | "minute", moveFocus = true): void {
    if (this.selected === unit && !moveFocus) return;
    this.selected = unit;
    this.paint();
    if (moveFocus) (unit === "hour" ? this.hourButton : this.minuteButton).focus({ preventScroll: true });
  }

  private step(unit: "hour" | "minute", delta: number): void {
    if (unit === "hour") this.hours = (this.hours + delta + 24) % 24;
    else this.minutes = (this.minutes + delta + 60) % 60;
    this.paint();
    this.onChange?.(this.hours, this.minutes);
  }

  private onSegmentKey(event: KeyboardEvent, unit: "hour" | "minute"): void {
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        if (unit === "minute") this.select("hour");
        else this.select("minute");
      } else if (unit === "hour") {
        this.select("minute");
      } else {
        this.increaseButton.focus();
      }
      return;
    }
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        this.selected = unit;
        this.step(unit, 1);
        this.paint();
        break;
      case "ArrowDown":
        event.preventDefault();
        this.selected = unit;
        this.step(unit, -1);
        this.paint();
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.select("hour");
        break;
      case "ArrowRight":
        event.preventDefault();
        this.select("minute");
        break;
      default:
        break;
    }
  }

  private paint(): void {
    this.hourButton.textContent = String(this.hours).padStart(2, "0");
    this.minuteButton.textContent = String(this.minutes).padStart(2, "0");
    this.hourButton.setAttribute("aria-label", `Hour ${String(this.hours).padStart(2, "0")}`);
    this.minuteButton.setAttribute("aria-label", `Minute ${String(this.minutes).padStart(2, "0")}`);
    this.hourButton.classList.toggle("is-selected", this.selected === "hour");
    this.minuteButton.classList.toggle("is-selected", this.selected === "minute");
    this.hourButton.setAttribute("aria-pressed", this.selected === "hour" ? "true" : "false");
    this.minuteButton.setAttribute("aria-pressed", this.selected === "minute" ? "true" : "false");
    this.root.dataset.value = `${String(this.hours).padStart(2, "0")}:${String(this.minutes).padStart(2, "0")}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function missingButton(name: string): HTMLButtonElement {
  throw new Error(`[Sky Palette] time stepper is missing its ${name} button`);
}
