import { findSimilarPages, saveFingerprint } from "@ladybug/backend";
import type { Db } from "@ladybug/backend";
import type { ScanReport, SimilarPage } from "@ladybug/shared";
import { THRESHOLDS } from "../scoring/weights.ts";

const MAX_SIMILAR = 3;

/** Where fingerprints live. The pipeline runs without one (CLI, or Postgres without pgvector). */
export type SimilarityStore = {
  find(scanId: string, fingerprint: number[]): Promise<SimilarPage[]>;
  save(report: ScanReport, title: string | null, fingerprint: number[]): Promise<void>;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export function pgSimilarityStore(db: Db): SimilarityStore {
  return {
    find: (scanId, fingerprint) =>
      findSimilarPages(db, fingerprint, { excludeScanId: scanId, minSimilarity: THRESHOLDS.similarPage, limit: MAX_SIMILAR }),
    save: (report, title, fingerprint) =>
      saveFingerprint(db, {
        scanId: report.scanId,
        url: report.finalUrl,
        host: hostOf(report.finalUrl),
        title,
        verdict: report.verdict,
        score: report.score,
        embedding: fingerprint,
      }),
  };
}
