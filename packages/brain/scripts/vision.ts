// What the eyes see and how far it gets: runs the stimulus battery
// (src/stimuli.ts) through the brain and shows, stage by stage, how much
// each kind of neuron responds, and what the commands do.
//
//   node packages/brain/scripts/vision.ts [--only <regex>] [--seed 1] [--set key=value] [--retina key=value] [--path connectome.bin]
//
// Each stimulus is run twice with the same seed, from the same start (1 s of
// its steady ground scene with the eyes open): once as itself, once with the
// ground held instead (the control). The tables give, for the eye it is aimed
// at (both eyes' neurons when it is aimed at both), each type's mean rate
// over the stimulus in Hz minus the control's, so the background's own
// activity cancels out; "." is a change under 0.05 Hz. Then the commands: the
// escape peak, walking and steering (DNa02 right minus left) over the
// stimulus, each as stimulus / control.
//
// --set changes the operating point as probe.ts's does (e.g. --set graded=2);
// --retina changes the input stage (e.g. --retina tonic=20).

import { parseArgs } from "node:util";
import type { Connectome } from "../src/format.ts";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "../src/node.ts";
import { OPERATING_POINT } from "../src/params.ts";
import type { OperatingPoint } from "../src/params.ts";
import { FlyBrain } from "../src/runtime.ts";
import { BATTERY, facetAngles, render } from "../src/stimuli.ts";
import type { Stimulus } from "../src/stimuli.ts";
import { RESTING_SENSES } from "../src/types.ts";
import { RETINA } from "../src/vision.ts";
import type { RetinaParameters } from "../src/vision.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    seed: { type: "string", default: "1" },
    set: { type: "string", multiple: true, default: [] },
    retina: { type: "string", multiple: true, default: [] },
    path: { type: "string", default: DEFAULT_CONNECTOME_PATH },
  },
});

/** A copy of `base` with dotted keys set to numbers (booleans as 0 or 1). */
export function override<T extends object>(base: T, sets: readonly string[]): T {
  const next = structuredClone({ ...base, fixes: undefined }) as T;
  if ("fixes" in base) (next as Record<string, unknown>).fixes = (base as Record<string, unknown>).fixes;
  for (const set of sets) {
    const [key, raw] = set.split("=");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${set}: not a number`);
    const path = key.split(".");
    let at = next as Record<string, unknown>;
    for (const part of path.slice(0, -1)) at = at[part] as Record<string, unknown>;
    const last = path[path.length - 1];
    if (typeof at?.[last] === "boolean") at[last] = value !== 0;
    else if (typeof at?.[last] === "number") at[last] = value;
    else throw new Error(`${set}: no setting called ${key}`);
  }
  return next;
}

/** The columns of the tables: a label and the cell types it pools. */
export const STAGES: readonly (readonly [string, readonly (string | RegExp)[]])[] = [
  ["L1", ["L1"]],
  ["L2", ["L2"]],
  ["L3", ["L3"]],
  ["Mi1", ["Mi1"]],
  ["Tm3", ["Tm3"]],
  ["Mi4", ["Mi4"]],
  ["Mi9", ["Mi9"]],
  ["Tm1", ["Tm1"]],
  ["Tm2", ["Tm2"]],
  ["Tm4", ["Tm4"]],
  ["Tm9", ["Tm9"]],
  ["T4", [/^T4[a-d]$/]],
  ["T5a", ["T5a"]],
  ["T5b", ["T5b"]],
  ["T5c", ["T5c"]],
  ["T5d", ["T5d"]],
  ["T2", ["T2", "T2a"]],
  ["T3", ["T3"]],
  ["LC4", ["LC4"]],
  ["LPLC2", ["LPLC2"]],
  ["LPLC1", ["LPLC1"]],
  ["LC11", ["LC11"]],
  ["LC12", ["LC12"]],
  ["LC15", ["LC15"]],
  ["LC17", ["LC17"]],
  ["LC10", [/^LC10[a-e]$/]],
  ["LC9", ["LC9"]],
  ["HS", ["HSE", "HSN", "HSS"]],
  ["VS", ["VS"]],
  ["H2", ["H2"]],
  ["DNp01", ["DNp01"]],
  ["DNp02", ["DNp02"]],
  ["DNp04", ["DNp04"]],
  ["DNp11", ["DNp11"]],
  ["DNa02", ["DNa02"]],
  ["DNg100", ["DNg100"]],
];

export type Measurement = {
  /** Mean rate, Hz, of each STAGES column over the measured window, stimulus and control. */
  stimulus: number[];
  control: number[];
  /** Commands over the window: peak escape, mean walk and mean turn, stimulus and control. */
  commands: { escape: [number, number]; walk: [number, number]; turn: [number, number] };
  /** Total spikes per second over the window. */
  spikes: [number, number];
};

const TICK = 10;

/** Runs one stimulus and its control on fresh brains. */
export function measure(connectome: Connectome, stimulus: Stimulus, options: { seed: number; operatingPoint?: OperatingPoint; retina?: RetinaParameters }): Measurement {
  const sides = stimulus.eye === "both" ? ["left", "right"] : [stimulus.eye];
  const groups = STAGES.map(([, types]) => connectome.find({ type: (t: string) => types.some((m) => (typeof m === "string" ? m === t : m.test(t))), side: sides }));
  const run = (live: boolean) => {
    const brain = new FlyBrain(connectome, { seed: options.seed, operatingPoint: options.operatingPoint, retina: options.retina });
    const angles = facetAngles(brain.eyes!);
    const light = { left: new Float32Array(angles.left.az.length), right: new Float32Array(angles.right.az.length) };
    const ground = () => stimulus.ground;
    for (let t = 0; t < 1000; t += TICK) {
      render(ground, 0, angles, light);
      brain.tick(TICK, { ...RESTING_SENSES, light });
    }
    const from = (stimulus.settle ?? 0) * 1000;
    let recording: Uint32Array | null = null;
    let escape = 0;
    let walk = 0;
    let turn = 0;
    let spikes = 0;
    let n = 0;
    for (let t = 0; t < stimulus.seconds * 1000; t += TICK) {
      if (t >= from && !recording) {
        brain.sim.setRecording(true);
        recording = brain.sim.recording;
      }
      render(live ? stimulus.scene : ground, t / 1000, angles, light);
      const { command, stats } = brain.tick(TICK, { ...RESTING_SENSES, light });
      if (!recording) continue;
      escape = Math.max(escape, command.escape);
      walk += command.walk;
      turn += command.turn;
      spikes += stats.spikes;
      n++;
    }
    const seconds = (n * TICK) / 1000;
    const rates = groups.map((members) => {
      let total = 0;
      for (const i of members) total += recording![i];
      return members.length ? total / members.length / seconds : 0;
    });
    return { rates, escape, walk: walk / n, turn: turn / n, spikes: spikes / seconds };
  };
  const a = run(true);
  const b = run(false);
  return {
    stimulus: a.rates,
    control: b.rates,
    commands: { escape: [a.escape, b.escape], walk: [a.walk, b.walk], turn: [a.turn, b.turn] },
    spikes: [a.spikes, b.spikes],
  };
}

function main() {
  const connectome = readConnectomeFile(values.path);
  const operatingPoint = override(OPERATING_POINT, values.set);
  const retina = override(RETINA, values.retina);
  const only = values.only ? new RegExp(values.only) : null;
  const battery = BATTERY.filter((s) => !only || only.test(s.name));
  console.log(`Vision battery, seed ${values.seed}${values.set.length ? `, ${values.set.join(" ")}` : ""}${values.retina.length ? `, retina ${values.retina.join(" ")}` : ""}`);
  const rows: [Stimulus, Measurement][] = [];
  for (const stimulus of battery) rows.push([stimulus, measure(connectome, stimulus, { seed: Number(values.seed), operatingPoint, retina })]);
  const cell = (x: number) => (Math.abs(x) < 0.05 ? "." : Math.abs(x) >= 99.5 ? x.toFixed(0) : x.toFixed(1)).padStart(6);
  const width = Math.max(...battery.map((s) => s.name.length)) + 2;
  const halves = [STAGES.slice(0, 18), STAGES.slice(18)];
  halves.forEach((half, h) => {
    const offset = h === 0 ? 0 : halves[0].length;
    console.log(`\n${"".padEnd(width)}${half.map(([label]) => label.padStart(6)).join("")}`);
    console.log(`${"control".padEnd(width)}${half.map((_, k) => cell(rows[0][1].control[offset + k])).join("")}`);
    for (const [stimulus, m] of rows) console.log(`${stimulus.name.padEnd(width)}${half.map((_, k) => cell(m.stimulus[offset + k] - m.control[offset + k])).join("")}`);
  });
  console.log(`\n${"".padEnd(width)}${"escape peak".padStart(14)}${"walk".padStart(14)}${"turn".padStart(14)}${"spikes/s".padStart(20)}`);
  for (const [stimulus, m] of rows) {
    const pair = ([a, b]: [number, number]) => `${a.toFixed(2)} / ${b.toFixed(2)}`.padStart(14);
    console.log(`${stimulus.name.padEnd(width)}${pair(m.commands.escape)}${pair(m.commands.walk)}${pair(m.commands.turn)}${`${Math.round(m.spikes[0] / 1000)}k / ${Math.round(m.spikes[1] / 1000)}k`.padStart(20)}`);
  }
}

if (import.meta.main) main();
