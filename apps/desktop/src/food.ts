// The berry the bug can be fed: how it falls and bounces, when the bug can
// taste it, and where the bug stands to eat it.

/** The berry's grab box, px. The berry itself sits at the bottom of it, in the middle. */
export const FOOD_SIZE = 40;
/** How far below the bug's ground line the box rests: a berry in front of the bug is nearer the viewer. */
export const FOOD_SINK = 3;
/** From the middle of the bug to the middle of a berry at its mouth, px. */
export const MOUTH_REACH = 56;
/** The bug tastes a berry whose middle is this close to its own (px): under its feet or at its mouth. */
export const TASTE_RANGE = 66;
/** ...and no higher than this off the ground (px). */
export const TASTE_HEIGHT = 18;
/** Standing within this many px of the eating spot, it eats. */
export const EAT_SLOP = 1.5;
/** Seconds to finish a berry at full appetite. */
export const EAT_SECONDS = 3;
/** The appetite of a bug without a fly brain. */
export const OWN_APPETITE = 0.4;
/** A new berry lands about this far (px) from the middle of the bug. */
export const DROP_AWAY = 130;

const GRAVITY = 2400; // px/s²
const BOUNCE = 0.45;
const GROUND_FRICTION = 5; // 1/s, damps rolling after a throw
const REST_SPEED = 110; // px/s, a bounce slower than this ends the fall
const MAX_THROW = 2500; // px/s

export type Food = {
  /** Top-left corner of the grab box. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: "resting" | "airborne" | "dragging";
  /** 1 when whole, down to 0 when eaten up. */
  left: number;
  /** The side the bites are on: -1 is the left of the berry. */
  biteFrom: 1 | -1;
};

/** Where the grab box may be: the range of its top-left corner, with `groundY` where it rests. */
export type FoodBounds = { minX: number; maxX: number; minY: number; groundY: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A fresh berry popping out beside the bug, on the side it faces if there's room. */
export function dropFood(pet: { centreX: number; y: number; heading: 1 | -1 }, bounds: FoodBounds): Food {
  const at = (side: 1 | -1) => pet.centreX + side * DROP_AWAY - FOOD_SIZE / 2;
  const fits = (x: number) => x >= bounds.minX && x <= bounds.maxX;
  const side = fits(at(pet.heading)) || !fits(at(pet.heading === 1 ? -1 : 1)) ? pet.heading : pet.heading === 1 ? -1 : 1;
  return {
    x: clamp(at(side), bounds.minX, bounds.maxX),
    y: clamp(pet.y - 40, bounds.minY, bounds.groundY),
    vx: 0,
    vy: -420,
    mode: "airborne",
    left: 1,
    biteFrom: -1,
  };
}

/** Moves a falling berry on by `dt` seconds. A held or resting one only stays inside the bounds. */
export function stepFood(food: Food, dt: number, bounds: FoodBounds) {
  if (food.mode === "airborne") {
    food.vy += GRAVITY * dt;
    food.x += food.vx * dt;
    food.y += food.vy * dt;
    if (food.x < bounds.minX || food.x > bounds.maxX) {
      food.x = clamp(food.x, bounds.minX, bounds.maxX);
      food.vx *= -BOUNCE;
    }
    if (food.y < bounds.minY) {
      food.y = bounds.minY;
      food.vy = Math.abs(food.vy) * BOUNCE;
    }
    if (food.y >= bounds.groundY) {
      food.y = bounds.groundY;
      food.vy = -food.vy * BOUNCE;
      food.vx *= 1 - Math.min(1, GROUND_FRICTION * dt);
      if (Math.abs(food.vy) < REST_SPEED) {
        food.vx = 0;
        food.vy = 0;
        food.mode = "resting";
      }
    }
  }
  food.x = clamp(food.x, bounds.minX, bounds.maxX);
  food.y = clamp(food.y, bounds.minY, bounds.groundY);
  // The ground moved (the display changed): a resting berry falls or is lifted onto it.
  if (food.mode === "resting" && food.y < bounds.groundY) food.mode = "airborne";
}

/** Lets go of a dragged berry with the velocity it was moving at. */
export function throwFood(food: Food) {
  food.vx = clamp(food.vx, -MAX_THROW, MAX_THROW);
  food.vy = clamp(food.vy, -MAX_THROW, MAX_THROW);
  food.mode = "airborne";
}

/** Whether a bug standing with its middle at `petCentreX` touches the berry: with its feet or its mouth. */
export function touchesFood(petCentreX: number, food: Food, bounds: FoodBounds) {
  return Math.abs(food.x + FOOD_SIZE / 2 - petCentreX) <= TASTE_RANGE && food.y >= bounds.groundY - TASTE_HEIGHT;
}

/** Where to stand to eat: how far the bug's middle has to move (px), and which way it faces there. */
export type EatingSpot = { dx: number; heading: 1 | -1 };

/**
 * The spot that puts the berry at the bug's mouth. It faces the berry, and one
 * straight underfoot stays ahead of it, so it backs up to it. `min` and `max`
 * are as far as its middle can go; near an edge it eats from the other side.
 */
export function eatingSpot(pet: { centreX: number; heading: 1 | -1 }, foodCentreX: number, min: number, max: number): EatingSpot {
  let heading: 1 | -1 = foodCentreX > pet.centreX ? 1 : foodCentreX < pet.centreX ? -1 : pet.heading;
  let stand = foodCentreX - heading * MOUTH_REACH;
  if (stand < min || stand > max) {
    const other = foodCentreX + heading * MOUTH_REACH;
    if (other >= min && other <= max) {
      heading = heading === 1 ? -1 : 1;
      stand = other;
    }
  }
  return { dx: clamp(stand, min, max) - pet.centreX, heading };
}

/** The velocity (px/s) that covers `dx` this frame without overshooting, at up to `speed`. */
export function stepToward(dx: number, speed: number, dt: number) {
  if (!(dt > 0)) return 0;
  return clamp(dx / dt, -speed, speed);
}
