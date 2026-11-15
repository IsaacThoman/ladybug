import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brain, BrainResponse, BrainState } from "@ladybug/brain";
import { createBrainHost } from "./host.ts";
import { RESTING, stateWith } from "./test-helpers.ts";

test("the worker builds the brain once and answers every tick", () => {
  const posted: BrainResponse[] = [];
  const ticks: number[] = [];
  const state: BrainState = stateWith({ walk: 0.5 });
  let received: ArrayBuffer | null = null;
  const handle = createBrainHost((data) => {
    received = data;
    return { neurons: 3, connections: 2, tick: (dtMs) => { ticks.push(dtMs); return state; } } satisfies Brain;
  }, (response) => posted.push(response));

  handle({ type: "tick", dtMs: 16, senses: RESTING });
  const data = new ArrayBuffer(4);
  handle({ type: "init", data });
  handle({ type: "tick", dtMs: 16, senses: RESTING });
  handle({ type: "init", data });

  assert.equal(received, data);
  assert.deepEqual(ticks, [16]);
  assert.deepEqual(posted.map((response) => response.type), ["error", "ready", "state", "error"]);
  assert.deepEqual(posted[1], { type: "ready", neurons: 3, connections: 2 });
  assert.deepEqual(posted[2], { type: "state", state });
});

test("errors building or ticking the brain become error responses", () => {
  const posted: BrainResponse[] = [];
  createBrainHost(() => { throw new Error("bad data"); }, (response) => posted.push(response))({ type: "init", data: new ArrayBuffer(0) });
  const handle = createBrainHost(() => ({ neurons: 1, connections: 0, tick: () => { throw "boom"; } }), (response) => posted.push(response));
  handle({ type: "init", data: new ArrayBuffer(0) });
  handle({ type: "tick", dtMs: 16, senses: RESTING });
  assert.deepEqual(posted, [
    { type: "error", message: "bad data" },
    { type: "ready", neurons: 1, connections: 0 },
    { type: "error", message: "boom" },
  ]);
});
