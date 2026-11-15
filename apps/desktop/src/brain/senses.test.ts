import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainSenses } from "@ladybug/brain";
import { LOOM_DECAY, LOOM_HOLD, LOOM_RANGE, RELEASE, SenseTracker, SWEET_FADE, TOUCH_HOVER } from "./senses.ts";
import type { PetMode, SenseInput } from "./senses.ts";

const DT = 1 / 60;
// A 100×60 bug whose centre is at (550, 530), in bounds 0..1000.
const PET = { x: 500, y: 500, width: 100, height: 60, mode: "idle" as PetMode, heading: 1 as 1 | -1 };
// A swat: fast enough to loom fully, and still that fast when it arrives.
const SWAT = { speed: 6000, seconds: 0.07 };
const CENTRE = { x: 550, y: 530 };

function frame(overrides: Partial<SenseInput> = {}): SenseInput {
  return { dt: DT, pet: PET, bounds: { minX: 0, maxX: 1000 }, cursor: null, hovered: false, held: false, linkOver: false, fed: false, ...overrides };
}

/** Moves the cursor in a straight line toward (or away from) the bug's centre at `speed` px/s. */
function swipe(tracker: SenseTracker, { from, speed, seconds, input = {} }: { from: { x: number; y: number }; speed: number; seconds: number; input?: Partial<SenseInput> }) {
  const dx = CENTRE.x - from.x;
  const dy = CENTRE.y - from.y;
  const length = Math.hypot(dx, dy);
  let senses!: BrainSenses;
  const frames = Math.round(seconds / DT);
  for (let i = 0; i <= frames; i++) {
    const travelled = speed * DT * i;
    senses = tracker.update(frame({ ...input, cursor: { x: from.x + (dx / length) * travelled, y: from.y + (dy / length) * travelled } }));
  }
  return senses;
}

const inRange = (senses: BrainSenses) => {
  for (const [key, value] of Object.entries(senses)) {
    if (typeof value === "number") assert.ok(value >= 0 && value <= 1, `${key} = ${value}`);
  }
};

test("at rest, the senses are quiet and it's on its feet", () => {
  const tracker = new SenseTracker();
  const senses = tracker.update(frame({ cursor: { x: 100, y: 100 } }));
  assert.deepEqual(senses, { loomLeft: 0, loomRight: 0, touch: 0, bumpLeft: 0, bumpRight: 0, wind: 0, sweet: 0, grounded: true });
  for (const mode of ["airborne", "dragging"] as const) {
    assert.equal(new SenseTracker().update(frame({ pet: { ...PET, mode } })).grounded, false);
  }
  assert.equal(new SenseTracker().update(frame({ pet: { ...PET, mode: "walking" } })).grounded, true);
});

test("a cursor rushing in from the right of the screen looms in the fly's left eye", () => {
  const senses = swipe(new SenseTracker(), { from: { x: 1050, y: 530 }, ...SWAT });
  assert.ok(senses.loomLeft > 0.5, `loomLeft ${senses.loomLeft}`);
  assert.equal(senses.loomRight, 0);
  inRange(senses);

  const fromLeft = swipe(new SenseTracker(), { from: { x: 50, y: 530 }, ...SWAT });
  assert.ok(fromLeft.loomRight > 0.5);
  assert.equal(fromLeft.loomLeft, 0);
});

test("straight from above, it looms in both eyes", () => {
  const senses = swipe(new SenseTracker(), { from: { x: 560, y: 30 }, ...SWAT });
  assert.ok(senses.loomLeft > 0.5 && senses.loomRight > 0.5);
  assert.equal(senses.loomLeft, senses.loomRight);
});

test("slow, receding or distant cursors don't loom", () => {
  assert.equal(swipe(new SenseTracker(), { from: { x: 900, y: 530 }, speed: 200, seconds: 0.5 }).loomLeft, 0);
  assert.equal(swipe(new SenseTracker(), { from: { x: 600, y: 530 }, speed: -6000, seconds: 0.07 }).loomLeft, 0);
  const far = { x: CENTRE.x + LOOM_RANGE + 600, y: CENTRE.y };
  assert.equal(swipe(new SenseTracker(), { from: far, ...SWAT }).loomLeft, 0);
});

test("a reach to click it slows down as it arrives, and doesn't loom", () => {
  // A minimum-jerk reach of 900 px in 0.45 s, ending on the bug.
  const tracker = new SenseTracker();
  const from = { x: CENTRE.x + 800, y: CENTRE.y - 400 };
  let peak = 0;
  for (let t = 0; t <= 0.6; t += DT) {
    const u = Math.min(1, t / 0.45);
    const s = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
    const senses = tracker.update(frame({ cursor: { x: from.x + (CENTRE.x - from.x) * s, y: from.y + (CENTRE.y - from.y) * s } }));
    peak = Math.max(peak, senses.loomLeft, senses.loomRight);
  }
  assert.ok(peak < 0.1, `loom ${peak}`);
});

test("faster and nearer looms harder", () => {
  const fast = swipe(new SenseTracker(), { from: { x: 1000, y: 530 }, speed: 6000, seconds: 0.065 }).loomLeft;
  const slow = swipe(new SenseTracker(), { from: { x: 1000, y: 530 }, speed: 3500, seconds: 0.11 }).loomLeft;
  assert.ok(fast > slow && slow > 0, `${fast} > ${slow}`);
  const near = swipe(new SenseTracker(), { from: { x: 850, y: 530 }, speed: 4500, seconds: 0.05 }).loomLeft;
  const farther = swipe(new SenseTracker(), { from: { x: 1000, y: 530 }, speed: 4500, seconds: 0.05 }).loomLeft;
  assert.ok(near > farther && farther > 0, `${near} > ${farther}`);
});

test("a loom is held briefly, then fades out", () => {
  const tracker = new SenseTracker();
  const peak = swipe(tracker, { from: { x: 1050, y: 530 }, ...SWAT }).loomLeft;
  const stopped = { x: 1050 - SWAT.speed * SWAT.seconds, y: 530 };
  // The cursor stops; the measured closing speed takes a few frames to fall.
  let senses = tracker.update(frame({ cursor: stopped }));
  assert.ok(senses.loomLeft >= peak * 0.9);
  for (let t = 0; t < LOOM_HOLD + 0.05; t += DT) senses = tracker.update(frame({ cursor: stopped }));
  assert.ok(senses.loomLeft > 0 && senses.loomLeft < peak);
  for (let t = 0; t < LOOM_DECAY; t += DT) senses = tracker.update(frame({ cursor: stopped }));
  assert.equal(senses.loomLeft, 0);
});

test("nothing looms while it's held: the cursor is on it", () => {
  const senses = swipe(new SenseTracker(), { from: { x: 1050, y: 530 }, ...SWAT, input: { held: true } });
  assert.equal(senses.loomLeft, 0);
  const tracker = new SenseTracker();
  swipe(tracker, { from: { x: 1050, y: 530 }, ...SWAT });
  assert.equal(tracker.update(frame({ cursor: CENTRE, pet: { ...PET, mode: "dragging" } })).loomLeft, 0);
});

test("touch: a light touch under the pointer, full while held, easing out after", () => {
  const tracker = new SenseTracker();
  assert.equal(tracker.update(frame({ hovered: true })).touch, TOUCH_HOVER);
  assert.equal(tracker.update(frame({ held: true })).touch, 1);
  const released = tracker.update(frame()).touch;
  assert.ok(released > 0.5 && released < 1);
  let touch = released;
  for (let t = 0; t < RELEASE; t += DT) touch = tracker.update(frame()).touch;
  assert.ok(touch < 0.1, `touch ${touch}`);
  for (let t = 0; t < RELEASE; t += DT) touch = tracker.update(frame()).touch;
  assert.equal(touch, 0);
});

test("bumps are mirrored: the left edge of the screen is the fly's right antenna", () => {
  const atLeft = new SenseTracker().update(frame({ pet: { ...PET, x: 0, heading: -1 } }));
  assert.equal(atLeft.bumpRight, 1);
  assert.equal(atLeft.bumpLeft, 0);
  const tracker = new SenseTracker();
  const atRight = tracker.update(frame({ pet: { ...PET, x: 1000 } }));
  assert.equal(atRight.bumpLeft, 1);
  assert.equal(atRight.bumpRight, 0);
  // Easing out once it walks away.
  const away = tracker.update(frame({ pet: { ...PET, x: 990 } }));
  assert.ok(away.bumpLeft > 0 && away.bumpLeft < 1);
});

test("it only feels an edge it faces or is thrown against", () => {
  const turnedAway = new SenseTracker().update(frame({ pet: { ...PET, x: 0, heading: 1 } }));
  assert.equal(turnedAway.bumpRight, 0);
  const tracker = new SenseTracker();
  tracker.update(frame({ pet: { ...PET, x: 1000 } }));
  // Turning its back on the edge lets go of it.
  let bump = 1;
  for (let t = 0; t < RELEASE * 2; t += DT) bump = tracker.update(frame({ pet: { ...PET, x: 1000, heading: -1 } })).bumpLeft;
  assert.equal(bump, 0);
  const thrown = new SenseTracker().update(frame({ pet: { ...PET, x: 0, heading: 1, mode: "airborne" } }));
  assert.equal(thrown.bumpRight, 1);
});

test("wind is its own speed through the air, nothing on the ground", () => {
  const fly = (mode: PetMode, speed: number, seconds = 0.4) => {
    const tracker = new SenseTracker();
    let senses!: BrainSenses;
    for (let i = 0; i * DT <= seconds; i++) {
      senses = tracker.update(frame({ pet: { ...PET, mode, x: 100 + speed * DT * i } }));
    }
    return senses.wind;
  };
  assert.ok(Math.abs(fly("airborne", 750) - 0.5) < 0.02);
  assert.ok(fly("dragging", 3000) > 0.98);
  assert.equal(fly("walking", 1500), 0);
  // Dropped onto the ground, it dies away.
  const tracker = new SenseTracker();
  for (let i = 0; i < 20; i++) tracker.update(frame({ pet: { ...PET, mode: "airborne", x: 100 + 25 * i } }));
  let wind = 1;
  for (let i = 0; i < 30; i++) wind = tracker.update(frame({ pet: { ...PET, x: 600 } })).wind;
  assert.equal(wind, 0);
});

test("sweet: a link over it smells sweet, a dropped one tastes sweet and fades", () => {
  const tracker = new SenseTracker();
  assert.equal(tracker.update(frame({ linkOver: true })).sweet, 0.5);
  assert.equal(tracker.update(frame({ fed: true })).sweet, 1);
  let sweet = 1;
  for (let t = 0; t < SWEET_FADE / 2; t += DT) sweet = tracker.update(frame()).sweet;
  assert.ok(Math.abs(sweet - 0.5) < 0.05, `sweet ${sweet}`);
  for (let t = 0; t < SWEET_FADE / 2 + 0.1; t += DT) sweet = tracker.update(frame()).sweet;
  assert.equal(sweet, 0);
});

test("the senses don't depend on the frame rate", () => {
  // 0.2 s after letting go, at 30 and at 120 frames a second.
  const run = (fps: number) => {
    const tracker = new SenseTracker();
    tracker.update(frame({ dt: 1 / fps, held: true }));
    let senses!: BrainSenses;
    for (let i = 0; i < fps * 0.2; i++) senses = tracker.update(frame({ dt: 1 / fps }));
    return senses.touch;
  };
  assert.ok(Math.abs(run(30) - run(120)) < 0.005, `${run(30)} vs ${run(120)}`);
});

test("odd input stays in range", () => {
  const tracker = new SenseTracker();
  for (const dt of [0, -1, Number.NaN, 5]) {
    inRange(tracker.update(frame({ dt, cursor: { x: 551, y: 531 }, held: false, hovered: true, fed: true, linkOver: true })));
  }
  inRange(tracker.update(frame({ pet: { ...PET, mode: "airborne", x: 1e9 } })));
});
