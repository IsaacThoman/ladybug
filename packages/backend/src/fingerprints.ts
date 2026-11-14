// Page fingerprints in pgvector. Every finished scan stores a vector of its
// page; a new scan looks up its nearest neighbours among pages we flagged, so
// a re-hosted phishing kit is recognised even on a brand-new domain.
import type pg from "pg";
import type { ScanVerdict, SimilarPage } from "@ladybug/shared";
import type { Db } from "./db.ts";

/** Length of every fingerprint vector. Changing it needs a new column. */
export const FINGERPRINT_DIMENSIONS = 512;

export async function setupFingerprints(client: pg.PoolClient) {
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(`
    CREATE TABLE IF NOT EXISTS page_fingerprints (
      scan_id     uuid PRIMARY KEY REFERENCES scans (id) ON DELETE CASCADE,
      url         text NOT NULL,
      host        text NOT NULL,
      title       text,
      verdict     text NOT NULL,
      score       integer NOT NULL,
      embedding   vector(${FINGERPRINT_DIMENSIONS}) NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(
    "CREATE INDEX IF NOT EXISTS page_fingerprints_embedding_idx ON page_fingerprints USING hnsw (embedding vector_cosine_ops)",
  );
}

const toVector = (values: number[]) => `[${values.join(",")}]`;

export async function saveFingerprint(
  db: Db,
  page: { scanId: string; url: string; host: string; title: string | null; verdict: ScanVerdict; score: number; embedding: number[] },
) {
  await db.query(
    `INSERT INTO page_fingerprints (scan_id, url, host, title, verdict, score, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
     ON CONFLICT (scan_id) DO UPDATE SET verdict = EXCLUDED.verdict, score = EXCLUDED.score, embedding = EXCLUDED.embedding`,
    [page.scanId, page.url, page.host, page.title, page.verdict, page.score, toVector(page.embedding)],
  );
}

type SimilarRow = {
  scan_id: string;
  url: string;
  title: string | null;
  verdict: ScanVerdict;
  score: number;
  similarity: number;
  created_at: Date;
};

/** The closest earlier pages that scanned suspicious or malicious, at or above `minSimilarity`. */
export async function findSimilarPages(
  db: Db,
  embedding: number[],
  opts: { excludeScanId: string; minSimilarity: number; limit: number },
): Promise<SimilarPage[]> {
  const { rows } = await db.query<SimilarRow>(
    `SELECT scan_id, url, title, verdict, score, created_at, 1 - (embedding <=> $1::vector) AS similarity
     FROM page_fingerprints
     WHERE verdict <> 'benign' AND scan_id <> $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [toVector(embedding), opts.excludeScanId, opts.limit],
  );
  return rows
    .filter((row) => row.similarity >= opts.minSimilarity)
    .map((row) => ({
      scanId: row.scan_id,
      url: row.url,
      title: row.title,
      verdict: row.verdict,
      score: row.score,
      similarity: Math.round(row.similarity * 1000) / 1000,
      scannedAt: row.created_at.toISOString(),
    }));
}
