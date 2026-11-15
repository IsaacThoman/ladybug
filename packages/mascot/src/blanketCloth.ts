/**
 * The bedtime blanket's fall, as a small cloth simulation that's baked once
 * into keyframes. Playing it back is just blending two stored frames, so it
 * costs next to nothing per frame, and the bake itself runs a few steps at a
 * time (see `ClothBake`) so it never stalls a frame either.
 *
 * Body space of the sleeping bug: feet on y = 0 before it sinks by
 * `groundY`, the head toward +z.
 */

/** Particles across (x) and from back to front (z). */
export const CLOTH_COLUMNS = 30;
export const CLOTH_ROWS = 25;
/** Rows at the front that fold over as a cream cuff. */
export const CLOTH_CUFF_ROWS = 2;
/** Big enough to cover the dome of the shell, with some left to hang down. */
const WIDTH = 1.5;
const DEPTH = 1.15;
/** Where the sheet's back and front edges start out. */
const BACK = -0.77;
/** Height of the sheet's middle when it starts falling, above the top of the canvas. */
const DROP_HEIGHT = 1.25;

const STEP = 1 / 180;
const ITERATIONS = 6;
const GRAVITY = 7;
/** Air drag, per second: fabric floats down rather than dropping like a stone. */
const DRAG = 2.2;
/** How much a particle's sideways motion is kept when it touches the floor. */
const FLOOR_GRIP = 0.35;
const MARGIN = 0.022;

/** Recorded at this rate, and for this long. */
export const CLOTH_FPS = 30;
export const CLOTH_SECONDS = 1.5;

type Ellipsoid = { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number };

export type ClothShape = {
  /** Height of the floor in body space once the bug has sunk down to sleep. */
  groundY: number;
  /** What the blanket lands on: the shell, the collar and the head. */
  colliders: Ellipsoid[];
};

export type BakedCloth = {
  frames: Float32Array[];
};

const COUNT = CLOTH_COLUMNS * CLOTH_ROWS;
const index = (i: number, j: number) => j * CLOTH_COLUMNS + i;

/** Index and UVs for the sheet; positions come from the baked frames. */
export function clothTopology() {
  const uvs = new Float32Array(COUNT * 2);
  for (let j = 0; j < CLOTH_ROWS; j++) {
    for (let i = 0; i < CLOTH_COLUMNS; i++) {
      const k = index(i, j);
      uvs[k * 2] = (i / (CLOTH_COLUMNS - 1)) * 3.2;
      uvs[k * 2 + 1] = (j / (CLOTH_ROWS - 1)) * 2.5;
    }
  }
  const quilt: number[] = [];
  const cuff: number[] = [];
  for (let j = 0; j < CLOTH_ROWS - 1; j++) {
    for (let i = 0; i < CLOTH_COLUMNS - 1; i++) {
      const a = index(i, j);
      const b = index(i, j + 1);
      const target = j >= CLOTH_ROWS - 1 - CLOTH_CUFF_ROWS ? cuff : quilt;
      target.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { uvs, quilt, cuff, count: COUNT };
}

/**
 * Bakes the fall a slice at a time. Call `advance` with a time budget each
 * frame until `result` is set; `finish` runs whatever is left at once.
 */
export class ClothBake {
  result: BakedCloth | null = null;
  private readonly steps: Generator<void, BakedCloth>;

  constructor(shape: ClothShape) {
    this.steps = simulate(shape);
  }

  /** Runs steps for up to `budgetMs`. */
  advance(budgetMs: number) {
    if (this.result) return this.result;
    const until = performance.now() + budgetMs;
    do {
      const next = this.steps.next();
      if (next.done) {
        this.result = next.value;
        break;
      }
    } while (performance.now() < until);
    return this.result;
  }

  finish() {
    return this.advance(Number.POSITIVE_INFINITY)!;
  }
}

function* simulate({ groundY, colliders }: ClothShape): Generator<void, BakedCloth> {
  const pos = new Float32Array(COUNT * 3);
  const prev = new Float32Array(COUNT * 3);
  const dx = WIDTH / (CLOTH_COLUMNS - 1);
  const dz = DEPTH / (CLOTH_ROWS - 1);

  // A sheet held loosely by its middle: corners and edges sag and ripple a
  // little, and it's tipped slightly so it doesn't land perfectly square.
  for (let j = 0; j < CLOTH_ROWS; j++) {
    for (let i = 0; i < CLOTH_COLUMNS; i++) {
      const k = index(i, j) * 3;
      const x = -WIDTH / 2 + i * dx;
      const z = BACK + j * dz;
      const u = (i / (CLOTH_COLUMNS - 1)) * 2 - 1;
      const v = (j / (CLOTH_ROWS - 1)) * 2 - 1;
      const sag = 0.22 * (u * u + v * v * 0.6);
      const ripple = 0.035 * Math.sin(u * 5.5 + 0.7) + 0.025 * Math.sin(v * 4.2 - 0.3);
      pos[k] = x;
      pos[k + 1] = DROP_HEIGHT - sag + ripple + 0.06 * u - 0.04 * v;
      pos[k + 2] = z;
    }
  }
  prev.set(pos);
  // A slight drift as it falls.
  for (let k = 0; k < COUNT; k++) {
    prev[k * 3] += 0.06 * STEP;
    prev[k * 3 + 1] += 0.4 * STEP;
  }

  // Distance constraints: structure, shear, and softer bending.
  const constraints: number[] = [];
  const add = (a: number, b: number, stiffness: number) => {
    const ax = pos[a * 3] - pos[b * 3];
    const az = pos[a * 3 + 2] - pos[b * 3 + 2];
    // Rest length from the flat layout, not the sagging start.
    constraints.push(a, b, Math.hypot(ax, az), stiffness);
  };
  for (let j = 0; j < CLOTH_ROWS; j++) {
    for (let i = 0; i < CLOTH_COLUMNS; i++) {
      const k = index(i, j);
      if (i + 1 < CLOTH_COLUMNS) add(k, index(i + 1, j), 1);
      if (j + 1 < CLOTH_ROWS) add(k, index(i, j + 1), 1);
      if (i + 1 < CLOTH_COLUMNS && j + 1 < CLOTH_ROWS) {
        add(k, index(i + 1, j + 1), 0.7);
        add(index(i + 1, j), index(i, j + 1), 0.7);
      }
      if (i + 2 < CLOTH_COLUMNS) add(k, index(i + 2, j), 0.12);
      if (j + 2 < CLOTH_ROWS) add(k, index(i, j + 2), 0.12);
    }
  }

  const floor = groundY + 0.004;
  const frames: Float32Array[] = [pos.slice()];
  const stepsPerFrame = Math.round(1 / CLOTH_FPS / STEP);
  const totalSteps = Math.round(CLOTH_SECONDS / STEP);
  const keep = 1 - DRAG * STEP;

  for (let step = 1; step <= totalSteps; step++) {
    // Verlet: carry on moving, slowed by the air, pulled down by gravity.
    for (let k = 0; k < COUNT * 3; k += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const p = pos[k + axis];
        const velocity = (p - prev[k + axis]) * keep;
        prev[k + axis] = p;
        pos[k + axis] = p + velocity - (axis === 1 ? GRAVITY * STEP * STEP : 0);
      }
    }

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      for (let c = 0; c < constraints.length; c += 4) {
        const a = constraints[c] * 3;
        const b = constraints[c + 1] * 3;
        const rest = constraints[c + 2];
        const ex = pos[b] - pos[a];
        const ey = pos[b + 1] - pos[a + 1];
        const ez = pos[b + 2] - pos[a + 2];
        const length = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (length < 1e-9) continue;
        // Cloth stretches very little but bunches up freely.
        const stiffness = length < rest ? constraints[c + 3] * 0.3 : constraints[c + 3];
        const correction = ((length - rest) / length) * 0.5 * stiffness;
        pos[a] += ex * correction;
        pos[a + 1] += ey * correction;
        pos[a + 2] += ez * correction;
        pos[b] -= ex * correction;
        pos[b + 1] -= ey * correction;
        pos[b + 2] -= ez * correction;
      }

      for (let k = 0; k < COUNT * 3; k += 3) {
        for (const e of colliders) {
          const nx = (pos[k] - e.cx) / (e.rx + MARGIN);
          const ny = (pos[k + 1] - e.cy) / (e.ry + MARGIN);
          const nz = (pos[k + 2] - e.cz) / (e.rz + MARGIN);
          const d2 = nx * nx + ny * ny + nz * nz;
          if (d2 >= 1 || d2 < 1e-12) continue;
          const d = Math.sqrt(d2);
          pos[k] = e.cx + (nx / d) * (e.rx + MARGIN);
          pos[k + 1] = e.cy + (ny / d) * (e.ry + MARGIN);
          pos[k + 2] = e.cz + (nz / d) * (e.rz + MARGIN);
          // Fabric clings rather than skating off the shell.
          prev[k] += (pos[k] - prev[k]) * 0.4;
          prev[k + 2] += (pos[k + 2] - prev[k + 2]) * 0.4;
        }
        if (pos[k + 1] < floor) {
          pos[k + 1] = floor;
          prev[k] += (pos[k] - prev[k]) * (1 - FLOOR_GRIP);
          prev[k + 2] += (pos[k + 2] - prev[k + 2]) * (1 - FLOOR_GRIP);
        }
      }
    }

    if (step % stepsPerFrame === 0) frames.push(pos.slice());
    yield;
  }
  return { frames };
}

/** Writes the blanket's shape `seconds` into its fall into `out`. */
export function sampleCloth(baked: BakedCloth, seconds: number, out: Float32Array) {
  const { frames } = baked;
  const at = Math.min(Math.max(seconds * CLOTH_FPS, 0), frames.length - 1);
  const a = Math.floor(at);
  const b = Math.min(a + 1, frames.length - 1);
  const t = at - a;
  const from = frames[a];
  const to = frames[b];
  for (let k = 0; k < out.length; k++) out[k] = from[k] + (to[k] - from[k]) * t;
}
