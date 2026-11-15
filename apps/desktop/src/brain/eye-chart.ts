// Where to draw each facet in the activity panel's picture of what the eyes
// see. Each eye gets its own picture, laid out by where its facets look:
// across by azimuth, up by elevation, at one scale for both. They're drawn as
// you'd see the bug's face when it faces you: its right eye on the left, its
// left eye on the right, and in each, the side it looks out to on the outside.
import type { Eye, EyeMap } from "@ladybug/brain";

/** One eye's picture: its size, and each facet's centre in it (x, y pairs), CSS px. */
export type EyePicture = { width: number; height: number; points: Float32Array };

export type EyeChart = {
  /** Shown on the left of the panel. */
  right: EyePicture;
  left: EyePicture;
  /** Radius of each facet's dot, CSS px. */
  dot: number;
};

/** Space left around the facets, CSS px. */
const PAD = 3;

/** Azimuth (positive toward the fly's right) and elevation of each facet, radians, unwrapped around the eye's middle. */
function angles(eye: Eye) {
  const { directions } = eye;
  const facets = Math.floor(directions.length / 3);
  let mx = 0, my = 0;
  for (let f = 0; f < facets; f++) { mx += directions[f * 3]; my += directions[f * 3 + 1]; }
  const middle = Math.atan2(mx, my);
  const azimuth = new Float32Array(facets);
  const elevation = new Float32Array(facets);
  for (let f = 0; f < facets; f++) {
    const x = directions[f * 3], y = directions[f * 3 + 1], z = directions[f * 3 + 2];
    let a = Math.atan2(x, y) - middle;
    a -= Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
    azimuth[f] = middle + a;
    elevation[f] = Math.atan2(z, Math.hypot(x, y));
  }
  return { azimuth, elevation };
}

const range = (values: Float32Array) => {
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  return values.length > 0 ? { min, max } : { min: 0, max: 0 };
};

/** Lays both eyes out to fit pictures `width` CSS px wide each. */
export function chartEyes(map: EyeMap, width: number): EyeChart {
  const left = angles(map.left), right = angles(map.right);
  const across = [range(left.azimuth), range(right.azimuth)];
  const up = [range(left.elevation), range(right.elevation)];
  const span = Math.max(...across.map((r) => r.max - r.min), 1e-6);
  const scale = (width - PAD * 2) / span;
  const top = Math.max(up[0].max, up[1].max);
  const height = Math.ceil((top - Math.min(up[0].min, up[1].min)) * scale + PAD * 2);
  const place = (eye: { azimuth: Float32Array; elevation: Float32Array }, { min, max }: { min: number; max: number }): EyePicture => {
    const points = new Float32Array(eye.azimuth.length * 2);
    // The fly's right is on your left as it faces you: azimuth runs leftward.
    // Each eye is centred in its picture.
    const offset = (width - (max - min) * scale) / 2;
    for (let f = 0; f < eye.azimuth.length; f++) {
      points[f * 2] = offset + (max - eye.azimuth[f]) * scale;
      points[f * 2 + 1] = PAD + (top - eye.elevation[f]) * scale;
    }
    return { width, height, points };
  };
  return {
    right: place(right, across[1]),
    left: place(left, across[0]),
    dot: Math.min(2.5, Math.max(0.8, map.acceptance * scale)),
  };
}
