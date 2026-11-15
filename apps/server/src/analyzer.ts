import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isIP } from "node:net";
import type { AdminStreamEvent, PendingAnalysis, ScanReport, Verdict } from "@ladybug/shared";
import { logEvent, sendPetAlert } from "./activity.ts";
import type { AlertRecipient } from "./activity.ts";
import { config } from "./config.ts";
import { createScan, waitForScan } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";
import { adminChannel } from "./sse.ts";
import { saveRecord } from "./store.ts";
import { notifyUnsafeVisit } from "./support/service.ts";
import { normaliseScanUrl } from "./validate.ts";

let scanDeps: ScanDeps | null = null;

/** Hears about each sandbox report the analyzer saved a verdict from. Must not throw. */
export type ScanListener = (host: string, scanId: string, report: ScanReport) => void;
let scanListener: ScanListener | null = null;

/**
 * Gives the analyzer what it needs to start sandbox scans. Without it, the
 * placeholder runs. `onScan` is how verdicts get notarised on Solana.
 */
export function configureAnalyzer(deps: ScanDeps, onScan?: ScanListener) {
  scanDeps = deps;
  scanListener = onScan ?? null;
}

const useScans = () => config.analyzer === "scan" && scanDeps !== null;

/** Analyses in progress, keyed by normalised URL. */
const browserVisits = new Map<string, Set<string>>();
const pending = new Map<string, PendingAnalysis>();
/** Who to tell when each analysis finishes, keyed by URL, then user id (or "everyone"). */
const watchers = new Map<string, Map<string, AlertRecipient>>();

const recipientKey = (recipient: AlertRecipient) => (recipient === "everyone" ? "everyone" : recipient.userId);

/** Everyone waiting on an analysis. Someone "everyone" covers needs no alert of their own. */
export function recipientsFor(url: string): AlertRecipient[] {
  const waiting = watchers.get(url);
  if (!waiting) return [];
  return waiting.has("everyone") ? ["everyone"] : [...waiting.values()];
}

export const listPending = () =>
  [...pending.values()].sort((a, b) => a.startedAt - b.startedAt);

export const isAnalysisRunning = (url: string) => pending.has(url);

export const pendingAnalysis = (url: string) => pending.get(url);

type PendingListener = (url: string) => void;
const pendingListeners = new Set<PendingListener>();

/** Calls `listener` with a URL whenever its analysis starts or ends. Returns an unsubscribe function. */
export function onPendingChange(listener: PendingListener) {
  pendingListeners.add(listener);
  return () => void pendingListeners.delete(listener);
}

function pendingChanged(url: string) {
  const message: AdminStreamEvent = { kind: "pending", pending: listPending() };
  adminChannel.send("message", message);
  for (const listener of pendingListeners) listener(url);
}

const SUSPICIOUS_PATTERNS: [RegExp, string][] = [
  [/phish/i, "mentions phishing"],
  [/malware|ransom/i, "mentions malware"],
  [/free-?gift|claim-?prize|you-?won/i, "looks like a prize scam"],
  [/(verify|confirm|secure)-?(account|login|wallet)/i, "asks to verify an account"],
];

/**
 * Fallback when sandbox scans are off (ANALYZER=placeholder): a few naive URL
 * heuristics so both outcomes can be demoed without the scan stack.
 */
export function placeholderVerdict(url: string, host: string): { verdict: Verdict; reason: string } {
  if (isIP(host)) return { verdict: "unsafe", reason: "Host is a raw IP address" };
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { verdict: "unsafe", reason: "Punycode host, possibly a lookalike domain" };
  }
  for (const [pattern, why] of SUSPICIOUS_PATTERNS) {
    if (pattern.test(url)) return { verdict: "unsafe", reason: `URL ${why}` };
  }
  return { verdict: "safe", reason: "Nothing suspicious in the URL" };
}

/**
 * Starts analysing a URL unless it's already being analysed. The result is
 * remembered in Typesense and pushed to the pets of everyone who visited the
 * URL meanwhile. `joined` is false when this recipient was already waiting.
 */
export function startAnalysis(url: string, host: string, recipient: AlertRecipient, browserVisit = false) {
  if (browserVisit && recipient !== "everyone") {
    const visitors = browserVisits.get(url) ?? new Set<string>();
    visitors.add(recipient.userId);
    browserVisits.set(url, visitors);
  }
  const waiting = watchers.get(url) ?? new Map<string, AlertRecipient>();
  const key = recipientKey(recipient);
  const joined = !waiting.has(key);
  waiting.set(key, recipient);
  watchers.set(url, waiting);

  const existing = pending.get(url);
  if (existing) return { analysis: existing, joined };

  const startedAt = Date.now();
  const scan = useScans();
  const analysis: PendingAnalysis = {
    url,
    host,
    startedAt,
    etaAt: startedAt + (scan ? config.scanEtaMs : config.analysisDelayMs),
    ...(scan ? { scanId: randomUUID() } : {}),
  };
  pending.set(url, analysis);
  pendingChanged(url);
  logEvent({
    type: "analysis_started",
    message: `Analysis started for ${url}`,
    url,
    host,
    details: scan
      ? { analyzer: "scan", scanId: analysis.scanId }
      : { analyzer: "placeholder", delayMs: config.analysisDelayMs },
  });
  void runAnalysis(analysis, recipient === "everyone" ? null : recipient.userId);
  return { analysis, joined };
}

/** Sandbox scans give benign / suspicious / malicious; the URL store keeps safe / unsafe. */
export function verdictFromReport(report: ScanReport): { verdict: Verdict; reason: string } {
  const summary = report.summary.length > 200 ? `${report.summary.slice(0, 200)}…` : report.summary;
  const match = report.verdict === "benign" ? undefined : report.similar?.[0];
  const lookalike = match ? `It's a ${Math.round(match.similarity * 100)}% match for a page I flagged on ${hostOf(match.url)}. ` : "";
  return {
    verdict: report.verdict === "benign" ? "safe" : "unsafe",
    reason: `Sandbox scan: ${report.verdict}, score ${report.score}/100. ${lookalike}${summary}`.trim(),
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Runs a sandbox scan and waits for its report. The scan is listed under `userId`. */
async function scanReport(url: string, scanId: string, userId: string | null) {
  const deps = scanDeps!;
  const parsed = normaliseScanUrl(url);
  if ("error" in parsed) throw new Error(`can't scan ${url}: ${parsed.error}`);
  await createScan(deps, parsed.url, { apiKey: null, userId }, scanId);
  const scan = await waitForScan(deps, scanId, config.scanTimeoutMs);
  if (scan.status !== "done" || !scan.report) throw new Error(scan.error ?? "the scan failed");
  return scan.report;
}

async function runAnalysis({ url, host, startedAt, scanId }: PendingAnalysis, userId: string | null) {
  const alertAll = (level: "danger" | "ok" | "info", message: string) => {
    for (const recipient of recipientsFor(url)) sendPetAlert(recipient, level, message, url, host, scanId);
  };
  try {
    let result: { verdict: Verdict; reason: string };
    let report: ScanReport | null = null;
    if (scanId) {
      report = await scanReport(url, scanId, userId);
      result = verdictFromReport(report);
    } else {
      await sleep(config.analysisDelayMs);
      result = placeholderVerdict(url, host);
    }
    const { verdict, reason } = result;
    const record = await saveRecord({
      scope: "url",
      url,
      host,
      verdict,
      reason,
      source: "analysis",
      checkedAt: Date.now(),
    });
    if (report && scanId) {
      try {
        scanListener?.(host, scanId, report);
      } catch (error) {
        console.error(`[server] notarising the scan of ${host} failed:`, error);
      }
    }
    logEvent({
      type: "analysis_completed",
      message: `Analysis finished: ${verdict} — ${url} (${reason})`,
      url,
      host,
      verdict,
      durationMs: Date.now() - startedAt,
      details: { analyzer: scanId ? "scan" : "placeholder", recordId: record.id, reason, scanId },
    });
    if (verdict === "unsafe") {
      for (const accountId of browserVisits.get(url) ?? []) notifyUnsafeVisit(url, accountId);
      alertAll("danger", `Watch out! ${host} looks unsafe. ${reason.replace(/\.$/, "")}.`);
    } else {
      alertAll("ok", `All good, ${host} checked out fine.`);
    }
  } catch (error) {
    logEvent({
      type: "error",
      message: `Analysis failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      url,
      host,
      details: { scanId },
    });
    if (scanId) alertAll("info", `I couldn't finish checking ${host}.`);
  } finally {
    pending.delete(url);
    browserVisits.delete(url);
    watchers.delete(url);
    pendingChanged(url);
  }
}
