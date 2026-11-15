// Community reports: one vote per account per host, plus the scan verdicts the
// server notarised on Solana (see docs/solana.md). Only the server sees the
// full URLs; on-chain they are hashed.
import type pg from "pg";
import type { ChainStatus, ReportVerdict, ScanVerdict } from "@ladybug/shared";
import type { Db } from "./db.ts";

export const REPORTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS site_reports (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  host          text NOT NULL,
  url           text NOT NULL,
  verdict       text NOT NULL,
  chain_status  text NOT NULL DEFAULT 'off',
  signature     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, host)
);
CREATE INDEX IF NOT EXISTS site_reports_host_idx ON site_reports (host);
CREATE INDEX IF NOT EXISTS site_reports_updated_idx ON site_reports (updated_at DESC);
-- The latest record_scan the chain confirmed for each host, for its signature.
CREATE TABLE IF NOT EXISTS site_scans (
  host         text PRIMARY KEY,
  scan_id      uuid,
  verdict      text NOT NULL,
  score        integer NOT NULL,
  report_hash  text NOT NULL,
  signature    text NOT NULL,
  scanned_at   timestamptz NOT NULL
);
`;

export async function setupReports(client: pg.PoolClient) {
  await client.query(REPORTS_TABLE_SQL);
}

export type SiteReport = {
  userId: string;
  host: string;
  url: string;
  verdict: ReportVerdict;
  chainStatus: ChainStatus;
  signature: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportCounts = {
  safe: number;
  unsafe: number;
  /** Reports still on their way to the chain. */
  pending: number;
};

export type ReportedSite = { host: string; safe: number; unsafe: number; lastReportAt: string };

export type NotarisedScan = {
  host: string;
  scanId: string | null;
  verdict: ScanVerdict;
  score: number;
  /** Hex. */
  reportHash: string;
  signature: string;
  scannedAt: string;
};

/** Where reports live. Postgres in the server; in memory in tests. */
export type ReportStore = {
  /** Creates or changes the account's vote on the host. */
  upsert(report: Pick<SiteReport, "userId" | "host" | "url" | "verdict" | "chainStatus">): Promise<SiteReport>;
  /** Records how the on-chain write went, unless the vote changed since it was sent. */
  setChainStatus(
    userId: string,
    host: string,
    verdict: ReportVerdict,
    status: ChainStatus,
    signature: string | null,
  ): Promise<void>;
  /** Votes from approved accounts. */
  counts(host: string): Promise<ReportCounts>;
  mine(userId: string, host: string): Promise<SiteReport | null>;
  /** Hosts with reports, the newest report first. */
  sites(limit: number): Promise<ReportedSite[]>;
  saveScan(scan: NotarisedScan): Promise<void>;
  latestScan(host: string): Promise<NotarisedScan | null>;
};

type ReportRow = {
  user_id: string;
  host: string;
  url: string;
  verdict: ReportVerdict;
  chain_status: ChainStatus;
  signature: string | null;
  created_at: Date;
  updated_at: Date;
};

type ScanRow = {
  host: string;
  scan_id: string | null;
  verdict: ScanVerdict;
  score: number;
  report_hash: string;
  signature: string;
  scanned_at: Date;
};

const toReport = (row: ReportRow): SiteReport => ({
  userId: row.user_id,
  host: row.host,
  url: row.url,
  verdict: row.verdict,
  chainStatus: row.chain_status,
  signature: row.signature,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toScan = (row: ScanRow): NotarisedScan => ({
  host: row.host,
  scanId: row.scan_id,
  verdict: row.verdict,
  score: row.score,
  reportHash: row.report_hash,
  signature: row.signature,
  scannedAt: row.scanned_at.toISOString(),
});

// Rejected accounts' votes stay in the table but stop counting.
const APPROVED = "JOIN users u ON u.id = r.user_id AND u.status = 'approved'";

export function createReportStore(db: Db): ReportStore {
  return {
    async upsert({ userId, host, url, verdict, chainStatus }) {
      const { rows } = await db.query<ReportRow>(
        `INSERT INTO site_reports (user_id, host, url, verdict, chain_status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, host) DO UPDATE SET
           url = EXCLUDED.url, verdict = EXCLUDED.verdict, chain_status = EXCLUDED.chain_status,
           signature = NULL, updated_at = now()
         RETURNING *`,
        [userId, host, url, verdict, chainStatus],
      );
      return toReport(rows[0]!);
    },

    async setChainStatus(userId, host, verdict, status, signature) {
      await db.query(
        "UPDATE site_reports SET chain_status = $4, signature = $5 WHERE user_id = $1 AND host = $2 AND verdict = $3",
        [userId, host, verdict, status, signature],
      );
    },

    async counts(host) {
      const { rows } = await db.query<ReportCounts>(
        `SELECT count(*) FILTER (WHERE r.verdict = 'safe')::int AS safe,
                count(*) FILTER (WHERE r.verdict = 'unsafe')::int AS unsafe,
                count(*) FILTER (WHERE r.chain_status = 'pending')::int AS pending
         FROM site_reports r ${APPROVED} WHERE r.host = $1`,
        [host],
      );
      return rows[0] ?? { safe: 0, unsafe: 0, pending: 0 };
    },

    async mine(userId, host) {
      const { rows } = await db.query<ReportRow>("SELECT * FROM site_reports WHERE user_id = $1 AND host = $2", [
        userId,
        host,
      ]);
      return rows[0] ? toReport(rows[0]) : null;
    },

    async sites(limit) {
      const { rows } = await db.query<{ host: string; safe: number; unsafe: number; last_report_at: Date }>(
        `SELECT r.host,
                count(*) FILTER (WHERE r.verdict = 'safe')::int AS safe,
                count(*) FILTER (WHERE r.verdict = 'unsafe')::int AS unsafe,
                max(r.updated_at) AS last_report_at
         FROM site_reports r ${APPROVED}
         GROUP BY r.host ORDER BY last_report_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        host: row.host,
        safe: row.safe,
        unsafe: row.unsafe,
        lastReportAt: row.last_report_at.toISOString(),
      }));
    },

    async saveScan(scan) {
      await db.query(
        `INSERT INTO site_scans (host, scan_id, verdict, score, report_hash, signature, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (host) DO UPDATE SET
           scan_id = EXCLUDED.scan_id, verdict = EXCLUDED.verdict, score = EXCLUDED.score,
           report_hash = EXCLUDED.report_hash, signature = EXCLUDED.signature, scanned_at = EXCLUDED.scanned_at`,
        [scan.host, scan.scanId, scan.verdict, scan.score, scan.reportHash, scan.signature, scan.scannedAt],
      );
    },

    async latestScan(host) {
      const { rows } = await db.query<ScanRow>("SELECT * FROM site_scans WHERE host = $1", [host]);
      return rows[0] ? toScan(rows[0]) : null;
    },
  };
}

/**
 * Approved accounts that reported the host unsafe, for the worker's scan
 * signal. 0 when the table isn't there yet.
 */
export async function countUnsafeReporters(db: Db, host: string) {
  try {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(DISTINCT r.user_id)::int AS count FROM site_reports r ${APPROVED}
       WHERE r.host = $1 AND r.verdict = 'unsafe'`,
      [host],
    );
    return rows[0]?.count ?? 0;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return 0;
    throw err;
  }
}
