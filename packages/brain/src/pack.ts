// Turns the Codex CSV export of the FlyEM male CNS into connectome.bin. Node
// only (streams, zlib), so it is not exported from the package index; the CLI
// is scripts/pack.ts.

import { createReadStream } from "node:fs";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { CATEGORY_COLUMNS, CATEGORY_NAMES, writeConnectome } from "./format.ts";
import type { CategoryName, ConnectomeData } from "./format.ts";

export class PackError extends Error {
  override name = "PackError";
}

function fail(message: string): never {
  throw new PackError(message);
}

/** Yields the bytes of `source`, gunzipped if they start with the gzip magic. */
export async function* decompressed(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  while (headBytes < 2) {
    const next = await iterator.next();
    if (next.done) break;
    head.push(next.value);
    headBytes += next.value.length;
  }
  const first = head.length > 0 ? Buffer.concat(head) : new Uint8Array(0);
  async function* all() {
    if (first.length > 0) yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  if (first[0] === 0x1f && first[1] === 0x8b) {
    // pipeline destroys the gunzip stream on any error, so it reaches the loop below.
    const gunzip = pipeline(Readable.from(all()), createGunzip(), () => {});
    for await (const chunk of gunzip) yield chunk as Uint8Array;
  } else {
    yield* all();
  }
}

/** A file's bytes, gunzipped if it is gzip whatever its name. */
export function openInput(path: string): AsyncGenerator<Uint8Array> {
  return decompressed(createReadStream(path));
}

/**
 * Parses RFC 4180-style CSV (quoted fields may hold commas, quotes as "" and
 * newlines), calling `onRow` with each record's fields and its 1-based record
 * number. Blank lines are skipped.
 */
export async function parseCsv(source: AsyncIterable<Uint8Array>, onRow: (fields: string[], row: number) => void) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let fieldStarted = false;
  let pendingQuote = false;
  let row = 0;
  const endRow = () => {
    if (fields.length === 0 && !fieldStarted) return;
    fields.push(field);
    onRow(fields, ++row);
    fields = [];
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };
  const consume = (text: string) => {
    let i = 0;
    while (i < text.length) {
      if (quoted) {
        const close = text.indexOf('"', i);
        if (close < 0) {
          field += text.slice(i);
          return;
        }
        field += text.slice(i, close);
        // A quote at the very end of a chunk may be the first half of "".
        if (close + 1 === text.length) {
          pendingQuote = true;
          quoted = false;
          return;
        }
        if (text[close + 1] === '"') {
          field += '"';
          i = close + 2;
        } else {
          quoted = false;
          afterQuote = true;
          i = close + 1;
        }
        continue;
      }
      const c = text[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') {
          field += '"';
          quoted = true;
          i++;
          continue;
        }
        afterQuote = true;
      }
      if (c === ",") {
        fields.push(field);
        field = "";
        fieldStarted = true;
        afterQuote = false;
      } else if (c === "\n") {
        endRow();
      } else if (c === "\r") {
        if (text[i + 1] !== undefined && text[i + 1] !== "\n") fail(`CSV row ${row + 1}: stray carriage return`);
      } else if (afterQuote) {
        fail(`CSV row ${row + 1}: text after a closing quote`);
      } else if (c === '"') {
        if (field.length > 0) fail(`CSV row ${row + 1}: quote inside an unquoted field`);
        quoted = true;
        fieldStarted = true;
      } else {
        // Copy the rest of the plain run in one go.
        let end = i + 1;
        while (end < text.length) {
          const d = text.charCodeAt(end);
          if (d === 44 || d === 10 || d === 13 || d === 34) break;
          end++;
        }
        field += text.slice(i, end);
        fieldStarted = true;
        i = end;
        continue;
      }
      i++;
    }
  };
  for await (const chunk of source) consume(decoder.decode(chunk, { stream: true }));
  consume(decoder.decode());
  if (quoted) fail(`CSV row ${row + 1}: unterminated quoted field`);
  if (pendingQuote) afterQuote = true;
  endRow();
}

export type NeuronTable = {
  rootId: Uint32Array;
  ntConfidence: Uint8Array;
  columns: Record<CategoryName, { codes: Uint8Array | Uint16Array; table: string[] }>;
};

const MAX_CODES: Record<CategoryName, number> = { superClass: 256, class: 256, subClass: 256, nt: 256, side: 256, nerve: 256, type: 65536 };

/** Reads neurons.csv. Neurons come out sorted by root ID; tables sorted, so blank is code 0. */
export async function readNeurons(source: AsyncIterable<Uint8Array>): Promise<NeuronTable> {
  let width = 0;
  let idColumn = -1;
  let confidenceColumn = -1;
  const categoryColumns = {} as Record<CategoryName, number>;
  const ids: number[] = [];
  const confidence: number[] = [];
  const values = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, [] as string[]])) as Record<CategoryName, string[]>;
  await parseCsv(source, (fields, row) => {
    if (row === 1) {
      width = fields.length;
      const find = (name: string) => {
        const index = fields.indexOf(name);
        if (index < 0) fail(`neurons CSV has no "${name}" column`);
        return index;
      };
      idColumn = find("Root ID");
      confidenceColumn = find("Predicted NT confidence");
      for (const name of CATEGORY_NAMES) categoryColumns[name] = find(CATEGORY_COLUMNS[name]);
      return;
    }
    if (fields.length !== width) fail(`neurons CSV row ${row}: ${fields.length} fields, expected ${width}`);
    const id = fields[idColumn];
    if (!/^\d{1,10}$/.test(id) || Number(id) > 0xffffffff) fail(`neurons CSV row ${row}: bad root ID "${id}"`);
    ids.push(Number(id));
    const c = fields[confidenceColumn];
    if (c === "") confidence.push(0);
    else {
      const x = /^\d+(\.\d+)?$/.test(c) ? Number(c) : NaN;
      if (!(x >= 0 && x <= 1)) fail(`neurons CSV row ${row}: bad NT confidence "${c}"`);
      confidence.push(Math.round(x * 100));
    }
    for (const name of CATEGORY_NAMES) values[name].push(fields[categoryColumns[name]]);
  });
  if (width === 0) fail("neurons CSV is empty");

  const n = ids.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => ids[a] - ids[b]);
  const rootId = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    rootId[k] = ids[order[k]];
    if (k > 0 && rootId[k] === rootId[k - 1]) fail(`neurons CSV: root ID ${rootId[k]} appears twice`);
  }
  const ntConfidence = Uint8Array.from(order, (i) => confidence[i]);
  const columns = {} as NeuronTable["columns"];
  for (const name of CATEGORY_NAMES) {
    const column = values[name];
    const table = [...new Set(column)].sort();
    if (!table.includes("")) table.unshift("");
    if (table.length > MAX_CODES[name]) fail(`neurons CSV: "${CATEGORY_COLUMNS[name]}" has ${table.length} distinct values, more than ${MAX_CODES[name]}`);
    const lookup = new Map(table.map((s, k) => [s, k]));
    const codes = MAX_CODES[name] > 256 ? new Uint16Array(n) : new Uint8Array(n);
    for (let k = 0; k < n; k++) codes[k] = lookup.get(column[order[k]])!;
    columns[name] = { codes, table };
  }
  return { rootId, ntConfidence, columns };
}

/** Index of each root ID in a sorted list. */
function indexer(rootId: Uint32Array) {
  const map = new Map<number, number>();
  rootId.forEach((id, i) => map.set(id, i));
  return map;
}

class Growable {
  data = new Uint32Array(1 << 16);
  length = 0;
  push(x: number) {
    if (this.length === this.data.length) {
      const bigger = new Uint32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = x;
  }
}

export type Connections = { ptr: Uint32Array; post: Uint32Array; count: Uint16Array; rows: number; synapses: number; clamped: number };

const ROLE_SKIP = 0;
const ROLE_PRE = 1;
const ROLE_POST = 2;
const ROLE_COUNT = 3;

/**
 * Reads the connections CSV (unquoted: pre_root_id, post_root_id, neuropil,
 * syn_count, ... in any column order) and builds the CSR arrays, merging each
 * (pre, post) pair across neuropils. Fails on malformed rows and on root IDs
 * that are not in `rootId`.
 */
export async function readConnections(source: AsyncIterable<Uint8Array>, rootId: Uint32Array): Promise<Connections> {
  const n = rootId.length;
  const index = indexer(rootId);
  const pres = new Growable();
  const posts = new Growable();
  const counts = new Growable();

  let headerText = "";
  let inHeader = true;
  let roles = new Uint8Array(0);
  let width = 0;
  // Line numbers, counting the header as line 1.
  let row = 2;
  let column = 0;
  let value = 0;
  let digits = 0;
  let empty = true;
  let carriageReturn = false;
  let pre = -1;
  let postId = -1;
  let syn = -1;
  let synapses = 0;

  const endField = () => {
    if (column >= width) fail(`connections CSV row ${row}: more than ${width} fields`);
    const role = roles[column];
    if (role !== ROLE_SKIP) {
      if (digits === 0) fail(`connections CSV row ${row}: empty number in column ${column + 1}`);
      if (digits > 10 || value > 0xffffffff) fail(`connections CSV row ${row}: number out of range in column ${column + 1}`);
      if (role === ROLE_PRE) pre = value;
      else if (role === ROLE_POST) postId = value;
      else syn = value;
    }
    column++;
    value = 0;
    digits = 0;
  };
  const endRow = () => {
    if (empty && column === 0) return; // blank line
    endField();
    if (column !== width) fail(`connections CSV row ${row}: ${column} fields, expected ${width}`);
    const i = index.get(pre);
    if (i === undefined) fail(`connections CSV row ${row}: unknown presynaptic root ID ${pre}`);
    const j = index.get(postId);
    if (j === undefined) fail(`connections CSV row ${row}: unknown postsynaptic root ID ${postId}`);
    if (syn < 1) fail(`connections CSV row ${row}: synapse count must be at least 1`);
    pres.push(i);
    posts.push(j);
    counts.push(syn);
    synapses += syn;
    column = 0;
    empty = true;
  };
  const startData = (header: string) => {
    const names = header.replace(/\r$/, "").split(",");
    width = names.length;
    roles = new Uint8Array(width);
    const find = (name: string, role: number) => {
      const k = names.indexOf(name);
      if (k < 0) fail(`connections CSV has no "${name}" column`);
      roles[k] = role;
    };
    find("pre_root_id", ROLE_PRE);
    find("post_root_id", ROLE_POST);
    find("syn_count", ROLE_COUNT);
    inHeader = false;
  };

  for await (const chunk of source) {
    let p = 0;
    if (inHeader) {
      const newline = chunk.indexOf(10);
      headerText += Buffer.from(chunk.subarray(0, newline < 0 ? chunk.length : newline)).toString("utf8");
      if (newline < 0) continue;
      startData(headerText);
      p = newline + 1;
    }
    for (const end = chunk.length; p < end; p++) {
      const c = chunk[p];
      if (carriageReturn && c !== 10) fail(`connections CSV row ${row}: stray carriage return`);
      carriageReturn = false;
      if (c === 44) {
        endField();
        empty = false;
      } else if (c === 10) {
        endRow();
        row++;
      } else if (c === 13) {
        carriageReturn = true;
      } else {
        empty = false;
        if (roles[column] !== ROLE_SKIP) {
          const d = c - 48;
          if (d < 0 || d > 9) fail(`connections CSV row ${row}: expected a number in column ${column + 1}`);
          value = value * 10 + d;
          digits++;
        } else if (c === 34) {
          fail(`connections CSV row ${row}: quoted fields are not supported`);
        }
      }
    }
  }
  if (inHeader) fail("connections CSV has no header line");
  endRow();

  // Bucket by pre, then sort and merge each row by post.
  const rows = pres.length;
  const ptr = new Uint32Array(n + 1);
  for (let k = 0; k < rows; k++) ptr[pres.data[k] + 1]++;
  for (let i = 0; i < n; i++) ptr[i + 1] += ptr[i];
  const fill = ptr.slice(0, n);
  // post < 2^32 and count < 2^21 for any realistic row, so post * 2^21 + count
  // is exact in a double and sorts by post.
  const keys = new Float64Array(rows);
  const SHIFT = 2 ** 21;
  for (let k = 0; k < rows; k++) {
    if (counts.data[k] >= SHIFT) fail(`connections CSV: synapse count ${counts.data[k]} is too large`);
    keys[fill[pres.data[k]]++] = posts.data[k] * SHIFT + counts.data[k];
  }
  const post = new Uint32Array(rows);
  const merged = new Float64Array(rows);
  const outPtr = new Uint32Array(n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const row = keys.subarray(ptr[i], ptr[i + 1]).sort();
    for (let k = 0; k < row.length; k++) {
      const target = Math.floor(row[k] / SHIFT);
      const count = row[k] - target * SHIFT;
      if (e > outPtr[i] && post[e - 1] === target) merged[e - 1] += count;
      else {
        post[e] = target;
        merged[e] = count;
        e++;
      }
    }
    outPtr[i + 1] = e;
  }
  const count = new Uint16Array(e);
  let clamped = 0;
  for (let k = 0; k < e; k++) {
    if (merged[k] > 65535) clamped++;
    count[k] = Math.min(65535, merged[k]);
  }
  return { ptr: outPtr, post: post.slice(0, e), count, rows, synapses, clamped };
}

export type PackSummary = { neurons: number; rows: number; connections: number; synapses: number; clamped: number; bytes: number };

/** Packs the two CSVs (plain or gzipped byte streams) into connectome.bin bytes. */
export async function pack(neurons: AsyncIterable<Uint8Array>, connections: AsyncIterable<Uint8Array>): Promise<{ bytes: Uint8Array; summary: PackSummary }> {
  const table = await readNeurons(decompressed(neurons));
  const wiring = await readConnections(decompressed(connections), table.rootId);
  const data: ConnectomeData = {
    synapses: wiring.synapses,
    rootId: table.rootId,
    ptr: wiring.ptr,
    post: wiring.post,
    count: wiring.count,
    ntConfidence: table.ntConfidence,
    columns: table.columns,
  };
  const bytes = writeConnectome(data);
  return {
    bytes,
    summary: {
      neurons: table.rootId.length,
      rows: wiring.rows,
      connections: wiring.post.length,
      synapses: wiring.synapses,
      clamped: wiring.clamped,
      bytes: bytes.length,
    },
  };
}
