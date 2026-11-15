// The running brain: the connectome at the operating point (params.ts), driven
// by the senses and the internal state (io.ts, state.ts), read out as
// commands. No Node APIs; it runs in the pet's Web Worker.

import type { EyeColumn } from "./eye-columns.ts";
import { buildEyes } from "./eyes.ts";
import type { Eyes } from "./eyes.ts";
import { ConnectomeFormatError, loadConnectome } from "./format.ts";
import { backgroundRates, decode, senseRates, smooth, wire } from "./io.ts";
import type { Wiring } from "./io.ts";
import { OPERATING_POINT, buildWeights } from "./params.ts";
import type { OperatingPoint } from "./params.ts";
import { Simulation } from "./sim.ts";
import { InternalState, INTERNAL_STATE } from "./state.ts";
import type { InternalStateParameters } from "./state.ts";
import { RETINA, Retina, VISION_STAGES, stageName } from "./vision.ts";
import type { RetinaParameters } from "./vision.ts";
import type { Brain, BrainSenses, BrainState, EyeMap } from "./types.ts";

export type BrainOptions = {
  /** Seeds the Poisson inputs and the internal state. Default 1. */
  seed?: number;
  /** For experiments; the defaults are the documented operating point. */
  operatingPoint?: OperatingPoint;
  internalState?: InternalStateParameters;
  retina?: RetinaParameters;
  /** Turn the internal state's background drive off (it is on by default). */
  spontaneous?: boolean;
  /** The eyes' columns (eye-columns.ts by default), for tests on a synthetic connectome. */
  eyeColumns?: { readonly right: readonly EyeColumn[]; readonly left: readonly EyeColumn[] };
};

/** Smoothing time constant, ms, of the vision.<stage> rates. */
export const VISION_TAU = 100;

/** Longest stretch, ms, simulated with the same input rates and before the readouts are smoothed. */
export const CHUNK_MS = 10;
/** Longest tick accepted, ms. */
export const MAX_TICK_MS = 1000;

/** A brain built on an already loaded connectome, with access to its parts (for scripts and tests). */
export class FlyBrain implements Brain {
  readonly neurons: number;
  readonly connections: number;
  readonly eyes: EyeMap | null;
  /** Each eye's columns and cells, and its input stage; null without eyes. */
  readonly vision: (Eyes & { retina: { left: Retina; right: Retina } }) | null;
  readonly sim: Simulation;
  readonly wiring: Wiring;
  readonly state: InternalState;
  readonly spontaneous: boolean;
  /** Smoothed mean rate of each readout group, Hz. */
  readonly rates: Record<string, number> = {};
  #counts: Record<string, number> = {};
  #vision: { name: string; size: number }[] = [];

  constructor(connectome: ReturnType<typeof loadConnectome>, options: BrainOptions = {}) {
    const seed = options.seed ?? 1;
    const point = options.operatingPoint ?? OPERATING_POINT;
    this.neurons = connectome.neurons;
    this.connections = connectome.connections;
    this.wiring = wire(connectome);
    const weights = buildWeights(connectome, point);
    this.sim = new Simulation(weights.network, { ...point.neuron, gain: weights.gain, seed });
    for (const { spec, neurons } of this.wiring.senses) this.sim.addInput(spec.name, neurons);
    for (const { spec, neurons } of this.wiring.background) this.sim.addInput(spec.name, neurons);
    for (const { spec, neurons } of this.wiring.readouts) {
      this.sim.addReadout(spec.name, neurons);
      this.rates[spec.name] = 0;
    }
    // The eyes come after every other input, so their streams leave the
    // others' as they were: with the eyes shut, the brain is the same.
    const eyes = buildEyes(connectome, options.eyeColumns);
    this.eyes = eyes?.map ?? null;
    this.vision = null;
    if (eyes) {
      const parameters = options.retina ?? RETINA;
      const retina = { left: new Retina(eyes.left, parameters), right: new Retina(eyes.right, parameters) };
      this.vision = { ...eyes, retina };
      const read = new Set(this.wiring.readouts.flatMap((group) => [...group.neurons]));
      for (const side of ["left", "right"] as const) {
        for (const i of retina[side].neurons) if (read.has(i)) throw new Error(`Neuron ${i} is both driven by the ${side} eye and read`);
        this.sim.addRatedInput(`eye ${side}`, retina[side].neurons);
      }
      for (const side of ["left", "right"] as const) {
        for (const { stage, select } of VISION_STAGES) {
          const neurons = select === "lamina" ? retina[side].neurons : connectome.find({ ...select, side });
          if (neurons.length === 0) continue;
          this.sim.addReadout(stageName(stage, side), neurons);
          this.#vision.push({ name: stageName(stage, side), size: neurons.length });
          this.rates[stageName(stage, side)] = 0;
        }
      }
    }
    // A separate stream from the Poisson inputs', which inputSeed derives from the same seed.
    this.state = new InternalState((seed ^ 0x5bd1e995) >>> 0, options.internalState ?? INTERNAL_STATE);
    this.spontaneous = options.spontaneous ?? true;
  }

  tick(dtMs: number, senses: BrainSenses): BrainState {
    if (!(dtMs >= 0 && dtMs <= MAX_TICK_MS)) throw new Error(`tick takes 0 to ${MAX_TICK_MS} ms, not ${dtMs}`);
    const started = performance.now();
    const spikesBefore = this.sim.stats.spikes;
    const timeBefore = this.sim.time;
    // Checked before anything moves, so a bad picture leaves the brain as it was.
    if (senses.light && this.vision) {
      for (const side of ["left", "right"] as const) {
        const facets = this.vision.retina[side].facets;
        if (senses.light[side]?.length !== facets) throw new Error(`The ${side} eye has ${facets} facets, but the light gives ${senses.light[side]?.length}`);
      }
    }
    for (const [name, rate] of senseRates(this.wiring, senses)) this.sim.setRate(name, rate);
    let left = dtMs;
    while (left > 1e-9) {
      const chunk = Math.min(CHUNK_MS, left);
      left -= chunk;
      if (this.spontaneous) {
        this.state.step(chunk / 1000);
        const level = { left: this.state.level("left"), right: this.state.level("right") };
        for (const [name, rate] of backgroundRates(this.wiring, level)) this.sim.setRate(name, rate);
      }
      if (this.vision) {
        for (const side of ["left", "right"] as const) {
          const retina = this.vision.retina[side];
          if (retina.step(chunk, senses.light ? senses.light[side] : null)) this.sim.setRates(`eye ${side}`, retina.rates);
        }
      }
      const before = this.sim.time;
      this.sim.advance(chunk);
      const ran = this.sim.time - before;
      if (ran <= 0) continue;
      this.sim.drainReadouts(this.#counts);
      for (const { spec, neurons } of this.wiring.readouts) {
        const hz = (this.#counts[spec.name] / neurons.length / ran) * 1000;
        this.rates[spec.name] = smooth(this.rates[spec.name], hz, ran, spec.tau);
      }
      for (const { name, size } of this.#vision) {
        this.rates[name] = smooth(this.rates[name], (this.#counts[name] / size / ran) * 1000, ran, VISION_TAU);
      }
    }
    return {
      command: decode(this.rates),
      stats: {
        simMs: this.sim.time - timeBefore,
        wallMs: performance.now() - started,
        spikes: this.sim.stats.spikes - spikesBefore,
        active: this.sim.active,
        rates: { ...this.rates },
      },
    };
  }
}

/** Builds a running brain from a packed connectome. */
export function createBrain(data: ArrayBuffer, options: { seed?: number } = {}): Brain {
  if (!(data instanceof ArrayBuffer)) throw new ConnectomeFormatError("The brain needs the packed connectome as an ArrayBuffer");
  const seed = options.seed ?? 1;
  if (!Number.isInteger(seed)) throw new Error(`The seed must be a whole number, not ${seed}`);
  return new FlyBrain(loadConnectome(data), { seed });
}
