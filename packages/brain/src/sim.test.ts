import assert from "node:assert/strict";
import { test } from "node:test";
import { PoissonInput, Simulation, inputSeed, mulberry32 } from "./sim.ts";
import type { Network } from "./sim.ts";

type Net = { ptr: Uint32Array; post: Uint32Array; count: Uint16Array };

type Setup = {
  net: Net;
  gain: Float32Array;
  postScale?: Float32Array;
  bias?: Float32Array;
  dt: number;
  tauMem: number;
  tauSyn: number;
  threshold: number;
  refractory: number;
  delay: number;
  epsilon: number;
  cleanupInterval: number;
  seed: number;
  resetDrive: boolean;
  adaptation?: { increment: number; tau: number };
  inputs: { neurons: number[]; rate: number }[];
  /** Rate changes applied just before the given step. */
  changes: { step: number; input: number; rate: number }[];
};

type Run = { spikes: number[][]; v: Float32Array; g: Float32Array; a: Float32Array };

function randomNetwork(random: () => number, n: number, maxDegree: number, maxCount: number): Net {
  const ptr = new Uint32Array(n + 1);
  const post: number[] = [];
  const count: number[] = [];
  for (let i = 0; i < n; i++) {
    const targets = new Set<number>();
    const degree = Math.floor(random() * (maxDegree + 1));
    while (targets.size < degree) targets.add(Math.floor(random() * n));
    for (const j of [...targets].sort((a, b) => a - b)) {
      post.push(j);
      count.push(1 + Math.floor(random() * maxCount));
    }
    ptr[i + 1] = post.length;
  }
  return { ptr, post: Uint32Array.from(post), count: Uint16Array.from(count) };
}

function randomSetup(seed: number, overrides: Partial<Setup> = {}): Setup {
  const random = mulberry32(seed);
  const n = 80 + Math.floor(random() * 80);
  const net = randomNetwork(random, n, 14, 10);
  // Mostly excitatory, some inhibitory, a few muted.
  const gain = Float32Array.from({ length: n }, () => {
    const r = random();
    return r < 0.65 ? 0.2 + random() * 0.9 : r < 0.93 ? -(0.3 + random() * 1.2) : 0;
  });
  const postScale = random() < 0.5 ? Float32Array.from({ length: n }, () => 0.5 + random()) : undefined;
  // A few tonic neurons, a few held down, the rest unbiased.
  const bias = random() < 0.7 ? Float32Array.from({ length: n }, () => (random() < 0.05 ? 7.5 + random() * 3 : random() < 0.05 ? -2 * random() : 0)) : undefined;
  const pick = (k: number) => Array.from({ length: k }, () => Math.floor(random() * n));
  return {
    net,
    gain,
    postScale,
    bias,
    dt: [0.5, 0.25, 0.1][Math.floor(random() * 3)],
    tauMem: 10 + random() * 20,
    tauSyn: 2 + random() * 6,
    threshold: 7,
    refractory: [0.3, 2.2, 5][Math.floor(random() * 3)],
    delay: [0.4, 1.8, 3.1][Math.floor(random() * 3)],
    epsilon: 1e-3,
    cleanupInterval: [1, 3, 16][Math.floor(random() * 3)],
    seed: Math.floor(random() * 2 ** 32),
    resetDrive: random() < 0.5,
    adaptation: random() < 0.5 ? { increment: 0.05 + random() * 0.5, tau: 20 + random() * 500 } : undefined,
    inputs: [
      { neurons: pick(12), rate: 80 + random() * 200 },
      { neurons: pick(30), rate: 5 + random() * 30 },
      { neurons: pick(5), rate: 0 },
    ],
    changes: [
      { step: 700, input: 0, rate: 0 },
      { step: 900, input: 2, rate: 400 },
      { step: 1500, input: 0, rate: 150 },
      { step: 2200, input: 2, rate: 0 },
    ],
    ...overrides,
  };
}

// Weak synapses, no tonic neurons, no adaptation (which keeps a neuron that
// fired active for a while), and all input stopped from step 800 to 2400
// (0.8 s): activity dies away and comes back, so neurons keep joining and
// leaving the active set.
function sparseSetup(seed: number): Setup {
  const setup = randomSetup(seed, { bias: undefined, dt: 0.5, adaptation: undefined });
  return {
    ...setup,
    gain: setup.gain.map((x) => x * 0.35),
    changes: [
      { step: 400, input: 2, rate: 300 },
      ...[0, 1, 2].map((input) => ({ step: 800, input, rate: 0 })),
      ...[0, 1, 2].map((input) => ({ step: 2400, input, rate: setup.inputs[0].rate })),
    ],
  };
}

function runEngine(setup: Setup, steps: number): Run & { sim: Simulation; activeLow: number; activeHigh: number } {
  const sim = new Simulation(setup.net, {
    dt: setup.dt,
    tauMem: setup.tauMem,
    tauSyn: setup.tauSyn,
    threshold: setup.threshold,
    refractory: setup.refractory,
    delay: setup.delay,
    epsilon: setup.epsilon,
    cleanupInterval: setup.cleanupInterval,
    seed: setup.seed,
    gain: setup.gain,
    postScale: setup.postScale,
    resetDrive: setup.resetDrive,
    adaptation: setup.adaptation,
  });
  if (setup.bias) sim.setBias(setup.bias);
  setup.inputs.forEach((input, q) => sim.addInput(`input ${q}`, input.neurons, input.rate));
  const spikes: number[][] = [];
  let activeLow = Infinity;
  let activeHigh = 0;
  for (let s = 0; s < steps; s++) {
    for (const change of setup.changes) if (change.step === s) sim.setRate(`input ${change.input}`, change.rate);
    sim.step();
    spikes.push([...sim.lastSpikes()]);
    if (s > 100) activeLow = Math.min(activeLow, sim.active);
    activeHigh = Math.max(activeHigh, sim.active);
  }
  const n = sim.neurons;
  return {
    sim,
    spikes,
    activeLow,
    activeHigh,
    v: Float32Array.from({ length: n }, (_, i) => sim.potential(i)),
    g: Float32Array.from({ length: n }, (_, i) => sim.drive(i)),
    a: Float32Array.from({ length: n }, (_, i) => sim.adaptationOf(i)),
  };
}

// The model stepped densely and naively: every neuron, every step. With
// `cut`, it applies the engine's rest cut (zeroing quiet neurons on cleanup
// steps) to every neuron; without, it never cuts.
function runReference(setup: Setup, steps: number, cut: boolean): Run {
  const { net, gain, postScale, dt } = setup;
  const n = net.ptr.length - 1;
  const leak = dt / setup.tauMem;
  const decay = Math.exp(-dt / setup.tauSyn);
  const keep = setup.resetDrive ? 0 : 1;
  const adaptDecay = setup.adaptation ? Math.exp(-dt / setup.adaptation.tau) : 0;
  const adaptStep = setup.adaptation ? setup.adaptation.increment : 0;
  const hold = Math.min(65535, Math.max(1, Math.round(setup.refractory / dt)));
  const delay = Math.max(1, Math.round(setup.delay / dt));
  const weight = new Float32Array(net.post.length);
  for (let i = 0; i < n; i++) {
    for (let e = net.ptr[i]; e < net.ptr[i + 1]; e++) weight[e] = net.count[e] * gain[i] * (postScale ? postScale[net.post[e]] : 1);
  }
  const bias = setup.bias ?? new Float32Array(n);
  const v = new Float32Array(n);
  const g = new Float32Array(n);
  const a = new Float32Array(n);
  const left = new Int32Array(n);
  const rates = setup.inputs.map((input) => input.rate);
  const sources = setup.inputs.map((input, q) => {
    const source = new PoissonInput(Uint32Array.from([...new Set(input.neurons)].sort((a, b) => a - b)), inputSeed(setup.seed, q));
    if (input.rate > 0) source.setProbability((input.rate * dt) / 1000);
    return source;
  });
  const picked = new Uint32Array(n);
  const spikes: number[][] = [];
  for (let s = 0; s < steps; s++) {
    for (const change of setup.changes) {
      if (change.step !== s || change.rate === rates[change.input]) continue;
      rates[change.input] = change.rate;
      sources[change.input].setProbability((change.rate * dt) / 1000);
    }
    if (s >= delay) {
      for (const pre of spikes[s - delay]) for (let e = net.ptr[pre]; e < net.ptr[pre + 1]; e++) g[net.post[e]] += weight[e];
    }
    const fired: number[] = [];
    const cleanup = cut && s % setup.cleanupInterval === setup.cleanupInterval - 1;
    for (let i = 0; i < n; i++) {
      const gi = g[i];
      const ai = a[i];
      g[i] = gi * decay;
      a[i] = ai * adaptDecay;
      if (left[i] > 0) {
        left[i]--;
      } else {
        const next = v[i] + leak * (gi + bias[i] - ai - v[i]);
        if (next >= setup.threshold) {
          v[i] = 0;
          g[i] = gi * decay * keep + 0;
          a[i] = ai * adaptDecay + adaptStep;
          left[i] = hold;
          fired.push(i);
        } else {
          v[i] = next;
        }
      }
      if (cleanup && left[i] === 0 && bias[i] === 0 && Math.abs(v[i]) < setup.epsilon && Math.abs(g[i]) < setup.epsilon && a[i] < setup.epsilon) {
        v[i] = 0;
        g[i] = 0;
        a[i] = 0;
      }
    }
    sources.forEach((source, q) => {
      if (rates[q] === 0) return;
      const m = source.sample(picked);
      for (let k = 0; k < m; k++) {
        const i = picked[k];
        if (left[i] !== 0) continue;
        v[i] = 0;
        if (setup.resetDrive) g[i] = 0;
        a[i] += adaptStep;
        left[i] = hold;
        fired.push(i);
      }
    });
    spikes.push(fired.sort((a, b) => a - b));
  }
  return { spikes, v, g, a };
}

const total = (spikes: number[][]) => spikes.reduce((sum, step) => sum + step.length, 0);

function assertMatches(setup: Setup, label: string) {
  const steps = 3000;
  const engine = runEngine(setup, steps);
  const reference = runReference(setup, steps, true);
  assert.ok(total(reference.spikes) > 200, `${label} should be lively, got ${total(reference.spikes)} spikes`);
  for (let s = 0; s < steps; s++) assert.deepEqual(engine.spikes[s], reference.spikes[s], `${label}, step ${s}`);
  assert.deepEqual(engine.v, reference.v, `${label}: v`);
  assert.deepEqual(engine.g, reference.g, `${label}: g`);
  assert.deepEqual(engine.a, reference.a, `${label}: a`);
  return engine;
}

test("the sparse engine matches the dense model, spike for spike and bit for bit", () => {
  for (let seed = 1; seed <= 12; seed++) assertMatches(randomSetup(seed), `seed ${seed}`);
});

test("it still matches while neurons keep joining and leaving the active set", () => {
  for (let seed = 51; seed <= 60; seed++) {
    const engine = assertMatches(sparseSetup(seed), `sparse seed ${seed}`);
    const n = engine.sim.neurons;
    assert.ok(engine.activeLow <= n * 0.1 && engine.activeHigh >= n * 0.4, `sparse seed ${seed}: active ranged ${engine.activeLow}-${engine.activeHigh} of ${n}`);
  }
});

test("with no rest cut the engine equals the uncut dense model exactly", () => {
  for (let seed = 21; seed <= 24; seed++) {
    const setup = randomSetup(seed, { epsilon: 0 });
    const engine = runEngine(setup, 2000);
    const reference = runReference(setup, 2000, false);
    assert.deepEqual(engine.spikes, reference.spikes, `seed ${seed}`);
    assert.deepEqual(engine.v, reference.v);
  }
});

// The rest cut moves v and g of a quiet neuron by less than epsilon (1e-3 mV,
// against a 7 mV threshold), so it can only change a spike when a neuron later
// lands within about that much of threshold. That makes differing spikes rare
// but, in a recurrent network, any one of them can set off others. The bound
// here, 1% of spikes differing, is loose enough for that and far tighter than
// any real bug (a wrong delay, sign or refractory period changes most spikes).
test("the rest cut changes almost nothing against the uncut dense model", () => {
  let differing = 0;
  let spikes = 0;
  for (let seed = 31; seed <= 40; seed++) {
    const setup = randomSetup(seed);
    const engine = runEngine(setup, 3000);
    const reference = runReference(setup, 3000, false);
    for (let s = 0; s < engine.spikes.length; s++) {
      const a = new Set(engine.spikes[s]);
      const b = new Set(reference.spikes[s]);
      for (const i of a) if (!b.has(i)) differing++;
      for (const i of b) if (!a.has(i)) differing++;
      spikes += a.size + b.size;
    }
  }
  assert.ok(spikes > 10_000);
  assert.ok(differing <= spikes * 0.01, `${differing} of ${spikes} spikes differ`);
});

test("a fixed seed gives the same run; reset replays it; another seed differs", () => {
  const setup = randomSetup(5, { bias: undefined });
  const a = runEngine(setup, 2000);
  const b = runEngine(setup, 2000);
  assert.deepEqual(a.spikes, b.spikes);

  const sim = a.sim;
  const firstRun = { spikes: sim.stats.spikes, events: sim.stats.events };
  // reset keeps the current rates, so put back the ones the run started with.
  setup.inputs.forEach((input, q) => sim.setRate(`input ${q}`, input.rate));
  sim.reset();
  assert.equal(sim.active, 0);
  assert.equal(sim.time, 0);
  const replay: number[][] = [];
  for (let s = 0; s < 2000; s++) {
    for (const change of setup.changes) if (change.step === s) sim.setRate(`input ${change.input}`, change.rate);
    sim.step();
    replay.push([...sim.lastSpikes()]);
  }
  assert.deepEqual(replay, a.spikes);
  assert.deepEqual({ spikes: sim.stats.spikes, events: sim.stats.events }, firstRun);

  const other = runEngine({ ...setup, seed: setup.seed + 1 }, 2000);
  assert.notDeepEqual(other.spikes, a.spikes);
});

test("readouts count each member's spikes, overlapping or not, until drained", () => {
  const setup = randomSetup(7);
  const sim = runEngine(setup, 0).sim;
  sim.addReadout("a", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  sim.addReadout("b", [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  sim.addReadout("triple", [3, 3, 3]);
  sim.setRecording(true);
  sim.advance(800);
  const recorded = sim.recording!;
  const sum = (members: number[]) => members.reduce((s, i) => s + recorded[i], 0);
  const counts = sim.drainReadouts();
  assert.deepEqual(counts, {
    a: sum([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    b: sum([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
    triple: recorded[3],
  });
  assert.ok(counts.a + counts.b > 0);
  assert.deepEqual(sim.drainReadouts(), { a: 0, b: 0, triple: 0 });
  assert.equal(recorded.reduce((s, x) => s + x, 0), sim.stats.spikes);
  assert.deepEqual([...sim.members("triple")], [3]);
  assert.throws(() => sim.addReadout("a", [1]), /already a readout called "a"/);
  assert.throws(() => sim.addReadout("bad", [sim.neurons]), /no neuron/);
  sim.setRecording(false);
  assert.equal(sim.recording, null);
});

test("advance runs whole steps and carries the remainder", () => {
  const setup = randomSetup(3);
  const sim = runEngine(setup, 0).sim;
  const dt = sim.dt;
  let steps = 0;
  for (let k = 0; k < 10; k++) steps += sim.advance(dt * 0.6);
  assert.equal(steps, 6);
  assert.equal(sim.stats.steps, 6);
  assert.equal(sim.advance(dt * 10), 10);
  assert.ok(Math.abs(sim.time - 16 * dt) < 1e-9);
});

test("bias drives a lone neuron tonically and keeps it active; muted neurons deliver nothing", () => {
  // 0 -> 1 with 5 synapses; neuron 0 muted at first.
  const net: Network = { ptr: Uint32Array.from([0, 1, 1, 1]), post: Uint32Array.from([1]), count: Uint16Array.from([5]) };
  const sim = new Simulation(net, { gain: new Float32Array(3) });
  sim.setBias(Float32Array.from([8, 0, 6]));
  assert.equal(sim.active, 2);
  sim.setRecording(true);
  sim.advance(1000);
  assert.ok(sim.recording![0] > 5, "bias above threshold fires");
  assert.equal(sim.recording![2], 0, "bias below threshold never does");
  assert.ok(sim.isActive(2));
  assert.equal(sim.stats.events, 0);
  assert.equal(sim.isActive(1), false);

  sim.setWeights(Float32Array.from([2, 0, 0]));
  sim.advance(200);
  assert.ok(sim.stats.events > 0);
  assert.ok(sim.drive(1) !== 0 || sim.potential(1) !== 0 || sim.isActive(1));

  sim.setBias(null);
  sim.advance(2000);
  assert.equal(sim.active, 0, "everything comes to rest");
  assert.equal(sim.potential(2), 0);
});

test("resetDrive clears the drive at each spike, so one strong input fires a neuron once", () => {
  // 0 -> 1 with 100 synapses of 1 mV: one spike gives neuron 1 a drive of 100 mV.
  const net: Network = { ptr: Uint32Array.from([0, 1, 1]), post: Uint32Array.from([1]), count: Uint16Array.from([100]) };
  const fired = (resetDrive: boolean) => {
    const sim = new Simulation(net, { gain: Float32Array.from([1, 0]), resetDrive });
    sim.addInput("kick", [0], 0);
    sim.setRecording(true);
    sim.setRate("kick", 1e6);
    sim.step();
    sim.setRate("kick", 0);
    sim.advance(200);
    if (resetDrive) assert.equal(sim.drive(1), 0);
    return sim.recording![1];
  };
  assert.equal(fired(true), 1);
  assert.ok(fired(false) > 1, "without the reset the leftover drive fires it again");
});

test("adaptation slows a tonically driven neuron, then decays away", () => {
  const net: Network = { ptr: Uint32Array.from([0, 0]), post: new Uint32Array(0), count: new Uint16Array(0) };
  const rate = (adaptation?: { increment: number; tau: number }) => {
    const sim = new Simulation(net, { gain: new Float32Array(1), adaptation });
    sim.setBias(Float32Array.from([12]));
    sim.setRecording(true);
    sim.advance(2000);
    const spikes = sim.recording![0];
    if (adaptation) {
      assert.ok(sim.adaptationOf(0) > 1);
      sim.setBias(null);
      sim.advance(10 * adaptation.tau);
      assert.equal(sim.active, 0, "it rests once the adaptation has decayed");
      assert.equal(sim.adaptationOf(0), 0);
    } else {
      assert.equal(sim.adaptationOf(0), 0);
    }
    return spikes / 2;
  };
  const plain = rate();
  const adapted = rate({ increment: 0.5, tau: 200 });
  assert.ok(plain > 50, `${plain} Hz without adaptation`);
  assert.ok(adapted < plain * 0.75, `${adapted} Hz with adaptation, against ${plain} Hz without`);
});

test("bad arguments are refused", () => {
  const net: Network = { ptr: Uint32Array.from([0, 0]), post: new Uint32Array(0), count: new Uint16Array(0) };
  assert.throws(() => new Simulation(net, { gain: new Float32Array(2) }), /gain has 2 entries, expected 1/);
  assert.throws(() => new Simulation(net, { gain: new Float32Array(1), dt: 0 }), /must be positive/);
  assert.throws(() => new Simulation(net, { gain: new Float32Array(1), cleanupInterval: 0.5 }), /cleanupInterval/);
  assert.throws(() => new Simulation(net, { gain: new Float32Array(1), adaptation: { increment: -1, tau: 10 } }), /adaptation/);
  assert.throws(() => new Simulation(net, { gain: new Float32Array(1), adaptation: { increment: 1, tau: 0 } }), /adaptation/);
  const sim = new Simulation(net, { gain: new Float32Array(1) });
  sim.addInput("x", [0]);
  assert.throws(() => sim.addInput("x", [0]), /already an input called "x"/);
  assert.throws(() => sim.addInput("y", [1]), /no neuron 1/);
  assert.throws(() => sim.setRate("x", -1), /zero or more/);
  assert.throws(() => sim.setRate("z", 1), /No input called "z"/);
  assert.throws(() => sim.setBias(new Float32Array(3)), /bias has 3 entries/);
});

test("Poisson inputs fire at the set rate, independently across neurons and steps", () => {
  const n = 2000;
  const steps = 4000;
  const p = 0.005;
  const input = new PoissonInput(Uint32Array.from({ length: n }, (_, i) => i), 99);
  input.setProbability(p);
  const out = new Uint32Array(n);
  const perNeuron = new Uint32Array(n);
  let previous = new Uint8Array(n);
  let pairs = 0;
  let spikes = 0;
  for (let s = 0; s < steps; s++) {
    const now = new Uint8Array(n);
    const m = input.sample(out);
    for (let k = 0; k < m; k++) {
      const i = out[k];
      assert.equal(now[i], 0, "a neuron is picked at most once a step");
      now[i] = 1;
      perNeuron[i]++;
      if (previous[i]) pairs++;
    }
    spikes += m;
    previous = now;
  }
  const expected = n * steps * p;
  const sd = Math.sqrt(n * steps * p * (1 - p));
  assert.ok(Math.abs(spikes - expected) < 5 * sd, `${spikes} spikes, expected ${expected} ± ${sd.toFixed(0)}`);
  const mean = spikes / n;
  const variance = perNeuron.reduce((s, c) => s + (c - mean) ** 2, 0) / (n - 1);
  // Binomial per neuron: variance ≈ mean (1 - p).
  assert.ok(variance > 17 && variance < 23, `per-neuron variance ${variance.toFixed(1)}`);
  // Firing in consecutive steps as often as chance says: n (steps - 1) p².
  const expectedPairs = n * (steps - 1) * p * p;
  assert.ok(Math.abs(pairs - expectedPairs) < 5 * Math.sqrt(expectedPairs), `${pairs} consecutive pairs, expected ${expectedPairs}`);

  input.setProbability(1);
  assert.equal(input.sample(out), n);
  input.setProbability(0);
  assert.equal(input.sample(out), 0);
});

test("a driven neuron fires at the Poisson rate, less what refractoriness takes", () => {
  // No connections; 500 neurons at 100 Hz, dt 0.5 ms, refractory 4 steps. A
  // picked neuron is blocked for the next refractory - 1 steps, so the mean
  // interval is (R - 1) + 1/p steps.
  const n = 500;
  const net: Network = { ptr: new Uint32Array(n + 1), post: new Uint32Array(0), count: new Uint16Array(0) };
  const sim = new Simulation(net, { gain: new Float32Array(n), seed: 4 });
  sim.addInput("all", Array.from({ length: n }, (_, i) => i), 100);
  sim.advance(10_000);
  const p = (100 * 0.5) / 1000;
  const expectedHz = 1000 / 0.5 / (sim.refractorySteps - 1 + 1 / p);
  const hz = sim.stats.spikes / n / 10;
  assert.ok(Math.abs(hz - expectedHz) / expectedHz < 0.01, `${hz.toFixed(2)} Hz, expected ${expectedHz.toFixed(2)}`);
  // Nothing to deliver to, so nothing but the driven neurons is ever active.
  assert.ok(sim.active <= n);
  assert.equal(sim.stats.events, 0);
});
