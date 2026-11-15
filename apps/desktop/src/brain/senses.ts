// What the pet goes through, as the fly brain's senses.
//
// Body frame: the ladybug stands facing the viewer, so the fly's left is the
// right side of the screen and its right is the left side. Something coming
// from the right of the screen looms in its left eye, and the left edge of the
// screen presses on its right antenna.
import type { BrainSenses } from "@ladybug/brain";

export type PetMode = "idle" | "walking" | "airborne" | "dragging";

export type SenseInput = {
  /** Seconds since the last update. */
  dt: number;
  /** The pet's hit box (top-left corner and size) and what it's doing. */
  pet: { x: number; y: number; width: number; height: number; mode: PetMode; heading: 1 | -1 };
  /** The range the hit box's x moves in. */
  bounds: { minX: number; maxX: number };
  /** The cursor, in the same coordinates, or null when unknown. */
  cursor: { x: number; y: number } | null;
  /** The pointer rests on the pet. */
  hovered: boolean;
  /** The pet is pressed or being dragged. */
  held: boolean;
  /** A link is being dragged over the pet. */
  linkOver: boolean;
  /** A link was dropped on the pet since the last update. */
  fed: boolean;
  /** A berry is under its feet or at its mouth. */
  food?: boolean;
};

/**
 * Closing speed (px/s) below which the cursor doesn't loom at all, and at
 * which it looms fully. The fly's giant fiber fires for almost any looming, so
 * these decide what the bug flees: a reach to click it or hand it a link has
 * slowed down by the time it's close, and a swat hasn't.
 */
export const LOOM_MIN_SPEED = 2500;
export const LOOM_FULL_SPEED = 5000;
/** The cursor looms only within this distance (px) of the bug's centre, fully within LOOM_NEAR. */
export const LOOM_RANGE = 350;
export const LOOM_NEAR = 60;
/** How quickly (1/s) the measured closing speed follows the cursor; it arrives in uneven steps. */
const LOOM_SMOOTHING = 25;
/** A loom is held this long (s) at its peak, then fades out over LOOM_DECAY. */
export const LOOM_HOLD = 0.08;
export const LOOM_DECAY = 0.2;
/** A cursor within this slope of straight above or below the bug looms in both eyes. */
export const LOOM_OVERHEAD_SLOPE = 0.35;
/** Touch while the pointer rests on the bug, and while it's held. */
export const TOUCH_HOVER = 0.4;
export const TOUCH_HELD = 1;
/** Touch and bump ease out over about this long (s) once they stop. */
export const RELEASE = 0.3;
/** Within this distance (px) of an edge of its bounds, the bug is pressed against it. */
export const BUMP_SLOP = 1;
/** Own speed (px/s) at which the wind is full. */
export const WIND_FULL_SPEED = 1500;
const WIND_SMOOTHING = 15;
/** A link dragged over the bug smells sweet; one dropped on it is a taste that fades over SWEET_FADE (s). */
export const SWEET_LINK_OVER = 0.5;
export const SWEET_FADE = 2;
/** A berry it's touching: flies taste with their feet as well as their mouthparts. */
export const SWEET_FOOD = 1;

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
/** Frame-rate independent smoothing factor. */
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
/** Follows a rising target at once and eases out toward a falling one over about `seconds`. */
function release(value: number, target: number, seconds: number, dt: number) {
  if (target >= value) return target;
  const next = value + (target - value) * ease(3 / seconds, dt);
  return next - target < 0.005 ? target : next;
}

type Eye = { value: number; hold: number };

/** Turns what the pet goes through each frame into the brain's senses. */
export class SenseTracker {
  private eyes = { left: { value: 0, hold: 0 } as Eye, right: { value: 0, hold: 0 } as Eye };
  private lastDistance: number | null = null;
  private closing = 0;
  private lastCentre: { x: number; y: number } | null = null;
  private touch = 0;
  private bumpLeft = 0;
  private bumpRight = 0;
  private wind = 0;
  private taste = 0;

  update({ dt: rawDt, pet, bounds, cursor, hovered, held, linkOver, fed, food = false }: SenseInput): BrainSenses {
    const dt = Number.isFinite(rawDt) ? Math.max(0, rawDt) : 0;
    const centre = { x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 };
    const dragged = held || pet.mode === "dragging";

    // Looming: the cursor closing in fast on the bug.
    let loom = 0;
    let side: "left" | "right" | "both" = "both";
    if (cursor && !dragged) {
      const dx = cursor.x - centre.x;
      const dy = cursor.y - centre.y;
      const distance = Math.hypot(dx, dy);
      if (this.lastDistance !== null && dt > 0) {
        this.closing += ((this.lastDistance - distance) / dt - this.closing) * ease(LOOM_SMOOTHING, dt);
      }
      this.lastDistance = distance;
      const speed = clamp01((this.closing - LOOM_MIN_SPEED) / (LOOM_FULL_SPEED - LOOM_MIN_SPEED));
      const proximity = clamp01((LOOM_RANGE - distance) / (LOOM_RANGE - LOOM_NEAR));
      // Squared: a near miss on either count barely looms.
      loom = (speed * proximity) ** 2;
      if (Math.abs(dx) > LOOM_OVERHEAD_SLOPE * Math.abs(dy)) side = dx > 0 ? "left" : "right";
    } else {
      this.lastDistance = null;
      this.closing = 0;
    }
    for (const eye of ["left", "right"] as const) {
      const state = this.eyes[eye];
      const seen = dragged ? 0 : side === "both" || side === eye ? loom : 0;
      if (dragged) {
        state.value = 0;
        state.hold = 0;
      } else if (seen >= state.value && seen > 0) {
        state.value = seen;
        state.hold = LOOM_HOLD;
      } else if (state.hold > 0) {
        state.hold = Math.max(0, state.hold - dt);
      } else {
        state.value = Math.max(seen, state.value - dt / LOOM_DECAY);
      }
    }

    this.touch = release(this.touch, dragged ? TOUCH_HELD : hovered ? TOUCH_HOVER : 0, RELEASE, dt);

    // Mirrored: the left edge of the screen is on the fly's right. Its antennae
    // lead the way, so it feels an edge it walks into or is thrown against, not
    // one it has turned its back on.
    const into = (edge: 1 | -1) => pet.mode === "airborne" || pet.heading === edge;
    this.bumpRight = release(this.bumpRight, pet.x <= bounds.minX + BUMP_SLOP && into(-1) ? 1 : 0, RELEASE, dt);
    this.bumpLeft = release(this.bumpLeft, pet.x >= bounds.maxX - BUMP_SLOP && into(1) ? 1 : 0, RELEASE, dt);

    // Wind: its own speed through the air, measured from where it actually went.
    let speed = 0;
    if (this.lastCentre && dt > 0) speed = Math.hypot(centre.x - this.lastCentre.x, centre.y - this.lastCentre.y) / dt;
    this.lastCentre = centre;
    const flying = pet.mode === "airborne" || dragged;
    this.wind += (clamp01(flying ? speed / WIND_FULL_SPEED : 0) - this.wind) * ease(WIND_SMOOTHING, dt);
    if (this.wind < 0.005) this.wind = 0;

    this.taste = fed ? 1 : Math.max(0, this.taste - dt / SWEET_FADE);

    return {
      loomLeft: clamp01(this.eyes.left.value),
      loomRight: clamp01(this.eyes.right.value),
      touch: clamp01(this.touch),
      bumpLeft: clamp01(this.bumpLeft),
      bumpRight: clamp01(this.bumpRight),
      wind: clamp01(this.wind),
      sweet: clamp01(Math.max(linkOver ? SWEET_LINK_OVER : 0, this.taste, food ? SWEET_FOOD : 0)),
      grounded: pet.mode === "idle" || pet.mode === "walking",
    };
  }
}
