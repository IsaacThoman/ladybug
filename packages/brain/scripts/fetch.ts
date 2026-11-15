// Downloads the packed connectome instead of packing it from the CSV export:
//
//   npm run brain:fetch [-- --url <url>] [--out <path>]
//
// The file is the FlyEM male CNS connectome (Janelia Research Campus, CC-BY
// 4.0) as packed by `npm run brain:pack`, gzipped.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { loadConnectome } from "../src/format.ts";
import { DEFAULT_CONNECTOME_PATH } from "../src/node.ts";

const DEFAULT_URL = "https://github.com/IsaacThoman/ladybug/releases/download/fly-brain-data-v1/connectome.bin.gz";
/** SHA-256 of the unpacked file at DEFAULT_URL. Packing is deterministic, so a fresh pack of the same export matches it. */
const SHA256 = "51c97031b39f93c04a683f16683d88f15d291f1e1062694fc0a215e23c3b895c";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.LADYBUG_BRAIN_URL ?? DEFAULT_URL },
    out: { type: "string", default: DEFAULT_CONNECTOME_PATH },
  },
});

const response = await fetch(values.url);
if (!response.ok) {
  console.error(`Couldn't download ${values.url}: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const downloaded = Buffer.from(await response.arrayBuffer());
// Some servers and proxies unzip on the way; take either.
const bytes = downloaded[0] === 0x1f && downloaded[1] === 0x8b ? gunzipSync(downloaded) : downloaded;

const sha256 = createHash("sha256").update(bytes).digest("hex");
if (values.url === DEFAULT_URL && sha256 !== SHA256) {
  console.error(`The download doesn't match the expected file (sha256 ${sha256}).`);
  process.exit(1);
}
// A copy at offset 0: typed-array views need the alignment.
const connectome = loadConnectome(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(`${out}.part`, bytes);
renameSync(`${out}.part`, out);
console.log(`neurons      ${connectome.rootId.length.toLocaleString("en-US")}`);
console.log(`pairs        ${connectome.post.length.toLocaleString("en-US")}`);
console.log(`sha256       ${sha256}`);
console.log(`wrote ${out}`);
