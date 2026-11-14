// Every visit the server checks, as TimescaleDB time-series: a hypertable of
// raw checks, compressed after a week and dropped after 90 days, plus a
// continuous aggregate of 5-minute counts that the admin chart reads.
import type pg from "pg";
import type { CheckTimeline, Decision, TimelineRange } from "@ladybug/shared";
import type { Db } from "./db.ts";

const HOUR_MS = 60 * 60_000;

/** How far back each chart range looks, and how wide its bars are. */
export const TIMELINE_WINDOWS: Record<TimelineRange, { spanMs: number; bucketMs: number }> = {
  "1h": { spanMs: HOUR_MS, bucketMs: 5 * 60_000 },
  "24h": { spanMs: 24 * HOUR_MS, bucketMs: HOUR_MS },
  "7d": { spanMs: 7 * 24 * HOUR_MS, bucketMs: 6 * HOUR_MS },
};

export async function setupChecks(client: pg.PoolClient) {
  await client.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
  await client.query(`
    CREATE TABLE IF NOT EXISTS url_checks (
      at           timestamptz NOT NULL DEFAULT now(),
      url          text NOT NULL,
      host         text NOT NULL,
      decision     text NOT NULL,
      origin       text NOT NULL,
      duration_ms  integer
    )`);
  await client.query("SELECT create_hypertable('url_checks', by_range('at', INTERVAL '1 day'), if_not_exists => TRUE)");

  const { rows } = await client.query<{ compression_enabled: boolean }>(
    "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'url_checks'",
  );
  if (!rows[0]?.compression_enabled) {
    await client.query(
      "ALTER TABLE url_checks SET (timescaledb.compress, timescaledb.compress_segmentby = 'decision', timescaledb.compress_orderby = 'at DESC')",
    );
  }
  await client.query("SELECT add_compression_policy('url_checks', INTERVAL '7 days', if_not_exists => TRUE)");
  await client.query("SELECT add_retention_policy('url_checks', INTERVAL '90 days', if_not_exists => TRUE)");

  // Real-time (materialized_only = false): the newest, not yet materialized
  // rows are read from the hypertable, so the chart is live.
  await client.query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS url_checks_5m
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT time_bucket(INTERVAL '5 minutes', at) AS bucket, decision, count(*) AS checks
    FROM url_checks
    GROUP BY bucket, decision
    WITH NO DATA`);
  // Refresh a little more than the widest chart range.
  await client.query(`
    SELECT add_continuous_aggregate_policy('url_checks_5m',
      start_offset => INTERVAL '8 days',
      end_offset => INTERVAL '5 minutes',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => TRUE)`);
}

export type CheckRow = {
  url: string;
  host: string;
  decision: Decision;
  origin: string;
  durationMs?: number;
};

export async function recordCheck(db: Db, check: CheckRow) {
  await db.query("INSERT INTO url_checks (url, host, decision, origin, duration_ms) VALUES ($1, $2, $3, $4, $5)", [
    check.url,
    check.host,
    check.decision,
    check.origin,
    check.durationMs ?? null,
  ]);
}

type TimelineRow = { t: Date; safe: number; unsafe: number; unknown: number };

/** Visits per bucket over the range, gap-filled with zeros. Oldest first. */
export async function checkTimeline(db: Db, range: TimelineRange): Promise<CheckTimeline> {
  const { spanMs, bucketMs } = TIMELINE_WINDOWS[range];
  const { rows } = await db.query<TimelineRow>(
    `SELECT time_bucket_gapfill($1::float8 * INTERVAL '1 millisecond', bucket) AS t,
       coalesce(sum(checks) FILTER (WHERE decision = 'known_safe'), 0)::int AS safe,
       coalesce(sum(checks) FILTER (WHERE decision = 'known_unsafe'), 0)::int AS unsafe,
       coalesce(sum(checks) FILTER (WHERE decision = 'unknown'), 0)::int AS unknown
     FROM url_checks_5m
     WHERE bucket >= now() - $2::float8 * INTERVAL '1 millisecond' AND bucket < now()
     GROUP BY t
     ORDER BY t`,
    [bucketMs, spanMs],
  );
  return {
    available: true,
    range,
    bucketMs,
    buckets: rows.map((row) => ({ at: row.t.getTime(), safe: row.safe, unsafe: row.unsafe, unknown: row.unknown })),
  };
}
