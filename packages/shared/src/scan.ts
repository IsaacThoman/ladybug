// Scan pipeline types: what the API, the worker, the report page and the pet
// all agree on.

export const SCAN_STATUSES = [
  "queued",
  "provisioning",
  "detonating",
  "investigating",
  "scoring",
  "done",
  "failed",
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ScanStatus[] = ["done", "failed"];
export const isTerminalStatus = (status: ScanStatus) => TERMINAL_STATUSES.includes(status);

export type Verdict = "benign" | "suspicious" | "malicious";
export type Confidence = "low" | "medium" | "high";
export type Severity = "info" | "low" | "medium" | "high";

export const SCAN_CATEGORIES = [
  "phishing",
  "malware_delivery",
  "scam",
  "cryptojacking",
  "cloaking",
  "prompt_injection",
  "brand_impersonation",
  "tech_support_scam",
  "fake_captcha",
  "notification_spam",
] as const;
export type ScanCategory = (typeof SCAN_CATEGORIES)[number];

export type Finding = {
  title: string;
  severity: Severity;
  evidence: string;
  /** Artifact keys (screenshots, HAR slices, files). Fetch via /api/scans/:id/artifacts/:key. */
  artifactKeys: string[];
};

/** A hard signal that fed the score. */
export type ScoreSignal = {
  id: string;
  label: string;
  /** Points added to signalScore. 0 for floor-only signals. */
  weight: number;
  /** If set, the final score is at least this. */
  floor?: number;
  evidence: string;
};

export type Screenshot = {
  artifactKey: string;
  /** e.g. "t+0s", "t+10s", "mobile", "agent". */
  label: string;
};

export type DomainInfo = {
  hostname: string;
  registrableDomain: string | null;
  registeredAt: string | null;
  ageDays: number | null;
  registrar: string | null;
  ips: string[];
  /** Hosting network, from a reverse lookup of the first IP. */
  asn: string | null;
  /** Certificates crt.sh has seen for the domain. */
  certificateCount: number | null;
  firstCertificateAt: string | null;
  /** Punycode / mixed-script / brand look-alike notes. */
  lookalike: string | null;
};

export type Iocs = { domains: string[]; ips: string[]; urls: string[]; sha256: string[] };

/**
 * Flags on a report that explain how it was produced:
 * - llm_skipped: no model endpoint configured, signal-only score
 * - llm_refused: the model declined, signal-only score
 * - llm_failed: the agent loop errored, signal-only score
 * - navigation_failed: the page never loaded
 */
export type ReportFlag = "llm_skipped" | "llm_refused" | "llm_failed" | "navigation_failed";

export type ScanReport = {
  scanId: string;
  inputUrl: string;
  finalUrl: string;
  redirectChain: string[];
  /** 0–100, final. */
  score: number;
  /** From hard signals. */
  signalScore: number;
  /** From the agent. null when the agent didn't produce one. */
  llmScore: number | null;
  verdict: Verdict;
  confidence: Confidence;
  categories: string[];
  findings: Finding[];
  signals: ScoreSignal[];
  iocs: Iocs;
  summary: string;
  screenshots: Screenshot[];
  domain: DomainInfo | null;
  flags: ReportFlag[];
  startedAt: string;
  finishedAt: string;
};

export type ScanEvent =
  | { type: "status"; status: ScanStatus; at: string; message?: string }
  | { type: "screenshot"; artifactKey: string; label: string; at: string }
  | { type: "finding"; finding: Finding; at: string }
  | { type: "agent_note"; text: string; at: string }
  /** The agent called a tool. `summary` is a one-line description for the live view. */
  | { type: "tool_call"; tool: string; summary: string; at: string }
  | { type: "signal"; signal: ScoreSignal; at: string }
  | { type: "redirect_chain"; chain: string[]; at: string }
  | { type: "report"; score: number; verdict: Verdict; at: string };

export type ScanEventType = ScanEvent["type"];

// ---------------------------------------------------------------------------
// HTTP API

export type CreateScanRequest = { url: string };
export type CreateScanResponse = { scanId: string };

export type ScanResponse = {
  scanId: string;
  inputUrl: string;
  status: ScanStatus;
  createdAt: string;
  updatedAt: string;
  report: ScanReport | null;
  error: string | null;
};

export type ScanListItem = Omit<ScanResponse, "report"> & {
  score: number | null;
  verdict: Verdict | null;
  finalUrl: string | null;
};
/** GET /api/scans?limit=20 — most recent first. */
export type ScanListResponse = { scans: ScanListItem[] };

export type ApiError = { error: string };

/** Header carrying the API key on POST /api/scans. Reads don't need it: scan ids are unguessable. */
export const API_KEY_HEADER = "x-api-key";

/**
 * Path of an artifact, relative to the API base URL. Keys contain slashes, so
 * they travel as one encoded path segment. The route redirects to a presigned
 * Object Storage URL (or streams the file in local dev), so it works as an
 * <img src>.
 */
export const artifactPath = (scanId: string, key: string) =>
  `/api/scans/${encodeURIComponent(scanId)}/artifacts/${encodeURIComponent(key)}`;

/**
 * SSE stream of a scan's events: GET /api/scans/:id/events. Each message's
 * `data` is one ScanEvent as JSON and its `id` is the Valkey Stream entry id
 * (Last-Event-ID resumes). The stream replays from the start, then follows
 * live, and the server ends it after a terminal status event; clients should
 * close their EventSource when they see one so it doesn't reconnect.
 */
export const eventsPath = (scanId: string) => `/api/scans/${encodeURIComponent(scanId)}/events`;

/** BullMQ job payload. */
export type ScanJob = { scanId: string; url: string };

// ---------------------------------------------------------------------------
// Infrastructure names. Server and worker must agree on these.

export const SCAN_QUEUE = "scans";
/** Valkey Stream holding a scan's events. Each entry has one field, `event`, holding JSON. */
export const scanStreamKey = (scanId: string) => `scan:${scanId}`;
export const SCAN_STREAM_TTL_SECONDS = 60 * 60 * 24;

/** Postgres schema. Both the server and the worker run this on startup. */
export const SCANS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scans (
  id          uuid PRIMARY KEY,
  input_url   text NOT NULL,
  status      text NOT NULL,
  api_key     text,
  report      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scans_created_at_idx ON scans (created_at DESC);
`;

/** Verdict thresholds: under 30 benign, 30–69 suspicious, 70+ malicious. */
export function verdictForScore(score: number): Verdict {
  if (score >= 70) return "malicious";
  if (score >= 30) return "suspicious";
  return "benign";
}
