// What the brain does, measured on the real connectome:
//
//   node packages/brain/scripts/report.ts [--minutes 10] [--seed 1] [--path connectome.bin]
//
// (a) the response matrix: each sense alone at full strength for 1 s, and
//     rest, with every command's mean and peak and the latency to its peak,
//     then the pet's looming pulse;
// (b) seizure recovery: every sense, every pair and all at once at full
//     strength for 2 s, then back to rest;
// (c) behaviour at rest over --minutes of fly time, as the pet would act on it;
// (d) wall time per simulated second at rest, under some typical stimulation
//     and with everything at once;
// (e) the eyes: every stimulus of the vision battery (src/stimuli.ts), alone
//     and with every other sense at full strength, then back to its steady
//     scene, checked against the resting band of (b); and wall time per
//     simulated second with the eyes open. scripts/vision.ts shows what each
//     stimulus does, stage by stage.
//
// Runs are deterministic for a seed. It takes about four minutes.

import { parseArgs } from "node:util";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "../src/node.ts";
import { PetObserver } from "../src/pet.ts";
import { FlyBrain } from "../src/runtime.ts";
import { RESTING_SENSES } from "../src/types.ts";
import type { BrainCommand, BrainSenses } from "../src/types.ts";
import type { ScalarSense } from "../src/io.ts";
import { BATTERY, facetAngles, render } from "../src/stimuli.ts";
import type { Scene, Stimulus } from "../src/stimuli.ts";

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "10" },
    seed: { type: "string", default: "1" },
    path: { type: "string", default: DEFAULT_CONNECTOME_PATH },
  },
});
const seed = Number(values.seed);
const connectome = readConnectomeFile(values.path);
const TICK = 16;
const COMMANDS = ["walk", "turn", "back", "escape", "wings", "groom", "feed"] as const;

const brain = () => new FlyBrain(connectome, { seed });
const rest = (b: FlyBrain, ms: number) => {
  for (let t = 0; t < ms; t += TICK) b.tick(TICK, RESTING_SENSES);
};
const fixed = (n: number, digits = 2) => (n >= 0 ? " " : "") + n.toFixed(digits);
const pad = (s: string, n: number) => s.padEnd(n);

/** Every combination the matrix and the seizure check use. */
const FULL: { [K in ScalarSense]: BrainSenses[K] } = {
  loomLeft: 1,
  loomRight: 1,
  touch: 1,
  bumpLeft: 1,
  bumpRight: 1,
  wind: 1,
  sweet: 1,
  grounded: false,
};
const label = (key: ScalarSense) => (key === "grounded" ? "airborne" : key);
const apply = (keys: readonly (ScalarSense)[]): BrainSenses => {
  const senses: Record<ScalarSense, number | boolean> = { ...RESTING_SENSES };
  for (const key of keys) senses[key] = FULL[key];
  return senses as BrainSenses;
};

console.log(`Fly brain report: ${connectome.neurons.toLocaleString("en-US")} neurons, ${connectome.connections.toLocaleString("en-US")} connected pairs, seed ${seed}`);

// (a) The response matrix.
console.log("\n(a) Response matrix. 2 s of rest, then 1 s of the sense at full strength (or nothing, for rest).");
console.log("    Each cell: mean / peak over that second, and ms from onset to the peak (- when it never rises above 0.05).");
console.log(`    ${pad("", 10)}${COMMANDS.map((c) => pad(c, 20)).join("")}`);
const cases: [string, BrainSenses][] = [["rest", RESTING_SENSES], ...(Object.keys(FULL) as (ScalarSense)[]).map((k) => [label(k), apply([k])] as [string, BrainSenses])];
const rateLines: string[] = [];
for (const [name, senses] of cases) {
  const b = brain();
  rest(b, 2000);
  const sum = Object.fromEntries(COMMANDS.map((c) => [c, 0])) as Record<keyof BrainCommand, number>;
  const peak = Object.fromEntries(COMMANDS.map((c) => [c, 0])) as Record<keyof BrainCommand, number>;
  const at = Object.fromEntries(COMMANDS.map((c) => [c, 0])) as Record<keyof BrainCommand, number>;
  const rates: Record<string, number> = {};
  let n = 0;
  for (let t = TICK; t <= 1000; t += TICK) {
    const { command, stats } = b.tick(TICK, senses);
    n++;
    for (const c of COMMANDS) {
      sum[c] += command[c];
      if (Math.abs(command[c]) > Math.abs(peak[c])) {
        peak[c] = command[c];
        at[c] = t;
      }
    }
    for (const [k, v] of Object.entries(stats.rates)) rates[k] = (rates[k] ?? 0) + v;
  }
  const cells = COMMANDS.map((c) => pad(`${fixed(sum[c] / n)} /${fixed(peak[c])} ${Math.abs(peak[c]) > 0.05 ? String(at[c]).padStart(4) : "   -"}`, 20));
  console.log(`    ${pad(name, 10)}${cells.join("")}`);
  rateLines.push(`    ${pad(name, 10)}${Object.entries(rates).map(([k, v]) => `${k} ${(v / n).toFixed(1)}`).join(", ")}`);
}
console.log("\n    Mean readout rates over the same second, Hz:");
for (const line of rateLines) console.log(line);

// The pet's looming pulse: full (or half) strength for 80 ms, then fading to 0 over 200 ms.
console.log("\n    The pet's looming pulse in the left eye (held 80 ms, fading over 200 ms), after 2 s of rest:");
for (const strength of [1, 0.5]) {
  const b = brain();
  rest(b, 2000);
  let up = -1;
  let down = -1;
  let top = 0;
  for (let t = TICK; t <= 1000; t += TICK) {
    const elapsed = t - TICK;
    const loom = elapsed < 80 ? strength : Math.max(0, strength * (1 - (elapsed - 80) / 200));
    const { command } = b.tick(TICK, { ...RESTING_SENSES, loomLeft: loom });
    top = Math.max(top, command.escape);
    if (up < 0 && command.escape >= 0.5) up = t;
    if (up >= 0 && down < 0 && loom === 0 && command.escape < 0.3) down = t - 280;
  }
  console.log(
    `      strength ${strength}: escape peaks at ${top.toFixed(2)}, ${up >= 0 ? `passes 0.5 ${up} ms after onset` : "never passes 0.5"}, ${down >= 0 ? `below 0.3 ${down} ms after the loom has faded` : "never falls below 0.3"}`,
  );
}

// (b) Seizure recovery.
const WINDOW = 250;
const windowRate = (b: FlyBrain, senses: BrainSenses) => {
  let spikes = 0;
  for (let t = 0; t < WINDOW; t += 10) spikes += b.tick(10, senses).stats.spikes;
  return (spikes * 1000) / WINDOW;
};
// The top of the resting band, which (e) checks against too.
let bandHigh: number;
{
  const b = brain();
  rest(b, 2000);
  const band: number[] = [];
  for (let w = 0; w < 120_000 / WINDOW; w++) band.push(windowRate(b, RESTING_SENSES));
  band.sort((x, y) => x - y);
  const high = band[band.length - 1];
  bandHigh = high;
  console.log(`\n(b) Seizure recovery. The resting band: total spikes per second in ${WINDOW} ms windows over 2 minutes at rest`);
  console.log(`    ran ${band[0].toLocaleString("en-US")} to ${high.toLocaleString("en-US")} (median ${band[band.length >> 1].toLocaleString("en-US")}).`);
  console.log(`    Each case: 1 s of rest, 2 s at full strength, then rest; spikes per second in the ${WINDOW} ms windows after it.`);
  const keys = Object.keys(FULL) as (ScalarSense)[];
  const combos = [...keys.map((k) => [k]), ...keys.flatMap((a, i) => keys.slice(i + 1).map((k) => [a, k])), keys];
  let passed = 0;
  for (const combo of combos) {
    const s = brain();
    rest(s, 1000);
    const senses = apply(combo);
    let during = 0;
    for (let t = 0; t < 2000; t += 10) during += s.tick(10, senses).stats.spikes;
    const after = [0, 1, 2, 3].map(() => windowRate(s, RESTING_SENSES));
    const ok = after[3] <= high;
    if (ok) passed++;
    const name = combo.length === keys.length ? "everything at once" : combo.map(label).join(" + ");
    console.log(
      `    ${ok ? "ok  " : "FAIL"} ${pad(name, 26)} during ${Math.round(during / 2).toLocaleString("en-US").padStart(9)}/s   after ${after.map((x) => Math.round(x).toLocaleString("en-US").padStart(7)).join(" ")}  (the last ends 1 s after)`,
    );
  }
  console.log(`    ${passed} of ${combos.length} back inside the resting band within 1 s.`);
}

// (c) Resting behaviour.
{
  const minutes = Number(values.minutes);
  const b = brain();
  const pet = new PetObserver();
  for (let t = 0; t < minutes * 60_000; t += TICK) pet.observe(b.tick(TICK, RESTING_SENSES).command, TICK / 1000);
  const t = pet.tally;
  console.log(`\n(c) Behaviour at rest over ${minutes} minutes, through the pet's thresholds (on its feet, free to move):`);
  console.log(`    walking forwards  ${((100 * t.walking) / t.seconds).toFixed(1)}% of the time, in ${t.walkBouts} bouts (mean ${(t.walking / Math.max(1, t.walkBouts)).toFixed(1)} s)`);
  console.log(`    walking backwards ${t.backing.toFixed(1)} s in ${t.backBouts} bouts`);
  console.log(`    turn-arounds      ${t.turnsLeft} toward the fly's left, ${t.turnsRight} toward its right`);
  console.log(`    escapes           ${t.escapes}`);
  console.log(`    peaks             ${COMMANDS.map((c) => `${c} ${t.peak[c].toFixed(2)}`).join(", ")}`);
}

// (d) Cost.
{
  // The pet's pulse (80 ms at full strength, fading over 200 ms) at the start of every second, in the left eye.
  const loomEverySecond = (seconds = 10) => {
    const b = brain();
    rest(b, 2000);
    let wall = 0;
    for (let t = 0; t < seconds * 1000; t += TICK) {
      const into = t % 1000;
      const loom = into < 80 ? 1 : Math.max(0, 1 - (into - 80) / 200);
      wall += b.tick(TICK, { ...RESTING_SENSES, loomLeft: loom }).stats.wallMs;
    }
    return wall / 1000 / seconds;
  };
  const cost = (senses: BrainSenses, seconds = 10) => {
    const b = brain();
    rest(b, 2000);
    b.tick(TICK, senses);
    let wall = 0;
    for (let t = 0; t < seconds * 1000; t += TICK) wall += b.tick(TICK, senses).stats.wallMs;
    return wall / 1000 / seconds;
  };
  console.log("\n(d) Wall time per simulated second, one thread, 10 s each after 2 s of rest:");
  const rows: [string, BrainSenses][] = [
    ["rest", RESTING_SENSES],
    ["the pointer resting on it (touch 0.4)", { ...RESTING_SENSES, touch: 0.4 }],
    ["a full looming pulse every second", RESTING_SENSES],
    ["held and dragged (touch 1, wind 0.5, airborne)", { ...RESTING_SENSES, touch: 1, wind: 0.5, grounded: false }],
    ["everything at once at full strength", apply(Object.keys(FULL) as (ScalarSense)[])],
  ];
  for (const [name, senses] of rows) {
    const seconds = name.startsWith("a full looming") ? loomEverySecond() : cost(senses);
    console.log(`    ${pad(name, 48)} ${seconds.toFixed(3)} s`);
  }
}

// (e) The eyes.
{
  /** A brain with its eyes open, and a way to show it a scene. */
  const seeing = () => {
    const b = brain();
    const angles = facetAngles(b.eyes!);
    const light = { left: new Float32Array(angles.left.az.length), right: new Float32Array(angles.right.az.length) };
    let wall = 0;
    /** Shows the scene for ms (its time from 0), under these other senses; returns the spikes per 10 ms tick. */
    const show = (scene: Scene, ms: number, others: BrainSenses = RESTING_SENSES) => {
      const spikes: number[] = [];
      for (let t = 0; t < ms; t += 10) {
        render(scene, t / 1000, angles, light);
        const { stats } = b.tick(10, { ...others, light });
        spikes.push(stats.spikes);
        wall += stats.wallMs;
      }
      return spikes;
    };
    /** The lamina's total input from both eyes, spikes per second. */
    const lamina = () => (["left", "right"] as const).reduce((sum, side) => sum + b.vision!.retina[side].rates.reduce((a, x) => a + x, 0), 0);
    return { show, lamina, wall: () => wall };
  };
  const everything = apply(Object.keys(FULL) as ScalarSense[]);
  const QUIET = 100;
  console.log(`\n(e) The eyes. Each stimulus after 1 s of its steady scene, alone and with every other sense at full strength, then`);
  console.log(`    its steady scene again. Going back to it can itself be a change the eyes signal for a while (L3's response`);
  console.log(`    is sustained), so the clock starts once the lamina is quiet (its input from both eyes under ${QUIET} spikes/s):`);
  console.log(`    ms until then, and spikes per second in the ${WINDOW} ms windows after (resting band from (b) up to ${bandHigh.toLocaleString("en-US")}).`);
  let passed = 0;
  let cases = 0;
  const width = Math.max(...BATTERY.map((each) => each.name.length)) + 2;
  for (const stimulus of BATTERY) {
    const cells: string[] = [];
    for (const others of [RESTING_SENSES, everything]) {
      const { show, lamina } = seeing();
      const ground = () => stimulus.ground;
      show(ground, 1000);
      show(stimulus.scene, stimulus.seconds * 1000, others);
      let quiet = 0;
      do {
        show(ground, 10);
        quiet += 10;
      } while (lamina() >= QUIET && quiet < 30_000);
      const after = [0, 1, 2, 3].map(() => (show(ground, WINDOW).reduce((a, x) => a + x, 0) * 1000) / WINDOW);
      const ok = after[3] <= bandHigh;
      cases++;
      if (ok) passed++;
      cells.push(`${ok ? "ok  " : "FAIL"} ${String(quiet).padStart(5)} ${after.map((x) => Math.round(x).toLocaleString("en-US").padStart(7)).join(" ")}`);
    }
    console.log(`    ${pad(stimulus.name, width)}alone ${cells[0]}   with everything ${cells[1]}`);
  }
  console.log(`    ${passed} of ${cases} back inside the resting band within 1 s.`);

  console.log("\n    Wall time per simulated second with the eyes open, one thread, 10 s each after 2 s of its steady scene:");
  {
    const b = brain();
    rest(b, 2000);
    let total = 0;
    for (let t = 0; t < 10_000; t += 10) total += b.tick(10, RESTING_SENSES).stats.wallMs;
    console.log(`    ${pad("eyes shut, for comparison", 52)} ${(total / 10_000).toFixed(3)} s`);
  }
  const looped = (stimulus: Stimulus): Scene => (t, a, e) => stimulus.scene(t % stimulus.seconds, a, e);
  const named = (name: string) => BATTERY.find((each) => each.name === name)!;
  const checkerboard: Scene = (_t, a, e) => named("static checkerboard").scene(0, a, e);
  const rows: { label: string; ground: Scene; settle: number; scene: Scene }[] = [
    { label: "a steady uniform scene", ground: () => 1, settle: 2000, scene: () => 1 },
    { label: "a steady checkerboard, 20 s after it appeared", ground: checkerboard, settle: 20_000, scene: checkerboard },
    { label: "a dark disc looming at the right eye, over and over", ground: () => 1, settle: 2000, scene: looped(named("loom right")) },
    { label: "a grating drifting across both eyes", ground: () => 0.5, settle: 2000, scene: named("grating, clockwise").scene },
    { label: "the whole field flickering at 4 Hz", ground: () => 0.6, settle: 2000, scene: named("flicker").scene },
  ];
  for (const { label, ground, settle, scene } of rows) {
    const { show, wall } = seeing();
    show(ground, settle);
    const before = wall();
    show(scene, 10_000);
    console.log(`    ${pad(label, 52)} ${((wall() - before) / 10_000).toFixed(3)} s`);
  }
}
