// Visit checks as TimescaleDB time-series, for the admin chart. Off (and
// silent) when Postgres has no timescaledb extension.
import { checkTimeline, recordCheck } from "@ladybug/backend";
import type { CheckRow, Db, DbFeatures } from "@ladybug/backend";
import type { CheckTimeline, TimelineRange } from "@ladybug/shared";

let db: Db | null = null;

export function configureChecks(pool: Db, features: DbFeatures) {
  db = features.timescale ? pool : null;
}

/** Best effort: a slow or failing insert never holds up the extension. */
export function recordVisit(check: CheckRow) {
  if (!db) return;
  recordCheck(db, check).catch((error: unknown) => {
    console.error("[ladybug] failed to record check:", error);
  });
}

export const visitTimeline = async (range: TimelineRange): Promise<CheckTimeline> =>
  db ? checkTimeline(db, range) : { available: false, range };
