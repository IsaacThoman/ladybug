import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainCommand } from "@ladybug/brain";
import {
  BACK_SPEED,
  COMMAND_STALE_MS,
  EDGE_PATIENCE,
  ESCAPE_REFRACTORY,
  ESCAPE_SIDE_SPEED,
  FlyBehavior,
  TURN_THRESHOLD,
  WALK_FASTEST,
  WALK_SLOWEST,
} from "./behavior.ts";
import type { BehaviorInput, BrainAct } from "./behavior.ts";
import { command } from "./test-helpers.ts";

const DT = 1 / 60;
const WALK_SPEED = 70;
const HOP = -650;
const JUMP = -1000;

const behavior = () => new FlyBehavior({ walkSpeed: WALK_SPEED, hopVelocity: HOP, jumpVelocity: JUMP });

function input(values: Partial<BrainCommand> | null, overrides: Partial<BehaviorInput> = {}): BehaviorInput {
  return { command: values ? command(values) : null, ageMs: 0, dt: DT, heading: 1, free: true, blocked: false, loomLeft: 0, loomRight: 0, ...overrides };
}

/** One update that must give an act. */
function step(fly: FlyBehavior, values: BehaviorInput): BrainAct {
  const act = fly.update(values);
  assert.ok(act);
  return act;
}

/** Runs the same command for a while, keeping the heading the behaviour picks. */
function hold(fly: FlyBehavior, values: Partial<BrainCommand>, seconds: number, overrides: Partial<BehaviorInput> = {}) {
  let heading = overrides.heading ?? 1;
  let act: BrainAct | null = null;
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    act = fly.update(input(values, { ...overrides, heading }));
    if (act) heading = act.heading;
  }
  return act!;
}

test("no command, or a stale one, leaves the pet to itself", () => {
  const fly = behavior();
  assert.equal(fly.update(input(null)), null);
  assert.notEqual(fly.update(input({ walk: 1 }, { ageMs: COMMAND_STALE_MS })), null);
  assert.equal(fly.update(input({ walk: 1 }, { ageMs: COMMAND_STALE_MS + 1 })), null);
  assert.equal(fly.update(input({ walk: 1 }, { ageMs: Number.NaN })), null);
});

test("walking has hysteresis, and speed scales with the drive", () => {
  const fly = behavior();
  assert.equal(hold(fly, { walk: 0.25 }, 1).vx, 0);
  const walking = hold(fly, { walk: 0.35 }, 1);
  assert.ok(Math.abs(walking.vx - WALK_SPEED * (WALK_SLOWEST + (WALK_FASTEST - WALK_SLOWEST) * 0.35)) < 0.5);
  // Between the thresholds it keeps walking; below the lower one it stops.
  assert.ok(hold(fly, { walk: 0.2 }, 1).vx > 0);
  assert.equal(hold(fly, { walk: 0.1 }, 1).vx, 0);
  assert.equal(hold(fly, { walk: 0.2 }, 1).vx, 0);

  const flat = hold(behavior(), { walk: 1 }, 1);
  assert.ok(Math.abs(flat.vx - WALK_SPEED * WALK_FASTEST) < 0.5);
  const left = hold(behavior(), { walk: 1 }, 1, { heading: -1 });
  assert.ok(left.vx < 0 && left.heading === -1);
});

test("the command is smoothed: a single spike in walk doesn't start a walk", () => {
  const fly = behavior();
  hold(fly, { walk: 0 }, 0.5);
  assert.equal(step(fly, input({ walk: 1 })).vx, 0);
  assert.equal(step(fly, input({ walk: 0 })).vx, 0);
});

test("a sustained turn toward the fly's left heads it right on screen, and vice versa", () => {
  // Turning toward its left (negative): heading left on screen, it turns around to face right.
  const towardLeft = behavior();
  let act = hold(towardLeft, { turn: -1 }, 0.3, { heading: -1 });
  assert.equal(act.heading, -1);
  act = hold(towardLeft, { turn: -1 }, TURN_THRESHOLD + 0.3, { heading: -1 });
  assert.equal(act.heading, 1);

  const towardRight = behavior();
  assert.equal(hold(towardRight, { turn: 1 }, 2, { heading: 1 }).heading, -1);
  // Already heading where it turns: it stays.
  assert.equal(hold(behavior(), { turn: 1 }, 2, { heading: -1 }).heading, -1);
});

test("a weak or wavering turn leaks away instead of adding up", () => {
  assert.equal(hold(behavior(), { turn: 0.15 }, 10).heading, 1);
  const fly = behavior();
  let heading: 1 | -1 = 1;
  for (let i = 0; i < 600; i++) {
    const act: BrainAct = step(fly, input({ turn: i % 60 < 30 ? 0.8 : -0.8 }, { heading }));
    heading = act.heading;
  }
  assert.equal(heading, 1);
});

test("the turn only counts while the brain can move the bug", () => {
  const fly = behavior();
  hold(fly, { turn: 1 }, 0.4);
  hold(fly, { turn: 1 }, 0.1, { free: false });
  assert.equal(hold(fly, { turn: 1 }, 0.4).heading, 1);
});

test("backing up when back beats walk, opposite to its facing and slower", () => {
  const fly = behavior();
  const act = hold(fly, { back: 0.8, walk: 0.2 }, 1);
  assert.equal(act.heading, 1);
  assert.ok(Math.abs(act.vx + WALK_SPEED * BACK_SPEED) < 1e-9);
  // Walk catches up: it stops backing.
  assert.ok(hold(fly, { back: 0.5, walk: 0.6 }, 1).vx > 0);
  // Close: not enough to start backing.
  assert.ok(hold(behavior(), { back: 0.55, walk: 0.45 }, 1).vx > 0);
});

test("held by something else, it doesn't move, but wings and grooming still come through", () => {
  const act = hold(behavior(), { walk: 1, wings: 0.6, groom: 0.4 }, 1, { free: false });
  assert.equal(act.vx, 0);
  assert.equal(act.jump, null);
  assert.ok(Math.abs(act.wings - 0.5) < 0.01);
  assert.ok(Math.abs(act.groom - 0.25) < 0.01);
});

test("escape takes off away from the loom, scaled by strength, then rests", () => {
  const fly = behavior();
  hold(fly, {}, 0.1);
  // Loom in the fly's left eye: the right of the screen. It jumps to the left.
  const act = step(fly, input({ escape: 1 }, { loomLeft: 0.9, loomRight: 0.1 }));
  assert.deepEqual(act.jump, { vx: -ESCAPE_SIDE_SPEED[1], vy: JUMP });
  assert.equal(act.heading, -1);

  // Still high, or again before the refractory period ends: nothing.
  assert.equal(step(fly, input({ escape: 1 })).jump, null);
  hold(fly, {}, ESCAPE_REFRACTORY - 0.2);
  assert.equal(step(fly, input({ escape: 1 })).jump, null);
  hold(fly, {}, 0.3);
  const weak = step(fly, input({ escape: 0.5 }, { loomRight: 0.5 }));
  assert.deepEqual(weak.jump, { vx: ESCAPE_SIDE_SPEED[0], vy: HOP });
});

test("escape needs to rise past the threshold while the bug is free", () => {
  const fly = behavior();
  assert.equal(step(fly, input({ escape: 1 })).jump, null, "already high when the brain started");
  hold(fly, {}, 0.1);
  assert.equal(step(fly, input({ escape: 0.45 })).jump, null);
  assert.equal(step(fly, input({ escape: 1 }, { free: false })).jump, null);
  hold(fly, {}, 0.1);
  // Nothing loomed: it takes off the way it faces.
  assert.equal(step(fly, input({ escape: 1 }, { heading: -1 })).jump!.vx, -ESCAPE_SIDE_SPEED[1]);
});

test("a stale gap resets everything", () => {
  const fly = behavior();
  hold(fly, { walk: 1, turn: 1 }, 0.4);
  fly.update(input(null));
  assert.equal(step(fly, input({ walk: 0.2, turn: 1 })).vx, 0);
  assert.equal(hold(fly, { walk: 0.2, turn: 1 }, 0.4).heading, 1);
});

test("out-of-range commands are clamped", () => {
  const act = hold(behavior(), { walk: 5, wings: -3, groom: Number.NaN }, 1);
  assert.ok(Math.abs(act.vx - WALK_SPEED * WALK_FASTEST) < 0.5);
  assert.equal(act.wings, 0);
  assert.equal(act.groom, 0);
});

test("pressed against an edge it faces, it turns around by itself after a while", () => {
  const fly = behavior();
  let act = hold(fly, { walk: 0.8 }, EDGE_PATIENCE - 0.1, { blocked: true });
  assert.equal(act.heading, 1);
  act = hold(fly, { walk: 0.8 }, 0.2, { blocked: true });
  assert.equal(act.heading, -1);
  assert.ok(act.vx < 0);

  // Stepping back from the edge, or being held by something else, starts the wait over.
  const patient = behavior();
  hold(patient, { walk: 0.8 }, EDGE_PATIENCE - 0.1, { blocked: true });
  hold(patient, { walk: 0.8 }, 0.1);
  assert.equal(hold(patient, { walk: 0.8 }, EDGE_PATIENCE - 0.1, { blocked: true }).heading, 1);
  const busy = behavior();
  hold(busy, { walk: 0.8 }, EDGE_PATIENCE - 0.1, { blocked: true });
  hold(busy, { walk: 0.8 }, 0.1, { blocked: true, free: false });
  assert.equal(hold(busy, { walk: 0.8 }, EDGE_PATIENCE - 0.1, { blocked: true }).heading, 1);
});

test("idle wing and grooming activity doesn't reach the pose", () => {
  const quiet = hold(behavior(), { wings: 0.15, groom: 0.1 }, 1);
  assert.equal(quiet.wings, 0);
  assert.equal(quiet.groom, 0);
  const busy = hold(behavior(), { wings: 1, groom: 0.6 }, 1);
  assert.ok(Math.abs(busy.wings - 1) < 0.01);
  assert.ok(Math.abs(busy.groom - 0.5) < 0.01);
});
