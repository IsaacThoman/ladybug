// Types and constants shared between the server, worker, sandbox, desktop app,
// extension, admin UI and web report page. Browser-safe: no Node imports.

export * from "./scan.ts";
export * from "./sandbox.ts";
export * from "./accounts.ts";

export const DEFAULT_SERVER_PORT = 3001;
/**
 * The hosted Ladybug: API, report pages and admin all live on this origin.
 * Built apps talk to it by default; dev builds use localhost instead.
 */
export const PUBLIC_URL = "https://ladybugg.garden";
export const DEFAULT_WEB_PORT = 5175;

export type HealthResponse = {
  status: "ok";
  uptimeSeconds: number;
  /** Whether the server can reach Typesense and has set up its collections. */
  typesense: "ready" | "unavailable";
};

export type GreetingResponse = {
  message: string;
};

// ---------------------------------------------------------------------------
// URL safety

export type Verdict = "safe" | "unsafe";

/** "url" records match one exact URL, "host" records match every URL on a host. */
export type UrlScope = "url" | "host";

/** Where a verdict came from. */
export type VerdictSource = "seed" | "analysis" | "admin";

/** A URL (or host) the server knows about, stored in Typesense. */
export type UrlRecord = {
  id: string;
  scope: UrlScope;
  url: string;
  host: string;
  verdict: Verdict;
  reason: string;
  source: VerdictSource;
  /** Epoch ms. */
  checkedAt: number;
};

/** Sent by the browser extension for every page the user visits. */
export type CheckRequest = {
  url: string;
  title?: string;
};

export type CheckResponse =
  /** Already known. `verdict` decides whether the pet raises an alert. */
  | { status: "known"; verdict: Verdict; record: UrlRecord }
  /** Unknown: an analysis is running (or was already running) for this URL. */
  | { status: "pending"; url: string; etaMs: number }
  /** Not something we check (non-http, localhost, private network, ...). */
  | { status: "skipped"; reason: string };

// ---------------------------------------------------------------------------
// Desktop pet alerts (server-sent events on /api/pet/stream, event name "alert")

export type AlertLevel = "danger" | "info" | "ok";

export type PetAlert = {
  id: string;
  level: AlertLevel;
  message: string;
  url: string;
  host: string;
  /** Epoch ms. */
  at: number;
  /** The sandbox scan behind this alert, if any. The pet opens its report on click. */
  scanId?: string;
};

// ---------------------------------------------------------------------------
// Activity log

export type LogEventType =
  | "request"
  | "decision"
  | "analysis_started"
  | "analysis_completed"
  | "alert"
  | "admin"
  | "account"
  | "error";

export type Decision = "known_safe" | "known_unsafe" | "unknown" | "skipped";

export type LogEvent = {
  id: string;
  type: LogEventType;
  /** Epoch ms. */
  at: number;
  message: string;
  url?: string;
  host?: string;
  decision?: Decision;
  verdict?: Verdict;
  durationMs?: number;
  /** Extra structured context, shown as JSON in the admin UI. */
  details?: Record<string, unknown>;
};

/** An analysis that's currently running. */
export type PendingAnalysis = {
  url: string;
  host: string;
  startedAt: number;
  etaAt: number;
  /** The sandbox scan doing the analysis, when the server runs real scans. */
  scanId?: string;
};

// ---------------------------------------------------------------------------
// Admin API

export type Page<T> = {
  items: T[];
  found: number;
  page: number;
  perPage: number;
};

export type AdminSummary = {
  typesense: HealthResponse["typesense"];
  urls: { total: number; safe: number; unsafe: number };
  events: { total: number; requests: number; alerts: number };
  pending: PendingAnalysis[];
  petsConnected: number;
  analysisDelayMs: number;
  /** Sign-ups waiting for an admin. */
  pendingAccounts: number;
};

/** `GET /api/admin/session`: whether the admin UI should show its sign-in page. */
export type AdminSession = {
  /** False when the server has no ADMIN_PASSWORD, so admin is open. */
  required: boolean;
  authenticated: boolean;
};

export type AdminLoginRequest = {
  password: string;
};

export type UpdateVerdictRequest = {
  verdict: Verdict;
  reason?: string;
};

/** Windows the admin visits chart can show. */
export const TIMELINE_RANGES = ["1h", "24h", "7d"] as const;
export type TimelineRange = (typeof TIMELINE_RANGES)[number];

/** Visits checked in one time bucket, by what the server decided. */
export type TimelineBucket = {
  /** Bucket start, epoch ms. */
  at: number;
  safe: number;
  unsafe: number;
  /** Unknown URLs, sent off to be analysed. */
  unknown: number;
};

/** GET /api/admin/timeline?range=24h, from the TimescaleDB continuous aggregate. */
export type CheckTimeline =
  | { available: true; range: TimelineRange; bucketMs: number; buckets: TimelineBucket[] }
  /** Postgres doesn't have the timescaledb extension. */
  | { available: false; range: TimelineRange };

// ---------------------------------------------------------------------------
// Scan model (admin setting)

/**
 * The models the worker's LLM endpoint offers. The worker holds the API key,
 * so it lists them and publishes this to Valkey for the server to read.
 */
export type LlmCatalog = {
  /** The endpoint's base URL (LLM_BASE_URL). */
  baseUrl: string;
  /** The worker's LLM_MODEL, used when the admin hasn't picked one. */
  defaultModel: string | null;
  /** Model ids, sorted. Empty when listing failed. */
  models: string[];
  /** Epoch ms. */
  fetchedAt: number;
  /** Why listing failed, if it did. */
  error?: string;
};

/** `GET /api/admin/settings/model`. */
export type AdminModelSettings = {
  /** The model the admin picked. null = the worker's default (LLM_MODEL). */
  selected: string | null;
  /**
   * What the worker has reported. null when no worker with an LLM_API_KEY has
   * checked in recently, so there's nothing to pick from.
   */
  catalog: LlmCatalog | null;
};

/** `PUT /api/admin/settings/model`. null goes back to the worker's default. */
export type UpdateModelRequest = {
  model: string | null;
};

/** Server-sent events on /api/admin/stream. */
export type AdminStreamEvent =
  | { kind: "event"; event: LogEvent }
  | { kind: "pending"; pending: PendingAnalysis[] };

export type { CallPhase, CallState, PreparedCall, FaceTimeApi } from "./calls.ts";
