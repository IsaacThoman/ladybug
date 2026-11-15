// The running brain: the connectome at the operating point (params.ts), driven
// by the senses and the internal state (io.ts, state.ts), read out as
// commands. No Node APIs; it runs in the pet's Web Worker.

import { ConnectomeFormatError, loadConnectome } from "./format.ts";
import { backgroundRates, decode, senseRates, smooth, wire } from "./io.ts";
import type { Wiring } from "./io.ts";
import { OPERATING_POINT, buildWeights } from "./params.ts";
import type { OperatingPoint } from "./params.ts";
import { Simulation } from "./sim.ts";
import { InternalState, INTERNAL_STATE } from "./state.ts";
import type { InternalStateParameters } from "./state.ts";
import type { Brain, BrainSenses, BrainState, EyeMap } from "./types.ts";

export type BrainOptions = {
  /** Seeds the Poisson inputs and the internal state. Default 1. */
  seed?: number;
  /** For experiments; the defaults are the documented operating point. */
  operatingPoint?: OperatingPoint;
  internalState?: InternalStateParameters;
  /** Turn the internal state's background drive off (it is on by default). */
  spontaneous?: boolean;
};

/** Longest stretch, ms, simulated with the same input rates and before the readouts are smoothed. */
export const CHUNK_MS = 10;
/** Longest tick accepted, ms. */
export const MAX_TICK_MS = 1000;

/** A brain built on an already loaded connectome, with access to its parts (for scripts and tests). */
export class FlyBrain implements Brain {
  readonly neurons: number;
  readonly connections: number;
  /** Not wired up yet: `light` is ignored. */
  readonly eyes: EyeMap | null = null;
  readonly sim: Simulation;
  readonly wiring: Wiring;
  readonly state: InternalState;
  readonly spontaneous: boolean;
  /** Smoothed mean rate of each readout group, Hz. */
  readonly rates: Record<string, number> = {};
  #counts: Record<string, number> = {};

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
    // A separate stream from the Poisson inputs', which inputSeed derives from the same seed.
    this.state = new InternalState((seed ^ 0x5bd1e995) >>> 0, options.internalState ?? INTERNAL_STATE);
    this.spontaneous = options.spontaneous ?? true;
  }

  tick(dtMs: number, senses: BrainSenses): BrainState {
    if (!(dtMs >= 0 && dtMs <= MAX_TICK_MS)) throw new Error(`tick takes 0 to ${MAX_TICK_MS} ms, not ${dtMs}`);
    const started = performance.now();
    const spikesBefore = this.sim.stats.spikes;
    const timeBefore = this.sim.time;
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
      const before = this.sim.time;
      this.sim.advance(chunk);
      const ran = this.sim.time - before;
      if (ran <= 0) continue;
      this.sim.drainReadouts(this.#counts);
      for (const { spec, neurons } of this.wiring.readouts) {
        const hz = (this.#counts[spec.name] / neurons.length / ran) * 1000;
        this.rates[spec.name] = smooth(this.rates[spec.name], hz, ran, spec.tau);
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
