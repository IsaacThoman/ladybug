// Checks against the real packed connectome. It is not in git (see README),
// so these skip unless `npm run brain:pack` has been run.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "./node.ts";
import { Simulation, gainByTransmitter } from "./sim.ts";

const skip = existsSync(DEFAULT_CONNECTOME_PATH) ? false : `no ${DEFAULT_CONNECTOME_PATH}; run npm run brain:pack`;
const connectome = skip ? undefined : readConnectomeFile();

test("the packed male CNS has the expected shape", { skip }, () => {
  const c = connectome!;
  assert.equal(c.neurons, 166_700);
  assert.equal(c.connections, 6_242_118);
  assert.equal(c.synapses, 89_860_280);
  assert.equal(c.source.dataset, "FlyEM male CNS");
  assert.equal(c.source.license, "CC-BY 4.0");
  assert.equal(c.ptr[0], 0);
  assert.equal(c.ptr[c.neurons], c.connections);
  let clampedSum = 0;
  for (let i = 0; i < c.neurons; i++) {
    assert.ok(c.ptr[i] <= c.ptr[i + 1]);
    for (let k = c.ptr[i]; k < c.ptr[i + 1]; k++) {
      assert.ok(c.post[k] < c.neurons);
      if (k > c.ptr[i]) assert.ok(c.post[k] > c.post[k - 1]);
      clampedSum += c.count[k];
    }
  }
  assert.ok(clampedSum <= c.synapses);
  assert.equal(c.columns.type.table.length > 10_000, true);
  assert.deepEqual(c.columns.nt.table, ["", "ACH", "DA", "GABA", "GLUT", "HIST", "OCT", "SER"]);
});

test("known neurons are where they should be", { skip }, () => {
  const c = connectome!;
  const giantFiber = c.find({ type: "DNp01" });
  assert.equal(giantFiber.length, 2);
  assert.deepEqual([...giantFiber].map((i) => c.columns.side.value(i)).sort(), ["left", "right"]);
  assert.deepEqual([...giantFiber].map((i) => c.rootId[i]), [10001, 10010]);
  for (const i of giantFiber) {
    assert.equal(c.columns.superClass.value(i), "descending_neuron");
    assert.equal(c.columns.nt.value(i), "ACH");
  }
  assert.ok(c.find({ type: "LPLC2" }).length > 50);
  assert.ok(c.find({ type: "LC4" }).length > 50);
  assert.ok(c.find({ superClass: "descending_neuron" }).length > 1000);
  assert.equal(c.indexOf(10001), giantFiber[0]);
});

test("looming input drives the giant fiber hard, and silence stays silent", { skip }, () => {
  const c = connectome!;
  const w = 0.07;
  const gain = gainByTransmitter(c, { ACH: w, GABA: -w, GLUT: -w, HIST: -w });
  const sim = new Simulation(c, { gain });
  sim.addInput("looming", [...c.find({ type: "LPLC2" }), ...c.find({ type: "LC4" })]);
  sim.addReadout("DNp01", c.find({ type: "DNp01" }));
  sim.advance(200);
  assert.equal(sim.stats.spikes, 0);
  assert.equal(sim.active, 0);
  sim.setRate("looming", 100);
  sim.advance(500);
  const hz = sim.drainReadouts().DNp01 / 2 / 0.5;
  assert.ok(hz > 200, `DNp01 at ${hz} Hz`);
});
