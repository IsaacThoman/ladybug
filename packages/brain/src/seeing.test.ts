// What the eyes do on the real connectome (skipped without it; see
// behaviour.test.ts). scripts/vision.ts and scripts/report.ts measure the same
// things at more length.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "./node.ts";
import { FlyBrain } from "./runtime.ts";
import { BATTERY, facetAngles, render } from "./stimuli.ts";
import type { Scene } from "./stimuli.ts";
import { RESTING_SENSES } from "./types.ts";
import type { BrainSenses } from "./types.ts";

const skip = existsSync(DEFAULT_CONNECTOME_PATH) ? false : `no ${DEFAULT_CONNECTOME_PATH}; run npm run brain:pack`;
const connectome = skip ? undefined : readConnectomeFile();
const TICK = 10;
const stimulus = (name: string) => BATTERY.find((s) => s.name === name)!;

/** A brain with its eyes open, and a way to show it a scene for a while. */
function seeing(seed = 1) {
  const brain = new FlyBrain(connectome!, { seed });
  const angles = facetAngles(brain.eyes!);
  const light = { left: new Float32Array(angles.left.az.length), right: new Float32Array(angles.right.az.length) };
  /** Shows the scene for ms (its time running from 0), with these other senses; calls `each` after every tick. */
  const show = (scene: Scene, ms: number, others: BrainSenses = RESTING_SENSES, each?: (state: ReturnType<FlyBrain["tick"]>) => void) => {
    for (let t = 0; t < ms; t += TICK) {
      render(scene, t / 1000, angles, light);
      const state = brain.tick(TICK, { ...others, light });
      each?.(state);
    }
  };
  return { brain, show };
}

test("with the eyes shut the brain is exactly what it was before it had eyes", { skip }, () => {
  // Spikes per tick under a fixed sequence of senses, seed 1, hashed: measured
  // on the commit before the eyes were added (b373345).
  const b = new FlyBrain(connectome!, { seed: 1 });
  const phases = [
    RESTING_SENSES,
    { ...RESTING_SENSES, loomLeft: 1 },
    { ...RESTING_SENSES, touch: 0.6, wind: 1, grounded: false },
    { ...RESTING_SENSES, sweet: 1, bumpRight: 1 },
    RESTING_SENSES,
  ];
  let total = 0;
  let hash = 0;
  for (const senses of phases) {
    for (let t = 0; t < 1000; t += 16) {
      const spikes = b.tick(16, senses).stats.spikes;
      total += spikes;
      hash = (Math.imul(hash, 31) + spikes) >>> 0;
    }
  }
  assert.deepEqual({ total, hash }, { total: 485164, hash: 1881340068 });
});

test("a dark disc looming at an eye fires the giant fiber through the optic lobe; a passing dot or a receding disc doesn't", { skip }, () => {
  const peak = (name: string) => {
    const s = stimulus(name);
    const { show } = seeing();
    show(() => s.ground, 1000);
    let top = 0;
    show(s.scene, s.seconds * 1000, RESTING_SENSES, (state) => (top = Math.max(top, state.command.escape)));
    return top;
  };
  for (const [name, low, high] of [
    ["loom right", 0.5, 1],
    ["loom right above", 0.5, 1],
    ["dot right, front to back", 0, 0.3],
    ["dot right, upward", 0, 0.3],
    ["recede right", 0, 0.5],
  ] as const) {
    const escape = peak(name);
    assert.ok(escape >= low && escape <= high, `${name}: escape peaked at ${escape}`);
  }
});

test("a steady scene, once adapted to, sends the lamina nothing", { skip }, () => {
  const s = stimulus("static checkerboard");
  const { brain, show } = seeing();
  show((_t, a, e) => s.scene(0, a, e), 20_000);
  for (const side of ["left", "right"] as const) {
    assert.ok(brain.vision!.retina[side].rates.every((rate) => rate === 0), `${side} eye still firing`);
    assert.ok(brain.rates[`vision.lamina ${side}`] < 0.01);
  }
});

test("motion: the right eye's HS cells prefer front-to-back motion and H2 back-to-front, and a rotation turns the fly with it", { skip }, () => {
  const types = { HS: ["HSE", "HSN", "HSS"], H2: ["H2"] };
  const respond = (name: string) => {
    const s = stimulus(name);
    const { brain, show } = seeing();
    show(() => s.ground, 1000);
    brain.sim.setRecording(true);
    let turn = 0;
    let n = 0;
    show(s.scene, s.seconds * 1000, RESTING_SENSES, (state) => {
      turn += state.command.turn;
      n++;
    });
    const rate = (list: string[]) => {
      const cells = connectome!.find({ type: list, side: "right" });
      return cells.reduce((sum, i) => sum + brain.sim.recording![i], 0) / cells.length / s.seconds;
    };
    return { HS: rate(types.HS), H2: rate(types.H2), turn: turn / n };
  };
  const forward = respond("grating right, front to back");
  const backward = respond("grating right, back to front");
  assert.ok(forward.HS > 2 * backward.HS, `HS: ${forward.HS} Hz front to back, ${backward.HS} back to front`);
  assert.ok(backward.H2 > 2 * forward.H2, `H2: ${backward.H2} Hz back to front, ${forward.H2} front to back`);
  const clockwise = respond("grating, clockwise");
  const anticlockwise = respond("grating, anticlockwise");
  assert.ok(clockwise.turn > anticlockwise.turn + 0.05, `turn ${clockwise.turn} clockwise, ${anticlockwise.turn} anticlockwise`);
});

test("no seizures: after a loom, a drifting grating or a flicker, alone and with every other sense at full strength, activity is back in the resting band within 1 s", { skip }, () => {
  const windowRate = (show: ReturnType<typeof seeing>["show"], ground: number) => {
    let spikes = 0;
    show(() => ground, 250, RESTING_SENSES, (state) => (spikes += state.stats.spikes));
    return spikes * 4;
  };
  const reference = seeing();
  reference.show(() => 1, 2000);
  let band = 0;
  for (let w = 0; w < 120; w++) band = Math.max(band, windowRate(reference.show, 1));
  const everything: BrainSenses = { loomLeft: 1, loomRight: 1, touch: 1, bumpLeft: 1, bumpRight: 1, wind: 1, sweet: 1, grounded: false };
  for (const name of ["loom right fast", "grating, clockwise", "flicker"]) {
    for (const others of [RESTING_SENSES, everything]) {
      const s = stimulus(name);
      const { show } = seeing();
      show(() => s.ground, 1000);
      show(s.scene, s.seconds * 1000, others);
      show(() => s.ground, 750);
      const after = windowRate(show, s.ground);
      assert.ok(after <= band, `${name}${others === everything ? " with everything" : ""}: ${after} spikes/s 1 s after, resting band tops out at ${band}`);
    }
  }
});
