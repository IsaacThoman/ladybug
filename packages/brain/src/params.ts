// The operating point: how the connectome's synapse counts and predicted
// transmitters become signed connection strengths, and the neuron model's
// constants. Every departure from "synapse count × transmitter sign" is here;
// the README explains each.

import type { Connectome } from "./format.ts";

export type TransmitterFix = {
  /** What the fix is and why. */
  reason: string;
  /** Which neurons it applies to (judged on the predicted transmitter, before any fix). */
  applies(connectome: Connectome, i: number): boolean;
  /** The transmitter they get instead. */
  nt: string;
};

export type OperatingPoint = {
  /** mV per synapse of an excitatory (cholinergic) neuron. */
  excitatory: number;
  /** mV per synapse of an inhibitory (GABA, glutamate, histamine) neuron; positive, applied with a minus sign. */
  inhibitory: number;
  /** mV per synapse of the slow modulators (dopamine, serotonin, octopamine); signed. */
  modulatory: number;
  /** mV per synapse of neurons with no predicted transmitter after the fixes; signed. */
  unknown: number;
  /**
   * Factor on the strength of every synapse made by a columnar neuron of the
   * optic lobe (see `columnar`): graded, non-spiking relays whose synapses
   * release continuously, which one spike per synapse understates.
   */
  graded: number;
  /**
   * Synaptic saturation: a connection of n synapses acts as
   * saturation × (1 - exp(-n / saturation)) synapses (rounded), so one
   * presynaptic spike can't push its target arbitrarily far. About n for small
   * n, never more than `saturation`. 0 turns it off.
   */
  saturation: number;
  /** Corrections to the predicted transmitter, applied in order. */
  fixes: readonly TransmitterFix[];
  /** Neuron model constants, passed to Simulation. */
  neuron: {
    dt: number;
    tauMem: number;
    tauSyn: number;
    threshold: number;
    refractory: number;
    delay: number;
    epsilon: number;
    resetDrive: boolean;
    adaptation: { increment: number; tau: number };
  };
};

const superClass = (c: Connectome, i: number) => c.columns.superClass.value(i);
const side = (c: Connectome, i: number) => c.columns.side.value(i);
const type = (c: Connectome, i: number) => c.columns.type.value(i);
const predicted = (c: Connectome, i: number) => c.columns.nt.value(i);

/** Transmitter corrections backed by known biology. */
export const TRANSMITTER_FIXES: readonly TransmitterFix[] = [
  {
    reason:
      "Kenyon cells are cholinergic (Barnstedt et al. 2016). This dataset predicts them as dopaminergic, and dopamine is muted here, which would cut the mushroom body's output.",
    applies: (c, i) => /^KC/.test(type(c, i)),
    nt: "ACH",
  },
  {
    reason: "Photoreceptors are histaminergic; the prediction is blank for most of them.",
    applies: (c, i) => superClass(c, i) === "ol_sensory" && predicted(c, i) === "",
    nt: "HIST",
  },
  {
    reason:
      "Mechanosensory, gustatory, olfactory and other primary sensory neurons outside the eye are cholinergic; the prediction is blank for about 2,100 of them, most head bristle neurons among them.",
    applies: (c, i) => /sensory/.test(superClass(c, i)) && superClass(c, i) !== "ol_sensory" && predicted(c, i) === "",
    nt: "ACH",
  },
  {
    reason:
      "Antennal lobe local neurons are overwhelmingly GABAergic (Chou et al. 2010). The prediction makes 75 lateral LNs (lLN1, lLN2T, lLN2X and others) cholinergic; wired densely to each other, they then lock the antennal lobe into saturated firing after any olfactory input. The least certain fix.",
    applies: (c, i) => /^lLN/.test(type(c, i)) && predicted(c, i) === "ACH",
    nt: "GABA",
  },
];

export const OPERATING_POINT: OperatingPoint = {
  // Shiu et al. 2024's w_syn, for both signs.
  excitatory: 0.275,
  inhibitory: 0.275,
  // Muted: their effects are slow and modulatory, not fast synaptic.
  modulatory: 0,
  unknown: 0,
  // A spike of the main columnar relay, L2 to Tm1 and Tm2 (124 and 130
  // synapses, 61 and 62 after saturation), brings its target from rest to
  // threshold: 7 mV / (0.177 × 0.275 mV × 61.5), where 0.177 is the peak of
  // the membrane's response to a unit step of drive at these time constants.
  graded: 2.3,
  saturation: 75,
  fixes: TRANSMITTER_FIXES,
  neuron: {
    // Shiu et al. 2024: rest -52 mV, threshold -45 mV, tauMem 20 ms, tauSyn 5 ms,
    // refractory 2.2 ms, delay 1.8 ms, and a spike resets g as well as v. They
    // stepped at 0.1 ms; at 1 ms the refractory period and delay round to 2 ms.
    dt: 1,
    tauMem: 20,
    tauSyn: 5,
    threshold: 7,
    refractory: 2.2,
    delay: 1.8,
    resetDrive: true,
    // Not in Shiu et al.: weak, slow adaptation, which stops self-sustaining loops.
    adaptation: { increment: 0.1, tau: 1000 },
    epsilon: 0.01,
  },
};

/**
 * The optic lobe's columnar classes (Fischbach and Dittrich 1989): lamina
 * monopolar (L), centrifugal (C), T, transmedullary (Tm, TmY), Y and medulla
 * intrinsic (Mi) neurons.
 */
const COLUMNAR_CLASSES = /^(L[1-5]|C[23]|T[1-5][a-d]?|Tm\d+[a-zA-Z]*|TmY\d+[a-z]*|Y\d+|Mi\d+)$/;
/** Fewer cells of a type on a side than this, and each cell pools many columns: not a column's relay. */
export const COLUMNAR_MIN_CELLS = 100;

/**
 * Optic lobe intrinsic neurons of a columnar type: one of the columnar classes
 * with at least COLUMNAR_MIN_CELLS cells on its side, one for every few of
 * the eye's ~890 columns. They are the column-by-column relays from the
 * lamina to the lobula and lobula plate. Left out: the amacrine and other
 * multicolumnar cells (Dm, Pm, Cm, Lawf and others), which pool many columns
 * into one point neuron and so are driven hard enough already, and for the
 * same reason the columnar classes' rarer types, such as Mi18 (36 a side).
 */
export function columnar(connectome: Connectome): Uint8Array {
  const counts = new Map<string, number>();
  const candidates = connectome.filter((i) => superClass(connectome, i) === "ol_intrinsic" && COLUMNAR_CLASSES.test(type(connectome, i)));
  for (const i of candidates) {
    const key = `${type(connectome, i)} ${side(connectome, i)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Uint8Array(connectome.neurons);
  for (const i of candidates) if (counts.get(`${type(connectome, i)} ${side(connectome, i)}`)! >= COLUMNAR_MIN_CELLS) out[i] = 1;
  return out;
}

/** Each neuron's transmitter after the fixes, and how many neurons each fix changed. */
export function transmitters(connectome: Connectome, fixes: readonly TransmitterFix[]): { nt: string[]; changed: number[] } {
  const out = Array.from({ length: connectome.neurons }, (_, i) => predicted(connectome, i));
  const changed = fixes.map(() => 0);
  for (let i = 0; i < connectome.neurons; i++) {
    fixes.forEach((fix, k) => {
      if (out[i] !== fix.nt && fix.applies(connectome, i)) {
        out[i] = fix.nt;
        changed[k]++;
      }
    });
  }
  return { nt: out, changed };
}

/** mV per synapse for a transmitter at this operating point. */
export function transmitterGain(point: OperatingPoint, transmitter: string): number {
  switch (transmitter) {
    case "ACH":
      return point.excitatory;
    case "GABA":
    case "GLUT":
    case "HIST":
      return -point.inhibitory;
    case "DA":
    case "SER":
    case "OCT":
      return point.modulatory;
    default:
      return point.unknown;
  }
}

/** Synapse counts after saturation (the input itself when saturation is off). */
export function saturatedCounts(count: Uint16Array, saturation: number): Uint16Array {
  if (!(saturation > 0)) return count;
  const lookup = new Uint16Array(65536);
  for (let n = 0; n < 65536; n++) lookup[n] = Math.round(saturation * -Math.expm1(-n / saturation));
  const out = new Uint16Array(count.length);
  for (let e = 0; e < count.length; e++) out[e] = lookup[count[e]];
  return out;
}

export type Weights = {
  /** Simulation's `gain`: mV per synapse of each presynaptic neuron. */
  gain: Float32Array;
  /** The wiring with saturated synapse counts, for Simulation. */
  network: { ptr: Uint32Array; post: Uint32Array; count: Uint16Array };
  /** Each neuron's transmitter after the fixes, and how many neurons each fix changed. */
  nt: string[];
  changed: number[];
};

/** The Simulation's wiring and gains at this operating point. */
export function buildWeights(connectome: Connectome, point: OperatingPoint = OPERATING_POINT): Weights {
  const { nt, changed } = transmitters(connectome, point.fixes);
  const gain = Float32Array.from(nt, (each) => transmitterGain(point, each));
  if (point.graded !== 1) {
    const graded = columnar(connectome);
    for (let i = 0; i < connectome.neurons; i++) if (graded[i]) gain[i] *= point.graded;
  }
  const network = { ptr: connectome.ptr, post: connectome.post, count: saturatedCounts(connectome.count, point.saturation) };
  return { gain, network, nt, changed };
}
