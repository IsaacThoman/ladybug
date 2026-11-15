// Internal state the connectome doesn't contain: how aroused the fly is, and
// how much there is to see on each side. Neither is a neuron in the data; both
// are stand-ins, and both act only by setting the background firing rate of
// the visual projection neurons of each eye (io.ts, BACKGROUND). Nothing here
// touches a neuron that is read out.
//
// Each is an Ornstein-Uhlenbeck process: it wanders around 0 with standard
// deviation 1 and forgets its past over `tau` seconds. An eye's background
// level is
//
//   logistic(arousal.weight × arousal + scene.weight × scene[eye] + bias)
//
// from 0 to 1, multiplying that eye's maximum background rate.

import { mulberry32 } from "./sim.ts";

export const INTERNAL_STATE = {
  arousal: { tau: 10, weight: 1.6 },
  scene: { tau: 4, weight: 1.5 },
  bias: -1,
} as const;

export type InternalStateParameters = {
  arousal: { tau: number; weight: number };
  scene: { tau: number; weight: number };
  bias: number;
};

/** A zero-mean, unit-variance Ornstein-Uhlenbeck process with time constant tau (s). */
export class Wander {
  value = 0;
  readonly tau: number;
  #normal: () => number;

  constructor(tau: number, normal: () => number) {
    this.tau = tau;
    this.#normal = normal;
  }

  /** Advances by dt seconds, exactly (the update is the process's own transition). */
  step(dt: number) {
    const keep = Math.exp(-dt / this.tau);
    this.value = this.value * keep + Math.sqrt(1 - keep * keep) * this.#normal();
    return this.value;
  }
}

/** Standard normal numbers from a seeded uniform generator (Box-Muller). */
export function normals(seed: number): () => number {
  const uniform = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const out = spare;
      spare = null;
      return out;
    }
    const u = 1 - uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export class InternalState {
  readonly parameters: InternalStateParameters;
  readonly arousal: Wander;
  readonly scene: { left: Wander; right: Wander };

  constructor(seed: number, parameters: InternalStateParameters = INTERNAL_STATE) {
    this.parameters = parameters;
    const normal = normals(seed);
    this.arousal = new Wander(parameters.arousal.tau, normal);
    this.scene = { left: new Wander(parameters.scene.tau, normal), right: new Wander(parameters.scene.tau, normal) };
  }

  /** Advances by dt seconds. */
  step(dt: number) {
    this.arousal.step(dt);
    this.scene.left.step(dt);
    this.scene.right.step(dt);
  }

  /** The background level of one eye, 0 to 1. */
  level(eye: "left" | "right") {
    const { arousal, scene, bias } = this.parameters;
    return logistic(arousal.weight * this.arousal.value + scene.weight * this.scene[eye].value + bias);
  }
}
