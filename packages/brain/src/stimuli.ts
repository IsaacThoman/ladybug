// A battery of visual stimuli for the eyes, as luminance over the visual
// sphere and time, for scripts/vision.ts, scripts/report.ts and the tests.
// Directions are the eyes' head frame (x right, y ahead, z up); azimuth is
// degrees from straight ahead toward the fly's right, elevation degrees up.

import type { EyeMap } from "./types.ts";

/** Luminance, 0 to 1, seen at time t (s from the stimulus' start) toward azimuth az and elevation el (degrees). */
export type Scene = (t: number, az: number, el: number) => number;

export type Stimulus = {
  name: string;
  /** Seconds the stimulus runs. */
  seconds: number;
  scene: Scene;
  /** The steady scene before and after it (and the control it is compared with): uniform at this luminance. */
  ground: number;
  /** The eye it is aimed at, or both. */
  eye: "left" | "right" | "both";
  /** Seconds from the start to leave out of the measurement (for a static scene, to see what is left once the eyes have adapted). */
  settle?: number;
};

const degrees = (r: number) => (r * 180) / Math.PI;
const radians = (d: number) => (d * Math.PI) / 180;

/** Angle in degrees between two directions given as azimuth and elevation. */
export function separation(az1: number, el1: number, az2: number, el2: number): number {
  const [a1, e1, a2, e2] = [az1, el1, az2, el2].map(radians);
  const c = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(a1 - a2);
  return degrees(Math.acos(Math.min(1, Math.max(-1, c))));
}

/** Each facet's azimuth and elevation, degrees, per eye. */
export function facetAngles(eyes: EyeMap): { left: { az: Float64Array; el: Float64Array }; right: { az: Float64Array; el: Float64Array } } {
  const angles = (d: Float32Array) => {
    const n = d.length / 3;
    const az = new Float64Array(n);
    const el = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      az[k] = degrees(Math.atan2(d[3 * k], d[3 * k + 1]));
      el[k] = degrees(Math.asin(Math.max(-1, Math.min(1, d[3 * k + 2]))));
    }
    return { az, el };
  };
  return { left: angles(eyes.left.directions), right: angles(eyes.right.directions) };
}

/** Fills `light` with what the eyes see of a scene at time t. */
export function render(scene: Scene, t: number, angles: ReturnType<typeof facetAngles>, light: { left: Float32Array; right: Float32Array }) {
  for (const side of ["left", "right"] as const) {
    const { az, el } = angles[side];
    const out = light[side];
    for (let k = 0; k < out.length; k++) out[k] = scene(t, az[k], el[k]);
  }
}

/**
 * A dark disc approaching at constant speed toward (az, el): half-size over
 * speed `lv` seconds, so its angular radius is atan(lv / time to contact). It
 * starts 5 degrees across, reaches 90 degrees (a wall) at contact and stays.
 */
const eyeOf = (az: number): Stimulus["eye"] => (az > 15 ? "right" : az < -15 ? "left" : "both");

export function loom(name: string, az: number, el: number, lv: number): Stimulus {
  const start = lv / Math.tan(radians(2.5));
  const seconds = start + 0.2;
  return {
    name,
    seconds,
    ground: 1,
    eye: eyeOf(az),
    scene: (t, a, e) => {
      const left = start - t;
      const radius = left <= 0 ? 90 : degrees(Math.atan(lv / left));
      return separation(a, e, az, el) <= radius ? 0 : 1;
    },
  };
}

/** The same disc receding: a loom played backwards, from 60 degrees across to 5. */
export function recede(name: string, az: number, el: number, lv: number): Stimulus {
  const from = lv / Math.tan(radians(30));
  const to = lv / Math.tan(radians(2.5));
  return {
    name,
    seconds: to - from,
    ground: 1,
    eye: eyeOf(az),
    scene: (t, a, e) => (separation(a, e, az, el) <= degrees(Math.atan(lv / (from + t))) ? 0 : 1),
  };
}

/** A dark bar `width` degrees wide crossing at `speed` degrees/s, vertical (moving in azimuth) or horizontal (moving in elevation). */
export function bar(name: string, axis: "azimuth" | "elevation", from: number, to: number, speed: number, width = 10): Stimulus {
  const seconds = Math.abs(to - from) / speed;
  const sign = Math.sign(to - from);
  return {
    name,
    seconds,
    ground: 1,
    eye: axis === "azimuth" ? "right" : "both",
    scene: (t, a, e) => (Math.abs((axis === "azimuth" ? a : e) - (from + sign * speed * t)) <= width / 2 ? 0 : 1),
  };
}

/** A dark dot `size` degrees across crossing along a great-circle-ish path at `speed` degrees/s: along the horizon at elevation `at`, or up/down at azimuth `at`. */
export function dot(name: string, axis: "azimuth" | "elevation", at: number, from: number, to: number, speed: number, size = 8): Stimulus {
  const seconds = Math.abs(to - from) / speed;
  const sign = Math.sign(to - from);
  return {
    name,
    seconds,
    ground: 1,
    eye: eyeOf(axis === "azimuth" ? (from + to) / 2 : at),
    scene: (t, a, e) => {
      const now = from + sign * speed * t;
      const [daz, del] = axis === "azimuth" ? [now, at] : [at, now];
      return separation(a, e, daz, del) <= size / 2 ? 0 : 1;
    },
  };
}

/**
 * A square-wave grating of `period` degrees drifting at `hz` cycles/s. In
 * azimuth, positive is toward the fly's right everywhere (seen from above, a
 * clockwise rotation: back to front in the left eye, front to back in the
 * right); in elevation, positive is upward. With `eye` it covers that eye's
 * side only (azimuth beyond 15 degrees), the rest a uniform grey of its mean.
 */
export function grating(name: string, axis: "azimuth" | "elevation", direction: 1 | -1, eye: Stimulus["eye"] = "both", period = 30, hz = 2, seconds = 2): Stimulus {
  return {
    name,
    seconds,
    ground: 0.5,
    eye,
    scene: (t, a, e) => {
      if ((eye === "right" && a < 15) || (eye === "left" && a > -15)) return 0.5;
      const phase = ((axis === "azimuth" ? a : e) - direction * period * hz * t) / period;
      return phase - Math.floor(phase) < 0.5 ? 0 : 1;
    },
  };
}

export const BATTERY: readonly Stimulus[] = [
  loom("loom right fast", 70, 0, 0.01),
  loom("loom right", 70, 0, 0.04),
  loom("loom right slow", 70, 0, 0.16),
  loom("loom left", -70, 0, 0.04),
  loom("loom front", 0, 0, 0.04),
  loom("loom right above", 70, 45, 0.04),
  recede("recede right", 70, 0, 0.04),
  { name: "dim", seconds: 1, ground: 1, eye: "both", scene: () => 0.2 },
  { name: "brighten", seconds: 1, ground: 0.2, eye: "both", scene: () => 1 },
  bar("bar right, front to back", "azimuth", -10, 160, 100),
  bar("bar right, back to front", "azimuth", 160, -10, 100),
  bar("bar, upward", "elevation", -80, 85, 100),
  bar("bar, downward", "elevation", 85, -80, 100),
  dot("dot right, front to back", "azimuth", 0, -10, 160, 100),
  dot("dot right, back to front", "azimuth", 0, 160, -10, 100),
  dot("dot right, upward", "elevation", 70, -80, 85, 100),
  dot("dot right, downward", "elevation", 70, 85, -80, 100),
  grating("grating right, front to back", "azimuth", 1, "right"),
  grating("grating right, back to front", "azimuth", -1, "right"),
  grating("grating right, upward", "elevation", 1, "right"),
  grating("grating right, downward", "elevation", -1, "right"),
  grating("grating, clockwise", "azimuth", 1),
  grating("grating, anticlockwise", "azimuth", -1),
  { name: "flicker", seconds: 2, ground: 0.6, eye: "both", scene: (t) => (Math.floor(t * 8) % 2 === 0 ? 0.2 : 1) },
  {
    name: "static checkerboard",
    seconds: 5,
    settle: 3,
    ground: 1,
    eye: "both",
    scene: (_t, a, e) => (Math.floor(a / 30) + Math.floor(e / 30)) % 2 === 0 ? 0.2 : 1,
  },
];
