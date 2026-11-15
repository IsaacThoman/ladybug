// Wall time per simulated second on the real connectome, in three regimes:
//
//   node packages/brain/scripts/bench.ts [--seconds 2] [--path connectome.bin]
//
// (a) no input; (b) looming (LPLC2 and LC4 at 100 Hz) with ±0.07 mV per
// synapse, which settles; (c) the same at ±0.275 with modulatory and unknown
// transmitters excitatory, which runs away and is the worst case.

import { parseArgs } from "node:util";
import { readConnectomeFile, DEFAULT_CONNECTOME_PATH } from "../src/node.ts";
import { Simulation, gainByTransmitter } from "../src/sim.ts";

const { values } = parseArgs({
  options: { seconds: { type: "string", default: "2" }, path: { type: "string", default: DEFAULT_CONNECTOME_PATH } },
});
const seconds = Number(values.seconds);

let started = performance.now();
const connectome = readConnectomeFile(values.path);
console.log(
  `loaded ${connectome.neurons.toLocaleString("en-US")} neurons, ${connectome.connections.toLocaleString("en-US")} pairs in ${(performance.now() - started).toFixed(0)} ms`,
);

const looming = [...connectome.find({ type: "LPLC2" }), ...connectome.find({ type: "LC4" })];
const giantFiber = connectome.find({ type: "DNp01" });

// Each regime runs half a simulated second untimed first, so the timings are
// of the settled network with the JIT warmed up.
function regime(label: string, gain: Float32Array, rate: number) {
  started = performance.now();
  const sim = new Simulation(connectome, { gain, seed: 1 });
  const setupMs = performance.now() - started;
  sim.addInput("looming", looming, rate);
  sim.addReadout("DNp01", giantFiber);
  sim.advance(500);
  sim.drainReadouts();
  sim.setRecording(true);
  const before = { ...sim.stats };
  let peak = 0;
  let activeSum = 0;
  let wall = 0;
  const ticks = Math.round((seconds * 1000) / 10);
  for (let t = 0; t < ticks; t++) {
    const tick = performance.now();
    sim.advance(10);
    wall += performance.now() - tick;
    peak = Math.max(peak, sim.active);
    activeSum += sim.active;
  }
  const dnp01 = sim.drainReadouts().DNp01 / giantFiber.length / seconds;
  let firing = 0;
  let fired = 0;
  for (const spikes of sim.recording!) {
    if (spikes > 0) fired++;
    if (spikes / seconds >= 50) firing++;
  }
  const perSecond = (n: number) => Math.round(n / seconds).toLocaleString("en-US");
  console.log(`\n${label}`);
  console.log(`  setup ${setupMs.toFixed(0)} ms; ${seconds} s simulated in ${(wall / 1000).toFixed(3)} s wall`);
  console.log(`  wall per simulated second  ${(wall / 1000 / seconds).toFixed(3)} s`);
  console.log(`  spikes per second          ${perSecond(sim.stats.spikes - before.spikes)}`);
  console.log(`  synaptic events per second ${perSecond(sim.stats.events - before.events)}`);
  console.log(`  active neurons             mean ${Math.round(activeSum / ticks).toLocaleString("en-US")}, peak ${peak.toLocaleString("en-US")}`);
  console.log(`  neurons that fired         ${fired.toLocaleString("en-US")}, ${firing.toLocaleString("en-US")} at 50 Hz or more`);
  console.log(`  DNp01 (${giantFiber.length} neurons)          ${dnp01.toFixed(0)} Hz`);
  return dnp01;
}

const signed = (w: number, modulatory: number) =>
  gainByTransmitter(connectome, { ACH: w, GABA: -w, GLUT: -w, HIST: -w, DA: modulatory, SER: modulatory, OCT: modulatory, "": modulatory });

regime("(a) no input", signed(0.07, 0), 0);
const dnp01 = regime("(b) looming at 100 Hz, ±0.07 mV/synapse, modulatory muted", signed(0.07, 0), 100);
regime("(c) looming at 100 Hz, ±0.275 mV/synapse, modulatory excitatory (runaway)", signed(0.275, 0.275), 100);

if (dnp01 < 100) {
  console.error(`\nDNp01 fired at only ${dnp01.toFixed(0)} Hz under looming; expected strong firing (~350 Hz).`);
  process.exitCode = 1;
}
