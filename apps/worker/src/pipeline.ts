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
import { pageFingerprint } from "./similarity/fingerprint.ts";
import type { SimilarityStore } from "./similarity/store.ts";
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
  /** Page fingerprints (pgvector). Without it, no "looks like a page we flagged" check. */
  similarity?: SimilarityStore;
  /** The model to investigate with (the admin's pick). Without it, LLM_MODEL. */
  llmModel?: () => Promise<string | null>;
  /** Approved accounts that reported a host unsafe. Without it, no community signal. */
  communityReports?: (host: string) => Promise<number>;
};

/** Worker-side lookups that never touch the target. */
async function prescan(ctx: ScanContext, ev: Evidence, communityReports: PipelineDeps["communityReports"]) {
  const host = new URL(ev.inputUrl).hostname;
  // Reports are kept per normalised host: lowercase, no brackets or trailing dot.
  const reportHost = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const [domain, sb, uh, reporters] = await Promise.all([
    lookupDomain(host).catch(() => null),
    safeBrowsing([ev.inputUrl]),
    urlhaus(ev.inputUrl, host),
    communityReports?.(reportHost).catch((err: unknown) => {
      console.warn(`[worker] ${ev.scanId}: community report lookup failed`, err);
      return 0;
    }) ?? 0,
  ]);
  ev.domain = domain;
  ev.reputationHits.push(...sb, ...uh);
  ev.communityUnsafeReports = reporters;
  const facts = [
    domain?.ageDays != null ? `${domain.registrableDomain} is ${domain.ageDays} days old` : null,
    domain?.asn ? `hosted on ${domain.asn}` : null,
    domain?.lookalike,
    ...ev.reputationHits.map((h) => `${h.source}: ${h.detail}`),
    reporters > 0 ? `${reporters} account(s) reported ${reportHost} as unsafe` : null,
  ].filter(Boolean);
  if (facts.length) await ctx.emit({ type: "agent_note", text: `Pre-scan: ${facts.join("; ")}.` });
}

/** Looks for earlier flagged pages that this one closely resembles. */
async function findSimilar(ctx: ScanContext, ev: Evidence, store: SimilarityStore, fingerprint: number[]) {
  try {
    ev.similar = await store.find(ev.scanId, fingerprint);
  } catch (err) {
    console.warn(`[worker] ${ev.scanId}: similarity lookup failed`, err);
    return;
  }
  const [best] = ev.similar;
  if (best) {
    await ctx.emit({
      type: "agent_note",
      text: `This page is a ${Math.round(best.similarity * 100)}% match for ${best.url}, which scanned ${best.verdict} (${best.score}/100).`,
    });
  }
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
  // Armed once the sandbox is up: the provider bounds the wait for it, which can
  // include a node scaling up, and that shouldn't eat the scan's own time.
  let startClock = () => {};
  const timeout = new Promise<never>((_, reject) => {
    startClock = () => {
      setTimeout(() => reject(new Error(`scan timed out after ${config.scanTimeoutMs / 1000}s`)), config.scanTimeoutMs).unref();
    };
  });

  try {
    const run = async () => {
      await setStatus("provisioning");
      // Lookups run while the sandbox boots.
      const [sandbox] = await Promise.all([deps.provider.create(scanId), prescan(ctx, ev, deps.communityReports)]);
      sandboxId = sandbox.id;
      startClock();

      await setStatus("detonating");
      const lastShot = await detonate(ctx, sandbox.client, ev);
      const fingerprint = pageFingerprint(ev.dom);
      if (fingerprint && deps.similarity) await findSimilar(ctx, ev, deps.similarity, fingerprint);
      await emitNewSignals();

      await setStatus("investigating");
      const model = deps.llmModel ? await deps.llmModel() : config.llm.model;
      await investigate(ctx, sandbox.client, ev, lastShot, model);

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
      if (fingerprint && deps.similarity) {
        await deps.similarity.save(report, ev.dom?.title || null, fingerprint).catch((err: unknown) => {
          console.warn(`[worker] ${scanId}: saving the page fingerprint failed`, err);
        });
      }
      return report;
    };

    const report = await Promise.race([run(), timeout]);
    await ctx.emit({ type: "report", score: report.score, verdict: report.verdict });
    return report;
  } finally {
    if (sandboxId) await deps.provider.destroy(sandboxId);
  }
}
