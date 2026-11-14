import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isIP } from "node:net";
import type { AdminStreamEvent, PendingAnalysis, ScanReport, Verdict } from "@ladybug/shared";
import { logEvent, sendPetAlert } from "./activity.ts";
import { config } from "./config.ts";
import { createScan, waitForScan } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";
import { adminChannel } from "./sse.ts";
import { saveRecord } from "./store.ts";
import { normaliseScanUrl } from "./validate.ts";

let scanDeps: ScanDeps | null = null;

/** Gives the analyzer what it needs to start sandbox scans. Without it, the placeholder runs. */
export function configureAnalyzer(deps: ScanDeps) {
  scanDeps = deps;
}

const useScans = () => config.analyzer === "scan" && scanDeps !== null;

/** Analyses in progress, keyed by normalised URL. */
const pending = new Map<string, PendingAnalysis>();

export const listPending = () =>
  [...pending.values()].sort((a, b) => a.startedAt - b.startedAt);

export const isAnalysisRunning = (url: string) => pending.has(url);

function broadcastPending() {
  const message: AdminStreamEvent = { kind: "pending", pending: listPending() };
  adminChannel.send("message", message);
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
 * remembered in Typesense and pushed to the desktop pet.
 */
export function startAnalysis(url: string, host: string) {
  const existing = pending.get(url);
  if (existing) return existing;

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
  broadcastPending();
  logEvent({
    type: "analysis_started",
    message: `Analysis started for ${url}`,
    url,
    host,
    details: scan
      ? { analyzer: "scan", scanId: analysis.scanId }
      : { analyzer: "placeholder", delayMs: config.analysisDelayMs },
  });
  void runAnalysis(analysis);
  return analysis;
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

/** Runs a sandbox scan and waits for its report. */
async function scanVerdict(url: string, scanId: string) {
  const deps = scanDeps!;
  const parsed = normaliseScanUrl(url);
  if ("error" in parsed) throw new Error(`can't scan ${url}: ${parsed.error}`);
  await createScan(deps, parsed.url, null, scanId);
  const scan = await waitForScan(deps, scanId, config.scanTimeoutMs);
  if (scan.status !== "done" || !scan.report) throw new Error(scan.error ?? "the scan failed");
  return verdictFromReport(scan.report);
}

async function runAnalysis({ url, host, startedAt, scanId }: PendingAnalysis) {
  try {
    let result: { verdict: Verdict; reason: string };
    if (scanId) {
      result = await scanVerdict(url, scanId);
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
      sendPetAlert("danger", `Watch out! ${host} looks unsafe. ${reason.replace(/\.$/, "")}.`, url, host, scanId);
    } else {
      sendPetAlert("ok", `All good, ${host} checked out fine.`, url, host, scanId);
    }
  } catch (error) {
    logEvent({
      type: "error",
      message: `Analysis failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      url,
      host,
      details: { scanId },
    });
    if (scanId) sendPetAlert("info", `I couldn't finish checking ${host}.`, url, host, scanId);
  } finally {
    pending.delete(url);
    broadcastPending();
  }
}
