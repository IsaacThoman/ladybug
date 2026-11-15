// Shared by the brain tests; not used by the app.
import type { BrainCommand, BrainSenses, BrainState, EyeMap } from "@ladybug/brain";

export const RESTING: BrainSenses = {
  loomLeft: 0,
  loomRight: 0,
  touch: 0,
  bumpLeft: 0,
  bumpRight: 0,
  wind: 0,
  sweet: 0,
  grounded: true,
};

export const STILL: BrainCommand = { walk: 0, turn: 0, back: 0, escape: 0, wings: 0, groom: 0, feed: 0 };

export const command = (values: Partial<BrainCommand>): BrainCommand => ({ ...STILL, ...values });

export const stateWith = (values: Partial<BrainCommand>, stats: Partial<BrainState["stats"]> = {}): BrainState => ({
  command: command(values),
  stats: { simMs: 16, wallMs: 3, spikes: 100, active: 10, rates: {}, ...stats },
});

const DEG = Math.PI / 180;

/**
 * A stand-in for the brain's eyes: a facet every `spacing` degrees, from 10°
 * across the midline to 160° round to its own side, and from 50° below the
 * horizon to 70° above it. About 875 facets an eye at 5°.
 */
export function latticeEyes(spacing = 5, acceptance = 2.5): EyeMap {
  const eye = (side: 1 | -1) => {
    const directions: number[] = [];
    for (let elevation = -50; elevation <= 70; elevation += spacing) {
      for (let azimuth = -10; azimuth <= 160; azimuth += spacing) {
        const a = azimuth * DEG, e = elevation * DEG;
        directions.push(side * Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
      }
    }
    return { directions: new Float32Array(directions) };
  };
  return { left: eye(-1), right: eye(1), acceptance: acceptance * DEG };
}

/** Eyes with one facet each, looking these ways (head frame). */
export function facetEyes(left: [number, number, number], right: [number, number, number] = left, acceptance = 2.5 * DEG): EyeMap {
  const unit = (v: [number, number, number]) => { const l = Math.hypot(...v); return new Float32Array(v.map((c) => c / l)); };
  return { left: { directions: unit(left) }, right: { directions: unit(right) }, acceptance };
}
