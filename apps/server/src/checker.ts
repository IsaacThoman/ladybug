import type { CheckRequest, CheckResponse, CheckStatusResponse } from "@ladybug/shared";
import { logEvent, sendPetAlert } from "./activity.ts";
import type { AlertRecipient } from "./activity.ts";
import { isAnalysisRunning, pendingAnalysis, startAnalysis } from "./analyzer.ts";
import { recordVisit } from "./checks.ts";
import { demoDelayMs } from "./demo.ts";
import { findRecord } from "./store.ts";
import { notifyUnsafeVisit } from "./support/service.ts";
import { normalizeUrl } from "./urls.ts";

export type CheckOrigin = "extension" | "admin";

/**
 * Handles one page visit: look the URL up in Typesense, then
 * - known safe: nothing else happens,
 * - known unsafe: the pet raises an alert,
 * - unknown: the pet says it's checking, and an analysis starts.
 * A staged demo record (see demo.ts) acts unknown, then reveals its verdict.
 *
 * Alerts go to the pets of the user who reported the visit. Admin checks
 * alert every pet.
 */
export async function checkVisit(
  request: CheckRequest,
  origin: CheckOrigin,
  recipient: AlertRecipient,
): Promise<CheckResponse> {
  const target = normalizeUrl(request.url);
  // Log the normalised URL where possible, so credentials never reach the log.
  const loggedUrl = target.ok ? target.url : request.url;
  const user = recipient === "everyone" ? undefined : recipient.username;
  logEvent({
    type: "request",
    message: `Visit reported by ${user ?? origin}: ${loggedUrl}`,
    url: loggedUrl,
    details: { origin, title: request.title, ...(user ? { user } : {}) },
  });

  if (!target.ok) {
    logEvent({
      type: "decision",
      decision: "skipped",
      message: `Skipped: ${target.reason}`,
      url: request.url,
    });
    return { status: "skipped", reason: target.reason };
  }

  const { url, host } = target;
  const started = performance.now();
  const record = await findRecord(url, host);
  const durationMs = Math.round(performance.now() - started);
  const delayMs = record ? demoDelayMs(record) : null;
  const demo = record && delayMs !== null ? { record, delayMs } : undefined;

  if (record && !demo) {
    recordVisit({ url, host, decision: record.verdict === "safe" ? "known_safe" : "known_unsafe", origin, durationMs });
    const match = record.scope === "host" ? `host-wide record for ${record.host}` : "exact URL";
    logEvent({
      type: "decision",
      decision: record.verdict === "safe" ? "known_safe" : "known_unsafe",
      verdict: record.verdict,
      message: `Known ${record.verdict}: ${url} (matched ${match}, from ${record.source})`,
      url,
      host,
      durationMs,
      details: { recordId: record.id, scope: record.scope, source: record.source, reason: record.reason },
    });
    if (record.verdict === "unsafe") {
      if (origin === "extension" && recipient !== "everyone") notifyUnsafeVisit(url, recipient.userId);
      sendPetAlert(recipient, "danger", `Careful! ${host} is flagged as unsafe. ${record.reason}.`, url, host);
    }
    return { status: "known", verdict: record.verdict, record };
  }

  recordVisit({ url, host, decision: "unknown", origin, durationMs });
  const alreadyRunning = isAnalysisRunning(url);
  logEvent({
    type: "decision",
    decision: "unknown",
    message: alreadyRunning
      ? `Unknown: ${url} (analysis already running)`
      : demo
        ? `Demo: ${url} acts unknown, revealing ${demo.record.verdict} in ${demo.delayMs / 1000}s`
        : `Unknown: ${url}, starting analysis`,
    url,
    host,
    durationMs,
    details: { alreadyRunning, ...(demo ? { demo: true, recordId: demo.record.id } : {}) },
  });
  const { analysis, joined } = startAnalysis(url, host, recipient, origin === "extension", demo);
  // Someone else's visit may have started it; this user's pet still needs to hear.
  if (joined) {
    sendPetAlert(recipient, "info", `Hmm, I don't know ${host} yet. Checking it…`, url, host, analysis.scanId);
  }
  return { status: "pending", url, etaMs: Math.max(0, analysis.etaAt - Date.now()) };
}

/**
 * What's known about a URL right now. Unlike `checkVisit`, nothing is logged,
 * counted or started: the extension polls this while an analysis runs.
 */
export async function lookupVisit(rawUrl: string): Promise<CheckStatusResponse> {
  const target = normalizeUrl(rawUrl);
  if (!target.ok) return { status: "skipped", reason: target.reason };
  const { url, host } = target;
  const record = await findRecord(url, host);
  // A staged demo record stays secret until its pretend analysis reveals it.
  if (record && demoDelayMs(record) === null) return { status: "known", verdict: record.verdict, record };
  const analysis = pendingAnalysis(url);
  if (analysis) return { status: "pending", url, etaMs: Math.max(0, analysis.etaAt - Date.now()) };
  return { status: "unknown", url };
}
