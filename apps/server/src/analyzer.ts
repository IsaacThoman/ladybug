import { setTimeout as sleep } from "node:timers/promises";
import { isIP } from "node:net";
import type { AdminStreamEvent, PendingAnalysis, Verdict } from "@ladybug/shared";
import { logEvent, sendPetAlert } from "./activity.ts";
import { config } from "./config.ts";
import { adminChannel } from "./sse.ts";
import { saveRecord } from "./store.ts";

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
 * PLACEHOLDER until the real URL check exists: a few naive URL heuristics so
 * both outcomes can be demoed. Swap this out for the real analysis.
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
  const analysis: PendingAnalysis = {
    url,
    host,
    startedAt,
    etaAt: startedAt + config.analysisDelayMs,
  };
  pending.set(url, analysis);
  broadcastPending();
  logEvent({
    type: "analysis_started",
    message: `Analysis started for ${url}`,
    url,
    host,
    details: { analyzer: "placeholder", delayMs: config.analysisDelayMs },
  });
  void runAnalysis(analysis);
  return analysis;
}

async function runAnalysis({ url, host, startedAt }: PendingAnalysis) {
  try {
    await sleep(config.analysisDelayMs);
    const { verdict, reason } = placeholderVerdict(url, host);
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
      details: { analyzer: "placeholder", recordId: record.id, reason },
    });
    if (verdict === "unsafe") {
      sendPetAlert("danger", `Watch out! ${host} looks unsafe. ${reason}.`, url, host);
    } else {
      sendPetAlert("ok", `All good, ${host} checked out fine.`, url, host);
    }
  } catch (error) {
    logEvent({
      type: "error",
      message: `Analysis failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      url,
      host,
    });
  } finally {
    pending.delete(url);
    broadcastPending();
  }
}
