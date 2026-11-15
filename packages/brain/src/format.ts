// The packed connectome, connectome.bin, and the code that reads and writes
// it. No Node APIs here: the desktop pet loads it in a Web Worker.
//
// Layout, all little-endian:
//
//   "CBUG"           4 bytes
//   version          u32
//   header length    u32, in bytes
//   header           UTF-8 JSON (ConnectomeHeader)
//   padding          zeros, to an 8-byte boundary
//   sections         each at its header offset (relative to the end of the
//                    padding, a multiple of 8), as typed arrays
//
// Neurons are numbered 0..N-1 in ascending root ID order. Connections are in
// CSR form by presynaptic neuron: the targets of neuron i are
// post[ptr[i]..ptr[i+1]], ascending, with count[k] synapses each (all
// neuropils merged, clamped to 65535). Categorical columns are indices into the
// header's string tables; blank is the empty string, a normal entry.

export const CONNECTOME_MAGIC = "CBUG";
export const CONNECTOME_VERSION = 1;

export const FLYEM_MALE_CNS: ConnectomeSource = {
  dataset: "FlyEM male CNS",
  license: "CC-BY 4.0",
  url: "https://male-cns.janelia.org/",
};

/** The categorical per-neuron columns, and the CSV column each comes from. */
export const CATEGORY_COLUMNS = {
  superClass: "Super Class",
  class: "Class",
  subClass: "Sub Class",
  nt: "Predicted NT type",
  side: "Soma side",
  nerve: "Nerve",
  type: "Primary Cell Type",
} as const;

export type CategoryName = keyof typeof CATEGORY_COLUMNS;
export const CATEGORY_NAMES = Object.keys(CATEGORY_COLUMNS) as CategoryName[];

type ElementType = "u8" | "u16" | "u32";
type SectionName = "rootId" | "ptr" | "post" | "count" | CategoryName | "ntConfidence";

// Section order in the file, element type, and length in terms of N and E.
const SECTIONS: readonly [SectionName, ElementType, "N" | "N+1" | "E"][] = [
  ["rootId", "u32", "N"],
  ["ptr", "u32", "N+1"],
  ["post", "u32", "E"],
  ["count", "u16", "E"],
  ["superClass", "u8", "N"],
  ["class", "u8", "N"],
  ["subClass", "u8", "N"],
  ["nt", "u8", "N"],
  ["side", "u8", "N"],
  ["nerve", "u8", "N"],
  ["type", "u16", "N"],
  ["ntConfidence", "u8", "N"],
];

const BYTES: Record<ElementType, number> = { u8: 1, u16: 2, u32: 4 };

export type ConnectomeSource = { dataset: string; license: string; url: string };

export type SectionInfo = { type: ElementType; offset: number; length: number };

export type ConnectomeHeader = {
  neurons: number;
  /** Connected (pre, post) pairs. */
  connections: number;
  /** Synapses before clamping counts to u16. */
  synapses: number;
  source: ConnectomeSource;
  sections: Record<SectionName, SectionInfo>;
  tables: Record<CategoryName, string[]>;
};

type Codes = Uint8Array | Uint16Array;

/** Everything the writer needs. Category codes index into their tables. */
export type ConnectomeData = {
  source?: ConnectomeSource;
  synapses: number;
  rootId: Uint32Array;
  ptr: Uint32Array;
  post: Uint32Array;
  count: Uint16Array;
  ntConfidence: Uint8Array;
  columns: Record<CategoryName, { codes: Codes; table: readonly string[] }>;
};

export type CategoryColumn = {
  readonly codes: Codes;
  readonly table: readonly string[];
  /** The string value for neuron i. */
  value(i: number): string;
  /** The code for a string value, or -1 if no neuron has it. */
  code(value: string): number;
};

/** One condition per column; a neuron matches when it meets all of them. */
export type NeuronQuery = {
  [K in CategoryName]?: string | readonly string[] | RegExp | ((value: string) => boolean);
};

export type Connectome = {
  readonly neurons: number;
  readonly connections: number;
  readonly synapses: number;
  readonly source: ConnectomeSource;
  readonly rootId: Uint32Array;
  readonly ptr: Uint32Array;
  readonly post: Uint32Array;
  readonly count: Uint16Array;
  /** Predicted NT confidence, 0-100 (0 when blank). */
  readonly ntConfidence: Uint8Array;
  readonly columns: { readonly [K in CategoryName]: CategoryColumn };
  /** The neuron index for a root ID, or -1. */
  indexOf(rootId: number): number;
  /** Indices, ascending, of the neurons matching every condition. */
  find(query: NeuronQuery): Uint32Array;
  /** Indices, ascending, of the neurons for which `predicate` is true. */
  filter(predicate: (i: number) => boolean): Uint32Array;
};

export class ConnectomeFormatError extends Error {
  override name = "ConnectomeFormatError";
}

function fail(message: string): never {
  throw new ConnectomeFormatError(message);
}

const align8 = (n: number) => (n + 7) & ~7;

/** Serialises a connectome. The output depends only on `data`. */
export function writeConnectome(data: ConnectomeData): Uint8Array {
  const n = data.rootId.length;
  const e = data.post.length;
  const arrays: Record<SectionName, Uint8Array | Uint16Array | Uint32Array> = {
    rootId: data.rootId,
    ptr: data.ptr,
    post: data.post,
    count: data.count,
    ntConfidence: data.ntConfidence,
    ...(Object.fromEntries(CATEGORY_NAMES.map((name) => [name, data.columns[name].codes])) as Record<CategoryName, Codes>),
  };
  const sections = {} as Record<SectionName, SectionInfo>;
  let offset = 0;
  for (const [name, type, size] of SECTIONS) {
    const array = arrays[name];
    const length = size === "N" ? n : size === "N+1" ? n + 1 : e;
    if (array.BYTES_PER_ELEMENT !== BYTES[type]) fail(`${name} must be a ${type} array`);
    if (array.length !== length) fail(`${name} has ${array.length} entries, expected ${length}`);
    sections[name] = { type, offset, length };
    offset = align8(offset + length * BYTES[type]);
  }
  const header: ConnectomeHeader = {
    neurons: n,
    connections: e,
    synapses: data.synapses,
    source: data.source ?? FLYEM_MALE_CNS,
    sections,
    tables: Object.fromEntries(CATEGORY_NAMES.map((name) => [name, [...data.columns[name].table]])) as Record<CategoryName, string[]>,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align8(12 + json.length);
  const out = new Uint8Array(dataStart + offset);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(CONNECTOME_MAGIC), 0);
  view.setUint32(4, CONNECTOME_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  for (const [name] of SECTIONS) {
    const array = arrays[name];
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), dataStart + sections[name].offset);
  }
  if (!littleEndian()) fail("Writing connectomes needs a little-endian machine");
  // Validates what was just written, so a bad writer input never reaches disk.
  loadConnectome(out.buffer);
  return out;
}

function littleEndian() {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/**
 * Reads a packed connectome. The arrays are views into `buffer`, not copies.
 * Throws ConnectomeFormatError on anything malformed, so the simulation can
 * index with the data without further checks.
 */
export function loadConnectome(buffer: ArrayBuffer): Connectome {
  if (!littleEndian()) fail("Connectomes can only be loaded on a little-endian machine");
  if (buffer.byteLength < 12) fail(`Not a connectome: only ${buffer.byteLength} bytes`);
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== CONNECTOME_MAGIC) fail(`Not a connectome: expected magic "${CONNECTOME_MAGIC}"`);
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== CONNECTOME_VERSION) fail(`Unsupported connectome version ${version} (expected ${CONNECTOME_VERSION})`);
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > buffer.byteLength) fail("Truncated connectome: the header runs past the end of the file");

  let header: ConnectomeHeader;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + headerLength)));
  } catch (error) {
    fail(`Corrupt connectome header: ${(error as Error).message}`);
  }
  if (typeof header !== "object" || header === null) fail("Corrupt connectome header");
  const n = header.neurons;
  const e = header.connections;
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(e) || e < 0) fail("Corrupt connectome header: bad counts");
  if (!Number.isSafeInteger(header.synapses) || header.synapses < 0) fail("Corrupt connectome header: bad synapse count");
  const source = header.source;
  if (typeof source?.dataset !== "string" || typeof source.license !== "string" || typeof source.url !== "string") {
    fail("Corrupt connectome header: missing source");
  }

  const dataStart = align8(12 + headerLength);
  const arrays = {} as Record<SectionName, Uint8Array | Uint16Array | Uint32Array>;
  for (const [name, type, size] of SECTIONS) {
    const info = header.sections?.[name];
    if (!info) fail(`Corrupt connectome header: no ${name} section`);
    const length = size === "N" ? n : size === "N+1" ? n + 1 : e;
    if (info.type !== type) fail(`Corrupt connectome: ${name} is ${info.type}, expected ${type}`);
    if (info.length !== length) fail(`Corrupt connectome: ${name} has ${info.length} entries, expected ${length}`);
    if (!Number.isSafeInteger(info.offset) || info.offset < 0 || info.offset % 8 !== 0) fail(`Corrupt connectome: bad ${name} offset`);
    const start = dataStart + info.offset;
    if (start + length * BYTES[type] > buffer.byteLength) fail(`Truncated connectome: the ${name} section runs past the end of the file`);
    arrays[name] =
      type === "u8" ? new Uint8Array(buffer, start, length) : type === "u16" ? new Uint16Array(buffer, start, length) : new Uint32Array(buffer, start, length);
  }

  const rootId = arrays.rootId as Uint32Array;
  const ptr = arrays.ptr as Uint32Array;
  const post = arrays.post as Uint32Array;
  for (let i = 1; i < n; i++) if (rootId[i] <= rootId[i - 1]) fail("Corrupt connectome: root IDs are not strictly ascending");
  if (ptr[0] !== 0 || ptr[n] !== e) fail("Corrupt connectome: ptr does not span the connections");
  for (let i = 0; i < n; i++) {
    const start = ptr[i];
    const end = ptr[i + 1];
    if (end < start) fail(`Corrupt connectome: ptr decreases at neuron ${i}`);
    let previous = -1;
    for (let k = start; k < end; k++) {
      const j = post[k];
      if (j >= n) fail(`Corrupt connectome: connection ${k} targets neuron ${j} of ${n}`);
      if (j <= previous) fail(`Corrupt connectome: targets of neuron ${i} are not strictly ascending`);
      previous = j;
    }
  }
  const ntConfidence = arrays.ntConfidence as Uint8Array;
  for (let i = 0; i < n; i++) if (ntConfidence[i] > 100) fail("Corrupt connectome: NT confidence above 100");

  const columns = {} as Record<CategoryName, CategoryColumn>;
  for (const name of CATEGORY_NAMES) {
    const table = header.tables?.[name];
    if (!Array.isArray(table) || !table.every((s) => typeof s === "string")) fail(`Corrupt connectome header: no ${name} table`);
    const codes = arrays[name] as Codes;
    for (let i = 0; i < n; i++) if (codes[i] >= table.length) fail(`Corrupt connectome: ${name} code out of range`);
    columns[name] = categoryColumn(codes, table);
  }

  const filter = (predicate: (i: number) => boolean) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (predicate(i)) out.push(i);
    return Uint32Array.from(out);
  };

  return {
    neurons: n,
    connections: e,
    synapses: header.synapses,
    source: { dataset: source.dataset, license: source.license, url: source.url },
    rootId,
    ptr,
    post,
    count: arrays.count as Uint16Array,
    ntConfidence,
    columns,
    indexOf(id) {
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const at = rootId[mid];
        if (at === id) return mid;
        if (at < id) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
    find(query) {
      // Each condition is resolved once per table entry, then neurons are
      // matched by code.
      const masks: [Codes, Uint8Array][] = [];
      for (const name of CATEGORY_NAMES) {
        const condition = query[name];
        if (condition === undefined) continue;
        const { codes, table } = columns[name];
        const test =
          typeof condition === "string"
            ? (s: string) => s === condition
            : condition instanceof RegExp
              ? (s: string) => s.search(condition) >= 0
              : typeof condition === "function"
                ? condition
                : (s: string) => condition.includes(s);
        masks.push([codes, Uint8Array.from(table, (s) => (test(s) ? 1 : 0))]);
      }
      return filter((i) => masks.every(([codes, mask]) => mask[codes[i]] === 1));
    },
    filter,
  };
}

function categoryColumn(codes: Codes, table: readonly string[]): CategoryColumn {
  let lookup: Map<string, number> | undefined;
  return {
    codes,
    table,
    value: (i) => table[codes[i]],
    code(value) {
      lookup ??= new Map(table.map((s, k) => [s, k]));
      return lookup.get(value) ?? -1;
    },
  };
}
