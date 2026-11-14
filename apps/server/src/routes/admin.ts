import express from "express";
import { TIMELINE_RANGES } from "@ladybug/shared";
import type {
  AccountStatus,
  AdminAccountsResponse,
  AdminModelSettings,
  AdminSandboxesResponse,
  AdminStreamEvent,
  AdminSummary,
  Decision,
  LogEventType,
  UrlScope,
  Verdict,
  VerdictSource,
} from "@ladybug/shared";
import type { AccountStore, ModelSettingsStore } from "@ladybug/backend";
import { publicAccount } from "../accounts.ts";
import { logEvent } from "../activity.ts";
import { listPending } from "../analyzer.ts";
import { checkVisit } from "../checker.ts";
import { visitTimeline } from "../checks.ts";
import { config } from "../config.ts";
import {
  HttpError,
  optionalEnum,
  optionalEnumList,
  optionalString,
  pageParams,
  requireEnum,
  requireStore,
  requireString,
} from "../http.ts";
import { adminChannel, petChannel } from "../sse.ts";
import {
  countBy,
  deleteRecord,
  getRecord,
  isStoreReady,
  saveRecord,
  searchEvents,
  searchRecords,
} from "../store.ts";
import { normalizeUrl } from "../urls.ts";

const VERDICTS = ["safe", "unsafe"] as const satisfies readonly Verdict[];
const SCOPES = ["url", "host"] as const satisfies readonly UrlScope[];
const SOURCES = ["seed", "analysis", "admin"] as const satisfies readonly VerdictSource[];
const EVENT_TYPES = [
  "request",
  "decision",
  "analysis_started",
  "analysis_completed",
  "alert",
  "admin",
  "account",
  "error",
] as const satisfies readonly LogEventType[];
const DECISIONS = [
  "known_safe",
  "known_unsafe",
  "unknown",
  "skipped",
] as const satisfies readonly Decision[];

/** Running sandbox scans and the newest `limit` finished ones. */
export type SandboxLister = (limit: number) => Promise<AdminSandboxesResponse>;

export function adminRouter(accounts: AccountStore, models: ModelSettingsStore, sandboxes: SandboxLister) {
  const router = express.Router();

  // Live activity: every logged event, plus the list of running analyses.
  router.get("/stream", (req, res) => {
    const send = adminChannel.attach(req, res);
    const initial: AdminStreamEvent = { kind: "pending", pending: listPending() };
    send("message", initial);
  });

  router.get("/summary", async (_req, res) => {
    const summary: AdminSummary = {
      typesense: isStoreReady() ? "ready" : "unavailable",
      urls: { total: 0, safe: 0, unsafe: 0 },
      events: { total: 0, requests: 0, alerts: 0 },
      pending: listPending(),
      petsConnected: petChannel.size,
      analysisDelayMs: config.analyzer === "scan" ? config.scanEtaMs : config.analysisDelayMs,
      pendingAccounts: await accounts.countPending(),
    };
    if (isStoreReady()) {
      const [urls, events] = await Promise.all([
        countBy("urls", "verdict"),
        countBy("events", "type"),
      ]);
      summary.urls = { total: urls.total, safe: urls.counts.safe ?? 0, unsafe: urls.counts.unsafe ?? 0 };
      summary.events = {
        total: events.total,
        requests: events.counts.request ?? 0,
        alerts: events.counts.alert ?? 0,
      };
    }
    res.json(summary);
  });

  // Visits per time bucket, from Postgres (TimescaleDB), so it works without Typesense.
  router.get("/timeline", async (req, res) => {
    res.json(await visitTimeline(optionalEnum(req.query.range, TIMELINE_RANGES, "range") ?? "24h"));
  });

  // Accounts live in Postgres, so these work without Typesense too.
  router.get("/users", async (_req, res) => {
    const body: AdminAccountsResponse = { accounts: await accounts.list() };
    res.json(body);
  });

  const STATUS_ACTIONS: Record<string, { status: AccountStatus; verb: string }> = {
    approve: { status: "approved", verb: "approved" },
    reject: { status: "rejected", verb: "turned down" },
  };

  router.post("/users/:id/:action", async (req, res) => {
    const action = STATUS_ACTIONS[req.params.action];
    if (!action) throw new HttpError(404, "Not found");
    const user = await accounts.setStatus(req.params.id, action.status);
    if (!user) throw new HttpError(404, "No such user");
    // Pets reconnect and find out they no longer have access.
    if (action.status !== "approved") petChannel.close(user.id);
    logEvent({
      type: "admin",
      message: `Admin ${action.verb} ${user.username}`,
      details: { userId: user.id, user: user.username, status: user.status },
    });
    res.json(publicAccount(user));
  });

  router.delete("/users/:id", async (req, res) => {
    const user = await accounts.remove(req.params.id);
    if (!user) throw new HttpError(404, "No such user");
    petChannel.close(user.id);
    logEvent({
      type: "admin",
      message: `Admin deleted ${user.username}`,
      details: { userId: user.id, user: user.username },
    });
    res.status(204).end();
  });

  // The model scans investigate with: one of those the worker's endpoint offers.
  // Postgres and Valkey, so these work without Typesense too.
  const modelSettings = async (): Promise<AdminModelSettings> => {
    const [selected, catalog] = await Promise.all([models.selected(), models.catalog()]);
    return { selected, catalog };
  };

  router.get("/settings/model", async (_req, res) => {
    res.json(await modelSettings());
  });

  router.put("/settings/model", async (req, res) => {
    const raw: unknown = req.body?.model;
    const catalog = await models.catalog();
    if (raw === null) {
      await models.select(null);
      const fallback = catalog?.defaultModel;
      logEvent({
        type: "admin",
        message: `Admin set the scan model back to the default${fallback ? ` (${fallback})` : ""}`,
        details: { model: null, default: fallback ?? null },
      });
      res.json(await modelSettings());
      return;
    }
    const model = requireString(raw, "model", 200);
    if (!catalog) throw new HttpError(409, "No worker has reported its models yet, so there's nothing to pick from");
    if (!catalog.models.includes(model)) throw new HttpError(400, `${model} isn't one of the models ${catalog.baseUrl} offers`);
    const previous = await models.selected();
    await models.select(model);
    logEvent({
      type: "admin",
      message: `Admin switched the scan model to ${model}`,
      details: { model, previous: previous ?? catalog.defaultModel },
    });
    res.json(await modelSettings());
  });

  // Every sandbox scan, live and finished. Postgres and Valkey, so it works without Typesense.
  router.get("/sandboxes", async (req, res) => {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 24)));
    res.json(await sandboxes(limit));
  });

  router.use(requireStore);

  router.get("/events", async (req, res) => {
    res.json(
      await searchEvents({
        q: optionalString(req.query.q, "q", 200),
        types: optionalEnumList(req.query.type, EVENT_TYPES, "type"),
        decision: optionalEnum(req.query.decision, DECISIONS, "decision"),
        verdict: optionalEnum(req.query.verdict, VERDICTS, "verdict"),
        ...pageParams(req.query),
      }),
    );
  });

  router.get("/urls", async (req, res) => {
    res.json(
      await searchRecords({
        q: optionalString(req.query.q, "q", 200),
        verdict: optionalEnum(req.query.verdict, VERDICTS, "verdict"),
        scope: optionalEnum(req.query.scope, SCOPES, "scope"),
        source: optionalEnum(req.query.source, SOURCES, "source"),
        ...pageParams(req.query),
      }),
    );
  });

  // Add (or overwrite) a record by hand.
  router.post("/urls", async (req, res) => {
    const scope = requireEnum(req.body?.scope, SCOPES, "scope");
    const verdict = requireEnum(req.body?.verdict, VERDICTS, "verdict");
    const raw = requireString(req.body?.url, "url");
    const target = normalizeUrl(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!target.ok) throw new HttpError(400, target.reason);
    const record = await saveRecord({
      scope,
      url: scope === "host" ? `https://${target.host}/` : target.url,
      host: target.host,
      verdict,
      reason: optionalString(req.body?.reason, "reason", 500) ?? "Set by admin",
      source: "admin",
      checkedAt: Date.now(),
    });
    logEvent({
      type: "admin",
      message: `Admin marked ${scope === "host" ? record.host : record.url} as ${verdict}`,
      url: record.url,
      host: record.host,
      verdict,
      details: { recordId: record.id, scope },
    });
    res.status(201).json(record);
  });

  router.put("/urls/:id", async (req, res) => {
    const verdict = requireEnum(req.body?.verdict, VERDICTS, "verdict");
    const existing = await getRecord(req.params.id);
    const record = await saveRecord({
      ...existing,
      verdict,
      reason: optionalString(req.body?.reason, "reason", 500) ?? `Changed to ${verdict} by admin`,
      source: "admin",
      checkedAt: Date.now(),
    });
    logEvent({
      type: "admin",
      message: `Admin changed ${record.scope === "host" ? record.host : record.url} from ${existing.verdict} to ${verdict}`,
      url: record.url,
      host: record.host,
      verdict,
      details: { recordId: record.id, previous: existing.verdict },
    });
    res.json(record);
  });

  router.delete("/urls/:id", async (req, res) => {
    const existing = await getRecord(req.params.id);
    await deleteRecord(existing.id);
    logEvent({
      type: "admin",
      message: `Admin removed ${existing.scope === "host" ? existing.host : existing.url} (was ${existing.verdict})`,
      url: existing.url,
      host: existing.host,
      details: { recordId: existing.id },
    });
    res.status(204).end();
  });

  // Run a URL through the same pipeline as a real visit.
  router.post("/check", async (req, res) => {
    res.json(await checkVisit({ url: requireString(req.body?.url, "url") }, "admin", "everyone"));
  });

  return router;
}
