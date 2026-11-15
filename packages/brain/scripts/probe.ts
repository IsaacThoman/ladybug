// Drives a group of neurons and shows what responds.
//
//   node packages/brain/scripts/probe.ts --type LPLC2,LC4 --side left [options]
//
// Selecting the driven neurons (all given conditions must match; each takes a
// comma-separated list of exact values, or /a regex/):
//   --type, --superClass, --class, --subClass, --side, --nt
// Options:
//   --rate 100        Poisson rate of each driven neuron, Hz
//   --ms 500          how long to drive them
//   --after 0         ms to keep running with the drive off, to see activity die away
//   --top 25          how many types to list
//   --only <regex>    only list responders whose super class matches
//   --set key=value   override an operating point number (excitatory, inhibitory,
//                     modulatory, unknown, saturation, neuron.dt, neuron.resetDrive
//                     as 0 or 1, neuron.adaptation.increment, ...); repeatable
//   --seed 1
//   --path <connectome.bin>
//
// Prints, for the driving period (and for the after period if asked), spike
// and activity totals, then the responding neurons (driven ones excluded)
// grouped by super class and by type, by mean rate per neuron. The after
// period lists every neuron, driven ones too, to show what keeps going.
//
// With --each <column> --target <type>, it instead drives each value of that
// column within the selection on its own (from rest, groups of at least two
// neurons) and ranks them by the target type's mean rate, e.g.
//
//   node packages/brain/scripts/probe.ts --class gustatory --each type --target MN9
//
// Adding --greedy builds a set instead: starting from nothing, it adds the
// value that raises the target's rate most when driven together with those
// already chosen, and stops when no value adds at least 1 Hz. That is how
// io.ts's SWEET_TYPES were chosen.

import { parseArgs } from "node:util";
import type { Connectome, NeuronQuery } from "../src/format.ts";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "../src/node.ts";
import { OPERATING_POINT, buildWeights } from "../src/params.ts";
import type { OperatingPoint } from "../src/params.ts";
import { Simulation } from "../src/sim.ts";

const { values } = parseArgs({
  options: {
    type: { type: "string" },
    superClass: { type: "string" },
    class: { type: "string" },
    subClass: { type: "string" },
    side: { type: "string" },
    nt: { type: "string" },
    rate: { type: "string", default: "100" },
    ms: { type: "string", default: "500" },
    after: { type: "string", default: "0" },
    top: { type: "string", default: "25" },
    only: { type: "string" },
    each: { type: "string" },
    target: { type: "string" },
    greedy: { type: "boolean", default: false },
    set: { type: "string", multiple: true, default: [] },
    seed: { type: "string", default: "1" },
    path: { type: "string", default: DEFAULT_CONNECTOME_PATH },
  },
});

/** "a,b" matches either exactly; "/re/" is a regex. */
function condition(text: string): string[] | RegExp {
  const regex = /^\/(.*)\/$/.exec(text);
  return regex ? new RegExp(regex[1]) : text.split(",");
}

export function withOverrides(point: OperatingPoint, sets: readonly string[]): OperatingPoint {
  const next = structuredClone({ ...point, fixes: [] }) as OperatingPoint;
  next.fixes = point.fixes;
  for (const set of sets) {
    const [key, raw] = set.split("=");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--set ${set}: not a number`);
    const path = key.split(".");
    let at = next as unknown as Record<string, unknown>;
    for (const part of path.slice(0, -1)) at = at[part] as Record<string, unknown>;
    const last = path[path.length - 1];
    if (typeof at?.[last] === "boolean") at[last] = value !== 0;
    else if (typeof at?.[last] === "number") at[last] = value;
    else throw new Error(`--set ${set}: no setting called ${key}`);
  }
  return next;
}

function main() {
  const query: NeuronQuery = {};
  for (const key of ["type", "superClass", "class", "subClass", "side", "nt"] as const) {
    const text = values[key];
    if (text !== undefined) query[key] = condition(text);
  }
  if (Object.keys(query).length === 0) throw new Error("Say which neurons to drive, e.g. --type LPLC2,LC4");
  const c = readConnectomeFile(values.path);
  const driven = c.find(query);
  if (driven.length === 0) throw new Error("No neurons match");
  const point = withOverrides(OPERATING_POINT, values.set);
  const weights = buildWeights(c, point);
  const sim = new Simulation(weights.network, { ...point.neuron, gain: weights.gain, seed: Number(values.seed) });
  const ms = Number(values.ms);
  const after = Number(values.after);
  if (values.each) return rank(c, sim, driven, values.each, point, ms);
  sim.addInput("driven", driven, Number(values.rate));
  console.log(`driving ${driven.length} neurons at ${values.rate} Hz for ${ms} ms; ${describe(point)}`);
  period(c, sim, driven, ms, "while driven");
  if (after > 0) {
    sim.setRate("driven", 0);
    period(c, sim, new Uint32Array(0), after, `after (${after} ms), driven neurons included`);
    console.log(`  active at the end: ${sim.active.toLocaleString("en-US")}`);
  }
}

function rank(c: Connectome, sim: Simulation, driven: Uint32Array, column: string, point: OperatingPoint, ms: number) {
  if (!(column in c.columns)) throw new Error(`--each takes a column: ${Object.keys(c.columns).join(", ")}`);
  if (!values.target) throw new Error("--each needs --target <type>, the neurons to rank by");
  const target = c.find({ type: condition(values.target) });
  if (target.length === 0) throw new Error(`No neurons of type ${values.target}`);
  const groups = new Map<string, number[]>();
  for (const i of driven) {
    const value = c.columns[column as keyof Connectome["columns"]].value(i) || "(blank)";
    (groups.get(value) ?? groups.set(value, []).get(value)!).push(i);
  }
  const names = [...groups].filter(([, members]) => members.length >= 2).map(([name]) => name);
  names.forEach((name) => sim.addInput(name, groups.get(name)!, 0));
  sim.addReadout("target", target);
  // The target's mean rate, Hz, with these groups driven together from rest.
  const response = (chosen: readonly string[]) => {
    sim.reset();
    sim.drainReadouts();
    for (const name of chosen) sim.setRate(name, Number(values.rate));
    sim.advance(ms);
    for (const name of chosen) sim.setRate(name, 0);
    return (sim.drainReadouts().target / target.length / ms) * 1000;
  };
  if (values.greedy) {
    console.log(`building a set of ${column} values greedily from ${driven.length} neurons at ${values.rate} Hz for ${ms} ms; ${describe(point)}`);
    const chosen: string[] = [];
    let best = 0;
    for (;;) {
      let pick: string | null = null;
      let pickHz = best + 1;
      for (const name of names) {
        if (chosen.includes(name)) continue;
        const hz = response([...chosen, name]);
        if (hz >= pickHz) {
          pick = name;
          pickHz = hz;
        }
      }
      if (pick === null) break;
      chosen.push(pick);
      best = pickHz;
      console.log(`  + ${pick.padEnd(24)} ${values.target} ${best.toFixed(1)} Hz`);
    }
    console.log(`chosen: ${chosen.join(", ") || "(nothing raised the target by 1 Hz)"}`);
    return;
  }
  console.log(`driving each ${column} of ${driven.length} neurons on its own at ${values.rate} Hz for ${ms} ms; ${describe(point)}`);
  const rows = names.map((name) => ({ name, n: groups.get(name)!.length, hz: response([name]) }));
  rows.sort((a, b) => b.hz - a.hz);
  console.log(`${values.target} (${target.length} neurons), mean rate:`);
  for (const row of rows.slice(0, Number(values.top))) console.log(`  ${row.name.padEnd(24)} ${String(row.n).padStart(5)} neurons  ${row.hz.toFixed(1).padStart(7)} Hz`);
}

function describe(point: OperatingPoint) {
  return `±${point.excitatory}/${point.inhibitory} mV per synapse, saturation ${point.saturation}, dt ${point.neuron.dt} ms, resetDrive ${point.neuron.resetDrive}, adaptation ${point.neuron.adaptation.increment} mV / ${point.neuron.adaptation.tau} ms`;
}

function period(c: Connectome, sim: Simulation, driven: Uint32Array, ms: number, label: string) {
  sim.setRecording(true);
  const before = sim.stats.spikes;
  let peak = 0;
  const started = performance.now();
  for (let t = 0; t < ms; t += 10) {
    sim.advance(Math.min(10, ms - t));
    peak = Math.max(peak, sim.active);
  }
  const wall = performance.now() - started;
  const recording = sim.recording!;
  const isDriven = new Uint8Array(c.neurons);
  for (const i of driven) isDriven[i] = 1;
  const seconds = ms / 1000;
  console.log(`\n${label}: ${(sim.stats.spikes - before).toLocaleString("en-US")} spikes, peak ${peak.toLocaleString("en-US")} active, ${((wall / ms) * 1).toFixed(3)} s wall per simulated s`);
  const only = values.only ? new RegExp(values.only) : null;
  const bySuper = new Map<string, { n: number; fired: number; spikes: number }>();
  const byType = new Map<string, { n: number; fired: number; spikes: number; superClass: string; sides: Map<string, number> }>();
  for (let i = 0; i < c.neurons; i++) {
    if (isDriven[i]) continue;
    const superClass = c.columns.superClass.value(i) || "(blank)";
    const s = bySuper.get(superClass) ?? { n: 0, fired: 0, spikes: 0 };
    s.n++;
    s.spikes += recording[i];
    if (recording[i] > 0) s.fired++;
    bySuper.set(superClass, s);
    if (only && !only.test(superClass)) continue;
    const type = c.columns.type.value(i) || `(blank ${superClass})`;
    const t = byType.get(type) ?? { n: 0, fired: 0, spikes: 0, superClass, sides: new Map() };
    t.n++;
    t.spikes += recording[i];
    if (recording[i] > 0) {
      t.fired++;
      const side = c.columns.side.value(i) || "?";
      t.sides.set(side, (t.sides.get(side) ?? 0) + recording[i]);
    }
    byType.set(type, t);
  }
  console.log("  by super class (fired / neurons, mean Hz per neuron):");
  for (const [name, s] of [...bySuper].filter(([, s]) => s.fired > 0).sort((a, b) => b[1].spikes - a[1].spikes)) {
    console.log(`    ${name.padEnd(22)} ${String(s.fired).padStart(6)} / ${String(s.n).padEnd(6)} ${(s.spikes / s.n / seconds).toFixed(2).padStart(8)} Hz`);
  }
  console.log(`  top types${only ? ` (${values.only})` : ""}:`);
  const top = [...byType].filter(([, t]) => t.fired > 0).sort((a, b) => b[1].spikes / b[1].n - a[1].spikes / a[1].n);
  for (const [name, t] of top.slice(0, Number(values.top))) {
    const sides = [...t.sides].map(([side, n]) => `${side[0]}${((n / t.spikes) * 100).toFixed(0)}%`).join(" ");
    console.log(`    ${name.padEnd(24)} ${t.superClass.padEnd(20)} ${String(t.fired).padStart(4)}/${String(t.n).padEnd(5)} ${(t.spikes / t.n / seconds).toFixed(1).padStart(7)} Hz  ${sides}`);
  }
}

if (import.meta.main) main();
