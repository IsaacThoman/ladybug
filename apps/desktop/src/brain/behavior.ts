// What the pet does with the fly brain's commands.
//
// The pet lives on a line and stands facing the viewer, so the fly's left is
// the right of the screen: a turn toward its left heads it right, and a turn
// toward its right heads it left.
import type { BrainCommand } from "@ladybug/brain";

export type BehaviorInput = {
  /** The latest command, or null when there isn't one. */
  command: BrainCommand | null;
  /** How old `command` is, in ms. */
  ageMs: number;
  /** Seconds since the last update. */
  dt: number;
  heading: 1 | -1;
  /**
   * The brain may move the bug this frame: it's on its feet and nothing the
   * product does (a bubble, a reaction, a menu, a drag) is holding it.
   */
  free: boolean;
  /** Standing or walking, rather than held or in the air. */
  onFeet: boolean;
  /** Pressed against an edge of its world that it's facing. */
  blocked: boolean;
  /** What the eyes see looming now, to jump away from it. */
  loomLeft: number;
  loomRight: number;
};

export type BrainAct = {
  /** Walk at this on-screen velocity (px/s), or 0 to stand. Always 0 unless free. */
  vx: number;
  /** Which way the bug faces. Walking backwards moves opposite to it. */
  heading: 1 | -1;
  /** Take off with this velocity (px/s). Only when free. */
  jump: { vx: number; vy: number } | null;
  /** 0 to 1, for the pose. */
  wings: number;
  groom: number;
};

/** Older commands are treated as absent: the brain has fallen behind or stopped. */
export const COMMAND_STALE_MS = 500;
/** How quickly (1/s) the smoothed command follows the brain; it arrives at uneven intervals. */
const COMMAND_SMOOTHING = 12;
/** Starts walking above WALK_ON and stops below WALK_OFF. */
export const WALK_ON = 0.3;
export const WALK_OFF = 0.15;
/** Walking speed, as a share of the pet's walking speed, at no drive and at full drive. */
export const WALK_SLOWEST = 0.5;
export const WALK_FASTEST = 1.6;
/** Backs up when `back` passes BACK_ON and beats `walk` by BACK_MARGIN; stops below BACK_OFF or once `walk` catches up. */
export const BACK_ON = 0.3;
export const BACK_OFF = 0.15;
export const BACK_MARGIN = 0.15;
/** Backing speed, as a share of the walking speed (the same as backing away from a dangerous page). */
export const BACK_SPEED = 0.6;
/** Accumulated turn (turn × seconds) that turns the bug around. It leaks away at TURN_LEAK (1/s), so noise doesn't add up. */
export const TURN_THRESHOLD = 0.5;
export const TURN_LEAK = 0.5;
/** Takes off when `escape` rises past ESCAPE_ON; it has to fall below ESCAPE_REARM first to go again. */
export const ESCAPE_ON = 0.5;
export const ESCAPE_REARM = 0.3;
/** Seconds after a take-off before another. */
export const ESCAPE_REFRACTORY = 1.5;
/**
 * Pressed against an edge it faces for this long (s), the bug turns around by
 * itself. The brain feels the edge on its antenna, but nothing in the model
 * turns it away, so the body does.
 */
export const EDGE_PATIENCE = 2;
/** Sideways speed (px/s) of a take-off, from the weakest to the strongest. */
export const ESCAPE_SIDE_SPEED = [220, 480] as const;

/**
 * Wings and grooming below this are the brain idling, not an action: the pose
 * gets nothing, and what's above is stretched back over 0 to 1.
 */
export const POSE_FLOOR = 0.2;
const posed = (value: number) => Math.max(0, (value - POSE_FLOOR) / (1 - POSE_FLOOR));

/**
 * A grooming bout outlasts the command that started it, fading over about
 * this long (s) once the bug is on its feet: the brain's grooming neurons fire
 * while the wind blows and fall silent as soon as it drops, where a fly cleans
 * up after it lands.
 */
export const GROOM_LINGER = 1.5;

/** `feed` has no action in the pet; it only shows in the activity panel. */
type Smoothed = Omit<BrainCommand, "escape" | "feed">;
const CHANNELS = ["walk", "turn", "back", "wings", "groom"] as const;

const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0);
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Turns the brain's latest command into what the pet does this frame. */
export class FlyBehavior {
  private walkSpeed: number;
  private hopVelocity: number;
  private jumpVelocity: number;
  private smoothed: Smoothed | null = null;
  private walking = false;
  private backing = false;
  private turned = 0;
  private pressed = 0;
  private grooming = 0;
  private armed = false;
  private refractory = 0;

  constructor({ walkSpeed, hopVelocity, jumpVelocity }: {
    /** The pet's walking speed (px/s). */
    walkSpeed: number;
    /** Upward launch (negative px/s) of the gentlest and the strongest take-off. */
    hopVelocity: number;
    jumpVelocity: number;
  }) {
    this.walkSpeed = walkSpeed;
    this.hopVelocity = hopVelocity;
    this.jumpVelocity = jumpVelocity;
  }

  /** What to do this frame, or null when there's no fresh command and the pet should behave as it does without a brain. */
  update({ command, ageMs, dt: rawDt, heading, free, onFeet, blocked, loomLeft, loomRight }: BehaviorInput): BrainAct | null {
    const dt = Number.isFinite(rawDt) ? Math.max(0, rawDt) : 0;
    this.refractory = Math.max(0, this.refractory - dt);
    if (!command || !(ageMs <= COMMAND_STALE_MS)) {
      this.smoothed = null;
      this.walking = false;
      this.backing = false;
      this.turned = 0;
      this.pressed = 0;
      this.grooming = 0;
      this.armed = false;
      return null;
    }

    const target: Smoothed = {
      walk: clamp(command.walk, 0, 1),
      turn: clamp(command.turn, -1, 1),
      back: clamp(command.back, 0, 1),
      wings: clamp(command.wings, 0, 1),
      groom: clamp(command.groom, 0, 1),
    };
    if (!this.smoothed) this.smoothed = target;
    else for (const channel of CHANNELS) this.smoothed[channel] += (target[channel] - this.smoothed[channel]) * ease(COMMAND_SMOOTHING, dt);
    const { walk, turn, back } = this.smoothed;
    const wings = posed(this.smoothed.wings);
    const asked = posed(this.smoothed.groom);
    if (asked >= this.grooming) this.grooming = asked;
    else if (onFeet) this.grooming += (asked - this.grooming) * ease(3 / GROOM_LINGER, dt);
    if (this.grooming < 0.01) this.grooming = 0;
    const groom = this.grooming;

    // Escape is a brief burst from the giant fiber, so it's read unsmoothed.
    const escape = clamp(command.escape, 0, 1);
    if (escape < ESCAPE_REARM) this.armed = true;

    this.walking = this.walking ? walk >= WALK_OFF : walk > WALK_ON;
    this.backing = this.backing ? back >= BACK_OFF && back >= walk : back > BACK_ON && back > walk + BACK_MARGIN;

    if (!free) {
      this.turned = 0;
      this.pressed = 0;
      return { vx: 0, heading, jump: null, wings, groom };
    }

    if (this.armed && this.refractory <= 0 && escape >= ESCAPE_ON) {
      this.armed = false;
      this.refractory = ESCAPE_REFRACTORY;
      this.turned = 0;
      this.pressed = 0;
      const strength = clamp((escape - ESCAPE_ON) / (1 - ESCAPE_ON), 0, 1);
      // Away from the eye that saw it coming: the left eye looks at the right of the screen.
      const away = loomLeft > loomRight ? -1 : loomRight > loomLeft ? 1 : heading;
      const side = ESCAPE_SIDE_SPEED[0] + (ESCAPE_SIDE_SPEED[1] - ESCAPE_SIDE_SPEED[0]) * strength;
      return {
        vx: 0,
        heading: away,
        jump: { vx: away * side, vy: this.hopVelocity + (this.jumpVelocity - this.hopVelocity) * strength },
        wings,
        groom,
      };
    }

    this.turned = this.turned * (1 - ease(TURN_LEAK, dt)) + turn * dt;
    let next = heading;
    if (Math.abs(this.turned) >= TURN_THRESHOLD) {
      // Toward the fly's right (positive) is toward the left of the screen.
      next = this.turned > 0 ? -1 : 1;
      this.turned = 0;
    }
    this.pressed = blocked && next === heading ? this.pressed + dt : 0;
    if (this.pressed >= EDGE_PATIENCE) {
      next = heading === 1 ? -1 : 1;
      this.pressed = 0;
      this.turned = 0;
    }

    const vx = this.backing
      ? -next * this.walkSpeed * BACK_SPEED
      : this.walking
        ? next * this.walkSpeed * (WALK_SLOWEST + (WALK_FASTEST - WALK_SLOWEST) * walk)
        : 0;
    return { vx, heading: next, jump: null, wings, groom };
  }
}
