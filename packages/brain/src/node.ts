// Loading connectome.bin from disk, for scripts and tests. Node only, so not
// exported from the package index.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConnectome } from "./format.ts";
import type { Connectome } from "./format.ts";

/** Where `npm run brain:pack` writes by default. */
export const DEFAULT_CONNECTOME_PATH = fileURLToPath(new URL("../data/connectome.bin", import.meta.url));

/** Reads a packed connectome into a fresh ArrayBuffer (Node's pooled Buffers may not be 8-byte aligned). */
export function readConnectomeFile(path = DEFAULT_CONNECTOME_PATH): Connectome {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = new ArrayBuffer(size);
    const bytes = new Uint8Array(buffer);
    for (let read = 0; read < size; ) {
      const n = readSync(fd, bytes, read, size - read, read);
      if (n === 0) throw new Error(`${path} shrank while being read`);
      read += n;
    }
    return loadConnectome(buffer);
  } finally {
    closeSync(fd);
  }
}
