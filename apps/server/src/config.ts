import path from "node:path";
import { DEFAULT_SERVER_PORT } from "@ladybug/shared";

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const config = {
  port: numberFromEnv("PORT", DEFAULT_SERVER_PORT),
  typesenseUrl: process.env.TYPESENSE_URL ?? "http://localhost:8108",
  typesenseApiKey: process.env.TYPESENSE_API_KEY ?? "ladybug-dev-key",
  /**
   * How unknown URLs from the extension get analysed: "scan" runs a full
   * sandbox scan through the worker; "placeholder" waits ANALYSIS_DELAY_MS and
   * applies naive URL heuristics (no Postgres / Valkey / worker needed).
   */
  analyzer: (process.env.ANALYZER === "placeholder" ? "placeholder" : "scan") as "scan" | "placeholder",
  /** How long the placeholder analysis "thinks" before deciding. */
  analysisDelayMs: numberFromEnv("ANALYSIS_DELAY_MS", 30_000),
  /** Expected sandbox scan duration, for the ETA shown to the extension and admin UI. */
  scanEtaMs: numberFromEnv("SCAN_ETA_MS", 90_000),
  /** Give up waiting on a sandbox scan after this long. */
  scanTimeoutMs: numberFromEnv("SCAN_WAIT_TIMEOUT_MS", 10 * 60_000),
  /** Keys allowed to start scans (x-api-key). Empty = no auth. */
  apiKeys: (process.env.API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  rateLimitPerMinute: numberFromEnv("RATE_LIMIT_PER_MINUTE", 10),
  /** Reverse proxies in front of the server: 2 on Kubernetes (edge, then the web nginx). */
  trustProxyHops: numberFromEnv("TRUST_PROXY_HOPS", 1),
  /** Built admin UI, served at /admin when it exists. */
  adminDist:
    process.env.ADMIN_DIST ?? path.resolve(import.meta.dirname, "../../admin/dist"),
};
