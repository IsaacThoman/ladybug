// What the brain does on the real connectome. It is not in git (see README),
// so these skip unless `npm run brain:pack` has been run. They take about a
// minute; scripts/report.ts measures the same things at more length.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "./node.ts";
import { PetObserver } from "./pet.ts";
import { FlyBrain } from "./runtime.ts";
import { RESTING_SENSES } from "./types.ts";
import type { BrainCommand, BrainSenses } from "./types.ts";

const skip = existsSync(DEFAULT_CONNECTOME_PATH) ? false : `no ${DEFAULT_CONNECTOME_PATH}; run npm run brain:pack`;
const connectome = skip ? undefined : readConnectomeFile();
const TICK = 16;

const brain = (options: { spontaneous?: boolean } = {}) => new FlyBrain(connectome!, { seed: 1, ...options });
const run = (b: FlyBrain, ms: number, senses: BrainSenses = RESTING_SENSES) => {
  let state = b.tick(TICK, senses);
  for (let t = TICK; t < ms; t += TICK) state = b.tick(TICK, senses);
  return state;
};
/** Mean of each command over `ms` under these senses. */
const mean = (b: FlyBrain, ms: number, senses: BrainSenses) => {
  const sum: Record<string, number> = {};
  let n = 0;
  for (let t = 0; t < ms; t += TICK) {
    const { command } = b.tick(TICK, senses);
    n++;
    for (const [k, v] of Object.entries(command)) sum[k] = (sum[k] ?? 0) + v;
  }
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, v / n])) as BrainCommand;
};
const FULL: BrainSenses = { loomLeft: 1, loomRight: 1, touch: 1, bumpLeft: 1, bumpRight: 1, wind: 1, sweet: 1, grounded: false };
const only = (key: keyof BrainSenses): BrainSenses => ({ ...RESTING_SENSES, [key]: FULL[key] });
const SENSES = Object.keys(FULL) as (keyof BrainSenses)[];

test("every group finds its neurons in the real connectome, and none is both driven and read", { skip }, () => {
  const { wiring } = brain();
  const sizes = Object.fromEntries([...wiring.senses, ...wiring.background, ...wiring.readouts].map((g) => [g.spec.name, g.neurons.length]));
  assert.deepEqual(sizes, {
    loomLeft: 165,
    loomRight: 146,
    "touch head": 932,
    "touch body": 2206,
    bumpLeft: 348,
    bumpRight: 324,
    wind: 475,
    sweet: 88,
    grounded: 426,
    "background left": 4424,
    "background right": 4466,
    DNg100: 2,
    "DNa02 left": 1,
    "DNa02 right": 1,
    MDN: 4,
    DNp01: 2,
    flight: 24,
    DNg12: 26,
    MN9: 2,
  });
  const driven = new Set([...wiring.senses, ...wiring.background].flatMap((g) => [...g.neurons]));
  for (const group of wiring.readouts) for (const i of group.neurons) assert.ok(!driven.has(i), `${group.spec.name} neuron ${i} is also driven`);
});

test("no seizures: after each sense, and everything at once, at full strength for 2 s, activity is back in the resting band within 1 s", { skip }, () => {
  const windowRate = (b: FlyBrain) => {
    let spikes = 0;
    for (let t = 0; t < 250; t += 10) spikes += b.tick(10, RESTING_SENSES).stats.spikes;
    return spikes * 4;
  };
  const reference = brain();
  run(reference, 2000);
  let band = 0;
  for (let w = 0; w < 120; w++) band = Math.max(band, windowRate(reference));
  for (const senses of [...SENSES.map(only), FULL]) {
    const b = brain();
    run(b, 1000);
    run(b, 2000, senses);
    run(b, 750);
    const after = windowRate(b);
    assert.ok(after <= band, `${JSON.stringify(senses)}: ${after} spikes/s 1 s after, resting band tops out at ${band}`);
  }
});

test("a full-strength loom in either eye fires the giant fiber: escape passes 0.5 within 150 ms and falls below 0.3 within 300 ms of the loom ending", { skip }, () => {
  for (const eye of ["loomLeft", "loomRight"] as const) {
    // The pet's pulse: held at its peak for 80 ms, fading to 0 over 200 ms.
    const b = brain();
    run(b, 2000);
    let up = -1;
    let down = -1;
    for (let t = TICK; t <= 800; t += TICK) {
      const elapsed = t - TICK;
      const loom = elapsed < 80 ? 1 : Math.max(0, 1 - (elapsed - 80) / 200);
      const { command } = b.tick(TICK, { ...RESTING_SENSES, [eye]: loom });
      if (up < 0 && command.escape > 0.5) up = t;
      if (loom === 0 && down < 0 && command.escape < 0.3) down = t - 280;
    }
    assert.ok(up >= 0 && up <= 150, `${eye} pulse: escape passed 0.5 at ${up} ms`);
    assert.ok(down >= 0 && down <= 300, `${eye} pulse: escape below 0.3 ${down} ms after the loom ended`);

    // A loom held for a second, then gone.
    const held = brain();
    run(held, 2000);
    let peak = 0;
    let first = -1;
    for (let t = TICK; t <= 1008; t += TICK) {
      const { command } = held.tick(TICK, only(eye));
      if (first < 0 && command.escape > 0.5) first = t;
      peak = Math.max(peak, command.escape);
    }
    assert.ok(first >= 0 && first <= 150, `${eye} held: escape passed 0.5 at ${first} ms`);
    let settled = -1;
    for (let t = TICK; t <= 600 && settled < 0; t += TICK) if (held.tick(TICK, RESTING_SENSES).command.escape < 0.3) settled = t;
    assert.ok(settled >= 0 && settled <= 300, `${eye} held: escape below 0.3 ${settled} ms after the loom ended`);
  }
});

test("escape stays below 0.3 under every sense that isn't looming", { skip }, () => {
  for (const key of SENSES.filter((k) => !k.startsWith("loom"))) {
    const b = brain();
    run(b, 1000);
    let peak = 0;
    for (let t = 0; t < 2000; t += TICK) peak = Math.max(peak, b.tick(TICK, only(key)).command.escape);
    assert.ok(peak < 0.3, `${key}: escape reached ${peak}`);
  }
});

test("left and right mirror each other: either eye's loom escapes alike, and a scene on either side steers toward it", { skip }, () => {
  const looms = (["loomLeft", "loomRight"] as const).map((eye) => {
    const b = brain();
    run(b, 1000);
    return mean(b, 500, only(eye));
  });
  for (const loom of looms) {
    assert.ok(loom.escape > 0.7, `escape ${loom.escape}`);
    assert.ok(loom.wings > 0.5, `wings ${loom.wings}`);
  }
  assert.ok(Math.abs(looms[0].escape - looms[1].escape) < 0.15, `escape ${looms[0].escape} vs ${looms[1].escape}`);

  // The internal state's scene, one eye at a time, with nothing else going on.
  const turns = (["left", "right"] as const).map((side) => {
    const b = brain({ spontaneous: false });
    for (const group of b.wiring.background) b.sim.setRate(group.spec.name, group.spec.side === side ? group.maxRate * 0.6 : 0);
    run(b, 500);
    return mean(b, 2000, RESTING_SENSES).turn;
  });
  assert.ok(turns[0] < -0.2, `a scene on the left turns ${turns[0]}`);
  assert.ok(turns[1] > 0.2, `a scene on the right turns ${turns[1]}`);
  const ratio = Math.abs(turns[0] / turns[1]);
  assert.ok(ratio > 1 / 1.6 && ratio < 1.6, `left ${turns[0]} against right ${turns[1]}`);
});

test("touch makes it back away, wind makes it groom, sweet makes it feed, and looming opens the wings", { skip }, () => {
  const restB = brain();
  run(restB, 1000);
  const rest = mean(restB, 1000, RESTING_SENSES);
  for (const [sense, command] of [
    ["touch", "back"],
    ["wind", "groom"],
    ["sweet", "feed"],
    ["loomLeft", "wings"],
  ] as const) {
    const b = brain();
    run(b, 1000);
    const response = mean(b, 1000, only(sense));
    assert.ok(response[command] > 0.3, `${sense}: ${command} ${response[command]}`);
    assert.ok(rest[command] < 0.1, `at rest: ${command} ${rest[command]}`);
  }
});

test("at rest it walks in bouts, turns both ways and never escapes (3 minutes of fly time)", { skip }, () => {
  const b = brain();
  const pet = new PetObserver();
  for (let t = 0; t < 180_000; t += TICK) pet.observe(b.tick(TICK, RESTING_SENSES).command, TICK / 1000);
  const t = pet.tally;
  const share = t.walking / t.seconds;
  assert.ok(share > 0.2 && share < 0.7, `walking ${(share * 100).toFixed(0)}% of the time`);
  assert.ok(t.walkBouts >= 15, `${t.walkBouts} walking bouts`);
  assert.ok(t.turnsLeft >= 1 && t.turnsRight >= 1, `${t.turnsLeft} turns left, ${t.turnsRight} right`);
  assert.equal(t.escapes, 0);
  assert.ok(t.peak.escape < 0.3, `escape reached ${t.peak.escape}`);
});

test("it builds in under 2 s and runs within its cost bounds, with room to spare", { skip }, () => {
  const started = performance.now();
  const b = brain();
  assert.ok(performance.now() - started < 2000, `built in ${performance.now() - started} ms`);
  const cost = (senses: BrainSenses) => {
    run(b, 1000, senses);
    let wall = 0;
    for (let t = 0; t < 4000; t += TICK) wall += b.tick(TICK, senses).stats.wallMs;
    return wall / 4000;
  };
  // The budgets are 0.15 and 0.5 s per simulated second; these allow twice that.
  const rest = cost(RESTING_SENSES);
  assert.ok(rest < 0.3, `${rest} s per simulated second at rest`);
  const all = cost(FULL);
  assert.ok(all < 1, `${all} s per simulated second with everything at once`);
});
