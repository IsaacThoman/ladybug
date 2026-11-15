// The input stage of the eyes: what each facet's photoreceptors and lamina
// make of the light, as firing rates of that column's L1, L2 and L3. No Node
// APIs.
//
// The photoreceptors (R1-R6) are too incompletely reconstructed in this
// dataset to carry the input (README, The eyes), so the stage stands in for
// them and for their synapses onto the lamina monopolar cells, and drives L1,
// L2 and L3 directly. What it reproduces:
//
// - Adaptation to the ambient level. Photoreceptors and lamina respond to
//   contrast, not to absolute luminance: a change is measured against the
//   recent mean, as a fraction of it (Weber's law), with a floor for black.
// - Sign. The photoreceptors' histamine hyperpolarises the lamina monopolar
//   cells to light, so they depolarise to darkening: darkening raises the
//   rate, brightening lowers it (below the tonic rate, if there is one).
// - Time course. L1 and L2 respond transiently to a change, L3 in a
//   sustained way (Silies et al. 2013; Ketkar et al. 2020): L1 and L2 compare
//   the light with its mean over the last `transient` ms, L3 with its mean
//   over `ambient` ms, which is also what all three are normalised by.
//
// What it leaves out: the cells are graded, not spiking, and the stage turns
// their depolarisation into a Poisson rate; L1's sustained component and
// L2's slight rectification are ignored; one facet feeds one column (neural
// superposition pools six photoreceptors from six neighbouring ommatidia that
// look the same way, which is the same thing here); no colour, no
// polarisation (the dorsal rim's R7 and R8 aren't modelled).

import type { EyeCells, Side } from "./eyes.ts";
import type { NeuronQuery } from "./format.ts";

export type RetinaParameters = {
  /** Time constant, ms, of the ambient level each facet adapts to, and of L3's response. */
  ambient: number;
  /** Time constant, ms, of the recent level L1 and L2 compare the light with. */
  transient: number;
  /** Luminance (0 black, 1 white) added to the ambient level in the Weber fraction, so a dark scene doesn't divide by 0. */
  floor: number;
  /** Rate, Hz, of a lamina cell at a contrast of 1 (full darkening), and its ceiling. */
  maxRate: number;
  /** Rate, Hz, of a lamina cell in a steady scene. */
  tonic: number;
};

export const RETINA: RetinaParameters = {
  ambient: 2000,
  transient: 200,
  floor: 0.05,
  maxRate: 200,
  tonic: 0,
};

/** One eye's photoreceptors and lamina: luminance per facet in, a rate per driven lamina cell out. */
export class Retina {
  readonly parameters: RetinaParameters;
  /** The driven cells, in the order of `rates`: every facet's L1 that exists, then its L2s, then its L3s. */
  readonly neurons: Int32Array;
  /** Hz per neuron of `neurons`, as of the last step. */
  readonly rates: Float64Array;
  readonly facets: number;
  // For each driven cell, its facet and whether it is transient (L1, L2) or sustained (L3).
  #facet: Int32Array;
  #transient: Uint8Array;
  #ambient: Float64Array;
  #recent: Float64Array;
  // Each facet's luminance at the last step, clamped to 0..1.
  #seen: Float64Array;
  #open = false;
  // Whether any rate was above 0 after the last step.
  #firing = false;
  // ms of unchanging light, with every rate 0, not yet applied to the levels.
  #idle = 0;

  constructor(cells: EyeCells, parameters: RetinaParameters = RETINA) {
    this.parameters = parameters;
    this.facets = cells.l1.length;
    const neurons: number[] = [];
    const facet: number[] = [];
    const transient: number[] = [];
    for (const [list, isTransient] of [
      [cells.l1, 1],
      [cells.l2, 1],
      [cells.l3, 0],
    ] as const) {
      list.forEach((i, k) => {
        if (i < 0) return;
        neurons.push(i);
        facet.push(k);
        transient.push(isTransient);
      });
    }
    this.neurons = Int32Array.from(neurons);
    this.#facet = Int32Array.from(facet);
    this.#transient = Uint8Array.from(transient);
    this.rates = new Float64Array(neurons.length);
    this.#ambient = new Float64Array(this.facets);
    this.#recent = new Float64Array(this.facets);
    this.#seen = new Float64Array(this.facets);
  }

  /**
   * Advances by dt ms under this light (null: the eye is shut) and updates
   * `rates`. Opening the eye starts it adapted to what it sees then. Returns
   * false when every rate was 0 before and still is, so there is nothing to
   * pass on. While the light doesn't change and nothing fires (a steady
   * scene, once adapted to, with no tonic rate), a step only compares the
   * light with the last and remembers the time; the levels catch up, exactly,
   * when it changes.
   */
  step(dt: number, light: ArrayLike<number> | null): boolean {
    const { ambient: tauAmbient, transient: tauTransient, floor, maxRate, tonic } = this.parameters;
    const was = this.#firing;
    if (light === null) {
      this.#open = false;
      this.#firing = false;
      if (was) this.rates.fill(0);
      return was;
    }
    if (light.length !== this.facets) throw new Error(`An eye has ${this.facets} facets, but the light gives ${light.length}`);
    const ambient = this.#ambient;
    const recent = this.#recent;
    const seen = this.#seen;
    const lum = (k: number) => {
      const x = light[k];
      return x > 0 ? Math.min(1, x) : 0;
    };
    if (!this.#open) {
      this.#open = true;
      this.#idle = 0;
      for (let k = 0; k < this.facets; k++) ambient[k] = recent[k] = seen[k] = lum(k);
    } else {
      let same = true;
      for (let k = 0; k < this.facets && same; k++) same = lum(k) === seen[k];
      // With the light constant, each level only moves toward it, so a
      // contrast of 0 or less stays so and every rate stays 0.
      if (same && !was && tonic === 0) {
        this.#idle += dt;
        return false;
      }
      const idleAmbient = Math.exp(-this.#idle / tauAmbient);
      const idleRecent = Math.exp(-this.#idle / tauTransient);
      const keepAmbient = Math.exp(-dt / tauAmbient);
      const keepRecent = Math.exp(-dt / tauTransient);
      for (let k = 0; k < this.facets; k++) {
        const before = seen[k];
        const x = lum(k);
        ambient[k] = x + (before + (ambient[k] - before) * idleAmbient - x) * keepAmbient;
        recent[k] = x + (before + (recent[k] - before) * idleRecent - x) * keepRecent;
        seen[k] = x;
      }
      this.#idle = 0;
    }
    const rates = this.rates;
    const facetOf = this.#facet;
    const isTransient = this.#transient;
    let firing = false;
    for (let n = 0; n < rates.length; n++) {
      const k = facetOf[n];
      const contrast = ((isTransient[n] ? recent[k] : ambient[k]) - seen[k]) / (ambient[k] + floor);
      const rate = Math.min(maxRate, Math.max(0, tonic + maxRate * contrast));
      rates[n] = rate;
      if (rate > 0) firing = true;
    }
    this.#firing = firing;
    return firing || was;
  }
}

/**
 * The groups `stats.rates` reports for each eye as `vision.<stage> <side>`,
 * in order from the eye inward: display only, no command reads them. The
 * lamina is the driven cells themselves (the input stage's output); the
 * looming detectors are also what `loomLeft` and `loomRight` drive, and every
 * visual projection neuron but those is also driven by the background (see
 * io.ts), so their rates mix vision with that.
 */
export const VISION_STAGES: readonly { stage: string; description: string; select: NeuronQuery | "lamina" }[] = [
  { stage: "lamina", description: "L1, L2 and L3, driven by the input stage", select: "lamina" },
  {
    stage: "medulla",
    description: "The columnar relays of the ON (Mi1, Tm3, Mi4, Mi9) and OFF (Tm1, Tm2, Tm4, Tm9) pathways",
    select: { type: ["Mi1", "Tm3", "Mi4", "Mi9", "Tm1", "Tm2", "Tm4", "Tm9"] },
  },
  { stage: "T4/T5", description: "The direction-selective T4 (ON) and T5 (OFF) cells, all four subtypes", select: { type: /^T[45][a-d]$/ } },
  {
    stage: "lobula",
    description: "Lobula and lobula plate columnar projection neurons (LC, LPLC, LLPC, LPC types) but the looming detectors",
    select: { superClass: "visual_projection", type: (t: string) => /^(LC|LPLC|LLPC|LPC)\d/.test(t) && t !== "LPLC2" && t !== "LC4" },
  },
  { stage: "looming", description: "The looming detectors LPLC2 and LC4", select: { type: ["LPLC2", "LC4"] } },
  {
    stage: "tangential",
    description: "Lobula plate tangential cells HS and VS (wide-field horizontal and vertical motion)",
    select: { type: ["HSE", "HSN", "HSS", "VS"] },
  },
];

/** A stage's name in stats.rates. */
export const stageName = (stage: string, side: Side) => `vision.${stage} ${side}`;
