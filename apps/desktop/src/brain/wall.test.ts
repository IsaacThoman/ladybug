import assert from "node:assert/strict";
import { test } from "node:test";
import { FLAT_WALL, WALL_CELL, Wall, luminance } from "./wall.ts";

/** An RGBA frame for `wall`, each cell grey at `paint(i, j)` (0 to 255). */
function frame(wall: Wall, paint: (i: number, j: number) => number) {
  const rgba = new Uint8ClampedArray(wall.cols * wall.rows * 4);
  for (let j = 0; j < wall.rows; j++) {
    for (let i = 0; i < wall.cols; i++) rgba.fill(paint(i, j), (j * wall.cols + i) * 4, (j * wall.cols + i) * 4 + 4);
  }
  return rgba;
}

test("the picture is a fraction of the screen's resolution, and starts as the plain wall", () => {
  const wall = new Wall();
  wall.resize(1728, 1117);
  assert.equal(wall.cols, Math.round(1728 / WALL_CELL));
  assert.equal(wall.rows, Math.round(1117 / WALL_CELL));
  assert.ok(Math.abs(wall.integral(0, 0, 1728, 1117) / (1728 * 1117) - FLAT_WALL) < 1e-9);
});

test("brightness is the luma of the screen's colours", () => {
  assert.equal(luminance(0, 0, 0), 0);
  assert.ok(Math.abs(luminance(255, 255, 255) - 1) < 1e-9);
  assert.ok(luminance(0, 255, 0) > luminance(255, 0, 0) && luminance(255, 0, 0) > luminance(0, 0, 255));
});

test("any box of it, cell-aligned or not, averages exactly what's under it", () => {
  const wall = new Wall();
  wall.resize(60, 60); // 10 × 10 cells of 6 px
  // The left half white, the right half black.
  wall.capture(frame(wall, (i) => (i < 5 ? 255 : 0)), []);
  const mean = (x0: number, y0: number, x1: number, y1: number) => wall.integral(x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
  assert.ok(Math.abs(mean(0, 0, 30, 60) - 1) < 1e-9);
  assert.ok(Math.abs(mean(30, 0, 60, 60)) < 1e-9);
  // Straddling the edge a third of the way into a cell either side.
  assert.ok(Math.abs(mean(28, 10, 32, 13.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(mean(25, 0, 32, 1) - 5 / 7) < 1e-9);
});

test("what's under a mask keeps what it showed before", () => {
  const wall = new Wall();
  wall.resize(60, 60);
  wall.capture(frame(wall, () => 255), []);
  wall.capture(frame(wall, () => 0), [{ x: 13, y: 13, width: 10, height: 4 }]);
  // Every cell the mask touches (columns 2 and 3 of row 2) is still white.
  assert.ok(Math.abs(wall.integral(12, 12, 24, 18) / 72 - 1) < 1e-9);
  assert.ok(Math.abs(wall.integral(12, 18, 24, 24)) < 1e-9);
  assert.ok(Math.abs(wall.integral(0, 0, 12, 60)) < 1e-9);
  wall.fill(FLAT_WALL);
  assert.ok(Math.abs(wall.integral(12, 12, 24, 18) / 72 - FLAT_WALL) < 1e-9);
});
