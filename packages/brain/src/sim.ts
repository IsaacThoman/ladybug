// The spiking engine: leaky integrate-and-fire neurons on a connectome, stepped
// sparsely so that only neurons with some state cost anything.
//
// Each neuron has a membrane potential v (mV above rest), a synaptic drive g
// (mV) and, optionally, a spike-frequency adaptation a (mV), with
//
//   dv/dt = (g + bias - a - v) / tauMem   dg/dt = -g / tauSyn   da/dt = -a / tauAdapt
//
// stepped with forward Euler for v and exact decays for g and a. A neuron
// spikes when v reaches the threshold; then v resets to 0 and holds there for
// the refractory period, a grows by the adaptation increment, and with
// `resetDrive` g is cleared to 0 too. A spike adds its edge weight to each
// target's g after the synaptic delay. An edge's weight is
// count × gain[pre] × postScale[post].
//
// Step s (counting from 0) does, in order:
//   1. deliver the spikes fired at step s - delay, in ascending neuron order;
//   2. update every active neuron: decay g and a; if refractory, count down
//      and hold v at 0, otherwise integrate v and fire at threshold;
//   3. fire the neurons the Poisson inputs pick, unless refractory.
// Delivering in a fixed order keeps g's float sums, and so the whole run,
// independent of where neurons happen to sit in the active set.
//
// A neuron is active while it has state. It joins the active set when a spike
// reaches it, an input fires it or it gets a bias. Every `cleanupInterval`
// steps (on steps where s % cleanupInterval is cleanupInterval - 1), after its
// update, a neuron that is not refractory, has no bias, and has |v|, |g| and a
// below `epsilon` is set to exactly 0 and leaves. That cut is the only way the
// result differs from stepping every neuron densely, and it moves v, g and a
// by less than epsilon.

import type { Connectome } from "./format.ts";

/** The wiring the engine needs: CSR by presynaptic neuron, as in format.ts. */
export type Network = {
  readonly ptr: Uint32Array;
  readonly post: Uint32Array;
  readonly count: ArrayLike<number>;
};

export type SimulationOptions = {
  /** Step, ms. Default 0.5. */
  dt?: number;
  /** Membrane time constant, ms. Default 20. */
  tauMem?: number;
  /** Synaptic time constant, ms. Default 5. */
  tauSyn?: number;
  /** Spike threshold, mV above rest. Default 7. */
  threshold?: number;
  /** Refractory period, ms; rounded to whole steps, at least one. Default 2.2. */
  refractory?: number;
  /** Synaptic delay, ms; rounded to whole steps, at least one. Default 1.8. */
  delay?: number;
  /** State below this, in mV, counts as rest. Default 1e-3. */
  epsilon?: number;
  /** Steps between checks for neurons at rest. Default 16. */
  cleanupInterval?: number;
  /** mV per synapse, per presynaptic neuron: negative inhibits, 0 mutes. */
  gain: Float32Array;
  /** Optional per-postsynaptic-neuron factor on incoming weights. */
  postScale?: Float32Array;
  /** Seeds the Poisson inputs. Default 1. */
  seed?: number;
  /**
   * Whether a spike also clears the neuron's synaptic drive g, as the reset of
   * Shiu et al. (2024) does (v = v_rst; g = 0). Default false.
   */
  resetDrive?: boolean;
  /**
   * Spike-frequency adaptation: each spike adds `increment` mV to an
   * adaptation variable a that decays with time constant `tau` ms and is
   * subtracted from the drive, dv/dt = (g + bias - a - v) / tauMem. Default
   * none.
   */
  adaptation?: { increment: number; tau: number };
};

export type SimulationStats = {
  /** Steps run since construction or reset. */
  steps: number;
  /** Spikes fired. */
  spikes: number;
  /** Spike deliveries to individual targets (muted neurons' spikes excluded). */
  events: number;
};

// Per-neuron state is interleaved, four floats a neuron, so an update touches
// one cache line rather than four; this is most of the sweep's speed. The
// bias, which is rare, is kept apart, and so are the neurons that have one:
// they are stepped by their own loop, which spares the main sweep the bias
// term.
const STRIDE = 4;
const SHIFT = 2;
const V = 0;
const G = 1;
// Spike-frequency adaptation, mV, subtracted from the drive.
const ADAPT = 2;
// Steps of refractory period left, a small whole number held as a float.
const HOLD = 3;

const SORT_BITS = 11;

export class Simulation {
  readonly neurons: number;
  readonly connections: number;
  readonly dt: number;
  readonly tauMem: number;
  readonly tauSyn: number;
  readonly threshold: number;
  readonly refractory: number;
  readonly delay: number;
  readonly epsilon: number;
  readonly cleanupInterval: number;
  readonly seed: number;
  readonly resetDrive: boolean;
  readonly adaptation: { readonly increment: number; readonly tau: number } | null;
  /** Synaptic delay and refractory period in whole steps. */
  readonly delaySteps: number;
  readonly refractorySteps: number;
  readonly stats: SimulationStats = { steps: 0, spikes: 0, events: 0 };

  #ptr: Uint32Array;
  #post: Uint32Array;
  #count: ArrayLike<number>;
  #weight: Float32Array;
  // Neurons whose every outgoing weight is 0; their spikes are not delivered,
  // which is exact, since adding 0 changes nothing.
  #silent: Uint8Array;
  #state: Float32Array;
  #bias: Float32Array;
  // Neurons with a nonzero bias. They count as active (inSet is 1) but are
  // kept out of the active list, never cut, and stepped by sweepBiased.
  #biased = new Uint32Array(0);
  #leak: number;
  #decay: number;
  // Per-step decay of the adaptation variable, and what a spike adds to it.
  // 0 with resetDrive, else 1: what a spike multiplies g by.
  #keepDrive: number;
  #adaptDecay: number;
  #adaptStep: number;

  #inSet: Uint8Array;
  #active: Uint32Array;
  #activeCount = 0;
  // active[0..sorted) is ascending; later entries were appended since.
  #sorted = 0;

  // Spikes by the step they were fired in, modulo the delay.
  #ring: Uint32Array[];
  #ringLength: Uint32Array;
  #lastSlot = -1;

  #inputs: { name: string; neurons: Uint32Array; rate: number; source: PoissonInput }[] = [];
  #scratch: Uint32Array;
  #bins = new Uint32Array((1 << SORT_BITS) + 1);
  #sortPasses: number;

  #readoutNames: string[] = [];
  #readoutMembers: Uint32Array[] = [];
  #readoutCounts = new Uint32Array(0);
  #watched: Uint8Array;
  #watchPtr = new Uint32Array(0);
  #watchIds = new Uint32Array(0);

  #recording: Uint32Array | null = null;
  #carryMs = 0;
  #sweepResult = new Uint32Array(2);

  constructor(network: Network, options: SimulationOptions) {
    const n = network.ptr.length - 1;
    if (n < 0) throw new Error("ptr must have at least one entry");
    this.neurons = n;
    this.connections = network.post.length;
    if (network.count.length !== this.connections) throw new Error("post and count differ in length");
    if (network.ptr[0] !== 0 || network.ptr[n] !== this.connections) throw new Error("ptr does not span the connections");
    this.dt = options.dt ?? 0.5;
    this.tauMem = options.tauMem ?? 20;
    this.tauSyn = options.tauSyn ?? 5;
    this.threshold = options.threshold ?? 7;
    this.refractory = options.refractory ?? 2.2;
    this.delay = options.delay ?? 1.8;
    this.epsilon = options.epsilon ?? 1e-3;
    this.cleanupInterval = options.cleanupInterval ?? 16;
    this.seed = options.seed ?? 1;
    this.resetDrive = options.resetDrive ?? false;
    const adaptation = options.adaptation;
    if (adaptation && !(adaptation.increment >= 0 && adaptation.tau > 0)) throw new Error("adaptation needs an increment of zero or more and a positive tau");
    this.adaptation = adaptation && adaptation.increment > 0 ? { increment: adaptation.increment, tau: adaptation.tau } : null;
    if (!(this.dt > 0 && this.tauMem > 0 && this.tauSyn > 0)) throw new Error("dt and the time constants must be positive");
    if (!(this.epsilon >= 0)) throw new Error("epsilon must not be negative");
    if (!(Number.isInteger(this.cleanupInterval) && this.cleanupInterval >= 1)) throw new Error("cleanupInterval must be a whole number of steps");
    this.#leak = this.dt / this.tauMem;
    this.#decay = Math.exp(-this.dt / this.tauSyn);
    this.#keepDrive = this.resetDrive ? 0 : 1;
    this.#adaptDecay = this.adaptation ? Math.exp(-this.dt / this.adaptation.tau) : 0;
    this.#adaptStep = this.adaptation ? this.adaptation.increment : 0;
    this.refractorySteps = Math.min(65535, Math.max(1, Math.round(this.refractory / this.dt)));
    this.delaySteps = Math.max(1, Math.round(this.delay / this.dt));

    this.#ptr = network.ptr;
    this.#post = network.post;
    this.#count = network.count;
    this.#weight = new Float32Array(this.connections);
    this.#silent = new Uint8Array(n);
    this.#state = new Float32Array(STRIDE * n);
    this.#bias = new Float32Array(n);
    this.#inSet = new Uint8Array(n);
    this.#active = new Uint32Array(n);
    this.#scratch = new Uint32Array(n);
    this.#watched = new Uint8Array(n);
    this.#ring = Array.from({ length: this.delaySteps }, () => new Uint32Array(Math.min(n, 256)));
    this.#ringLength = new Uint32Array(this.delaySteps);
    let bits = 1;
    while (2 ** bits < n) bits++;
    this.#sortPasses = Math.ceil(bits / SORT_BITS);
    this.setWeights(options.gain, options.postScale);
  }

  /** Simulated time since construction or reset, ms. */
  get time() {
    return this.stats.steps * this.dt;
  }

  /** Neurons in the active set now. */
  get active() {
    return this.#activeCount + this.#biased.length;
  }

  /** Neuron i's membrane potential, mV above rest. */
  potential(i: number) {
    return this.#state[STRIDE * i + V];
  }

  /** Neuron i's synaptic drive, mV. */
  drive(i: number) {
    return this.#state[STRIDE * i + G];
  }

  /** Neuron i's adaptation, mV (0 without adaptation). */
  adaptationOf(i: number) {
    return this.#state[STRIDE * i + ADAPT];
  }

  /** Whether neuron i is in the active set. */
  isActive(i: number) {
    return this.#inSet[i] === 1;
  }

  /** Recomputes every edge weight: count × gain[pre] × postScale[post]. */
  setWeights(gain: Float32Array, postScale?: Float32Array) {
    const n = this.neurons;
    if (gain.length !== n) throw new Error(`gain has ${gain.length} entries, expected ${n}`);
    if (postScale && postScale.length !== n) throw new Error(`postScale has ${postScale.length} entries, expected ${n}`);
    const ptr = this.#ptr;
    const post = this.#post;
    const count = this.#count;
    const weight = this.#weight;
    for (let i = 0; i < n; i++) {
      const gi = gain[i];
      let silent = 1;
      for (let e = ptr[i], end = ptr[i + 1]; e < end; e++) {
        weight[e] = postScale ? count[e] * gi * postScale[post[e]] : count[e] * gi;
        if (weight[e] !== 0) silent = 0;
      }
      this.#silent[i] = silent;
    }
  }

  /**
   * Sets a steady drive, mV, added to each neuron's g when integrating v (so v
   * settles at g + bias). Neurons with a bias never leave the active set, so
   * each costs an update every step. Pass null to clear it.
   */
  setBias(bias: Float32Array | null) {
    if (bias && bias.length !== this.neurons) throw new Error(`bias has ${bias.length} entries, expected ${this.neurons}`);
    // Neurons that had a bias rejoin the active list, which cuts them once at rest.
    for (const i of this.#biased) this.#active[this.#activeCount++] = i;
    const biased: number[] = [];
    for (let i = 0; i < this.neurons; i++) {
      this.#bias[i] = bias ? bias[i] : 0;
      if (this.#bias[i] !== 0) biased.push(i);
    }
    this.#biased = Uint32Array.from(biased);
    if (biased.length > 0) {
      let kept = 0;
      for (let k = 0; k < this.#activeCount; k++) {
        const i = this.#active[k];
        if (this.#bias[i] === 0) this.#active[kept++] = i;
      }
      this.#activeCount = kept;
    }
    this.#sort(this.#active, this.#activeCount);
    this.#sorted = this.#activeCount;
    this.#activateBiased();
  }

  /**
   * Adds a named group of neurons driven as independent Poisson spike trains
   * at `rateHz` each. A picked neuron fires unless it is refractory. Each group
   * draws from its own stream, seeded from the simulation's seed and the
   * group's position, so adding groups does not disturb earlier ones.
   */
  addInput(name: string, neurons: ArrayLike<number>, rateHz = 0) {
    if (this.#inputs.some((input) => input.name === name)) throw new Error(`There is already an input called "${name}"`);
    const members = this.#members(neurons, `input "${name}"`);
    const source = new PoissonInput(members, inputSeed(this.seed, this.#inputs.length));
    this.#inputs.push({ name, neurons: members, rate: 0, source });
    this.setRate(name, rateHz);
  }

  /** Changes an input's rate, Hz per neuron, from the next step on. */
  setRate(name: string, rateHz: number) {
    const input = this.#inputs.find((each) => each.name === name);
    if (!input) throw new Error(`No input called "${name}"`);
    if (!(rateHz >= 0)) throw new Error("Input rates must be zero or more");
    if (rateHz === input.rate) return;
    input.rate = rateHz;
    input.source.setProbability((rateHz * this.dt) / 1000);
  }

  /** Adds a named group of neurons whose spikes drainReadouts counts. */
  addReadout(name: string, neurons: ArrayLike<number>) {
    if (this.#readoutNames.includes(name)) throw new Error(`There is already a readout called "${name}"`);
    this.#readoutNames.push(name);
    this.#readoutMembers.push(this.#members(neurons, `readout "${name}"`));
    const counts = new Uint32Array(this.#readoutNames.length);
    counts.set(this.#readoutCounts);
    this.#readoutCounts = counts;
    // Neuron -> readouts, as CSR.
    const n = this.neurons;
    const ptr = new Uint32Array(n + 1);
    for (const members of this.#readoutMembers) for (const i of members) ptr[i + 1]++;
    for (let i = 0; i < n; i++) ptr[i + 1] += ptr[i];
    const ids = new Uint32Array(ptr[n]);
    const fill = ptr.slice(0, n);
    this.#readoutMembers.forEach((members, r) => {
      for (const i of members) ids[fill[i]++] = r;
    });
    this.#watchPtr = ptr;
    this.#watchIds = ids;
    for (let i = 0; i < n; i++) this.#watched[i] = ptr[i + 1] > ptr[i] ? 1 : 0;
  }

  /** Spikes in each readout since the last drain. */
  drainReadouts(into: Record<string, number> = {}): Record<string, number> {
    const counts = this.#readoutCounts;
    this.#readoutNames.forEach((name, r) => {
      into[name] = counts[r];
    });
    counts.fill(0);
    return into;
  }

  /** The neurons of a readout or input, deduplicated and ascending. */
  members(name: string): Uint32Array {
    const r = this.#readoutNames.indexOf(name);
    if (r >= 0) return this.#readoutMembers[r];
    const input = this.#inputs.find((each) => each.name === name);
    if (input) return input.neurons;
    throw new Error(`No readout or input called "${name}"`);
  }

  /**
   * Turns per-neuron spike counting on (from zero) or off. While on,
   * `recording` holds each neuron's spikes since then.
   */
  setRecording(on: boolean) {
    this.#recording = on ? new Uint32Array(this.neurons) : null;
  }

  get recording(): Uint32Array | null {
    return this.#recording;
  }

  /** The neurons that spiked in the last step, ascending. A view: copy it to keep it. */
  lastSpikes(): Uint32Array {
    if (this.#lastSlot < 0) return new Uint32Array(0);
    return this.#ring[this.#lastSlot].subarray(0, this.#ringLength[this.#lastSlot]);
  }

  /**
   * Runs whole steps covering `ms` of simulated time. Remainders carry over,
   * so many short calls add up to the right number of steps. Returns the
   * number of steps run.
   */
  advance(ms: number): number {
    const total = this.#carryMs + ms;
    const steps = Math.max(0, Math.floor(total / this.dt + 1e-9));
    this.#carryMs = Math.max(0, total - steps * this.dt);
    for (let s = 0; s < steps; s++) this.step();
    return steps;
  }

  /** Back to rest at time 0, with the inputs reseeded. Wiring, inputs, rates, readouts and bias stay. */
  reset() {
    const state = this.#state;
    for (let i = 0; i < this.neurons; i++) {
      state[STRIDE * i + V] = 0;
      state[STRIDE * i + G] = 0;
      state[STRIDE * i + HOLD] = 0;
      state[STRIDE * i + ADAPT] = 0;
    }
    this.#inSet.fill(0);
    this.#activeCount = 0;
    this.#sorted = 0;
    this.#ringLength.fill(0);
    this.#lastSlot = -1;
    this.#carryMs = 0;
    this.stats.steps = 0;
    this.stats.spikes = 0;
    this.stats.events = 0;
    this.#readoutCounts.fill(0);
    this.#recording?.fill(0);
    this.#inputs.forEach((input, k) => {
      input.source = new PoissonInput(input.neurons, inputSeed(this.seed, k));
      input.source.setProbability((input.rate * this.dt) / 1000);
    });
    this.#activateBiased();
  }

  /** Runs one step of dt. */
  step() {
    const slot = this.stats.steps % this.delaySteps;
    const state = this.#state;
    const inSet = this.#inSet;
    const active = this.#active;
    let count = this.#activeCount;

    // 1. Deliver the spikes from `delay` steps ago, which sit in this slot.
    const arriving = this.#ring[slot];
    const arrivingLength = this.#ringLength[slot];
    if (arrivingLength > 0) {
      const ptr = this.#ptr;
      const post = this.#post;
      const weight = this.#weight;
      const silent = this.#silent;
      let events = 0;
      for (let k = 0; k < arrivingLength; k++) {
        const pre = arriving[k];
        if (silent[pre] !== 0) continue;
        const start = ptr[pre];
        const end = ptr[pre + 1];
        events += end - start;
        for (let e = start; e < end; e++) {
          const j = post[e] | 0;
          state[(j << SHIFT) + G] += weight[e];
          if (inSet[j] === 0) {
            inSet[j] = 1;
            active[count++] = j;
          }
        }
      }
      this.stats.events += events;
    }

    // 2. Update the active neurons. This step's spikes overwrite the slot just
    // delivered; room is made up front because a call inside the sweep would
    // stop V8 hoisting its typed-array loads out of the loop.
    const biased = this.#biased;
    let out = arriving.length >= count + biased.length ? arriving : this.#grow(slot, count + biased.length);
    const cleanup = this.stats.steps % this.cleanupInterval === this.cleanupInterval - 1;
    let fired: number;
    if (cleanup) {
      const result = this.#sweepResult;
      fired = sweepAndCleanup(
        active,
        count,
        this.#sorted,
        inSet,
        state,
        out,
        this.#leak,
        this.#decay,
        this.threshold,
        this.refractorySteps,
        this.#keepDrive,
        this.#adaptDecay,
        this.#adaptStep,
        this.epsilon,
        result,
      );
      count = result[0];
      this.#sorted = result[1];
      // The sweep runs several times faster in index order than in arrival
      // order, so re-sort once enough has been appended.
      if (count - this.#sorted > (count >>> 3) + 64) {
        this.#sort(active, count);
        this.#sorted = count;
      }
    } else {
      fired = sweep(active, count, state, out, this.#leak, this.#decay, this.threshold, this.refractorySteps, this.#keepDrive, this.#adaptDecay, this.#adaptStep);
    }
    if (biased.length > 0) {
      fired = sweepBiased(biased, state, this.#bias, out, fired, this.#leak, this.#decay, this.threshold, this.refractorySteps, this.#keepDrive, this.#adaptDecay, this.#adaptStep);
    }

    // 3. Poisson inputs.
    const inputs = this.#inputs;
    const picked = this.#scratch;
    const refractorySteps = this.refractorySteps;
    const resetDrive = this.resetDrive;
    const adaptStep = this.#adaptStep;
    for (let q = 0; q < inputs.length; q++) {
      const input = inputs[q];
      if (input.rate === 0) continue;
      const m = input.source.sample(picked);
      if (out.length < fired + m) out = this.#grow(slot, fired + m);
      for (let k = 0; k < m; k++) {
        const i = picked[k];
        const o = i * STRIDE;
        if (state[o + HOLD] !== 0) continue;
        state[o + V] = 0;
        if (resetDrive) state[o + G] = 0;
        state[o + ADAPT] += adaptStep;
        state[o + HOLD] = refractorySteps;
        out[fired++] = i;
        if (inSet[i] === 0) {
          inSet[i] = 1;
          active[count++] = i;
        }
      }
    }
    this.#activeCount = count;

    if (fired > 1) this.#sort(out, fired);
    this.#ringLength[slot] = fired;
    this.#lastSlot = slot;
    this.stats.steps++;
    if (fired === 0) return;
    this.stats.spikes += fired;
    const recording = this.#recording;
    if (recording !== null) for (let k = 0; k < fired; k++) recording[out[k]]++;
    if (this.#readoutNames.length > 0) {
      const watched = this.#watched;
      const watchPtr = this.#watchPtr;
      const watchIds = this.#watchIds;
      const counts = this.#readoutCounts;
      for (let k = 0; k < fired; k++) {
        const i = out[k];
        if (watched[i] === 0) continue;
        for (let m = watchPtr[i], end = watchPtr[i + 1]; m < end; m++) counts[watchIds[m]]++;
      }
    }
  }

  // Makes room for `needed` spikes in a slot, keeping what is there.
  #grow(slot: number, needed: number) {
    const old = this.#ring[slot];
    const bigger = new Uint32Array(Math.min(this.neurons, Math.max(needed, old.length * 2)));
    bigger.set(old);
    this.#ring[slot] = bigger;
    return bigger;
  }

  #activateBiased() {
    for (const i of this.#biased) this.#inSet[i] = 1;
  }

  #members(neurons: ArrayLike<number>, what: string) {
    const unique = [...new Set(Array.from(neurons))].sort((a, b) => a - b);
    for (const i of unique) if (!Number.isInteger(i) || i < 0 || i >= this.neurons) throw new Error(`${what}: no neuron ${i}`);
    return Uint32Array.from(unique);
  }

  // Sorts a[0..n) ascending without allocating: insertion sort when short,
  // otherwise LSD radix through the scratch buffer (free outside step 3).
  #sort(a: Uint32Array, n: number) {
    if (n < 48) {
      for (let k = 1; k < n; k++) {
        const x = a[k];
        let m = k - 1;
        while (m >= 0 && a[m] > x) {
          a[m + 1] = a[m];
          m--;
        }
        a[m + 1] = x;
      }
      return;
    }
    const bins = this.#bins;
    const mask = (1 << SORT_BITS) - 1;
    let from = a;
    let to = this.#scratch;
    for (let pass = 0; pass < this.#sortPasses; pass++) {
      const shift = pass * SORT_BITS;
      bins.fill(0);
      for (let k = 0; k < n; k++) bins[((from[k] >>> shift) & mask) + 1]++;
      for (let b = 0; b < mask + 1; b++) bins[b + 1] += bins[b];
      for (let k = 0; k < n; k++) to[bins[(from[k] >>> shift) & mask]++] = from[k];
      const swap = from;
      from = to;
      to = swap;
    }
    if (from !== a) a.set(from.subarray(0, n));
  }
}

// Step 2 of Simulation.step: updates active[0..count) and writes this step's
// spikes to `out`, returning how many. On cleanup steps sweepAndCleanup does
// the same and also drops neurons at rest, compacting the list. They are
// separate loops because V8 optimises each far better than one loop with a
// flag; the update itself must stay the same in both. It computes the
// integrated v before looking at the refractory count (a held neuron's v is 0,
// so this is harmless) which keeps the loop free of dependent branches; `| 0`
// tells V8 the index is a small integer.
function sweep(
  active: Uint32Array,
  count: number,
  state: Float32Array,
  out: Uint32Array,
  leak: number,
  decay: number,
  threshold: number,
  refractorySteps: number,
  keepDrive: number,
  adaptDecay: number,
  adaptStep: number,
) {
  let fired = 0;
  for (let k = 0; k < count; k++) {
    const i = active[k] | 0;
    const o = i << SHIFT;
    const v = state[o + V];
    const g = state[o + G];
    const hold = state[o + HOLD];
    const a = state[o + ADAPT];
    const next = v + leak * (g - a - v);
    const decayed = g * decay;
    state[o + G] = decayed;
    state[o + ADAPT] = a * adaptDecay;
    if (hold > 0) {
      state[o + HOLD] = hold - 1;
    } else if (next >= threshold) {
      state[o + V] = 0;
      // + 0 turns -0 into 0, so that a cleared drive is exactly 0.
      state[o + G] = decayed * keepDrive + 0;
      state[o + ADAPT] = a * adaptDecay + adaptStep;
      state[o + HOLD] = refractorySteps;
      out[fired++] = i;
    } else {
      state[o + V] = next;
    }
  }
  return fired;
}

// The same update for the biased neurons, appending their spikes to out[from..].
function sweepBiased(
  biased: Uint32Array,
  state: Float32Array,
  bias: Float32Array,
  out: Uint32Array,
  from: number,
  leak: number,
  decay: number,
  threshold: number,
  refractorySteps: number,
  keepDrive: number,
  adaptDecay: number,
  adaptStep: number,
) {
  let fired = from;
  for (let k = 0; k < biased.length; k++) {
    const i = biased[k] | 0;
    const o = i << SHIFT;
    const v = state[o + V];
    const g = state[o + G];
    const hold = state[o + HOLD];
    const a = state[o + ADAPT];
    const next = v + leak * (g + bias[i] - a - v);
    const decayed = g * decay;
    state[o + G] = decayed;
    state[o + ADAPT] = a * adaptDecay;
    if (hold > 0) {
      state[o + HOLD] = hold - 1;
    } else if (next >= threshold) {
      state[o + V] = 0;
      // + 0 turns -0 into 0, so that a cleared drive is exactly 0.
      state[o + G] = decayed * keepDrive + 0;
      state[o + ADAPT] = a * adaptDecay + adaptStep;
      state[o + HOLD] = refractorySteps;
      out[fired++] = i;
    } else {
      state[o + V] = next;
    }
  }
  return fired;
}

// result gets the new active count and the length of the list's sorted prefix.
function sweepAndCleanup(
  active: Uint32Array,
  count: number,
  sortedBefore: number,
  inSet: Uint8Array,
  state: Float32Array,
  out: Uint32Array,
  leak: number,
  decay: number,
  threshold: number,
  refractorySteps: number,
  keepDrive: number,
  adaptDecay: number,
  adaptStep: number,
  epsilon: number,
  result: Uint32Array,
) {
  let fired = 0;
  let kept = 0;
  let sorted = sortedBefore >= count ? -1 : 0;
  for (let k = 0; k < count; k++) {
    if (k === sortedBefore) sorted = kept;
    const i = active[k] | 0;
    const o = i << SHIFT;
    const v = state[o + V];
    const g = state[o + G];
    const hold = state[o + HOLD];
    const a = state[o + ADAPT];
    const next = v + leak * (g - a - v);
    const decayed = g * decay;
    state[o + G] = decayed;
    state[o + ADAPT] = a * adaptDecay;
    if (hold > 0) {
      state[o + HOLD] = hold - 1;
    } else if (next >= threshold) {
      state[o + V] = 0;
      // + 0 turns -0 into 0, so that a cleared drive is exactly 0.
      state[o + G] = decayed * keepDrive + 0;
      state[o + ADAPT] = a * adaptDecay + adaptStep;
      state[o + HOLD] = refractorySteps;
      out[fired++] = i;
    } else {
      state[o + V] = next;
    }
    // Compared as stored, in single precision, as the dense reference does.
    // The most active neurons fail the first test, so it goes first.
    if (
      Math.abs(state[o + V]) < epsilon &&
      Math.abs(state[o + G]) < epsilon &&
      state[o + HOLD] === 0 &&
      state[o + ADAPT] < epsilon
    ) {
      state[o + V] = 0;
      state[o + G] = 0;
      state[o + ADAPT] = 0;
      inSet[i] = 0;
    } else {
      active[kept++] = i;
    }
  }
  result[0] = kept;
  result[1] = sorted < 0 ? kept : sorted;
  return fired;
}

/**
 * Independent Bernoulli trials of probability p for each neuron each step
 * (a Poisson train of rate p / dt), drawn by skipping geometric gaps between
 * successes, so the cost is per spike rather than per neuron per step.
 */
export class PoissonInput {
  readonly neurons: Uint32Array;
  #random: () => number;
  #p = 0;
  #logMiss = 0;
  // Trials from the start of the next step to the next success.
  #next = Infinity;

  constructor(neurons: Uint32Array, seed: number) {
    this.neurons = neurons;
    this.#random = mulberry32(seed);
  }

  /**
   * The chance each neuron fires in a step. Changing it redraws the gap to the
   * next success, which is fair because the trials are memoryless.
   */
  setProbability(p: number) {
    this.#p = Math.min(1, Math.max(0, p));
    this.#logMiss = Math.log1p(-this.#p);
    this.#next = this.#gap();
  }

  /** Writes this step's firing neurons into `out`, in group order; returns how many. */
  sample(out: Uint32Array): number {
    const size = this.neurons.length;
    let at = this.#next;
    let n = 0;
    while (at < size) {
      out[n++] = this.neurons[at];
      at += 1 + this.#gap();
    }
    this.#next = at - size;
    return n;
  }

  #gap() {
    if (this.#p <= 0) return Infinity;
    if (this.#p >= 1) return 0;
    // 1 - random() is in (0, 1], so the log is finite.
    return Math.floor(Math.log(1 - this.#random()) / this.#logMiss);
  }
}

/** The seed of input group `index` in a simulation seeded with `seed`. */
export function inputSeed(seed: number, index: number) {
  let x = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** A small seeded generator of uniform numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-neuron gain from each neuron's predicted transmitter: `table` maps NT
 * names as they appear in the connectome ("ACH", "GABA", "" for blank, ...) to
 * mV per synapse; anything missing gets `fallback`.
 */
export function gainByTransmitter(connectome: Connectome, table: Readonly<Record<string, number>>, fallback = 0): Float32Array {
  const { codes, table: names } = connectome.columns.nt;
  const byCode = Float32Array.from(names, (name) => table[name] ?? fallback);
  return Float32Array.from(codes, (code) => byCode[code]);
}
