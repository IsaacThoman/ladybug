import type { ScanReport, ScanStatus } from "@ladybug/shared";
import type { ArtifactStore } from "@ladybug/backend";
import { ScanContext } from "./context.ts";
import type { EmitFn } from "./context.ts";
import { config } from "./config.ts";
import { newEvidence } from "./evidence.ts";
import type { Evidence } from "./evidence.ts";
import { lookupDomain } from "./prescan/osint.ts";
import { safeBrowsing, urlhaus } from "./prescan/reputation.ts";
import type { SandboxProvider } from "./sandbox/provider.ts";
import { buildReport } from "./scoring/report.ts";
import { computeSignals } from "./scoring/signals.ts";
import { checkDownloads, detonate } from "./stages/detonate.ts";
import { investigate } from "./stages/investigate.ts";

export type PipelineDeps = {
  provider: SandboxProvider;
  artifacts: ArtifactStore;
  emit: EmitFn;
  /** Persist a status change (the DB row). Events are emitted separately. */
  onStatus?: (status: ScanStatus, error?: string) => Promise<void>;
};

/** Worker-side lookups that never touch the target. */
async function prescan(ctx: ScanContext, ev: Evidence) {
  const host = new URL(ev.inputUrl).hostname;
  const [domain, sb, uh] = await Promise.all([
    lookupDomain(host).catch(() => null),
    safeBrowsing([ev.inputUrl]),
    urlhaus(ev.inputUrl, host),
  ]);
  ev.domain = domain;
  ev.reputationHits.push(...sb, ...uh);
  const facts = [
    domain?.ageDays != null ? `${domain.registrableDomain} is ${domain.ageDays} days old` : null,
    domain?.asn ? `hosted on ${domain.asn}` : null,
    domain?.lookalike,
    ...ev.reputationHits.map((h) => `${h.source}: ${h.detail}`),
  ].filter(Boolean);
  if (facts.length) await ctx.emit({ type: "agent_note", text: `Pre-scan: ${facts.join("; ")}.` });
}

export async function runScan(scanId: string, url: string, deps: PipelineDeps): Promise<ScanReport> {
  const ctx = new ScanContext(scanId, deps.emit, deps.artifacts);
  const ev = newEvidence(scanId, url);
  const emitted = new Set<string>();
  const emitNewSignals = async () => {
    for (const signal of computeSignals(ev)) {
      if (emitted.has(signal.id)) continue;
      emitted.add(signal.id);
      await ctx.emit({ type: "signal", signal });
    }
  };
  const setStatus = async (status: ScanStatus, message?: string) => {
    await deps.onStatus?.(status, message);
    await ctx.emit({ type: "status", status, message });
  };

  let sandboxId: string | null = null;
  let finished = false;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`scan timed out after ${config.scanTimeoutMs / 1000}s`)), config.scanTimeoutMs);
    timer.unref();
  });

  try {
    const run = async () => {
      await setStatus("provisioning");
      // Lookups run while the sandbox boots.
      const [sandbox] = await Promise.all([deps.provider.create(scanId), prescan(ctx, ev)]);
      if (finished) {
        // Timed out while booting; the outer finally already ran.
        await deps.provider.destroy(sandbox.id);
        throw new Error("scan ended before the sandbox was ready");
      }
      sandboxId = sandbox.id;

      await setStatus("detonating");
      const lastShot = await detonate(ctx, sandbox.client, ev);
      await emitNewSignals();

      await setStatus("investigating");
      await investigate(ctx, sandbox.client, ev, lastShot);

      // Pick up whatever the agent's clicking triggered.
      const [requests, events, files, har] = await Promise.all([
        sandbox.client.requests().catch(() => null),
        sandbox.client.events().catch(() => null),
        sandbox.client.files().catch(() => null),
        sandbox.client.har().catch(() => null),
      ]);
      if (requests) ev.requests = requests.requests;
      if (events) ev.events = events;
      if (files) ev.files = files.files;
      await Promise.all([
        checkDownloads(ev, ev.files),
        har && ctx.putArtifact("final/requests.har", har, "application/json"),
      ]);

      await setStatus("scoring");
      await emitNewSignals();
      const report = buildReport(ev);
      await ctx.putArtifact("report.json", JSON.stringify(report, null, 2), "application/json");
      return report;
    };

    const report = await Promise.race([run(), timeout]);
    await ctx.emit({ type: "report", score: report.score, verdict: report.verdict });
    return report;
  } finally {
    finished = true;
    if (sandboxId) await deps.provider.destroy(sandboxId);
  }
}
