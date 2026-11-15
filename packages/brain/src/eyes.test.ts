// The eye map: the shipped column table, the idealised viewing directions,
// and resolving the table against a connectome (the real one when it is
// there).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { COLUMN_KINDS, EYE_COLUMNS } from "./eye-columns.ts";
import { ACCEPTANCE, EYE_GEOMETRY, buildEyes, facetDirection } from "./eyes.ts";
import { loadConnectome } from "./format.ts";
import { DEFAULT_CONNECTOME_PATH, readConnectomeFile } from "./node.ts";
import { bufferOf, syntheticConnectome, syntheticEyeColumns } from "./test-helpers.ts";

const skip = existsSync(DEFAULT_CONNECTOME_PATH) ? false : `no ${DEFAULT_CONNECTOME_PATH}; run npm run brain:pack`;
const degrees = (r: number) => (r * 180) / Math.PI;
const angle = (a: readonly number[], b: readonly number[]) => degrees(Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const SIDES = ["left", "right"] as const;

test("the column table has every column once, in order, with distinct cells", () => {
  assert.equal(EYE_COLUMNS.right.length, 892);
  assert.equal(EYE_COLUMNS.left.length, 880);
  for (const side of SIDES) {
    const rows = EYE_COLUMNS[side];
    for (let k = 1; k < rows.length; k++) assert.ok(rows[k][0] > rows[k - 1][0] || (rows[k][0] === rows[k - 1][0] && rows[k][1] > rows[k - 1][1]), `${side} row ${k} out of order`);
    for (const row of rows) assert.ok(row[2] >= 0 && row[2] < COLUMN_KINDS.length);
    const ids = rows.flatMap((row) => row.slice(3).filter((id) => id !== 0));
    assert.equal(new Set(ids).size, ids.length, `${side}: a cell is in two columns`);
  }
  // The male CNS paper's table has an L1 for every right column and all but 8 left ones.
  assert.equal(EYE_COLUMNS.right.filter((row) => row[3] !== 0).length, 892);
  assert.equal(EYE_COLUMNS.left.filter((row) => row[3] !== 0).length, 872);
});

test("facets look out on an idealised lattice: unit vectors, about 5 degrees apart, none alike", () => {
  for (const side of SIDES) {
    const d = EYE_COLUMNS[side].map((row) => facetDirection(side, row[0], row[1]));
    let nearest = Infinity;
    for (let i = 0; i < d.length; i++) {
      assert.ok(Math.abs(Math.hypot(...d[i]) - 1) < 1e-12);
      for (let j = i + 1; j < d.length; j++) nearest = Math.min(nearest, angle(d[i], d[j]));
    }
    assert.ok(nearest > 3, `${side}: two facets ${nearest.toFixed(2)} degrees apart`);
  }
  // Neighbours of the centre column, along the lattice's three axes, are `spacing` apart.
  const [q, p] = EYE_GEOMETRY.centre;
  const centre = facetDirection("right", q, p);
  for (const [dq, dp] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 0],
  ]) {
    assert.ok(Math.abs(angle(centre, facetDirection("right", q + dq, p + dp)) - EYE_GEOMETRY.spacing) < 1e-9);
  }
  assert.ok(Math.abs(degrees(ACCEPTANCE) - EYE_GEOMETRY.spacing / Math.sqrt(3)) < 1e-12);
});

test("the eyes mirror each other, look a little past the midline in front, and the dorsal rim looks up", () => {
  for (const row of EYE_COLUMNS.right.slice(0, 50)) {
    const [x, y, z] = facetDirection("right", row[0], row[1]);
    assert.deepEqual(facetDirection("left", row[0], row[1]), [-x, y, z]);
  }
  for (const side of SIDES) {
    const sign = side === "right" ? 1 : -1;
    const rows = EYE_COLUMNS[side];
    const azimuth = rows.map((row) => {
      const [x, y] = facetDirection(side, row[0], row[1]);
      return sign * degrees(Math.atan2(x, y));
    });
    // Each eye reaches 5 to 15 degrees into the other's side in front, and well behind.
    assert.ok(Math.min(...azimuth) < -5 && Math.min(...azimuth) > -15, `${side}: frontmost ${Math.min(...azimuth)}`);
    assert.ok(Math.max(...azimuth) > 130);
    // h grows toward the front: the column with the largest h looks further forward than the smallest.
    const h = rows.map((row) => row[0] - row[1]);
    assert.ok(azimuth[h.indexOf(Math.max(...h))] < azimuth[h.indexOf(Math.min(...h))]);
    const rim = rows.filter((row) => COLUMN_KINDS[row[2]] === "DRA").map((row) => degrees(Math.asin(facetDirection(side, row[0], row[1])[2])));
    assert.ok(rim.length >= 40);
    assert.ok(rim.reduce((a, b) => a + b, 0) / rim.length > 45, `${side}: the dorsal rim looks too low`);
  }
});

test("a connectome without the lamina has no eyes; given columns, it has, and a mismatched cell is refused", () => {
  const synthetic = syntheticConnectome();
  const connectome = loadConnectome(bufferOf(synthetic.bytes));
  assert.equal(buildEyes(connectome), null);
  const columns = syntheticEyeColumns(synthetic);
  const eyes = buildEyes(connectome, columns)!;
  assert.equal(eyes.map.right.directions.length, 12);
  assert.deepEqual([...eyes.right.l2], synthetic.index["L2 right"]);
  assert.equal(eyes.left.l3[3], -1);
  const wrong = { ...columns, right: columns.right.map((row, k) => (k === 0 ? ([row[0], row[1], row[2], row[4], row[4], row[5]] as const) : row)) };
  assert.throws(() => buildEyes(connectome, wrong), /should be L1 right but is L2 right/);
});

test("on the real connectome every column's cells resolve to its side's L1, L2 and L3", { skip }, () => {
  const eyes = buildEyes(readConnectomeFile())!;
  const count = (list: Int32Array) => list.filter((i) => i >= 0).length;
  assert.deepEqual(
    SIDES.map((side) => [count(eyes[side].l1), count(eyes[side].l2), count(eyes[side].l3)]),
    [
      [872, 862, 865],
      [892, 883, 885],
    ],
  );
});
