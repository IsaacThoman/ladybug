// The contract between the fly brain and whatever body it drives.
//
// Left and right are the fly's own left and right. The body decides how its
// world maps onto them.

/**
 * What the body feels, each tick. Intensities run from 0 (nothing) to 1 (as
 * strong as it gets); the brain turns them into firing rates of the sensory
 * neurons that carry that sense in the fly.
 */
export type BrainSenses = {
  /** Something growing fast in the left or right eye: an approaching threat. */
  loomLeft: number;
  loomRight: number;
  /** Something touching the body: stroked, poked or held. */
  touch: number;
  /** The left or right antenna pressed against something. */
  bumpLeft: number;
  bumpRight: number;
  /** Air rushing past: carried quickly, thrown or falling. */
  wind: number;
  /** Something sweet on the mouthparts. */
  sweet: number;
  /** Standing on its feet, rather than held or in the air. */
  grounded: boolean;
};

/**
 * What the brain wants the body to do, read from the descending and motor
 * neurons that command each action in the fly. All but `turn` run 0 to 1.
 */
export type BrainCommand = {
  /** Drive to walk forwards. */
  walk: number;
  /** Steering: -1 is hard toward the fly's left, 1 hard toward its right. */
  turn: number;
  /** Drive to walk backwards. */
  back: number;
  /** Escape take-off (the giant fiber). */
  escape: number;
  /** Flight: the wing power muscles. */
  wings: number;
  /** Grooming with the front legs. */
  groom: number;
  /** Feeding: extending the mouthparts. */
  feed: number;
};

export type BrainStats = {
  /** Simulated time covered by this tick, in ms. */
  simMs: number;
  /** Wall-clock time the tick took, in ms. */
  wallMs: number;
  /** Spikes fired during this tick. */
  spikes: number;
  /** Neurons with any activity at the end of the tick. */
  active: number;
  /** Smoothed firing rate (Hz) of each group of neurons the brain reads from. */
  rates: Record<string, number>;
};

export type BrainState = { command: BrainCommand; stats: BrainStats };

export interface Brain {
  /** Neurons and connected pairs in the loaded connectome. */
  readonly neurons: number;
  readonly connections: number;
  /** Advances the simulation by `dtMs` of fly time under these senses. */
  tick(dtMs: number, senses: BrainSenses): BrainState;
}

/** Messages to the worker that runs the brain. */
export type BrainRequest =
  /** The packed connectome (see format.ts). Transferred, not copied. */
  | { type: "init"; data: ArrayBuffer }
  | { type: "tick"; dtMs: number; senses: BrainSenses };

/** Messages from the worker. Every "tick" gets exactly one "state". */
export type BrainResponse =
  | { type: "ready"; neurons: number; connections: number }
  | { type: "state"; state: BrainState }
  | { type: "error"; message: string };

export const RESTING_SENSES: BrainSenses = {
  loomLeft: 0,
  loomRight: 0,
  touch: 0,
  bumpLeft: 0,
  bumpRight: 0,
  wind: 0,
  sweet: 0,
  grounded: true,
};
