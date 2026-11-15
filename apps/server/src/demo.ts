import { DEMO_DEFAULT_HOLD_SECONDS, DEMO_MIN_HOLD_SECONDS } from "@ladybug/shared";
import type { UrlRecord } from "@ladybug/shared";

/**
 * Demo staging: an unsafe record with `demoDelaySeconds` set acts unknown when
 * visited. A pretend analysis runs for that long, then reveals the stored
 * verdict. The record then counts as plainly known-unsafe for
 * `demoHoldSeconds`, and stages again after that, so the demo can be repeated.
 */

/**
 * Until when each revealed demo record counts as known-unsafe, epoch ms by
 * record id. In memory: a restart stages every demo record again.
 */
const revealed = new Map<string, number>();

export const isDemoRecord = (record: UrlRecord) =>
  record.verdict === "unsafe" && typeof record.demoDelaySeconds === "number";

/** Until when a demo record counts as revealed, or undefined if it's staged. */
export function demoRevealedUntil(record: UrlRecord, now = Date.now()) {
  const until = revealed.get(record.id);
  if (until === undefined) return undefined;
  if (until > now) return until;
  revealed.delete(record.id);
  return undefined;
}

/** How long a visit's pretend analysis should take, or null to answer from the record right away. */
export function demoDelayMs(record: UrlRecord, now = Date.now()) {
  if (!isDemoRecord(record) || demoRevealedUntil(record, now) !== undefined) return null;
  return record.demoDelaySeconds! * 1000;
}

/** The pretend analysis revealed the verdict: hold it for `demoHoldSeconds`. */
export function markDemoRevealed(record: UrlRecord, now = Date.now()) {
  const holdSeconds = Math.max(DEMO_MIN_HOLD_SECONDS, record.demoHoldSeconds ?? DEMO_DEFAULT_HOLD_SECONDS);
  revealed.set(record.id, now + holdSeconds * 1000);
}

/** Stages a record again straight away, e.g. after an admin changes or clears its demo settings. */
export const resetDemoReveal = (id: string) => void revealed.delete(id);

/** The record with its demo staging taken off. */
export function withoutDemo(record: UrlRecord): UrlRecord {
  const copy = { ...record };
  delete copy.demoDelaySeconds;
  delete copy.demoHoldSeconds;
  delete copy.demoRevealedUntil;
  return copy;
}

/** The record with its reveal window filled in, for the admin UI. */
export function withDemoState(record: UrlRecord, now = Date.now()): UrlRecord {
  if (!isDemoRecord(record)) return record;
  const until = demoRevealedUntil(record, now);
  return until === undefined ? record : { ...record, demoRevealedUntil: until };
}
