import assert from "node:assert/strict";
import { test } from "node:test";
import { DROP_AWAY, FOOD_SIZE, MOUTH_REACH, TASTE_HEIGHT, TASTE_RANGE, dropFood, eatingSpot, stepFood, stepToward, throwFood, touchesFood } from "./food.ts";
import type { Food, FoodBounds } from "./food.ts";

const BOUNDS: FoodBounds = { minX: 0, maxX: 1000, minY: 0, groundY: 600 };
const berry = (values: Partial<Food> = {}): Food => ({ x: 500, y: 600, vx: 0, vy: 0, mode: "resting", left: 1, biteFrom: -1, ...values });
const centre = (food: Food) => food.x + FOOD_SIZE / 2;

/** Lets a berry fall for up to `seconds`, a frame at a time. */
function settle(food: Food, seconds = 5) {
  for (let t = 0; t < seconds && food.mode === "airborne"; t += 1 / 60) stepFood(food, 1 / 60, BOUNDS);
  return food;
}

test("a new berry pops out on the side the bug faces, falls and comes to rest on the ground", () => {
  const food = dropFood({ centreX: 400, y: 540, heading: 1 }, BOUNDS);
  assert.equal(centre(food), 400 + DROP_AWAY);
  assert.equal(food.mode, "airborne");
  assert.equal(food.left, 1);
  settle(food);
  assert.equal(food.mode, "resting");
  assert.equal(food.y, BOUNDS.groundY);
  assert.equal(food.vx, 0);

  assert.equal(centre(dropFood({ centreX: 400, y: 540, heading: -1 }, BOUNDS)), 400 - DROP_AWAY);
});

test("a berry dropped by a bug facing an edge lands on its other side", () => {
  assert.equal(centre(dropFood({ centreX: 980, y: 540, heading: 1 }, BOUNDS)), 980 - DROP_AWAY);
  assert.equal(centre(dropFood({ centreX: 60, y: 540, heading: -1 }, BOUNDS)), 60 + DROP_AWAY);
  // Nowhere to put it on either side: as near as it fits.
  const tight = dropFood({ centreX: 50, y: 540, heading: 1 }, { ...BOUNDS, maxX: 80 });
  assert.equal(tight.x, 80);
});

test("a thrown berry bounces off the edges and stays inside them", () => {
  const food = berry({ x: 900, y: 300, vx: 9000, vy: -9000, mode: "dragging" });
  throwFood(food);
  assert.equal(food.mode, "airborne");
  assert.ok(Math.abs(food.vx) <= 2500 && Math.abs(food.vy) <= 2500);
  for (let t = 0; t < 10 && food.mode === "airborne"; t += 1 / 60) {
    stepFood(food, 1 / 60, BOUNDS);
    assert.ok(food.x >= BOUNDS.minX && food.x <= BOUNDS.maxX && food.y >= BOUNDS.minY && food.y <= BOUNDS.groundY);
  }
  assert.equal(food.mode, "resting");
});

test("a held berry stays where it's put, inside the bounds; a resting one falls if the ground drops", () => {
  const held = berry({ x: -50, y: 2000, mode: "dragging" });
  stepFood(held, 1 / 60, BOUNDS);
  assert.deepEqual([held.x, held.y, held.mode], [0, 600, "dragging"]);

  const resting = berry();
  stepFood(resting, 1 / 60, { ...BOUNDS, groundY: 700 });
  assert.equal(resting.mode, "airborne");
  // A ground that rises carries it up.
  const lifted = berry();
  stepFood(lifted, 1 / 60, { ...BOUNDS, groundY: 500 });
  assert.deepEqual([lifted.y, lifted.mode], [500, "resting"]);
});

test("the bug tastes a berry at its feet or its mouth, on or near the ground", () => {
  const food = berry();
  assert.ok(touchesFood(centre(food), food, BOUNDS));
  assert.ok(touchesFood(centre(food) - TASTE_RANGE, food, BOUNDS));
  assert.ok(!touchesFood(centre(food) - TASTE_RANGE - 1, food, BOUNDS));
  assert.ok(touchesFood(centre(food), berry({ y: 600 - TASTE_HEIGHT, mode: "dragging" }), BOUNDS));
  assert.ok(!touchesFood(centre(food), berry({ y: 600 - TASTE_HEIGHT - 1, mode: "dragging" }), BOUNDS));
});

test("it stands facing the berry, a mouth's reach away", () => {
  // Ahead on the right: walk up to it.
  assert.deepEqual(eatingSpot({ centreX: 300, heading: -1 }, 500, 50, 950), { dx: 200 - MOUTH_REACH, heading: 1 });
  // On the left: turn to it.
  assert.deepEqual(eatingSpot({ centreX: 700, heading: 1 }, 500, 50, 950), { dx: -200 + MOUTH_REACH, heading: -1 });
  // Just ahead, under its feet: back up until it's at its mouth.
  assert.deepEqual(eatingSpot({ centreX: 490, heading: 1 }, 500, 50, 950), { dx: 10 - MOUTH_REACH, heading: 1 });
  // Dead centre: it keeps facing the way it was.
  assert.deepEqual(eatingSpot({ centreX: 500, heading: -1 }, 500, 50, 950), { dx: MOUTH_REACH, heading: -1 });
  // Already there.
  assert.equal(eatingSpot({ centreX: 500 - MOUTH_REACH, heading: 1 }, 500, 50, 950).dx, 0);
});

test("a berry by an edge is eaten from the side there's room on", () => {
  // The bug is between the berry and the left edge, with no room to back up.
  assert.deepEqual(eatingSpot({ centreX: 55, heading: 1 }, 70, 50, 950), { dx: 70 + MOUTH_REACH - 55, heading: -1 });
  assert.deepEqual(eatingSpot({ centreX: 945, heading: -1 }, 930, 50, 950), { dx: 930 - MOUTH_REACH - 945, heading: 1 });
});

test("a step covers the distance without overshooting", () => {
  assert.equal(stepToward(100, 42, 1 / 60), 42);
  assert.equal(stepToward(-100, 42, 1 / 60), -42);
  assert.ok(Math.abs(stepToward(0.3, 42, 1 / 60) - 18) < 1e-9);
  assert.equal(stepToward(5, 42, 0), 0);
});
