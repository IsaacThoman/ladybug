// The runtime on a small synthetic connectome (test-helpers.ts), so these run
// without the real data: decoding, the sense-to-rate mapping, the wiring's
// checks, createBrain end to end and its errors, and determinism.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectomeFormatError, loadConnectome } from "./format.ts";
import { BACKGROUND, READOUTS, SCALES, SENSES, backgroundRates, balanceFactor, decode, intensity, outputSynapses, senseRates, smooth, wire } from "./io.ts";
import { createBrain, FlyBrain, MAX_TICK_MS } from "./runtime.ts";
import { InternalState, Wander, normals } from "./state.ts";
import { bufferOf, syntheticConnectome, syntheticEyeColumns } from "./test-helpers.ts";
import { RESTING_SENSES } from "./types.ts";
import type { BrainSenses } from "./types.ts";
import { VISION_STAGES } from "./vision.ts";

const synthetic = syntheticConnectome();
const load = () => loadConnectome(bufferOf(synthetic.bytes));
const close = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

test("decode turns readout rates into commands with the documented scales", () => {
  const zero = decode({});
  assert.deepEqual(zero, { walk: 0, turn: 0, back: 0, escape: 0, wings: 0, groom: 0, feed: 0 });
  const half = decode({
    DNg100: SCALES.walk / 2,
    "DNa02 right": SCALES.turn / 2,
    MDN: SCALES.back / 2,
    DNp01: SCALES.escape / 2,
    flight: SCALES.wings / 2,
    DNg12: SCALES.groom / 2,
    MN9: SCALES.feed / 2,
  });
  for (const value of Object.values(half)) assert.ok(close(value, 0.5));
  // Turning is right minus left, toward the side whose DNa02 fires more.
  assert.ok(close(decode({ "DNa02 left": SCALES.turn / 4 }).turn, -0.25));
  assert.ok(close(decode({ "DNa02 left": 10, "DNa02 right": 10 }).turn, 0));
  // Clamped to the contract's ranges, and nonsense reads as 0.
  const huge = decode({ DNg100: 1e6, "DNa02 left": 1e6, MDN: 1e6, DNp01: 1e6, flight: 1e6, DNg12: 1e6, MN9: 1e6 });
  assert.deepEqual(huge, { walk: 1, turn: -1, back: 1, escape: 1, wings: 1, groom: 1, feed: 1 });
  assert.equal(decode({ DNg100: Number.NaN }).walk, 0);
  assert.equal(decode({ DNg100: -5 }).walk, 0);
});

test("smoothing follows a step with its time constant, however the time is split", () => {
  assert.ok(close(smooth(0, 1, 100, 100), 1 - Math.exp(-1)));
  let split = 0;
  for (let k = 0; k < 7; k++) split = smooth(split, 1, 100 / 7, 100);
  assert.ok(close(split, 1 - Math.exp(-1), 1e-12));
  assert.equal(smooth(3, 3, 16, 40), 3);
  assert.equal(smooth(2, 9, 0, 40), 2);
});

test("each sense drives its groups at its intensity times the stated maximum", () => {
  const wiring = wire(load());
  const at = (senses: Partial<BrainSenses>) => senseRates(wiring, { ...RESTING_SENSES, grounded: false, ...senses });
  const max = new Map(wiring.senses.map((s) => [s.spec.name, s.maxRate]));
  // At rest on the ground only the load sensors fire.
  for (const [name, rate] of senseRates(wiring, RESTING_SENSES)) assert.equal(rate, name === "grounded" ? max.get(name) : 0);
  for (const [name, rate] of at({})) assert.equal(rate, 0, name);
  assert.equal(at({ loomLeft: 1 }).get("loomLeft"), 100);
  assert.equal(at({ loomLeft: 0.25 }).get("loomLeft"), 25);
  assert.equal(at({ loomLeft: 1 }).get("loomRight"), 0);
  assert.equal(at({ sweet: 0.5 }).get("sweet"), 50);
  // Touch drives both of its groups.
  const touch = at({ touch: 1 });
  assert.equal(touch.get("touch head"), max.get("touch head"));
  assert.equal(touch.get("touch body"), max.get("touch body"));
  // Out of range and nonsense are clamped.
  assert.equal(at({ wind: 7 }).get("wind"), max.get("wind"));
  assert.equal(at({ wind: -1 }).get("wind"), 0);
  assert.equal(at({ wind: Number.NaN }).get("wind"), 0);
  assert.equal(intensity({ ...RESTING_SENSES, grounded: true }, "grounded"), 1);
  assert.equal(intensity({ ...RESTING_SENSES, grounded: false }, "grounded"), 0);
  // Every sense in the contract drives something.
  for (const sense of Object.keys(RESTING_SENSES)) assert.ok(SENSES.some((s) => s.sense === sense), sense);

  const background = backgroundRates(wiring, { left: 0.5, right: 2 });
  assert.equal(background.get("background left"), BACKGROUND[0].maxRate * 0.5);
  assert.equal(background.get("background right"), BACKGROUND[1].maxRate);
});

test("balancing turns down the side whose neurons make more synapses", () => {
  const c = load();
  const left = synthetic.index["LC10a left"];
  const fewer = left.slice(0, 3);
  assert.equal(balanceFactor(c, fewer, left), 1);
  assert.ok(close(balanceFactor(c, left, fewer), outputSynapses(c, fewer) / outputSynapses(c, left)));
  assert.equal(balanceFactor(c, left, synthetic.index["LC10a right"]), 1);
});

test("no neuron is both driven and read, and wiring refuses connectomes where one would be", () => {
  const wiring = wire(load());
  const driven = new Set([...wiring.senses, ...wiring.background].flatMap((g) => [...g.neurons]));
  const read = wiring.readouts.flatMap((g) => [...g.neurons]);
  assert.ok(driven.size > 0 && read.length > 0);
  for (const i of read) assert.ok(!driven.has(i), `neuron ${i} is both driven and read`);
  assert.equal(wiring.readouts.length, READOUTS.length);

  // A giant fiber annotated as a visual projection neuron would be in the background.
  const overlapping = syntheticConnectome({ change: { "DNp01 left": { superClass: "visual_projection" } } });
  assert.throws(() => createBrain(bufferOf(overlapping.bytes)), /both driven and read \(readout "DNp01"\)/);
});

test("createBrain runs the synthetic connectome end to end", () => {
  const brain = createBrain(bufferOf(synthetic.bytes), { seed: 3 });
  assert.equal(brain.neurons, synthetic.neurons.length);
  assert.equal(brain.connections > 0, true);
  let state = brain.tick(16, RESTING_SENSES);
  assert.equal(state.stats.simMs, 16);
  assert.ok(state.stats.wallMs >= 0);
  assert.deepEqual(Object.keys(state.stats.rates).sort(), READOUTS.map((r) => r.name).sort());
  for (const [key, value] of Object.entries(state.command)) {
    assert.ok(Number.isFinite(value), key);
    assert.ok(value >= (key === "turn" ? -1 : 0) && value <= 1, `${key} ${value}`);
  }
  // Any dt adds up: 0, a fraction of a step, and the longest the pet sends.
  let total = 0;
  for (const dt of [0, 0.4, 0.6, 3.3, 100, 16]) total += brain.tick(dt, RESTING_SENSES).stats.simMs;
  assert.ok(Math.abs(total - 120.3) <= 1, `${total} ms simulated`);

  const run = (senses: Partial<BrainSenses>, ms = 300) => {
    const fresh = createBrain(bufferOf(synthetic.bytes), { seed: 3 });
    for (let t = 0; t < ms; t += 16) state = fresh.tick(16, { ...RESTING_SENSES, ...senses });
    return state;
  };
  const loom = run({ loomRight: 1 });
  assert.ok(loom.command.escape > 0.5, `escape ${loom.command.escape}`);
  assert.ok(loom.command.wings > 0.1, `wings ${loom.command.wings}`);
  assert.ok(loom.stats.rates.DNp01 > 50);
  assert.ok(run({ sweet: 1 }).command.feed > 0.3);
  assert.ok(run({ touch: 1 }).command.back > 0.3);
  assert.ok(run({ wind: 1 }).command.groom > 0.3);
});

test("createBrain explains what is wrong with a bad buffer or a bad call", () => {
  assert.throws(() => createBrain(new Uint8Array(8) as unknown as ArrayBuffer), ConnectomeFormatError);
  assert.throws(() => createBrain(new ArrayBuffer(4)), /Not a connectome: only 4 bytes/);
  assert.throws(() => createBrain(new TextEncoder().encode("this is not a connectome").buffer), /expected magic "CBUG"/);
  assert.throws(() => createBrain(bufferOf(synthetic.bytes.subarray(0, synthetic.bytes.length - 64))), /Truncated connectome/);
  assert.throws(() => createBrain(bufferOf(syntheticConnectome({ without: ["MN9"] }).bytes)), /no neurons for "MN9"/);
  assert.throws(() => createBrain(bufferOf(syntheticConnectome({ without: ["LPLC2 left", "LC4 left"] }).bytes)), /no neurons for "loomLeft"/);
  assert.throws(() => createBrain(bufferOf(synthetic.bytes), { seed: 1.5 }), /whole number/);
  const brain = createBrain(bufferOf(synthetic.bytes));
  for (const dt of [-1, Number.NaN, MAX_TICK_MS + 1]) assert.throws(() => brain.tick(dt, RESTING_SENSES), /tick takes 0 to/);
});

test("a seed gives the same brain every time; another seed a different one", () => {
  const ticks = (seed: number) => {
    const brain = createBrain(bufferOf(synthetic.bytes), { seed });
    const out: unknown[] = [];
    const senses = [RESTING_SENSES, { ...RESTING_SENSES, loomLeft: 0.7, touch: 0.4 }, { ...RESTING_SENSES, sweet: 1, wind: 0.3 }];
    for (let k = 0; k < 90; k++) {
      const { command, stats } = brain.tick(k % 5 === 0 ? 33 : 16, senses[Math.floor(k / 30)]);
      out.push({ command, spikes: stats.spikes, active: stats.active, rates: stats.rates });
    }
    return out;
  };
  assert.deepEqual(ticks(5), ticks(5));
  assert.notDeepEqual(ticks(5), ticks(6));
});

test("the internal state wanders around 0 with unit spread, reproducibly", () => {
  const wander = new Wander(2, normals(9));
  let sum = 0;
  let squares = 0;
  const n = 200_000;
  for (let k = 0; k < n; k++) {
    const x = wander.step(0.05);
    sum += x;
    squares += x * x;
  }
  assert.ok(Math.abs(sum / n) < 0.1, `mean ${sum / n}`);
  assert.ok(Math.abs(squares / n - 1) < 0.1, `variance ${squares / n}`);
  const a = new InternalState(4);
  const b = new InternalState(4);
  for (let k = 0; k < 100; k++) {
    a.step(0.01);
    b.step(0.01);
  }
  assert.equal(a.level("left"), b.level("left"));
  assert.ok(a.level("left") > 0 && a.level("left") < 1);
  assert.notEqual(a.level("left"), a.level("right"));
  // Off, nothing spontaneous happens.
  const quiet = new FlyBrain(load(), { spontaneous: false });
  for (let t = 0; t < 500; t += 16) assert.equal(quiet.tick(16, { ...RESTING_SENSES, grounded: false }).stats.spikes, 0);
});

test("the eyes: shut, the brain is the same as one without them; open, darkness reaches the lamina and on", () => {
  const columns = syntheticEyeColumns(synthetic);
  const seeing = () => new FlyBrain(load(), { seed: 4, eyeColumns: columns });
  assert.equal(createBrain(bufferOf(synthetic.bytes)).eyes, null);
  const brain = seeing();
  assert.ok(brain.eyes);
  assert.equal(brain.eyes.right.directions.length, 12);
  // The eyes add the vision.<stage> rates the connectome has neurons for, after the readouts.
  const names = Object.keys(brain.tick(10, RESTING_SENSES).stats.rates);
  assert.deepEqual(names.slice(0, READOUTS.length), READOUTS.map((r) => r.name));
  assert.deepEqual(names.slice(READOUTS.length), ["lamina", "lobula", "looming"].flatMap((stage) => [`vision.${stage} left`]).concat(["lamina", "lobula", "looming"].map((stage) => `vision.${stage} right`)));
  assert.ok(VISION_STAGES.every(({ stage }) => stage !== "lamina" || names.includes(`vision.${stage} left`)));

  // Shut eyes: spike for spike the brain without eyes, whatever else is going on.
  const blind = new FlyBrain(load(), { seed: 4 });
  const eyes = seeing();
  const senses = [RESTING_SENSES, { ...RESTING_SENSES, loomLeft: 0.6, touch: 1 }, { ...RESTING_SENSES, sweet: 1, grounded: false }];
  for (let k = 0; k < 90; k++) {
    const s = senses[Math.floor(k / 30)];
    const a = blind.tick(16, s);
    const b = eyes.tick(16, s);
    assert.equal(b.stats.spikes, a.stats.spikes, `tick ${k}`);
    assert.deepEqual(b.command, a.command);
  }

  // Open: a steady scene, then the right eye goes dark. Its L2s drive the right LPLC2 and the giant fiber.
  const light = { left: [1, 1, 1, 1], right: [1, 1, 1, 1] };
  let state = brain.tick(200, { ...RESTING_SENSES, light });
  assert.equal(state.stats.rates["vision.lamina right"], 0);
  light.right = [0, 0, 0, 0];
  for (let t = 0; t < 200; t += 10) state = brain.tick(10, { ...RESTING_SENSES, light });
  assert.ok(state.stats.rates["vision.lamina right"] > 20, `lamina ${state.stats.rates["vision.lamina right"]}`);
  assert.ok(state.stats.rates["vision.looming right"] > 5, `looming ${state.stats.rates["vision.looming right"]}`);
  assert.equal(state.stats.rates["vision.lamina left"], 0);
  assert.ok(state.stats.rates.DNp01 > 5, `giant fiber ${state.stats.rates.DNp01} Hz`);
  assert.throws(() => brain.tick(10, { ...RESTING_SENSES, light: { left: [1], right: [1, 1, 1, 1] } }), /left eye has 4 facets, but the light gives 1/);
});
