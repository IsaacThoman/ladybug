// The eyes: a facet for every column of each optic lobe (eye-columns.ts), the
// way each facet looks out, and the lamina monopolar cells L1, L2 and L3 that
// carry what it sees into the brain. No Node APIs.
//
// Orientation, measured from the data (README, The eyes): in both optic lobes
// v = (hex1 - 18) + (hex2 - 19) grows dorsally (the dorsal rim area columns
// sit at its top end) and h = (hex1 - 18) - (hex2 - 19) grows toward the
// front of the eye (anterior in the lamina; the first optic chiasm reverses it
// in the medulla). So the same hex coordinates in the two eyes look in
// mirror-image directions.
//
// Viewing directions are idealised: no per-column table of measured optical
// axes is published. The columns are laid on a regular hexagonal lattice
// `spacing` degrees apart, hex1 and hex2 being two of its axes 120 degrees
// apart, centred on [18, 19], and the lattice is wrapped onto the sphere
// around the eye's central direction (an azimuthal equidistant map: distance
// and bearing from the centre are kept). Neighbours are `spacing` apart near
// the centre and closer toward the edges, where the map squeezes the lattice
// around the centre (down to 3.3 degrees; median 4.3), and no two facets look
// the same way.

import type { Connectome } from "./format.ts";
import { EYE_COLUMNS } from "./eye-columns.ts";
import type { EyeColumn } from "./eye-columns.ts";
import type { EyeMap } from "./types.ts";

export const EYE_GEOMETRY = {
  /**
   * Degrees between neighbouring facets. Drosophila's interommatidial angle
   * is about 4.5 to 5 degrees (Götz 1964; Heisenberg and Wolf 1984).
   */
  spacing: 5,
  /** The column at the centre of the lattice, [hex1, hex2] (as in the male visual system papers). */
  centre: [18, 19],
  /**
   * Azimuth of the centre column's direction, degrees from straight ahead
   * toward the eye's own side. 68 puts the frontmost facets 8.5 degrees past
   * the midline, so the eyes overlap by about 17 degrees in front (Zhao et
   * al. 2025 measured under 20); the rearmost then look 152 degrees back,
   * leaving a blind zone behind of about 56 degrees (they measured about 50).
   */
  azimuth: 68,
  /** Elevation of the centre column, degrees: the eye's equator looks at the horizon. */
  elevation: 0,
} as const;

/** A facet's cone: the radius of the hexagon each facet covers, spacing / √3 (about 2.9 degrees; Drosophila's acceptance angle is about 5 degrees across). */
export const ACCEPTANCE = ((EYE_GEOMETRY.spacing / Math.sqrt(3)) * Math.PI) / 180;

export type Side = "left" | "right";

/** One eye's columns: per facet, its hex coordinates, kind (COLUMN_KINDS) and the neuron index of its L1, L2 and L3 (-1 when it has none). */
export type EyeCells = {
  hex1: Uint8Array;
  hex2: Uint8Array;
  kind: Uint8Array;
  l1: Int32Array;
  l2: Int32Array;
  l3: Int32Array;
};

export type Eyes = { map: EyeMap; left: EyeCells; right: EyeCells };

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Where the facet at [hex1, hex2] of one eye looks: a unit vector, x toward the fly's right, y ahead, z up. */
export function facetDirection(side: Side, hex1: number, hex2: number): [number, number, number] {
  const { spacing, centre, azimuth, elevation } = EYE_GEOMETRY;
  const q = hex1 - centre[0];
  const p = hex2 - centre[1];
  // On the lattice: forward (toward the front of the eye) and up, in radians.
  const forward = radians(((q - p) * Math.sqrt(3) * spacing) / 2);
  const up = radians(((q + p) * spacing) / 2);
  // The right eye's centre direction, and unit vectors toward the front and up there.
  const a = radians(azimuth);
  const e = radians(elevation);
  const c = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
  const front = [-Math.cos(a), Math.sin(a), 0];
  const top = [-Math.sin(a) * Math.sin(e), -Math.cos(a) * Math.sin(e), Math.cos(e)];
  const r = Math.hypot(forward, up);
  const along = r === 0 ? 0 : Math.sin(r) / r;
  const d = [0, 1, 2].map((k) => Math.cos(r) * c[k] + along * (forward * front[k] + up * top[k]));
  return [side === "right" ? d[0] : -d[0], d[1], d[2]];
}

/**
 * The eyes of this connectome: each column's cells resolved to neuron
 * indices. Null when none of the columns' L1s are in it (a connectome without
 * the optic lobes, or the synthetic one of the tests, unless it is given
 * columns of its own). Throws if a body ID belongs to a neuron of another
 * type or side, which means the table and the connectome don't match.
 */
export function buildEyes(connectome: Connectome, columns: { readonly right: readonly EyeColumn[]; readonly left: readonly EyeColumn[] } = EYE_COLUMNS): Eyes | null {
  const resolve = (side: Side, type: string, id: number) => {
    if (id === 0) return -1;
    const i = connectome.indexOf(id);
    if (i < 0) return -1;
    const found = `${connectome.columns.type.value(i)} ${connectome.columns.side.value(i)}`;
    if (found !== `${type} ${side}`) throw new Error(`Eye column cell ${id} should be ${type} ${side} but is ${found}`);
    return i;
  };
  const eye = (side: Side) => {
    const rows = columns[side];
    const cells: EyeCells = {
      hex1: Uint8Array.from(rows, (row) => row[0]),
      hex2: Uint8Array.from(rows, (row) => row[1]),
      kind: Uint8Array.from(rows, (row) => row[2]),
      l1: Int32Array.from(rows, (row) => resolve(side, "L1", row[3])),
      l2: Int32Array.from(rows, (row) => resolve(side, "L2", row[4])),
      l3: Int32Array.from(rows, (row) => resolve(side, "L3", row[5])),
    };
    const directions = new Float32Array(3 * rows.length);
    rows.forEach((row, k) => directions.set(facetDirection(side, row[0], row[1]), 3 * k));
    return { cells, directions };
  };
  const left = eye("left");
  const right = eye("right");
  if (![...left.cells.l1, ...right.cells.l1].some((i) => i >= 0)) return null;
  return {
    map: { left: { directions: left.directions }, right: { directions: right.directions }, acceptance: ACCEPTANCE },
    left: left.cells,
    right: right.cells,
  };
}
