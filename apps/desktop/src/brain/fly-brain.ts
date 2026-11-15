import { FlyBehavior } from "./behavior.ts";
import type { BrainAct } from "./behavior.ts";
import type { BrainClient } from "./client.ts";
import { BUMP_SLOP, SenseTracker } from "./senses.ts";
import type { PetMode } from "./senses.ts";

export type FrameInput = {
  /** performance.now() time of this frame. */
  now: number;
  /** Seconds since the last frame. */
  dt: number;
  pet: { x: number; y: number; width: number; height: number; mode: PetMode; heading: 1 | -1 };
  bounds: { minX: number; maxX: number };
  /** The pet is pressed or being dragged. */
  held: boolean;
  /** Nothing but the brain wants to move the bug this frame; see BehaviorInput. */
  free: boolean;
  /** The pet is asleep in bed: the brain rests too, and picks up where it left off. */
  asleep?: boolean;
};

/**
 * The fly brain as the pet sees it: what the bug goes through goes in each
 * frame, and what the brain wants done comes out. Everything here is a no-op
 * while the brain is off, unavailable or failed.
 */
export class FlyBrain {
  readonly client: BrainClient;
  private behavior: FlyBehavior;
  private senses = new SenseTracker();
  private active = false;
  private cursor: { x: number; y: number } | null = null;
  private hovered = false;
  private linkOver = false;
  private fed = false;

  constructor(client: BrainClient, behavior: ConstructorParameters<typeof FlyBehavior>[0]) {
    this.client = client;
    this.behavior = new FlyBehavior(behavior);
  }

  setCursor(point: { x: number; y: number } | null) { this.cursor = point; }
  setHovered(hovered: boolean) { this.hovered = hovered; }
  setLinkOver(linkOver: boolean) { this.linkOver = linkOver; }
  /** A link was dropped on the bug. */
  feed() { this.fed = true; }

  /** What the brain wants done this frame, or null to carry on as without it. */
  frame({ now, dt, pet, bounds, held, free, asleep = false }: FrameInput): BrainAct | null {
    const { status } = this.client;
    if (asleep || (status !== "loading" && status !== "running")) {
      if (this.active) {
        this.active = false;
        this.senses = new SenseTracker();
        this.behavior.update({ command: null, ageMs: Infinity, dt, heading: pet.heading, free, blocked: false, loomLeft: 0, loomRight: 0 });
      }
      this.fed = false;
      return null;
    }
    this.active = true;
    const senses = this.senses.update({
      dt,
      pet,
      bounds,
      cursor: this.cursor,
      hovered: this.hovered,
      held,
      linkOver: this.linkOver,
      fed: this.fed,
    });
    this.fed = false;
    this.client.tick(dt * 1000, senses);
    const state = this.client.state;
    return this.behavior.update({
      command: state?.command ?? null,
      ageMs: now - this.client.stateAt,
      dt,
      heading: pet.heading,
      free,
      blocked: pet.heading === 1 ? pet.x >= bounds.maxX - BUMP_SLOP : pet.x <= bounds.minX + BUMP_SLOP,
      loomLeft: senses.loomLeft,
      loomRight: senses.loomRight,
    });
  }
}
