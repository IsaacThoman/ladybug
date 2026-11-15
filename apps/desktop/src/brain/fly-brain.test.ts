import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainRequest, BrainResponse } from "@ladybug/brain";
import { BrainClient } from "./client.ts";
import { FlyBrain } from "./fly-brain.ts";
import type { BrainAct } from "./behavior.ts";
import type { FrameInput, FrameScene, ScreenCapture } from "./fly-brain.ts";
import { latticeEyes, stateWith } from "./test-helpers.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  let time = 0;
  const posted: BrainRequest[] = [];
  let reply: (response: BrainResponse) => void = () => {};
  const client = new BrainClient({
    createWorker: (onMessage) => { reply = onMessage; return { post: (request) => posted.push(request), terminate: () => {} }; },
    loadData: async () => new ArrayBuffer(1),
    now: () => time,
  });
  const brain = new FlyBrain(client, { walkSpeed: 70, hopVelocity: -650, jumpVelocity: -1000 });
  const frame = (overrides: Partial<FrameInput> = {}): FrameInput => ({
    now: time,
    dt: 1 / 60,
    pet: { x: 500, y: 500, width: 100, height: 60, mode: "idle", heading: 1 },
    bounds: { minX: 0, maxX: 1000 },
    held: false,
    free: true,
    ...overrides,
  });
  return { client, brain, posted, frame, reply: (r: BrainResponse) => reply(r), advance: (ms: number) => { time += ms; } };
}

const ticks = (posted: BrainRequest[]) => posted.filter((r): r is Extract<BrainRequest, { type: "tick" }> => r.type === "tick");

test("while the brain is off it does nothing", () => {
  const { brain, posted, frame } = setup();
  assert.equal(brain.frame(frame()), null);
  assert.deepEqual(posted, []);
});

test("each frame tells the brain what the bug feels and returns what it wants", async () => {
  const { client, brain, posted, frame, reply, advance } = setup();
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes: null });

  brain.setHovered(true);
  brain.feed();
  assert.equal(brain.frame(frame()), null, "no command yet");
  assert.equal(ticks(posted)[0].senses.touch, 0.4);
  assert.equal(ticks(posted)[0].senses.sweet, 1);
  assert.ok(Math.abs(ticks(posted)[0].dtMs - 1000 / 60) < 1e-9);

  advance(16);
  reply({ type: "state", state: stateWith({ walk: 1 }) });
  const act = brain.frame(frame({ now: 16 }));
  assert.ok(act && act.vx > 0);
  // Fed is a one-off.
  assert.ok(ticks(posted)[1].senses.sweet < 1);

  // Too old: carry on without it.
  advance(600);
  assert.equal(brain.frame(frame({ now: 616 })), null);
});

test("a berry in reach is tasted, and eaten once the brain wants to feed", async () => {
  const { client, brain, posted, frame, reply, advance } = setup();
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes: null });

  brain.frame(frame());
  assert.equal(ticks(posted)[0].senses.sweet, 0);
  advance(16);
  reply({ type: "state", state: stateWith({ walk: 1 }) });
  const food = { dx: 0, heading: -1 as const };
  const walking = brain.frame(frame({ now: 16, food }));
  assert.equal(ticks(posted)[1].senses.sweet, 1);
  assert.ok(walking && walking.vx > 0 && walking.eat === 0, "the brain hasn't answered the taste yet");

  let act: BrainAct | null = walking;
  for (let now = 32; now < 600; now += 16) {
    advance(16);
    reply({ type: "state", state: stateWith({ feed: 0.9 }) });
    act = brain.frame(frame({ now, food }));
  }
  assert.ok(act && act.vx === 0 && act.heading === -1 && act.eat > 0.8);
});

test("while the pet sleeps the brain rests, and picks up again when it wakes", async () => {
  const { client, brain, posted, frame, reply, advance } = setup();
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes: null });
  brain.frame(frame());
  advance(16);
  reply({ type: "state", state: stateWith({ walk: 1 }) });
  assert.ok(brain.frame(frame({ now: 16 })));
  advance(16);
  reply({ type: "state", state: stateWith({ walk: 1 }) });

  const sent = ticks(posted).length;
  for (let now = 32; now < 5000; now += 16) {
    advance(16);
    assert.equal(brain.frame(frame({ now, asleep: true })), null);
  }
  assert.equal(ticks(posted).length, sent, "no ticks while asleep");
  assert.equal(client.status, "running");

  // Awake: the old command is stale, so nothing until the brain answers again.
  assert.equal(brain.frame(frame({ now: 5000 })), null);
  assert.equal(ticks(posted).length, sent + 1);
  advance(16);
  reply({ type: "state", state: stateWith({ walk: 1 }) });
  assert.ok(brain.frame(frame({ now: 5016 })));
});

const SCENE: FrameScene = {
  width: 1000, height: 700, ledgeY: 560, yaw: 0,
  sprite: { x: 460, y: 424, width: 180, height: 150 }, berry: null, ball: null,
};

test("with Fly Eyes on, the senses carry what each facet sees, and the cursor no longer looms by itself", async () => {
  const { client, brain, posted, frame, reply, advance } = setup();
  const eyes = latticeEyes();
  brain.setEyes({ capture: null });
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes });

  // A swat from the right of the screen, which would loom in the left eye.
  let now = 0;
  for (let x = 1000; x > 560; x -= 100) {
    brain.setCursor({ x, y: 530 });
    brain.frame(frame({ now, scene: SCENE }));
    advance(16);
    now += 16;
    reply({ type: "state", state: stateWith({}) });
  }
  const sent = ticks(posted);
  assert.ok(sent.length >= 4);
  for (const { senses } of sent) {
    assert.equal(senses.loomLeft, 0);
    assert.equal(senses.loomRight, 0);
    assert.ok(senses.light, "light every tick");
    assert.equal(senses.light.left.length, eyes.left.directions.length / 3);
    assert.equal(senses.light.right.length, eyes.right.directions.length / 3);
  }
  // The arrays are reused from tick to tick; the worker gets a copy of each.
  const { light } = sent.at(-1)!.senses;
  assert.ok([...Array.from(light!.left), ...Array.from(light!.right)].every((v) => v >= 0 && v <= 1));
  assert.ok(brain.seeing(), "the panel can show it");

  // Without a scene, or with Fly Eyes off, it's as before.
  brain.setEyes(null);
  brain.setCursor({ x: 1000, y: 530 });
  brain.frame(frame({ now, scene: SCENE }));
  assert.equal(ticks(posted).at(-1)!.senses.light, undefined);
  assert.equal(brain.seeing(), null);
});

test("with Fly Eyes on but a brain without eyes, nothing changes", async () => {
  const { client, brain, posted, frame, reply } = setup();
  brain.setEyes({ capture: null });
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes: null });
  brain.frame(frame({ scene: SCENE }));
  assert.equal(ticks(posted)[0].senses.light, undefined);
  assert.equal(brain.seeing(), null);
});

test("the screen is only captured while the eyes are in use, and a failed capture isn't retried until asked", async () => {
  const { client, brain, frame, reply, advance } = setup();
  const started: { ended: (failed: boolean) => void; stopped: boolean }[] = [];
  const capture: ScreenCapture = (_vision, ended) => {
    const run = { ended, stopped: false };
    started.push(run);
    return () => { run.stopped = true; };
  };
  brain.setEyes({ capture });
  brain.frame(frame({ scene: SCENE }));
  assert.equal(started.length, 0, "not before the brain runs");
  client.start();
  await flush();
  reply({ type: "ready", neurons: 1, connections: 0, eyes: latticeEyes() });
  let now = 0;
  const step = (input: Partial<FrameInput> = {}) => {
    brain.frame(frame({ now, scene: SCENE, ...input }));
    advance(16);
    now += 16;
    reply({ type: "state", state: stateWith({}) });
  };
  step();
  step();
  assert.equal(started.length, 1);

  // Asleep, the brain rests and the capture stops; awake again, it starts again.
  step({ asleep: true });
  assert.equal(started[0].stopped, true);
  step();
  assert.equal(started.length, 2);

  // It stopped by itself because nothing looked: the next look starts it again.
  started[1].ended(false);
  step();
  assert.equal(started.length, 3);

  // It failed: the plain wall until Fly Eyes is turned off and on.
  started[2].ended(true);
  step();
  step();
  assert.equal(started.length, 3);
  brain.setEyes({ capture });
  step();
  assert.equal(started.length, 4);

  brain.setEyes(null);
  assert.equal(started[3].stopped, true);
  step();
  assert.equal(started.length, 4);
});
