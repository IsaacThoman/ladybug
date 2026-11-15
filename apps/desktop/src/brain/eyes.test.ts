import assert from "node:assert/strict";
import { test } from "node:test";
import { BERRY, BODY_DEPTH, CURSOR, EYE_HEIGHT, HEAD_REACH, LEDGE, ROOM, Retina, headPose } from "./eyes.ts";
import type { Ball, Scene } from "./eyes.ts";
import { FLAT_WALL, Wall } from "./wall.ts";
import { facetEyes, latticeEyes } from "./test-helpers.ts";

// A 1200×800 screen with the ledge along y = 700, and the bug in the middle of it.
const WIDTH = 1200;
const HEIGHT = 800;
const LEDGE_Y = 700;
const CENTRE = 600;
/** The renderer's yaw while walking: about 63° toward its heading. */
const WALK_YAW = 1.1;
const EYES = latticeEyes();

/** A wall whose brightness at each point is `paint(x, y)`, px. */
function wallOf(paint: (x: number, y: number) => number = () => FLAT_WALL) {
  const wall = new Wall();
  wall.resize(WIDTH, HEIGHT);
  const cellW = WIDTH / wall.cols, cellH = HEIGHT / wall.rows;
  const rgba = new Uint8ClampedArray(wall.cols * wall.rows * 4);
  for (let j = 0; j < wall.rows; j++) {
    for (let i = 0; i < wall.cols; i++) {
      const value = Math.round(paint((i + 0.5) * cellW, (j + 0.5) * cellH) * 255);
      rgba.set([value, value, value, 255], (j * wall.cols + i) * 4);
    }
  }
  wall.capture(rgba, []);
  return wall;
}

function look({ map = EYES, yaw = 0, wall = wallOf(), cursor = null, berry = null, centreX = CENTRE }: {
  map?: typeof EYES; yaw?: number; wall?: Wall; cursor?: Scene["cursor"]; berry?: Ball | null; centreX?: number;
} = {}) {
  const retina = new Retina(map);
  retina.look(headPose(centreX, LEDGE_Y, yaw), { wall, ledgeY: LEDGE_Y, cursor, berry });
  return retina.light;
}

/** The direction from the eyes to a point in the world, in the head frame. */
function toHead(eye: { x: number; y: number; depth: number }, yaw: number, x: number, y: number, depth: number): [number, number, number] {
  const wx = x - eye.x, wy = y - eye.y, wz = depth - eye.depth;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [-wx * c + wz * s, wx * s + wz * c, -wy];
}

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
const count = (values: Float32Array, test: (value: number) => boolean) => values.reduce((n, value) => n + (test(value) ? 1 : 0), 0);
/** Facets that see at least `by` darker than in `before`. */
const darker = (after: Float32Array, before: Float32Array, by = 0.02) => after.reduce((n, value, i) => n + (before[i] - value >= by ? 1 : 0), 0);

test("the eyes stand on the ledge in front of the screen, and the head leads the way it faces", () => {
  assert.deepEqual(headPose(100, 700, 0), { x: 100, y: 700 - EYE_HEIGHT, depth: BODY_DEPTH + HEAD_REACH, yaw: 0 });
  const walking = headPose(100, 700, WALK_YAW);
  assert.ok(walking.x > 100 + HEAD_REACH * 0.8, "toward the right of the screen");
  assert.ok(walking.depth < BODY_DEPTH + HEAD_REACH && walking.depth > BODY_DEPTH);
});

test("a dark patch on the wall to the right of a bug facing the viewer lands in its left eye", () => {
  const plain = look({ wall: wallOf(() => 1) });
  const { left, right } = look({ wall: wallOf((x, y) => (x > 680 && x < 820 && y > 560 && y < 690 ? 0 : 1)) });
  assert.ok(darker(left, plain.left, 0.3) >= 3, `left eye: ${darker(left, plain.left, 0.3)} dark facets`);
  assert.equal(darker(right, plain.right), 0);

  // And one to its left, in its right eye.
  const mirrored = look({ wall: wallOf((x, y) => (x > 380 && x < 520 && y > 560 && y < 690 ? 0 : 1)) });
  assert.ok(darker(mirrored.right, plain.right, 0.3) >= 3);
  assert.equal(darker(mirrored.left, plain.left), 0);
});

test("turning to walk moves the wall to its side: walking right, the screen is on its left", () => {
  const wall = wallOf(() => 1);
  const lit = (values: Float32Array) => count(values, (v) => v > 0.9);
  const idle = look({ wall });
  // Facing the viewer, the wall is behind it, evenly on both sides.
  assert.ok(Math.abs(lit(idle.left) - lit(idle.right)) <= 0.1 * lit(idle.left), `${lit(idle.left)} / ${lit(idle.right)}`);

  const right = look({ wall, yaw: WALK_YAW });
  assert.ok(lit(right.left) > 1.5 * lit(idle.left), `left eye sees the wall: ${lit(right.left)} facets, from ${lit(idle.left)}`);
  assert.ok(lit(right.right) < lit(idle.right) / 2, `right eye looks away from it: ${lit(right.right)} facets`);

  const left = look({ wall, yaw: -WALK_YAW });
  assert.equal(lit(left.right), lit(right.left));
  assert.equal(lit(left.left), lit(right.right));
});

test("a nearby dark shape covers more facets than a distant one", () => {
  // Walking right, with the wall on its left. The cursor is drawn on the wall at its real size.
  const eye = headPose(CENTRE, LEDGE_Y, WALK_YAW);
  const plain = look({ yaw: WALK_YAW });
  const covered = (cursor: { x: number; y: number }) => {
    const { left, right } = look({ yaw: WALK_YAW, cursor });
    return darker(left, plain.left, 0.005) + darker(right, plain.right, 0.005);
  };
  const close = covered({ x: eye.x + 10, y: eye.y - 30 });
  const far = covered({ x: eye.x + 250, y: eye.y - 30 });
  assert.ok(close > 2 * far, `near ${close}, far ${far}`);
  assert.ok(far >= 1, "still seen from afar");

  // Up close, a facet looking straight at it sees almost only the cursor.
  const cursor = { x: eye.x + 10, y: eye.y - 30 };
  const straight = look({ map: facetEyes(toHead(eye, WALK_YAW, cursor.x + 4, cursor.y + 10, 0)), yaw: WALK_YAW, cursor }).left[0];
  assert.ok(straight < CURSOR + 0.1, `${straight}`);
});

test("a facet looking away from the wall sees the room, one looking down the ledge, one looking back the wall", () => {
  const wall = wallOf(() => 1);
  // Facing the viewer: straight ahead is out into the room, straight back is the wall.
  near(look({ wall, map: facetEyes([0, 1, 0.2]) }).left[0], ROOM);
  near(look({ wall, map: facetEyes([0, 1, -0.3]) }).left[0], LEDGE);
  assert.ok(Math.abs(look({ wall, map: facetEyes([0, -1, 0.3]) }).left[0] - 1) < 1e-3);
  // Down and back: the ledge in front of the wall.
  near(look({ wall, map: facetEyes([0, -1, -1]) }).left[0], LEDGE);
  // Past the screen's edges: to the left of a bug near its left edge.
  near(look({ wall, map: facetEyes([1, -0.5, 0.1]), centreX: 20 }).right[0], ROOM);
  // A footprint over the top of the screen is part wall, part room.
  const top = look({ wall, map: facetEyes([0, -0.12, 1]) }).left[0];
  assert.ok(top > ROOM && top < 1, `${top}`);
});

test("the berry on the ledge beside the bug hides the wall behind it", () => {
  const eye = headPose(CENTRE, LEDGE_Y, WALK_YAW);
  const berry: Ball = { x: CENTRE + 70, y: LEDGE_Y - 12, depth: BODY_DEPTH, radius: 10 };
  const head = toHead(eye, WALK_YAW, berry.x, berry.y, berry.depth);
  const seen = look({ map: facetEyes(head), yaw: WALK_YAW, berry }).left[0];
  near(seen, BERRY);
  assert.notEqual(look({ map: facetEyes(head), yaw: WALK_YAW }).left[0], BERRY);
});

test("everything seen is a brightness from 0 to 1, the cursor dark", () => {
  const { left, right } = look({ yaw: 0.4, cursor: { x: 610, y: 640 }, berry: { x: 520, y: 688, depth: BODY_DEPTH, radius: 10 } });
  for (const value of [...left, ...right]) assert.ok(value >= 0 && value <= 1, `${value}`);
  assert.ok(CURSOR < LEDGE && LEDGE < ROOM && ROOM < FLAT_WALL);
});
