import { FlyBehavior } from "./behavior.ts";
import type { BrainAct } from "./behavior.ts";
import type { BrainClient } from "./client.ts";
import { BUMP_SLOP, SenseTracker } from "./senses.ts";
import type { PetMode } from "./senses.ts";
import { Vision } from "./vision.ts";
import type { ViewInput } from "./vision.ts";
import type { EatingSpot } from "../food.ts";

/** What the eyes need to know about the bug's world each frame; see ViewInput. */
export type FrameScene = Pick<ViewInput, "width" | "height" | "ledgeY" | "yaw" | "sprite" | "berry" | "ball">;

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
  /** A berry the bug is touching, and where it would stand to eat it; see BehaviorInput. */
  food?: EatingSpot | null;
  /** The world around the bug, for its eyes. Without it, it can't see. */
  scene?: FrameScene;
};

/**
 * Starts capturing the screen into `vision`'s wall, and returns what stops it.
 * `ended` is called if it stops by itself: `failed` when it couldn't capture,
 * otherwise because nothing has looked for a while.
 */
export type ScreenCapture = (vision: Vision, ended: (failed: boolean) => void) => () => void;

/**
 * The fly brain as the pet sees it: what the bug goes through goes in each
 * frame, and what the brain wants done comes out. Everything here is a no-op
 * while the brain is off, unavailable or failed.
 */
export class FlyBrain {
  readonly client: BrainClient;
  readonly vision = new Vision();
  private behavior: FlyBehavior;
  private senses = new SenseTracker();
  private active = false;
  private cursor: { x: number; y: number } | null = null;
  private hovered = false;
  private linkOver = false;
  private fed = false;
  /** Fly Eyes is on; `capture` is how to see the screen, or null for the plain wall. */
  private eyes: { capture: ScreenCapture | null } | null = null;
  private stopCapture: (() => void) | null = null;
  private captureFailed = false;
  private view: ViewInput = {
    now: 0, width: 0, height: 0, ledgeY: 0, centreX: 0, feetY: 0, yaw: 0,
    sprite: { x: 0, y: 0, width: 0, height: 0 }, berry: null, ball: null, cursor: null,
  };

  constructor(client: BrainClient, behavior: ConstructorParameters<typeof FlyBehavior>[0]) {
    this.client = client;
    this.behavior = new FlyBehavior(behavior);
  }

  setCursor(point: { x: number; y: number } | null) { this.cursor = point; }
  setHovered(hovered: boolean) { this.hovered = hovered; }
  setLinkOver(linkOver: boolean) { this.linkOver = linkOver; }
  /** A link was dropped on the bug. */
  feed() { this.fed = true; }

  /**
   * Fly Eyes on or off (null). While it's on and the brain has eyes, they see
   * the screen through `capture`, or a plain wall without it, and the cursor
   * is something they see rather than a looming sense of its own.
   */
  setEyes(eyes: { capture: ScreenCapture | null } | null) {
    this.endCapture();
    this.captureFailed = false;
    this.eyes = eyes;
    this.vision.reset();
  }

  /** The eyes the brain is seeing with right now, or null when it isn't. */
  seeing() {
    const eyes = this.eyes ? this.client.eyes : null;
    return eyes && this.vision.eyes === eyes ? this.vision : null;
  }

  /** What the brain wants done this frame, or null to carry on as without it. */
  frame({ now, dt, pet, bounds, held, free, asleep = false, food = null, scene }: FrameInput): BrainAct | null {
    const { status } = this.client;
    if (asleep || (status !== "loading" && status !== "running")) {
      if (this.active) {
        this.active = false;
        this.senses = new SenseTracker();
        this.behavior.update({ command: null, ageMs: Infinity, dt, heading: pet.heading, free, onFeet: true, blocked: false, loomLeft: 0, loomRight: 0 });
      }
      this.endCapture();
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
      food: food !== null,
    });
    this.fed = false;
    let loom = { left: senses.loomLeft, right: senses.loomRight };
    const eyes = this.eyes && scene ? this.client.eyes : null;
    if (eyes && scene) {
      const view = this.view;
      Object.assign(view, scene);
      view.now = now;
      view.centreX = pet.x + pet.width / 2;
      view.feetY = pet.y + pet.height;
      view.cursor = this.cursor;
      this.vision.track(view);
      this.startCapture();
      // The cursor is something the eyes see now, not a sense of its own.
      senses.loomLeft = 0;
      senses.loomRight = 0;
      // Only worth looking when the brain is ready for what they see.
      if (this.client.ready) senses.light = this.vision.look(eyes, view);
      loom = this.vision.startle;
    } else {
      this.endCapture();
    }
    this.client.tick(dt * 1000, senses);
    const state = this.client.state;
    return this.behavior.update({
      command: state?.command ?? null,
      ageMs: now - this.client.stateAt,
      dt,
      heading: pet.heading,
      free,
      onFeet: pet.mode === "idle" || pet.mode === "walking",
      blocked: pet.heading === 1 ? pet.x >= bounds.maxX - BUMP_SLOP : pet.x <= bounds.minX + BUMP_SLOP,
      loomLeft: loom.left,
      loomRight: loom.right,
      food,
    });
  }

  private startCapture() {
    const capture = this.eyes?.capture;
    if (!capture || this.stopCapture || this.captureFailed) return;
    let current = true;
    const stopCapture = () => { current = false; stop(); };
    const stop = capture(this.vision, (failed) => {
      if (!current) return;
      current = false;
      if (this.stopCapture === stopCapture) this.stopCapture = null;
      if (failed) this.captureFailed = true;
    });
    if (current) this.stopCapture = stopCapture;
  }

  private endCapture() {
    const stop = this.stopCapture;
    this.stopCapture = null;
    stop?.();
  }
}
