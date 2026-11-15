import assert from "node:assert/strict";
import { test } from "node:test";
import { chartEyes } from "./eye-chart.ts";
import { facetEyes, latticeEyes } from "./test-helpers.ts";

test("both eyes fit side by side at one scale, every facet inside its picture", () => {
  const chart = chartEyes(latticeEyes(), 98);
  assert.equal(chart.left.width, 98);
  assert.equal(chart.right.width, 98);
  assert.equal(chart.left.height, chart.right.height);
  assert.ok(chart.left.height > 40 && chart.left.height < 98, `${chart.left.height}`);
  for (const picture of [chart.left, chart.right]) {
    for (let k = 0; k < picture.points.length; k += 2) {
      assert.ok(picture.points[k] >= 0 && picture.points[k] <= picture.width);
      assert.ok(picture.points[k + 1] >= 0 && picture.points[k + 1] <= picture.height);
    }
  }
  assert.ok(chart.dot >= 0.8 && chart.dot <= 2.5);
});

test("as when the bug faces you: what each eye sees out to its side is on the outside, and up is up", () => {
  // Facet 0 looks straight ahead, facet 1 out to the side, facet 2 ahead and up.
  const map = facetEyes([0, 1, 0]);
  map.left.directions = new Float32Array([0, 1, 0, -1, 0, 0, 0, 0.7, 0.7]);
  map.right.directions = new Float32Array([0, 1, 0, 1, 0, 0, 0, 0.7, 0.7]);
  const { left, right } = chartEyes(map, 98);
  // Its left eye, shown on the right of the panel, looks out to the right of the picture.
  assert.ok(left.points[2] > left.points[0]);
  assert.ok(right.points[2] < right.points[0]);
  assert.ok(left.points[5] < left.points[1]);
  assert.ok(right.points[5] < right.points[1]);
});
