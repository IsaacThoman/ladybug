import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rect } from "../ladybug-api.ts";
import { MASK_MS, Vision } from "./vision.ts";
import type { ViewInput } from "./vision.ts";
import { latticeEyes } from "./test-helpers.ts";

const EYES = latticeEyes();
const WALK_YAW = 1.1;
// Walking right along the ledge of a 1200×800 screen, so the wall is on its
// left: it sees the screen at its side and ahead of it, to the right.
const SPRITE: Rect = { x: 510, y: 564, width: 180, height: 150 };
const INPUT: ViewInput = {
  now: 0, width: 1200, height: 800, ledgeY: 700, centreX: 600, feetY: 700, yaw: WALK_YAW,
  sprite: SPRITE, berry: null, ball: null, cursor: null,
};

const inside = (rect: Rect, x: number, y: number) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

/** A captured frame of the screen: white, with whatever the overlay or the screen shows in `dark` black. Behind the overlay, the screen is white too. */
function screenshot(vision: Vision, dark: Rect[]) {
  const { cols, rows, width, height } = vision.wall;
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5) * width) / cols, y = ((j + 0.5) * height) / rows;
      rgba.fill(dark.some((rect) => inside(rect, x, y)) ? 0 : 255, (j * cols + i) * 4, (j * cols + i) * 4 + 3);
      rgba[(j * cols + i) * 4 + 3] = 255;
    }
  }
  return rgba;
}

/** What the eyes see with everything in `dark` captured black, after the bug was where `frames` say. */
function seen(frames: Partial<ViewInput>[], dark: Rect[], { overlay = [] as Rect[], at = 0, look = {} as Partial<ViewInput>, masked = true } = {}) {
  const vision = new Vision();
  vision.track(INPUT);
  // An earlier frame, before the overlay came along, saw the screen behind it.
  vision.wall.capture(screenshot(vision, []), []);
  for (const frame of frames) vision.track({ ...INPUT, ...frame });
  const rgba = screenshot(vision, dark);
  if (masked) vision.capture(rgba, overlay, at);
  else vision.wall.capture(rgba, overlay);
  const light = vision.look(EYES, { ...INPUT, ...look, now: at });
  return { left: Float32Array.from(light.left), right: Float32Array.from(light.right) };
}

const differences = (a: { left: Float32Array; right: Float32Array }, b: { left: Float32Array; right: Float32Array }) =>
  [...a.left.map((v, i) => Math.abs(v - b.left[i])), ...a.right.map((v, i) => Math.abs(v - b.right[i]))].filter((d) => d > 1e-3).length;

const plain = () => seen([{}], []);
const frames = (from: number, to: number, input: Partial<ViewInput> = {}) =>
  Array.from({ length: Math.floor((to - from) / 16) + 1 }, (_, k) => ({ ...input, now: from + k * 16 }));

test("the bug never sees its own sprite in the captured screen", () => {
  // The capture shows the overlay's ladybug, drawn on top of the screen.
  const unmasked = seen(frames(0, 200), [SPRITE], { at: 200, masked: false });
  assert.ok(differences(unmasked, plain()) > 10, "it would be in plain view");
  assert.equal(differences(seen(frames(0, 200), [SPRITE], { at: 200 }), plain()), 0);
});

test("nor where it was a moment ago, while the frame was on its way, but it sees what's there once it's gone", () => {
  const before: Rect = { ...SPRITE, x: SPRITE.x + 120 };
  // It walked off 150 ms before the frame was read: the frame may still show it there.
  const recent = [...frames(0, 100, { sprite: before }), ...frames(116, 250)];
  assert.equal(differences(seen(recent, [before], { at: 250 }), plain()), 0);
  // Long gone: whatever is dark there is the screen itself.
  const old = [...frames(0, 100, { sprite: before }), ...frames(116, 100 + MASK_MS + 200)];
  assert.ok(differences(seen(old, [before], { at: 100 + MASK_MS + 200 }), plain()) > 10);
});

test("bubbles, menus and panels the overlay draws are kept out too", () => {
  const panel: Rect = { x: 760, y: 450, width: 200, height: 240 };
  assert.ok(differences(seen([{}], [panel]), plain()) > 10);
  assert.equal(differences(seen([{}], [panel], { overlay: [panel] }), plain()), 0);
});

test("the cursor is in the picture exactly once: where it is now, not where the capture last saw it", () => {
  const then = { x: 700, y: 600 };
  const now = { x: 740, y: 620 };
  const arrow = (at: { x: number; y: number }): Rect => ({ x: at.x, y: at.y, width: 11, height: 21 });
  const history = [...frames(0, 120, { cursor: then }), ...frames(136, 240, { cursor: now })];
  const captured = seen(history, [arrow(then)], { at: 240, look: { cursor: now } });
  const drawn = seen([{}], [], { look: { cursor: now } });
  assert.equal(differences(captured, drawn), 0);
  assert.ok(differences(drawn, plain()) > 0, "and it is there");
});

test("a dark shape sweeping in on one side startles that eye", () => {
  const vision = new Vision();
  for (let k = 0; k <= 10; k++) {
    // Walking right, its left eye looks at the wall ahead of it, at the right of the screen.
    const input = { ...INPUT, now: k * 16, cursor: { x: 1050 - k * 35, y: 620 } };
    vision.track(input);
    vision.look(EYES, input);
  }
  assert.ok(vision.startle.left > 0.2 && vision.startle.right === 0, JSON.stringify(vision.startle));
});
