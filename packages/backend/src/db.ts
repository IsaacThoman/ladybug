import pg from "pg";
import { SCANS_TABLE_SQL } from "@ladybug/shared";
import type { ScanReport, ScanResponse, ScanStatus } from "@ladybug/shared";

export type Db = pg.Pool;

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

export async function migrate(db: Db) {
  await db.query(SCANS_TABLE_SQL);
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

export async function insertScan(db: Db, scan: { id: string; inputUrl: string; apiKey: string | null }) {
  await db.query("INSERT INTO scans (id, input_url, status, api_key) VALUES ($1, $2, 'queued', $3)", [
    scan.id,
    scan.inputUrl,
    scan.apiKey,
  ]);
}

export async function getScan(db: Db, id: string): Promise<ScanResponse | null> {
  const { rows } = await db.query<ScanRow>("SELECT * FROM scans WHERE id = $1", [id]);
  return rows[0] ? toResponse(rows[0]) : null;
}

export async function listScans(db: Db, limit: number): Promise<ScanResponse[]> {
  const { rows } = await db.query<ScanRow>("SELECT * FROM scans ORDER BY created_at DESC LIMIT $1", [limit]);
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
