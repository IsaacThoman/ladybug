import type { Brain } from "./types.ts";

/** Builds a running brain from a packed connectome. */
export function createBrain(_data: ArrayBuffer, _options: { seed?: number } = {}): Brain {
  throw new Error("The fly brain runtime is not implemented yet.");
}
