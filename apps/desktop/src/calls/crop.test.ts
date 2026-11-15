import assert from "node:assert/strict";
import test from "node:test";
import { FULL_FRAME, detectCrop, fitAspect, sameCrop } from "./crop.ts";

type Rect = { x: number; y: number; width: number; height: number };

/** A black frame with a lit rectangle, optionally with rounded (black) corners. */
function frame(width: number, height: number, lit: Rect, { luma = 140, radius = 0 } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      pixels[p + 3] = 255;
      const inside = x >= lit.x && x < lit.x + lit.width && y >= lit.y && y < lit.y + lit.height;
      if (!inside) { pixels.fill(12, p, p + 3); continue; }
      const cx = Math.min(x - lit.x, lit.x + lit.width - 1 - x);
      const cy = Math.min(y - lit.y, lit.y + lit.height - 1 - y);
      const corner = cx < radius && cy < radius && Math.hypot(radius - cx, radius - cy) > radius;
      pixels.fill(corner ? 12 : luma, p, p + 3);
    }
  }
  return pixels;
}

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.011, `${actual} ≉ ${expected}`);

test("crops pillarbox bars to the left and right", () => {
  // The phone-portrait feed from the screenshot: 552×311 with 208 lit in the middle.
  const crop = detectCrop(frame(160, 90, { x: 50, y: 0, width: 60, height: 90 }, { radius: 4 }), 160, 90)!;
  near(crop.x, 50 / 160);
  near(crop.width, 60 / 160);
  assert.deepEqual([crop.y, crop.height], [0, 1]);
});

test("crops letterbox bars above and below", () => {
  const crop = detectCrop(frame(90, 160, { x: 0, y: 40, width: 90, height: 80 }), 90, 160)!;
  near(crop.y, 40 / 160);
  near(crop.height, 80 / 160);
  assert.deepEqual([crop.x, crop.width], [0, 1]);
});

test("leaves a full frame alone", () => {
  assert.deepEqual(detectCrop(frame(64, 48, { x: 0, y: 0, width: 64, height: 48 }), 64, 48), FULL_FRAME);
});

test("can't tell from an all-black or nearly black frame", () => {
  assert.equal(detectCrop(frame(64, 48, { x: 0, y: 0, width: 0, height: 0 }), 64, 48), null);
  assert.equal(detectCrop(frame(64, 48, { x: 30, y: 0, width: 4, height: 48 }), 64, 48), null);
});

test("crops both sides by the thinner bar when they disagree", () => {
  // Content with a dark left edge: don't trust the wider left "bar".
  const crop = detectCrop(frame(100, 50, { x: 30, y: 0, width: 60, height: 50 }), 100, 50)!;
  near(crop.x, 0.1);
  near(crop.width, 0.8);
});

test("compares crops with a tolerance", () => {
  assert.ok(sameCrop({ x: 0.3, y: 0, width: 0.4, height: 1 }, { x: 0.305, y: 0, width: 0.39, height: 1 }));
  assert.ok(!sameCrop({ x: 0.3, y: 0, width: 0.4, height: 1 }, FULL_FRAME));
});

test("fits an aspect ratio inside a box", () => {
  assert.deepEqual(fitAspect(2 / 3, 1000, 600), { width: 400, height: 600 });
  assert.deepEqual(fitAspect(16 / 9, 320, 1000), { width: 320, height: 180 });
});
