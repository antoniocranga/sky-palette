/**
 * Reusable horizontal ruler ("jog dial") with iOS-style momentum, rubber-band
 * edges and snapping. The pure maths live in exported functions so they can be
 * unit tested; the controller only schedules DOM writes in animation frames.
 */

import { prefersReducedMotion } from "./dom";

export const STEP_HOURS = 0.25;
export const STEPS_PER_DAY = 96;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPosition(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

export const OUT_OF_RANGE_RESISTANCE = 0.3;
export const OUT_OF_RANGE_STIFFNESS = 260;
export const SPRING_STIFFNESS = 170;
export const SPRING_DAMPING = 18;
export const SPRING_BACK_DURATION_MS = 420;

/** Soft resistance outside the ends instead of a hard stop. */
export function rubberBand(value: number, min: number, max: number, resistance = 0.28): number {
  if (value > max) return max + (value - max) * resistance;
  if (value < min) return min - (min - value) * resistance;
  return value;
}

/**
 * Progressive rubber banding: about 30% of the finger delta at the boundary,
 * easing harder the further the finger goes (never a hard stop or free travel).
 */
export function clampWithResistance(
  value: number,
  min: number,
  max: number,
  resistance = OUT_OF_RANGE_RESISTANCE,
  stiffness = OUT_OF_RANGE_STIFFNESS,
): number {
  if (value > max) {
    const distance = value - max;
    return max + (distance * resistance) / (1 + distance / stiffness);
  }
  if (value < min) {
    const distance = min - value;
    return min - (distance * resistance) / (1 + distance / stiffness);
  }
  return value;
}

/** Which boundary an out-of-range release should return to. */
export function springBackTarget(
  position: number,
  min: number,
  max: number,
  velocity: number,
): { boundary: number; velocity: number } {
  if (position > max) return { boundary: max, velocity };
  if (position < min) return { boundary: min, velocity };
  return { boundary: position, velocity };
}

/**
 * One mass-spring-damper frame. Velocity is px/s. Damping is below critical
 * for a small, single rebound rather than a wobble.
 */
export function springBackFrame(
  state: MomentumState,
  boundary: number,
  dtSeconds: number,
  stiffness = SPRING_STIFFNESS,
  damping = SPRING_DAMPING,
): MomentumState {
  const dt = Math.min(0.034, Math.max(0.001, dtSeconds));
  const acceleration = -stiffness * (state.position - boundary) - damping * state.velocity;
  const velocity = state.velocity + acceleration * dt;
  return { position: state.position + velocity * dt, velocity };
}

export function snapIndex(position: number, gap: number, stepCount: number): number {
  return clamp(Math.round(position / gap), 0, stepCount);
}

export function indexForHour(hour: number): number {
  return clamp(Math.round(hour / STEP_HOURS), 0, STEPS_PER_DAY);
}

export function hourForIndex(index: number): number {
  return clamp(index, 0, STEPS_PER_DAY) * STEP_HOURS;
}

export function positionForIndex(index: number, gap: number): number {
  return index * gap;
}

export interface MomentumState {
  position: number;
  velocity: number;
}

/**
 * One frame of inertia. Returns the next state; `settled` is true when the
 * caller should snap to `target` and stop.
 */
export function momentumStep(
  state: MomentumState,
  gap: number,
  min: number,
  max: number,
): { position: number; velocity: number; target: number | null } {
  let { position, velocity } = state;

  if (position > max) {
    position += (max - position) * 0.18;
    velocity *= 0.55;
    if (Math.abs(position - max) < 0.4 && Math.abs(velocity) < 0.25) {
      return { position: max, velocity: 0, target: null };
    }
    return { position, velocity, target: null };
  }

  if (position < min) {
    position += (min - position) * 0.18;
    velocity *= 0.55;
    if (Math.abs(position - min) < 0.4 && Math.abs(velocity) < 0.25) {
      return { position: min, velocity: 0, target: null };
    }
    return { position, velocity, target: null };
  }

  velocity *= 0.93;
  position += velocity;

  if (Math.abs(velocity) < 0.4) {
    const target = clampPosition(snapIndex(position, gap, Math.round(max / gap)) * gap, min, max);
    position += (target - position) * 0.25;
    if (Math.abs(target - position) < 0.25 && Math.abs(velocity) < 0.12) {
      return { position: target, velocity: 0, target };
    }
    return { position, velocity, target: null };
  }

  return { position, velocity, target: null };
}

/** Instantaneous drag velocity in tape pixels per 16 ms frame. */
export function dragVelocity(previous: number, deltaX: number, deltaMs: number): number {
  const frame = Math.max(6, deltaMs) / 16;
  const next = -deltaX / frame;
  return clamp(previous * 0.4 + next * 0.6, -34, 34);
}

export interface TapeOptions {
  viewport: HTMLElement;
  tape: HTMLElement;
  gap?: number;
  stepCount?: number;
  initialIndex?: number;
  labelForIndex?: (index: number) => string;
  onInput?: (index: number, hour: number, position: number) => void;
  onSettle?: (index: number, hour: number) => void;
  onScrollingChange?: (scrolling: boolean) => void;
  liveIndex?: number | null;
  /** Last reachable step. Home uses the current live step; detail uses 96. */
  maxIndex?: number;
  /** Unique id for the green checkpoint (Home and detail each own one). */
  liveDotId?: string;
}

export class Tape {
  private readonly viewport: HTMLElement;
  private readonly tape: HTMLElement;
  private readonly gap: number;
  private readonly stepCount: number;
  private readonly labelForIndex: (index: number) => string;
  private readonly onInput: TapeOptions["onInput"];
  private readonly onSettle: TapeOptions["onSettle"];
  private readonly onScrollingChange: TapeOptions["onScrollingChange"];
  private readonly reducedMotion = prefersReducedMotion();
  private readonly ticks: HTMLElement[] = [];
  private readonly tickElements: HTMLElement[] = [];
  private readonly liveDotId: string;
  private liveDot: HTMLElement | null = null;
  private liveIndexValue: number | null = null;

  private position: number;
  private lastIndex = -1;
  private velocity = 0;
  private dragging = false;
  private dragStartX = 0;
  private dragStartPosition = 0;
  private lastX = 0;
  private lastTime = 0;
  private pointerId: number | null = null;
  private frameId: number | null = null;
  private pendingPosition: number | null = null;
  private pendingFrame: number | null = null;
  private lastSettledIndex = -1;
  private readonly min = 0;
  private max: number;
  private maxIndexValue: number;

  constructor(options: TapeOptions) {
    this.viewport = options.viewport;
    this.tape = options.tape;
    this.gap = options.gap ?? 14;
    this.stepCount = options.stepCount ?? STEPS_PER_DAY;
    this.liveDotId = options.liveDotId ?? "ruler-live-dot";
    this.maxIndexValue = clamp(options.maxIndex ?? this.stepCount, 0, this.stepCount);
    this.max = this.maxIndexValue * this.gap;
    this.labelForIndex = options.labelForIndex ?? defaultLabel;
    this.onInput = options.onInput;
    this.onSettle = options.onSettle;
    this.onScrollingChange = options.onScrollingChange;

    const initial = clamp(options.initialIndex ?? 0, 0, this.maxIndexValue);
    this.position = initial * this.gap;

    this.buildTicks();
    this.setMaxIndex(this.maxIndexValue);
    this.bind();
    if (options.liveIndex !== undefined) this.setLiveIndex(options.liveIndex);
    this.render(this.position, true, false);
    this.setIndex(initial, { animate: false, silent: true });
  }

  get currentIndex(): number {
    return snapIndex(this.position, this.gap, this.maxIndexValue);
  }

  /** True when the tape is parked exactly on the step, with no residual motion. */
  isSettledAt(index: number): boolean {
    return this.currentIndex === index && Math.abs(this.position - index * this.gap) < 0.5;
  }

  get currentHour(): number {
    return hourForIndex(this.currentIndex);
  }

  /** Future steps are removed from reach when the live time advances. */
  setMaxIndex(index: number): void {
    const next = clamp(Math.round(index), 0, this.stepCount);
    this.maxIndexValue = next;
    this.max = next * this.gap;
    this.viewport.setAttribute("aria-valuemax", String(next * 15));
    this.tickElements.forEach((tick, tickIndex) => {
      const disabled = tickIndex > next;
      tick.classList.toggle("is-disabled", disabled);
      tick.setAttribute("aria-disabled", disabled ? "true" : "false");
    });
    if (this.position > this.max) {
      this.cancel();
      this.render(this.max, true, false);
    }
  }

  setInk(ink: string, idle: string): void {
    this.tape.style.setProperty("--tape-ink", ink);
    this.tape.style.setProperty("--tape-idle", idle);
  }

  /** Places the green live checkpoint under a step, preview-style. */
  setLiveIndex(index: number | null): void {
    if (index === null || !Number.isFinite(index)) {
      this.liveDot?.remove();
      this.liveDot = null;
      this.liveIndexValue = null;
      this.render(this.position, true, false);
      return;
    }
    const targetIndex = clamp(Math.round(index), 0, this.stepCount);
    this.liveIndexValue = targetIndex;
    if (!this.liveDot) {
      const dot = document.createElement("div");
      dot.id = this.liveDotId;
      dot.className = "ruler-live-dot";
      dot.setAttribute("aria-hidden", "true");
      this.liveDot = dot;
    }
    for (const tick of this.tickElements) tick.classList.remove("is-live");
    const tick = this.tickElements[targetIndex];
    if (tick) {
      tick.classList.add("is-live");
      tick.appendChild(this.liveDot);
      this.liveDot.style.top = "calc(50% + 15px)";
    }
    this.render(this.position, true, false);
  }

  setTone(tone: "light" | "dark"): void {
    if (tone === "light") {
      this.setInk("#0B0D12", "rgba(11, 13, 18, 0.35)");
    } else {
      this.setInk("#FFFFFF", "rgba(255, 255, 255, 0.52)");
    }
  }

  setIndex(index: number, options: { animate?: boolean; silent?: boolean } = {}): void {
    this.cancel();
    const target = clamp(Math.round(index), 0, this.maxIndexValue);
    const targetPosition = target * this.gap;
    if (options.animate && !this.reducedMotion) {
      this.animateTo(targetPosition);
      return;
    }
    this.render(targetPosition, true, false);
    if (!options.silent) {
      this.emitInput();
      this.lastSettledIndex = target;
      this.emitSettle(true);
    }
  }

  scrollToHour(hour: number, animate = true): void {
    this.setIndex(Math.min(indexForHour(hour), this.maxIndexValue), { animate });
  }

  private buildTicks(): void {
    for (let index = 0; index <= this.stepCount; index += 1) {
      const tick = document.createElement("div");
      tick.className = "ruler-tick";
      tick.style.left = `${index * this.gap}px`;
      tick.setAttribute("aria-hidden", "true");
      tick.dataset.index = String(index);
      tick.title = this.labelForIndex(index);
      const bar = document.createElement("div");
      bar.className = "ruler-bar";
      tick.appendChild(bar);
      tick.addEventListener("click", (event) => {
        event.stopPropagation();
        if (index > this.maxIndexValue) return;
        this.cancel();
        this.setIndex(index, { animate: true });
      });
      this.tape.appendChild(tick);
      this.ticks.push(bar);
      this.tickElements.push(tick);
    }
  }

  private bind(): void {
    this.viewport.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    this.viewport.addEventListener("pointermove", this.onPointerMove, { passive: true });
    this.viewport.addEventListener("pointerup", this.onPointerUp);
    this.viewport.addEventListener("pointercancel", this.onPointerUp);
    this.viewport.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.reducedMotion) return;
        this.cancel(false);
        const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
        this.velocity = clamp(this.velocity + delta * 0.12, -26, 26);
        this.onScrollingChange?.(true);
        this.startMomentum();
      },
      { passive: false },
    );
    this.viewport.addEventListener("keydown", this.onKeyDown);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    this.cancel();
    this.dragging = true;
    this.velocity = 0;
    this.dragStartX = event.clientX;
    this.lastX = event.clientX;
    this.lastTime = performance.now();
    this.dragStartPosition = this.position;
    this.pointerId = event.pointerId;
    this.viewport.setPointerCapture?.(event.pointerId);
    this.viewport.classList.add("is-dragging");
    this.onScrollingChange?.(true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const now = performance.now();
    const dx = event.clientX - this.lastX;
    this.velocity = dragVelocity(this.velocity, dx, now - this.lastTime);
    this.lastX = event.clientX;
    this.lastTime = now;

    const raw = this.dragStartPosition - (event.clientX - this.dragStartX);
    const next = clampWithResistance(raw, this.min, this.max);
    this.schedule(next);
  };

  private readonly onPointerUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.viewport.classList.remove("is-dragging");
    if (this.pointerId !== null) {
      try {
        this.viewport.releasePointerCapture(this.pointerId);
      } catch {
        // pointer already released by the browser
      }
      this.pointerId = null;
    }

    if (this.reducedMotion) {
      this.settleNow();
      return;
    }

    this.velocity = clamp(this.velocity, -30, 30);
    if (this.position > this.max || this.position < this.min) {
      this.startSpringBack();
      return;
    }
    this.startMomentum();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const current = this.currentIndex;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + 1;
        break;
      case "PageDown":
        next = current - 4;
        break;
      case "PageUp":
        next = current + 4;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = this.maxIndexValue;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.setIndex(clamp(next, 0, this.maxIndexValue), { animate: true });
  };

  private schedule(position: number): void {
    this.pendingPosition = position;
    if (this.pendingFrame !== null) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      if (this.pendingPosition === null) return;
      this.render(this.pendingPosition);
      this.pendingPosition = null;
    });
  }

  private startSpringBack(): void {
    const { boundary } = springBackTarget(this.position, this.min, this.max, this.velocity);
    this.onScrollingChange?.(true);
    this.cancel(false);

    if (this.reducedMotion) {
      this.position = boundary;
      this.velocity = 0;
      this.render(boundary, true, false);
      this.onScrollingChange?.(false);
      this.emitSettle(false);
      return;
    }

    const startedAt = performance.now();
    let last = startedAt;
    let state = { position: this.position, velocity: this.velocity * 60 };

    const frame = (now: number): void => {
      if (this.dragging) return;
      const elapsed = now - startedAt;
      if (elapsed >= SPRING_BACK_DURATION_MS) {
        this.position = boundary;
        this.velocity = 0;
        this.render(boundary, true);
        this.onScrollingChange?.(false);
        this.emitSettle(false);
        return;
      }

      state = springBackFrame(state, boundary, (now - last) / 1000);
      last = now;
      this.position = state.position;
      this.velocity = state.velocity / 60;
      this.render(this.position);
      this.frameId = requestAnimationFrame(frame);
    };

    this.frameId = requestAnimationFrame(frame);
  }

  private startMomentum(): void {
    this.cancel(false);
    const frame = (): void => {
      if (this.dragging) return;
      const next = momentumStep({ position: this.position, velocity: this.velocity }, this.gap, this.min, this.max);
      this.position = next.position;
      this.velocity = next.velocity;
      this.render(this.position);

      if (next.target !== null || (Math.abs(this.velocity) < 0.02 && this.position === next.position)) {
        this.finishMomentum();
        return;
      }
      this.frameId = requestAnimationFrame(frame);
    };
    this.frameId = requestAnimationFrame(frame);
  }

  private animateTo(target: number): void {
    this.onScrollingChange?.(true);
    const frame = (): void => {
      const diff = target - this.position;
      if (Math.abs(diff) < 0.35) {
        this.render(target, true);
        this.finishMomentum();
        return;
      }
      this.position += diff * 0.22;
      this.render(this.position);
      this.frameId = requestAnimationFrame(frame);
    };
    this.frameId = requestAnimationFrame(frame);
  }

  private finishMomentum(): void {
    this.cancel(false);
    const index = this.currentIndex;
    this.render(index * this.gap, true);
    this.onScrollingChange?.(false);
    this.emitSettle(false);
  }

  private settleNow(): void {
    this.cancel();
    const index = this.currentIndex;
    this.render(index * this.gap, true);
    this.onScrollingChange?.(false);
    this.emitSettle(false);
  }

  private cancel(stopScrolling = true): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
    this.frameId = null;
    this.pendingFrame = null;
    this.pendingPosition = null;
    if (stopScrolling) this.onScrollingChange?.(false);
  }

  private render(position: number, force = false, emit = true): void {
    const clamped = position;
    this.position = clamped;
    // The only per-frame write: the tape itself moves on the compositor.
    this.tape.style.transform = `translateX(${-clamped}px)`;

    const index = snapIndex(clamped, this.gap, this.maxIndexValue);
    if (index !== this.lastIndex || force) {
      const previousIndex = this.lastIndex;
      this.lastIndex = index;
      const label = this.labelForIndex(index);
      const atLive = this.liveIndexValue !== null && index === this.liveIndexValue;
      this.viewport.setAttribute("aria-valuenow", String(index * 15));
      this.viewport.setAttribute("aria-valuetext", atLive ? `${label} · Live` : label);
      if (emit) this.emitInput();

      // Class state only changes when the centred index changes. Never size
      // bars inline per frame: transform/opacity stay on the compositor.
      for (let offset = -5; offset <= 5; offset += 1) {
        const tick = this.tickElements[previousIndex + offset];
        if (tick) tick.classList.remove("is-active", "is-near");
      }
      for (let offset = -5; offset <= 5; offset += 1) {
        const tick = this.tickElements[index + offset];
        if (!tick) continue;
        tick.classList.toggle("is-active", offset === 0);
        tick.classList.toggle("is-near", offset !== 0);
      }
    }

    if (this.liveDot && this.liveIndexValue !== null) {
      const current = this.tickElements[this.liveIndexValue];
      current?.classList.toggle("is-current", index === this.liveIndexValue);
    }
  }

  private emitInput(): void {
    const index = this.currentIndex;
    this.onInput?.(index, hourForIndex(index), this.position);
  }

  private emitSettle(force: boolean): void {
    const index = this.currentIndex;
    if (!force && index === this.lastSettledIndex) {
      this.onSettle?.(index, hourForIndex(index));
      return;
    }
    this.lastSettledIndex = index;
    this.onSettle?.(index, hourForIndex(index));
  }
}

function defaultLabel(index: number): string {
  const hour = hourForIndex(index);
  const hours = Math.floor(hour);
  const minutes = Math.round((hour - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
