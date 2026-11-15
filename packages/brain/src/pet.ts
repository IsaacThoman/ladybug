// How the desktop pet acts on the commands, reduced to what the brain's
// behaviour statistics need. The thresholds mirror
// apps/desktop/src/brain/behavior.ts (which this package can't import); if
// they change there, change them here.

import type { BrainCommand } from "./types.ts";

export const PET = {
  /** 1/s; how quickly the pet's smoothed command follows the brain. */
  smoothing: 12,
  walkOn: 0.3,
  walkOff: 0.15,
  backOn: 0.3,
  backOff: 0.15,
  backMargin: 0.15,
  /** turn × seconds that turns it around, and how fast that leaks (1/s). */
  turnThreshold: 0.5,
  turnLeak: 0.5,
  escapeOn: 0.5,
  escapeRearm: 0.3,
  /** s between take-offs. */
  escapeRefractory: 1.5,
} as const;

export type PetTally = {
  seconds: number;
  /** Seconds spent walking forwards, and the number of separate bouts. */
  walking: number;
  walkBouts: number;
  backing: number;
  backBouts: number;
  /** Turn-arounds toward the fly's left and right. */
  turnsLeft: number;
  turnsRight: number;
  escapes: number;
  /** Highest raw value of each command. */
  peak: BrainCommand;
};

const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Feeds commands through the pet's thresholds and counts what it would do (always free to move, on its feet). */
export class PetObserver {
  readonly tally: PetTally = {
    seconds: 0,
    walking: 0,
    walkBouts: 0,
    backing: 0,
    backBouts: 0,
    turnsLeft: 0,
    turnsRight: 0,
    escapes: 0,
    peak: { walk: 0, turn: 0, back: 0, escape: 0, wings: 0, groom: 0, feed: 0 },
  };
  #smoothed: { walk: number; turn: number; back: number } | null = null;
  #walking = false;
  #backing = false;
  #turned = 0;
  #armed = false;
  #refractory = 0;

  /** One update of `dt` seconds with the brain's latest command. */
  observe(command: BrainCommand, dt: number) {
    const t = this.tally;
    t.seconds += dt;
    for (const key of Object.keys(t.peak) as (keyof BrainCommand)[]) {
      t.peak[key] = key === "turn" ? (Math.abs(command.turn) > Math.abs(t.peak.turn) ? command.turn : t.peak.turn) : Math.max(t.peak[key], command[key]);
    }
    if (!this.#smoothed) this.#smoothed = { walk: command.walk, turn: command.turn, back: command.back };
    else for (const key of ["walk", "turn", "back"] as const) this.#smoothed[key] += (command[key] - this.#smoothed[key]) * ease(PET.smoothing, dt);
    const { walk, turn, back } = this.#smoothed;

    this.#refractory = Math.max(0, this.#refractory - dt);
    if (command.escape < PET.escapeRearm) this.#armed = true;
    if (this.#armed && this.#refractory <= 0 && command.escape >= PET.escapeOn) {
      this.#armed = false;
      this.#refractory = PET.escapeRefractory;
      this.#turned = 0;
      t.escapes++;
    }

    const wasWalking = this.#walking && !this.#backing;
    const wasBacking = this.#backing;
    this.#walking = this.#walking ? walk >= PET.walkOff : walk > PET.walkOn;
    this.#backing = this.#backing ? back >= PET.backOff && back >= walk : back > PET.backOn && back > walk + PET.backMargin;
    const walkingNow = this.#walking && !this.#backing;
    if (walkingNow) {
      t.walking += dt;
      if (!wasWalking) t.walkBouts++;
    }
    if (this.#backing) {
      t.backing += dt;
      if (!wasBacking) t.backBouts++;
    }

    this.#turned = this.#turned * (1 - ease(PET.turnLeak, dt)) + turn * dt;
    if (Math.abs(this.#turned) >= PET.turnThreshold) {
      if (this.#turned > 0) t.turnsRight++;
      else t.turnsLeft++;
      this.#turned = 0;
    }
  }
}
