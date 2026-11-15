import pg from "pg";
import { SCANS_TABLE_SQL } from "@ladybug/shared";
import type { ScanReport, ScanResponse, ScanStatus } from "@ladybug/shared";
import { setupAccounts } from "./accounts.ts";
import { setupChecks } from "./checks.ts";
import { setupFingerprints } from "./fingerprints.ts";
import { setupReports } from "./reports.ts";
import { setupSettings } from "./settings.ts";

export type Db = pg.Pool;

/**
 * Optional Postgres extensions the app uses when they're there. Tiger Cloud
 * and the timescale/timescaledb image have both; plain Postgres has neither,
 * and scans still work without them.
 */
export type DbFeatures = {
  /** TimescaleDB: the url_checks hypertable and its continuous aggregate. */
  timescale: boolean;
  /** pgvector: page fingerprints for "looks like a page we flagged". */
  vector: boolean;
};

type ScanRow = {
  id: string;
  input_url: string;
  status: ScanStatus;
  report: ScanReport | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

export function createDb(): Db {
  const connectionString = process.env.DATABASE_URL ?? "postgres://ladybug:ladybug@localhost:5432/ladybug";
  const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString, ssl, max: 10 });
}

// Any constant works; it just has to be the same in the server and the worker.
const MIGRATION_LOCK = 0x1adb09;

async function tryFeature(client: pg.PoolClient, name: string, setup: (client: pg.PoolClient) => Promise<void>) {
  try {
    await setup(client);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[db] ${name} unavailable, carrying on without it: ${reason}`);
    return false;
  }
}

/**
 * Creates the schema. The server and the worker both run this on startup, so
 * it holds an advisory lock: two CREATE EXTENSIONs racing each other fail.
 */
export async function migrate(db: Db): Promise<DbFeatures> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(SCANS_TABLE_SQL);
    await setupAccounts(client);
    await setupSettings(client);
    await setupReports(client);
    const timescale = await tryFeature(client, "TimescaleDB", setupChecks);
    const vector = await tryFeature(client, "pgvector", setupFingerprints);
    return { timescale, vector };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

const toResponse = (row: ScanRow): ScanResponse => ({
  scanId: row.id,
  inputUrl: row.input_url,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  report: row.report,
  error: row.error,
});

export async function insertScan(
  db: Db,
  scan: { id: string; inputUrl: string; apiKey: string | null; userId?: string | null },
) {
  await db.query("INSERT INTO scans (id, input_url, status, api_key, user_id) VALUES ($1, $2, 'queued', $3, $4)", [
    scan.id,
    scan.inputUrl,
    scan.apiKey,
    scan.userId ?? null,
  ]);
}

export async function getScan(db: Db, id: string): Promise<ScanResponse | null> {
  const { rows } = await db.query<ScanRow>("SELECT * FROM scans WHERE id = $1", [id]);
  return rows[0] ? toResponse(rows[0]) : null;
}

/** The newest scans one user started (or that their visits started). */
export async function listScans(db: Db, userId: string, limit: number): Promise<ScanResponse[]> {
  const { rows } = await db.query<ScanRow>(
    "SELECT * FROM scans WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map(toResponse);
}

export async function setScanStatus(db: Db, id: string, status: ScanStatus, error: string | null = null) {
  await db.query("UPDATE scans SET status = $2, error = $3, updated_at = now() WHERE id = $1", [id, status, error]);
}

export async function saveReport(db: Db, id: string, report: ScanReport) {
  await db.query("UPDATE scans SET status = 'done', report = $2, error = NULL, updated_at = now() WHERE id = $1", [
    id,
    JSON.stringify(report),
  ]);
}

/** A scan row for the admin Sandboxes page: who started it, and the bits of the report a tile shows. */
export type SandboxScanRow = {
  scanId: string;
  inputUrl: string;
  status: ScanStatus;
  /** The account's username, "API key", or null (an admin check). */
  startedBy: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  report: Pick<ScanReport, "finalUrl" | "verdict" | "score" | "summary" | "screenshots" | "finishedAt"> | null;
};

type SandboxRow = {
  id: string;
  input_url: string;
  status: ScanStatus;
  started_by: string | null;
  created_at: Date;
  updated_at: Date;
  error: string | null;
  report: SandboxScanRow["report"];
};

const SANDBOX_COLUMNS = `
  s.id, s.input_url, s.status, s.error, s.created_at, s.updated_at,
  coalesce(u.username, CASE WHEN s.api_key IS NOT NULL THEN 'API key' END) AS started_by,
  CASE WHEN s.report IS NULL THEN NULL ELSE jsonb_build_object(
    'finalUrl', s.report->'finalUrl', 'verdict', s.report->'verdict', 'score', s.report->'score',
    'summary', s.report->'summary', 'screenshots', s.report->'screenshots', 'finishedAt', s.report->'finishedAt'
  ) END AS report`;

const toSandboxRow = (row: SandboxRow): SandboxScanRow => ({
  scanId: row.id,
  inputUrl: row.input_url,
  status: row.status,
  startedBy: row.started_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  error: row.error,
  report: row.report,
});

/**
 * Every scan across all users that hasn't finished (from the last day, as
 * long as its event stream lives), and the newest `limit` that have.
 */
export async function listSandboxScans(db: Db, limit: number) {
  const [running, finished] = await Promise.all([
    db.query<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM scans s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.status NOT IN ('done', 'failed') AND s.created_at > now() - interval '1 day'
       ORDER BY s.created_at DESC LIMIT 200`,
    ),
    db.query<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM scans s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.status IN ('done', 'failed')
       ORDER BY s.created_at DESC LIMIT $1`,
      [limit + 1],
    ),
  ]);
  return {
    running: running.rows.map(toSandboxRow),
    finished: finished.rows.slice(0, limit).map(toSandboxRow),
    moreFinished: finished.rows.length > limit,
  };
}
