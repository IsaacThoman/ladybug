import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { loadConnectome } from "./format.ts";
import { PackError, openInput, pack, parseCsv, readConnections } from "./pack.ts";

const NEURON_HEADER =
  "Root ID,Top in/out region,Community labels,Predicted NT type,Predicted NT confidence,Verified NT type,Body Part,Super Class,Class,Sub Class,Nerve,Soma side,Primary Cell Type,Volume (nm^3)";

// Rows deliberately out of root ID order, with quoted labels holding commas,
// an escaped quote and a newline.
const NEURONS = [
  NEURON_HEADER,
  `10010,g10001,"hemibrainType: Giant Fiber,instance: DNp01(GF),mancBodyid: 10002",ACH,0.56,,,descending_neuron,,lt,,left,DNp01,`,
  `30,g3,"say ""hi"", twice",GABA,0.9,,,visual_projection,visual,,CvN,right,LPLC2,`,
  `10001,g10001,"hemibrainType: Giant Fiber,instance: DNp01(GF)",ACH,0.5,,,descending_neuron,,lt,,right,DNp01,`,
  `500,g5,"two
lines",,,,,cb_intrinsic,,,,,,`,
].join("\r\n");

const CONNECTIONS = [
  "pre_root_id,post_root_id,neuropil,syn_count,nt_type",
  "10001,10010,GOR_R,4,",
  "10001,30,PVLP_R,2,",
  "10001,10010,EPA_R,1,", // same pair, another neuropil: merges to 5
  "500,10001,CB_UNASGD,70000,", // clamps
  "30,500,LO_R,3,",
  "10001,500,SPS_R,1,",
  "",
].join("\r\n");

async function* chunks(text: string | Uint8Array, size: number) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function rowsOf(text: string, size = 1 << 16) {
  const rows: string[][] = [];
  await parseCsv(chunks(text, size), (fields) => rows.push(fields));
  return rows;
}

test("CSV fields may be quoted, hold commas, quotes and newlines, and split across chunks anywhere", async () => {
  const expected = [
    ["a", "b,c", 'say "hi"', ""],
    ["", "two\nlines", "x", 'end"'],
  ];
  const text = `a,"b,c","say ""hi""",\r\n,"two\nlines",x,"end"""\n`;
  for (const size of [1, 2, 3, 7, 1 << 16]) assert.deepEqual(await rowsOf(text, size), expected, `chunk size ${size}`);
  assert.deepEqual(await rowsOf("a,b\n\nc,d"), [["a", "b"], ["c", "d"]]);
  await assert.rejects(rowsOf('a,"b'), /unterminated quoted field/);
  await assert.rejects(rowsOf('a,"b"c\n'), /text after a closing quote/);
  await assert.rejects(rowsOf('a,b"c\n'), /quote inside an unquoted field/);
});

test("packing sorts neurons by root ID, merges neuropils and clamps counts", async () => {
  const { bytes, summary } = await pack(chunks(NEURONS, 5), chunks(CONNECTIONS, 3));
  assert.deepEqual(summary, { neurons: 4, rows: 6, connections: 5, synapses: 70011, clamped: 1, bytes: bytes.length });
  const c = loadConnectome(bytes.slice().buffer);
  assert.deepEqual([...c.rootId], [30, 500, 10001, 10010]);
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < c.neurons; i++) for (let k = c.ptr[i]; k < c.ptr[i + 1]; k++) pairs.push([c.rootId[i], c.rootId[c.post[k]], c.count[k]]);
  assert.deepEqual(pairs, [
    [30, 500, 3],
    [500, 10001, 65535],
    [10001, 30, 2],
    [10001, 500, 1],
    [10001, 10010, 5],
  ]);
  assert.deepEqual([...c.find({ type: "DNp01" })].map((i) => c.columns.side.value(i)), ["right", "left"]);
  assert.equal(c.columns.nt.value(c.indexOf(30)), "GABA");
  assert.equal(c.columns.nerve.value(c.indexOf(30)), "CvN");
  assert.equal(c.columns.class.value(c.indexOf(30)), "visual");
  assert.equal(c.columns.subClass.value(c.indexOf(10010)), "lt");
  assert.deepEqual([...c.ntConfidence], [90, 0, 50, 56]);
  // Tables are sorted, so blank is always code 0.
  assert.deepEqual(c.columns.nt.table, ["", "ACH", "GABA"]);
  assert.equal(c.columns.type.codes[c.indexOf(500)], 0);
});

test("the output depends only on the data, not on row order or compression", async () => {
  const { bytes } = await pack(chunks(NEURONS, 1 << 16), chunks(CONNECTIONS, 1 << 16));
  const [header, ...rows] = NEURONS.split("\r\n");
  const shuffledNeurons = [header, rows[3], rows[1], rows[0], rows[2]].join("\n");
  const [cHeader, ...cRows] = CONNECTIONS.trim().split("\r\n");
  const shuffledConnections = [cHeader, ...cRows.reverse()].join("\n") + "\n";
  const again = await pack(chunks(gzipSync(shuffledNeurons), 4), chunks(gzipSync(shuffledConnections), 9));
  assert.deepEqual(again.bytes, bytes);
});

test("files are read plain or gzipped, whatever their name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-pack-"));
  try {
    writeFileSync(join(dir, "neurons.csv"), gzipSync(NEURONS));
    writeFileSync(join(dir, "connections.csv.gz"), CONNECTIONS);
    const fromFiles = await pack(openInput(join(dir, "neurons.csv")), openInput(join(dir, "connections.csv.gz")));
    const direct = await pack(chunks(NEURONS, 1 << 16), chunks(CONNECTIONS, 1 << 16));
    assert.deepEqual(fromFiles.bytes, direct.bytes);
    writeFileSync(join(dir, "broken.csv"), gzipSync(CONNECTIONS).subarray(0, 30));
    await assert.rejects(pack(openInput(join(dir, "neurons.csv")), openInput(join(dir, "broken.csv"))), /unexpected end of file/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("malformed rows and unknown IDs fail loudly, naming the row", async () => {
  const rootId = Uint32Array.from([1, 2, 3]);
  const read = (text: string) => readConnections(chunks(text, 4), rootId);
  const header = "pre_root_id,post_root_id,neuropil,syn_count,nt_type\n";
  await assert.rejects(read(header + "1,2,A,3,\n1,9,A,1,\n"), (error: Error) => error instanceof PackError && /row 3: unknown postsynaptic root ID 9/.test(error.message));
  await assert.rejects(read(header + "7,2,A,3,\n"), /row 2: unknown presynaptic root ID 7/);
  await assert.rejects(read(header + "1,2,A,3\n"), /row 2: 4 fields, expected 5/);
  await assert.rejects(read(header + "1,2,A,3,,\n"), /row 2: more than 5 fields/);
  await assert.rejects(read(header + "1,2,A,x,\n"), /row 2: expected a number in column 4/);
  await assert.rejects(read(header + "1,,A,3,\n"), /row 2: empty number in column 2/);
  await assert.rejects(read(header + "1,2,A,0,\n"), /row 2: synapse count must be at least 1/);
  await assert.rejects(read(header + "1,2,A,3,\r1,2,A,3,\n"), /row 2: stray carriage return/);
  await assert.rejects(read("pre,post,syn_count\n"), /no "pre_root_id" column/);
  await assert.rejects(read(""), /no header line/);
  // A last row without a newline still counts.
  const ok = await read(header + "1,2,A,3,\n3,1,B,2,");
  assert.equal(ok.rows, 2);

  const neurons = (text: string) => pack(chunks(text, 8), chunks(header, 8));
  await assert.rejects(neurons(NEURON_HEADER + "\n1,a,b\n"), /neurons CSV row 2: 3 fields, expected 14/);
  await assert.rejects(neurons(NEURON_HEADER + "\nx1,,,ACH,0.5,,,,,,,,,\n"), /bad root ID "x1"/);
  await assert.rejects(neurons(NEURON_HEADER + "\n1,,,ACH,1.5,,,,,,,,,\n"), /bad NT confidence "1.5"/);
  await assert.rejects(neurons(NEURON_HEADER + "\n1,,,ACH,0.5,,,,,,,,,\n1,,,ACH,0.5,,,,,,,,,\n"), /root ID 1 appears twice/);
  await assert.rejects(neurons("Root ID,Super Class\n1,x\n"), /no "Predicted NT confidence" column/);
});
