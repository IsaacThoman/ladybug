// Shared by the brain tests; not used by the app.
import type { BrainCommand, BrainSenses, BrainState } from "@ladybug/brain";

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
