import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainRequest, BrainResponse } from "@ladybug/brain";
import { BrainClient } from "./client.ts";
import { FlyBrain } from "./fly-brain.ts";
import type { FrameInput } from "./fly-brain.ts";
import { stateWith } from "./test-helpers.ts";

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
  reply({ type: "ready", neurons: 1, connections: 0 });

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
