// The eyes' input stage: luminance per facet to rates of L1, L2 and L3.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EyeCells } from "./eyes.ts";
import { RETINA, Retina } from "./vision.ts";

// Two facets: the first with all three cells, the second with no L3.
const cells: EyeCells = {
  hex1: Uint8Array.from([18, 19]),
  hex2: Uint8Array.from([19, 19]),
  kind: new Uint8Array(2),
  l1: Int32Array.from([10, 11]),
  l2: Int32Array.from([20, 21]),
  l3: Int32Array.from([30, -1]),
};
// Rates by cell: L1 of facet 0, L1 of 1, L2 of 0, L2 of 1, L3 of 0.
const [L1, , L2, L2b, L3] = [0, 1, 2, 3, 4];

/** Holds a light for ms, in 10 ms steps; returns the rates at the end and whether the last step changed anything. */
function hold(retina: Retina, light: number[], ms: number) {
  let changed = false;
  for (let t = 0; t < ms; t += 10) changed = retina.step(10, light);
  return { rates: [...retina.rates], changed };
}

test("the driven cells are each facet's L1s, then L2s, then L3s", () => {
  assert.deepEqual([...new Retina(cells).neurons], [10, 11, 20, 21, 30]);
});

test("opening the eyes starts adapted: a steady scene drives nothing and passes nothing on", () => {
  const retina = new Retina(cells);
  assert.equal(retina.step(10, [0.3, 0.9]), false);
  assert.deepEqual(hold(retina, [0.3, 0.9], 5000), { rates: [0, 0, 0, 0, 0], changed: false });
});

test("darkening drives L1 and L2 transiently and L3 for longer; brightening drives nothing", () => {
  const retina = new Retina(cells);
  hold(retina, [1, 1], 1000);
  const onset = hold(retina, [0.2, 1], 10).rates;
  // Contrast about 0.76 of full darkening, in facet 0 only.
  assert.ok(onset[L1] > 0.5 * RETINA.maxRate && onset[L2] === onset[L1] && onset[L3] > 0.5 * RETINA.maxRate, `${onset}`);
  assert.equal(onset[L2b], 0);
  const later = hold(retina, [0.2, 1], 990).rates;
  // A second on, L1 and L2 have adapted to the new level (time constant 200 ms); L3 (2 s) has not.
  assert.ok(later[L1] < 0.02 * RETINA.maxRate, `L1 ${later[L1]}`);
  assert.ok(later[L3] > 0.3 * RETINA.maxRate, `L3 ${later[L3]}`);
  const back = hold(retina, [1, 1], 10);
  assert.deepEqual(back.rates, [0, 0, 0, 0, 0]);
  assert.equal(back.changed, true, "the rates fell to 0, which must be passed on");
  assert.equal(hold(retina, [1, 1], 10).changed, false);
});

test("the response is to contrast: the same fractional dimming at any ambient level gives the same rate (above the floor)", () => {
  const at = (level: number) => {
    const retina = new Retina(cells, { ...RETINA, floor: 0 });
    hold(retina, [level, level], 3000);
    return hold(retina, [level / 2, level], 10).rates[L1];
  };
  assert.ok(Math.abs(at(1) - at(0.1)) < 1e-9);
  // With the floor, a dim scene's changes count for less.
  const retina = new Retina(cells);
  hold(retina, [0.02, 0.02], 3000);
  assert.ok(hold(retina, [0.01, 0.02], 10).rates[L1] < 0.3 * RETINA.maxRate * 0.5);
});

test("skipping steps of unchanging light is exact", () => {
  // A tonic rate turns the skipping off, so the two retinas step the same light in different ways.
  const skipping = new Retina(cells);
  const stepping = new Retina(cells, { ...RETINA, tonic: 1e-300 });
  const sequence: [number[], number][] = [
    [[0.5, 0.5], 500],
    [[0.9, 0.5], 700],
    [[0.9, 0.5], 3000],
    [[0.4, 0.2], 300],
  ];
  for (const [light, ms] of sequence) {
    const a = hold(skipping, light, ms).rates;
    const b = hold(stepping, light, ms).rates;
    for (let n = 0; n < a.length; n++) assert.ok(Math.abs(a[n] - b[n]) < 1e-9, `${light} cell ${n}: ${a[n]} vs ${b[n]}`);
  }
});

test("shut eyes drive nothing, and reopen adapted; nonsense light is clamped and a wrong length refused", () => {
  const retina = new Retina(cells);
  hold(retina, [1, 1], 100);
  hold(retina, [0, 1], 10);
  assert.ok(retina.rates[L1] > 0);
  assert.equal(retina.step(10, null), true);
  assert.deepEqual([...retina.rates], [0, 0, 0, 0, 0]);
  assert.equal(retina.step(10, null), false);
  assert.deepEqual(hold(retina, [0, 0.5], 10).rates, [0, 0, 0, 0, 0]);
  const clamped = new Retina(cells);
  hold(clamped, [5, Number.NaN], 100);
  assert.deepEqual(hold(clamped, [1, -3], 10).rates, [0, 0, 0, 0, 0]);
  assert.throws(() => retina.step(10, [1]), /2 facets, but the light gives 1/);
});
