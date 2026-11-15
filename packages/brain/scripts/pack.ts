// Packs the Codex CSV export of the FlyEM male CNS into connectome.bin:
//
//   npm run brain:pack -- --neurons neurons.csv --connections connections_princeton.csv [--out path]
//
// Either input may be gzipped, whatever its name.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openInput, pack } from "../src/pack.ts";

const { values } = parseArgs({
  options: {
    neurons: { type: "string" },
    connections: { type: "string" },
    out: { type: "string", default: resolve(import.meta.dirname, "../data/connectome.bin") },
  },
});
if (!values.neurons || !values.connections) {
  console.error("usage: npm run brain:pack -- --neurons <path> --connections <path> [--out <path>]");
  process.exit(2);
}

const started = performance.now();
const { bytes, summary } = await pack(openInput(values.neurons), openInput(values.connections));
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`neurons      ${summary.neurons.toLocaleString("en-US")}`);
console.log(`rows         ${summary.rows.toLocaleString("en-US")}`);
console.log(`pairs        ${summary.connections.toLocaleString("en-US")}${summary.clamped ? ` (${summary.clamped} counts clamped to 65535)` : ""}`);
console.log(`synapses     ${summary.synapses.toLocaleString("en-US")}`);
console.log(`bytes        ${summary.bytes.toLocaleString("en-US")}`);
console.log(`wrote ${out} in ${seconds} s`);
