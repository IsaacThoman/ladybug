// Community reports: signed-in people can say a site is safe or unsafe. One
// vote per account per host, changeable. When Solana is configured, every
// report and every scan verdict is also written to the Computerbug program
// on-chain (see docs/solana.md), so anyone can audit the tallies.
//
// Reports never flip a verdict on their own: they show as a tally, flag the
// record for an admin, and count as one signal in the scan score.

import type { ScanVerdict } from "./scan.ts";
import type { Verdict } from "./index.ts";

/** What a person says about a site. Same words as the URL store's verdicts. */
export type ReportVerdict = Verdict;
export const REPORT_VERDICTS = ["safe", "unsafe"] as const satisfies readonly ReportVerdict[];

/** Where a report's on-chain write stands. "off" when the server has no Solana config. */
export type ChainStatus = "off" | "pending" | "confirmed" | "failed";

/** Solana cluster the server writes to. */
export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

/** Where to look a site up on-chain. */
export type SiteChainInfo = {
  cluster: SolanaCluster;
  programId: string;
  /** The site's PDA (base58). */
  siteAddress: string;
  /** Solana Explorer link for the site account. */
  explorerUrl: string;
};

/** The latest sandbox scan verdict written on-chain for a host. */
export type ChainScan = {
  verdict: ScanVerdict;
  score: number;
  /** SHA-256 of the report JSON, hex. */
  reportHash: string;
  /** ISO 8601. */
  scannedAt: string;
  /** Transaction signature, when known. */
  signature: string | null;
  explorerUrl: string | null;
};

/** `GET /api/reports?url=…` (signed in or not) and the body of `POST /api/reports`. */
export type CommunityTally = {
  host: string;
  safe: number;
  unsafe: number;
  /** The signed-in account's own vote, if any. Absent when signed out. */
  mine?: MyReport | null;
  /** null when the server has no Solana config. */
  chain: SiteChainInfo | null;
  /** The latest scan verdict recorded on-chain, if any. */
  lastScan: ChainScan | null;
};

export type MyReport = {
  verdict: ReportVerdict;
  /** ISO 8601. */
  reportedAt: string;
  chainStatus: ChainStatus;
  /** Transaction signature once sent. */
  signature: string | null;
  explorerUrl: string | null;
};

/** `POST /api/reports`: approved account. Responds with the updated `CommunityTally`. */
export type CreateReportRequest = {
  url: string;
  verdict: ReportVerdict;
};

/** One row in the admin URL database's community column, and `GET /api/admin/reports`. */
export type AdminSiteReports = {
  host: string;
  safe: number;
  unsafe: number;
  /** ISO 8601: the newest report. */
  lastReportAt: string;
  /** What the URL store says now, if it knows the host or a URL on it. */
  verdict: Verdict | null;
  /** The community disagrees with the stored verdict (or there is none yet): worth a look. */
  needsReview: boolean;
};

/** `GET /api/admin/reports?limit=50`: hosts with reports, newest first. */
export type AdminReportsResponse = { sites: AdminSiteReports[] };

/** Accounts needed before community "unsafe" reports count as a scan signal. */
export const COMMUNITY_SIGNAL_MIN_REPORTS = 3;
