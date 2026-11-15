import type { PetFocus } from "@ladybug/shared";
import { onPendingChange, pendingAnalysis } from "./analyzer.ts";
import { petChannel } from "./sse.ts";
import { normalizeUrl } from "./urls.ts";

/**
 * Which page each user has open in their browser's active tab, as their
 * extension last reported it, so their pets can tell when the page in front
 * of them is the one being checked.
 */
export class FocusTracker {
  /** Normalised active-tab URL per user id. */
  private readonly active = new Map<string, string>();
  /** What each user's pets were last told, to skip repeats. */
  private readonly told = new Map<string, string>();

  private readonly isPending: (url: string) => boolean;
  private readonly send: (userId: string, focus: PetFocus) => void;

  constructor(isPending: (url: string) => boolean, send: (userId: string, focus: PetFocus) => void) {
    this.isPending = isPending;
    this.send = send;
  }

  /** The extension reported a new active tab (null: none worth checking). */
  set(userId: string, rawUrl: string | null) {
    const target = rawUrl === null ? null : normalizeUrl(rawUrl);
    if (target?.ok) this.active.set(userId, target.url);
    else this.active.delete(userId);
    this.publish(userId);
  }

  /** What a user's pets should show right now. */
  of(userId: string): PetFocus {
    const url = this.active.get(userId) ?? null;
    return { url, investigating: url !== null && this.isPending(url) };
  }

  /** An analysis of `url` started or ended: tell whoever has it open. */
  pendingChanged(url: string) {
    for (const [userId, active] of this.active) if (active === url) this.publish(userId);
  }

  /** Forgets a user, e.g. when they lose access. */
  forget(userId: string) {
    this.active.delete(userId);
    this.told.delete(userId);
  }

  private publish(userId: string) {
    const focus = this.of(userId);
    const key = JSON.stringify(focus);
    if (this.told.get(userId) === key) return;
    this.told.set(userId, key);
    this.send(userId, focus);
  }
}

export const focus = new FocusTracker(
  (url) => pendingAnalysis(url) !== undefined,
  (userId, value) => petChannel.sendTo(userId, "focus", value),
);
onPendingChange((url) => focus.pendingChanged(url));
