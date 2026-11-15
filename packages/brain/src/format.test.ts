import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORY_NAMES, CONNECTOME_VERSION, ConnectomeFormatError, FLYEM_MALE_CNS, loadConnectome, writeConnectome } from "./format.ts";
import type { CategoryName, ConnectomeData } from "./format.ts";

function columns(codes: Record<CategoryName, number[]>, tables: Record<CategoryName, string[]>) {
  const out = {} as ConnectomeData["columns"];
  for (const name of CATEGORY_NAMES) {
    out[name] = { codes: name === "type" ? Uint16Array.from(codes[name]) : Uint8Array.from(codes[name]), table: tables[name] };
  }
  return out;
}

// Four neurons: 0 -> 1 (3 synapses), 0 -> 2 (1), 2 -> 0 (65535), 3 -> 1 (7).
function sample(): ConnectomeData {
  const tables: Record<CategoryName, string[]> = {
    superClass: ["", "descending_neuron", "visual_projection"],
    class: ["", "visual"],
    subClass: [""],
    nt: ["", "ACH", "GABA"],
    side: ["", "left", "right"],
    nerve: ["", "CvN"],
    type: ["", "DNp01", "LPLC2"],
  };
  const codes: Record<CategoryName, number[]> = {
    superClass: [1, 1, 2, 0],
    class: [0, 0, 1, 0],
    subClass: [0, 0, 0, 0],
    nt: [1, 1, 2, 0],
    side: [2, 1, 1, 0],
    nerve: [0, 1, 0, 0],
    type: [1, 1, 2, 0],
  };
  return {
    synapses: 3 + 1 + 70000 + 7,
    rootId: Uint32Array.from([10001, 10010, 20000, 4294967295]),
    ptr: Uint32Array.from([0, 2, 2, 3, 4]),
    post: Uint32Array.from([1, 2, 0, 1]),
    count: Uint16Array.from([3, 1, 65535, 7]),
    ntConfidence: Uint8Array.from([50, 56, 90, 0]),
    columns: columns(codes, tables),
  };
}

const copy = (bytes: Uint8Array) => bytes.slice().buffer;

test("a written connectome loads back unchanged, as views into the buffer", () => {
  const data = sample();
  const bytes = writeConnectome(data);
  const buffer = copy(bytes);
  const c = loadConnectome(buffer);
  assert.equal(c.neurons, 4);
  assert.equal(c.connections, 4);
  assert.equal(c.synapses, 70011);
  assert.deepEqual(c.source, FLYEM_MALE_CNS);
  assert.deepEqual([...c.rootId], [...data.rootId]);
  assert.deepEqual([...c.ptr], [...data.ptr]);
  assert.deepEqual([...c.post], [...data.post]);
  assert.deepEqual([...c.count], [...data.count]);
  assert.deepEqual([...c.ntConfidence], [...data.ntConfidence]);
  for (const name of CATEGORY_NAMES) {
    assert.deepEqual([...c.columns[name].codes], [...data.columns[name].codes]);
    assert.deepEqual(c.columns[name].table, data.columns[name].table);
  }
  assert.equal(c.columns.type.codes.BYTES_PER_ELEMENT, 2);
  assert.equal(c.columns.nt.codes.BYTES_PER_ELEMENT, 1);
  assert.equal(c.post.buffer, buffer);
  assert.equal(c.rootId.byteOffset % 8, 0);
  // Same input, same bytes.
  assert.deepEqual(writeConnectome(sample()), bytes);
});

test("queries find neurons by column", () => {
  const c = loadConnectome(copy(writeConnectome(sample())));
  assert.deepEqual([...c.find({ type: "DNp01" })], [0, 1]);
  assert.deepEqual([...c.find({ type: "DNp01", side: "left" })], [1]);
  assert.deepEqual([...c.find({ nt: ["GABA", ""] })], [2, 3]);
  assert.deepEqual([...c.find({ superClass: /^visual/ })], [2]);
  assert.deepEqual([...c.find({ superClass: /visual/g })], [2]);
  assert.deepEqual([...c.find({ type: (t) => t.startsWith("DN") })], [0, 1]);
  assert.deepEqual([...c.find({ type: "nothing" })], []);
  assert.deepEqual([...c.find({})], [0, 1, 2, 3]);
  assert.deepEqual([...c.filter((i) => c.ntConfidence[i] > 55)], [1, 2]);
  assert.equal(c.columns.side.value(0), "right");
  assert.equal(c.columns.type.code("LPLC2"), 2);
  assert.equal(c.columns.type.code("nope"), -1);
  assert.equal(c.indexOf(20000), 2);
  assert.equal(c.indexOf(4294967295), 3);
  assert.equal(c.indexOf(10002), -1);
});

test("an empty connectome round-trips", () => {
  const empty: ConnectomeData = {
    synapses: 0,
    rootId: new Uint32Array(0),
    ptr: new Uint32Array(1),
    post: new Uint32Array(0),
    count: new Uint16Array(0),
    ntConfidence: new Uint8Array(0),
    columns: columns(
      Object.fromEntries(CATEGORY_NAMES.map((name) => [name, []])) as unknown as Record<CategoryName, number[]>,
      Object.fromEntries(CATEGORY_NAMES.map((name) => [name, [""]])) as unknown as Record<CategoryName, string[]>,
    ),
  };
  const c = loadConnectome(copy(writeConnectome(empty)));
  assert.equal(c.neurons, 0);
  assert.equal(c.find({ type: "" }).length, 0);
});

test("wrong magic, version and truncation are rejected clearly", () => {
  const bytes = writeConnectome(sample());
  const bad = bytes.slice();
  bad[0] = 0x58;
  assert.throws(() => loadConnectome(bad.buffer), /expected magic "CBUG"/);
  const future = bytes.slice();
  new DataView(future.buffer).setUint32(4, CONNECTOME_VERSION + 1, true);
  assert.throws(() => loadConnectome(future.buffer), /Unsupported connectome version 2/);
  assert.throws(() => loadConnectome(new ArrayBuffer(5)), /only 5 bytes/);
  const headerLength = new DataView(bytes.buffer).getUint32(8, true);
  assert.throws(() => loadConnectome(bytes.slice(0, 12 + headerLength - 1).buffer), /header runs past the end/);
  // Every cut that removes section data fails, naming a section.
  for (let cut = 12 + headerLength; cut < bytes.length; cut++) {
    const cutTo = cut;
    // Padding after the last section may be cut without losing data.
    if (bytes.subarray(cutTo).every((b) => b === 0) && cutTo >= bytes.length - 7) continue;
    assert.throws(() => loadConnectome(bytes.slice(0, cutTo).buffer), ConnectomeFormatError, `cut at ${cutTo}`);
  }
});

test("corrupt contents are rejected", () => {
  const corrupt = (edit: (data: ConnectomeData) => void) => {
    const data = sample();
    edit(data);
    return () => writeConnectome(data);
  };
  assert.throws(corrupt((d) => (d.post[0] = 9)), /targets neuron 9 of 4/);
  assert.throws(corrupt((d) => (d.post[1] = 1)), /not strictly ascending/);
  assert.throws(corrupt((d) => (d.ptr[2] = 1)), /ptr decreases/);
  assert.throws(corrupt((d) => (d.rootId[1] = 1)), /root IDs are not strictly ascending/);
  assert.throws(corrupt((d) => (d.columns.nt.codes[0] = 3)), /nt code out of range/);
  assert.throws(corrupt((d) => (d.ntConfidence[0] = 101)), /NT confidence above 100/);
  assert.throws(corrupt((d) => (d.count = new Uint16Array(3))), /count has 3 entries, expected 4/);

  const bytes = writeConnectome(sample());
  const headerLength = new DataView(bytes.buffer).getUint32(8, true);
  const garbled = bytes.slice();
  garbled[12] = 0x7b + 1;
  assert.throws(() => loadConnectome(garbled.buffer), /Corrupt connectome header/);
  // A header that points a section past the end.
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  header.sections.count.offset += 1 << 20;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const moved = new Uint8Array(bytes.length + json.length);
  moved.set(bytes.subarray(0, 12));
  new DataView(moved.buffer).setUint32(8, json.length, true);
  moved.set(json, 12);
  assert.throws(() => loadConnectome(moved.buffer), /count section runs past the end/);
});
