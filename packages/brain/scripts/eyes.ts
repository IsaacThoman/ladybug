// Builds src/eye-columns.ts, the columns of both eyes and their lamina
// monopolar cells, from the male CNS paper's column table and the connectome:
//
//   node packages/brain/scripts/eyes.ts --columns optic-column-type-assignments-v1.0.xlsx [--check ME_assigned_columns.csv] [--path connectome.bin]
//
// --columns is the supplemental table of the male CNS paper
// (github.com/flyconnectome/2025malecns, optic-column-type-assignments-v1.0.xlsx):
// every column of each optic lobe with its hex coordinates, its L1 and its
// column type. L2 and L3 are not in it. Each L2 and L3 is given the column of
// the L1 it shares most synaptic partners with (cosine similarity of their
// input and output synapse counts, partner by partner), one per column, and
// only when the best L1 is clearly ahead of the second (README, The eyes).
//
// --check takes a published column assignment of the right optic lobe
// (bodyId,neuron_type,assigned_hex1,assigned_hex2, as in reiserlab's
// male-drosophila-visual-system-connectome-code results/exchange/) and reports
// how many of our L2 and L3 assignments agree with it. Nothing from it is
// written out.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";
import type { Connectome } from "../src/format.ts";
import { COLUMN_KINDS } from "../src/eye-columns.ts";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "../src/node.ts";

const { values } = parseArgs({
  options: {
    columns: { type: "string" },
    check: { type: "string" },
    path: { type: "string", default: DEFAULT_CONNECTOME_PATH },
    out: { type: "string", default: resolve(import.meta.dirname, "../src/eye-columns.ts") },
  },
});
if (!values.columns) {
  console.error("usage: node packages/brain/scripts/eyes.ts --columns <optic-column-type-assignments-v1.0.xlsx> [--check <csv>] [--path <connectome.bin>]");
  process.exit(2);
}

/** The best L1 must beat the second best by this factor, or the cell is left out. */
const MARGIN = 0.6;

// The few parts of the xlsx format this table needs: the zip's central
// directory, deflated or stored entries, shared strings and plain cells.
function readXlsx(path: string): Map<string, string[][]> {
  const zip = readFileSync(path);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${path} is not a zip file`);
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let k = 0, n = zip.readUInt16LE(end + 10); k < n; k++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    at += 46 + skip;
  }
  const text = (name: string) => {
    const file = files.get(name);
    if (!file) throw new Error(`${path} has no ${name}`);
    return file.toString("utf8");
  };
  const unescape = (s: string) =>
    s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]!);
  const strings = [...text("xl/sharedStrings.xml").matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join("")),
  );
  const targets = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = new Map<string, string[][]>();
  for (const m of text("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const rows: string[][] = [];
    for (const row of text(`xl/${targets.get(m[2])}`).matchAll(/<row [^>]*>(.*?)<\/row>/gs)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const column = [...cell[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const value = /<v>(.*?)<\/v>/s.exec(cell[3] ?? "")?.[1] ?? "";
        cells[column] = /t="s"/.test(cell[2]) ? strings[Number(value)] : unescape(value);
      }
      rows.push(Array.from(cells, (each) => each ?? ""));
    }
    sheets.set(unescape(m[1]), rows);
  }
  return sheets;
}

type Column = { hex1: number; hex2: number; kind: number; l1: number; l2: number; l3: number };

/** Each neuron's input partners, as CSR (the packed file has outputs only). */
function inputs(c: Connectome) {
  const ptr = new Uint32Array(c.neurons + 1);
  for (let e = 0; e < c.post.length; e++) ptr[c.post[e] + 1]++;
  for (let i = 0; i < c.neurons; i++) ptr[i + 1] += ptr[i];
  const pre = new Uint32Array(c.post.length);
  const count = new Uint16Array(c.post.length);
  const fill = ptr.slice(0, c.neurons);
  for (let i = 0; i < c.neurons; i++) {
    for (let e = c.ptr[i]; e < c.ptr[i + 1]; e++) {
      const k = fill[c.post[e]]++;
      pre[k] = i;
      count[k] = c.count[e];
    }
  }
  return { ptr, pre, count };
}

/** A neuron's partners as keys (an output partner j is j, an input partner is -1 - j) and synapse counts. */
function partners(c: Connectome, back: ReturnType<typeof inputs>, i: number): [number, number][] {
  const out: [number, number][] = [];
  for (let e = c.ptr[i]; e < c.ptr[i + 1]; e++) out.push([c.post[e], c.count[e]]);
  for (let e = back.ptr[i]; e < back.ptr[i + 1]; e++) out.push([-1 - back.pre[e], back.count[e]]);
  return out;
}

/**
 * Gives each cell of `type` on `side` the L1 it is most similar to, one cell
 * per L1, when the best L1 is ahead of the second by MARGIN. Returns L1 ->
 * cell, both as neuron indices.
 */
function assign(c: Connectome, back: ReturnType<typeof inputs>, l1s: number[], type: string, side: string): Map<number, number> {
  const byPartner = new Map<number, [number, number][]>();
  const norm = new Map<number, number>();
  for (const l1 of l1s) {
    let sum = 0;
    for (const [key, n] of partners(c, back, l1)) {
      let list = byPartner.get(key);
      if (!list) byPartner.set(key, (list = []));
      list.push([l1, n]);
      sum += n * n;
    }
    norm.set(l1, Math.sqrt(sum));
  }
  const candidates: { cell: number; l1: number; similarity: number }[] = [];
  for (const cell of c.find({ type, side })) {
    const dot = new Map<number, number>();
    let sum = 0;
    for (const [key, n] of partners(c, back, cell)) {
      sum += n * n;
      for (const [l1, m] of byPartner.get(key) ?? []) dot.set(l1, (dot.get(l1) ?? 0) + n * m);
    }
    let best = -1;
    let first = 0;
    let second = 0;
    for (const [l1, d] of dot) {
      const similarity = d / Math.sqrt(sum) / norm.get(l1)!;
      if (similarity > first) {
        second = first;
        first = similarity;
        best = l1;
      } else if (similarity > second) second = similarity;
    }
    if (best >= 0 && second <= MARGIN * first) candidates.push({ cell, l1: best, similarity: first });
  }
  // Most similar first; a cell whose L1 is already taken gets none.
  candidates.sort((a, b) => b.similarity - a.similarity || a.cell - b.cell);
  const out = new Map<number, number>();
  for (const { cell, l1 } of candidates) if (!out.has(l1)) out.set(l1, cell);
  return out;
}

const connectome = readConnectomeFile(values.path);
const back = inputs(connectome);
const sheets = readXlsx(values.columns);
const result: Record<"left" | "right", Column[]> = { left: [], right: [] };
const lines: string[] = [];
for (const side of ["right", "left"] as const) {
  const sheetName = side === "right" ? "Right OL" : "Left OL";
  const rows = sheets.get(sheetName);
  if (!rows) throw new Error(`${values.columns} has no sheet "${sheetName}"`);
  const header = rows[0];
  const col = (name: string) => {
    const k = header.indexOf(name);
    if (k < 0) throw new Error(`"${sheetName}" has no column "${name}"`);
    return k;
  };
  const [cName, cL1, cKind] = [col("column"), col("L1"), col("column_type")];
  const columns: (Column & { l1Index: number })[] = [];
  for (const row of rows.slice(1)) {
    const m = /^ME_[LR]_col_(\d+)_(\d+)$/.exec(row[cName]);
    if (!m) throw new Error(`"${sheetName}": unexpected column name "${row[cName]}"`);
    const kind = COLUMN_KINDS.indexOf(row[cKind] as (typeof COLUMN_KINDS)[number]);
    if (kind < 0) throw new Error(`"${sheetName}": unknown column type "${row[cKind]}"`);
    const id = Number(row[cL1]);
    let l1Index = -1;
    if (id !== -99) {
      l1Index = connectome.indexOf(id);
      if (l1Index < 0) throw new Error(`L1 ${id} of ${row[cName]} is not in the connectome`);
      const found = `${connectome.columns.type.value(l1Index)} ${connectome.columns.side.value(l1Index)}`;
      if (found !== `L1 ${side}`) throw new Error(`${id} of ${row[cName]} is ${found}, not L1 ${side}`);
    }
    columns.push({ hex1: Number(m[1]), hex2: Number(m[2]), kind, l1: id === -99 ? 0 : id, l2: 0, l3: 0, l1Index });
  }
  columns.sort((a, b) => a.hex1 - b.hex1 || a.hex2 - b.hex2);
  const l1s = columns.filter((each) => each.l1Index >= 0).map((each) => each.l1Index);
  const l2 = assign(connectome, back, l1s, "L2", side);
  const l3 = assign(connectome, back, l1s, "L3", side);
  for (const each of columns) {
    each.l2 = l2.has(each.l1Index) ? connectome.rootId[l2.get(each.l1Index)!] : 0;
    each.l3 = l3.has(each.l1Index) ? connectome.rootId[l3.get(each.l1Index)!] : 0;
  }
  result[side] = columns.map(({ hex1, hex2, kind, l1, l2, l3 }) => ({ hex1, hex2, kind, l1, l2, l3 }));
  const count = (type: string) => connectome.find({ type, side }).length;
  lines.push(
    `${side}: ${columns.length} columns, ${l1s.length} with an L1; L2 assigned to ${l2.size} (of ${count("L2")}), L3 to ${l3.size} (of ${count("L3")})`,
  );
}
for (const line of lines) console.log(line);

if (values.check) {
  const published = new Map<number, string>();
  for (const line of readFileSync(values.check, "utf8").trim().split("\n").slice(1)) {
    const [id, , hex1, hex2] = line.split(",");
    published.set(Number(id), `${Number(hex1)},${Number(hex2)}`);
  }
  for (const type of ["L1", "L2", "L3"] as const) {
    const key = type.toLowerCase() as "l1" | "l2" | "l3";
    let agree = 0;
    let assigned = 0;
    const wrong: string[] = [];
    for (const each of result.right) {
      if (!each[key]) continue;
      assigned++;
      const want = published.get(each[key]);
      if (want === `${each.hex1},${each.hex2}`) agree++;
      else wrong.push(`${each[key]} at ${each.hex1},${each.hex2} (published ${want ?? "none"})`);
    }
    const total = [...connectome.find({ type, side: "right" })].filter((i) => published.has(connectome.rootId[i])).length;
    console.log(`check, right ${type}: ${assigned} assigned, ${agree} agree with the published column (${((100 * agree) / assigned).toFixed(1)}%); ${total} have a published column${wrong.length ? `; disagree: ${wrong.join("; ")}` : ""}`);
  }
}

const rows = (columns: Column[]) => columns.map((each) => `    [${each.hex1}, ${each.hex2}, ${each.kind}, ${each.l1}, ${each.l2}, ${each.l3}],`).join("\n");
const source = readFileSync(values.out, "utf8");
const marker = "// Generated by scripts/eyes.ts; everything below is data.\n";
const at = source.indexOf(marker);
if (at < 0) throw new Error(`${values.out} has no "${marker.trim()}" line`);
writeFileSync(
  values.out,
  `${source.slice(0, at + marker.length)}export const EYE_COLUMNS: { readonly right: readonly EyeColumn[]; readonly left: readonly EyeColumn[] } = {\n  right: [\n${rows(result.right)}\n  ],\n  left: [\n${rows(result.left)}\n  ],\n};\n`,
);
console.log(`wrote ${values.out}`);
