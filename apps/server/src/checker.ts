import type { CheckRequest, CheckResponse } from "@ladybug/shared";
import { logEvent, sendPetAlert } from "./activity.ts";
import type { AlertRecipient } from "./activity.ts";
import { isAnalysisRunning, startAnalysis } from "./analyzer.ts";
import { recordVisit } from "./checks.ts";
import { findRecord } from "./store.ts";
import { normalizeUrl } from "./urls.ts";

export type CheckOrigin = "extension" | "admin";

/**
 * Handles one page visit: look the URL up in Typesense, then
 * - known safe: nothing else happens,
 * - known unsafe: the pet raises an alert,
 * - unknown: the pet says it's checking, and an analysis starts.
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

  if (record) {
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
      : `Unknown: ${url}, starting analysis`,
    url,
    host,
    durationMs,
    details: { alreadyRunning },
  });
  const { analysis, joined } = startAnalysis(url, host, recipient);
  // Someone else's visit may have started it; this user's pet still needs to hear.
  if (joined) {
    sendPetAlert(recipient, "info", `Hmm, I don't know ${host} yet. Checking it…`, url, host, analysis.scanId);
  }
  return { status: "pending", url, etaMs: Math.max(0, analysis.etaAt - Date.now()) };
}
