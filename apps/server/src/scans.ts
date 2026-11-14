import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { API_KEY_HEADER, isTerminalStatus } from "@ladybug/shared";
import type { ApiError, CreateScanResponse, ScanEvent, ScanJob, ScanListResponse } from "@ladybug/shared";
import { getScan, insertScan, isValidArtifactKey, listScans, readEvents } from "@ladybug/backend";
import type { ArtifactStore, Db } from "@ladybug/backend";
import { normaliseScanUrl } from "./validate.ts";

export type ScanDeps = {
  db: Db;
  redis: Redis;
  queue: Queue<ScanJob>;
  artifacts: ArtifactStore;
  /** SSE readers block on XREAD, so each needs its own connection. */
  createSubscriber: () => Redis;
  apiKeys: string[];
  rateLimitPerMinute: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SSE_BLOCK_MS = 15_000;

const fail = (res: Response, status: number, error: string) => {
  const body: ApiError = { error };
  res.status(status).json(body);
};

function scanId(req: Request, res: Response): string | null {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    fail(res, 404, "scan not found");
    return null;
  }
  return id;
}

/** Stores and queues a scan for an already-validated URL. */
export async function createScan(deps: ScanDeps, url: string, apiKey: string | null, id: string = randomUUID()) {
  await insertScan(deps.db, { id, inputUrl: url, apiKey });
  await deps.queue.add("scan", { scanId: id, url }, { jobId: id, removeOnComplete: 1000, removeOnFail: 1000 });
  return id;
}

/**
 * Follows a scan's event stream until it finishes, then returns the stored
 * scan. Throws if it doesn't finish within timeoutMs.
 */
export async function waitForScan(deps: ScanDeps, scanId: string, timeoutMs: number) {
  const subscriber = deps.createSubscriber();
  const deadline = Date.now() + timeoutMs;
  let lastId = "0";
  try {
    while (Date.now() < deadline) {
      const entries = await readEvents(subscriber, scanId, lastId, Math.min(SSE_BLOCK_MS, deadline - Date.now()));
      for (const entry of entries) {
        lastId = entry.id;
        if (entry.event.type === "status" && isTerminalStatus(entry.event.status)) {
          const scan = await getScan(deps.db, scanId);
          if (scan) return scan;
        }
      }
    }
  } finally {
    subscriber.disconnect();
  }
  throw new Error(`scan ${scanId} didn't finish within ${Math.round(timeoutMs / 1000)}s`);
}

export function scansRouter(deps: ScanDeps) {
  const router = Router();

  router.post("/", async (req, res) => {
    let apiKey: string | null = null;
    if (deps.apiKeys.length > 0) {
      apiKey = req.header(API_KEY_HEADER) ?? null;
      if (!apiKey || !deps.apiKeys.includes(apiKey)) return fail(res, 401, "missing or invalid API key");
    }

    // Fixed one-minute window per key (or per client IP when auth is off).
    const bucket = `ratelimit:${apiKey ?? req.ip}:${Math.floor(Date.now() / 60_000)}`;
    const count = await deps.redis.multi().incr(bucket).expire(bucket, 120).exec();
    if (Number(count?.[0]?.[1] ?? 0) > deps.rateLimitPerMinute) {
      res.setHeader("Retry-After", "60");
      return fail(res, 429, "rate limit exceeded, try again in a minute");
    }

    const parsed = normaliseScanUrl(req.body?.url);
    if ("error" in parsed) return fail(res, 400, parsed.error);

    const body: CreateScanResponse = { scanId: await createScan(deps, parsed.url, apiKey) };
    res.status(202).json(body);
  });

  router.get("/", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const scans = await listScans(deps.db, limit);
    const body: ScanListResponse = {
      scans: scans.map(({ report, ...scan }) => ({
        ...scan,
        score: report?.score ?? null,
        verdict: report?.verdict ?? null,
        finalUrl: report?.finalUrl ?? null,
      })),
    };
    res.json(body);
  });

  router.get("/:id", async (req, res) => {
    const id = scanId(req, res);
    if (!id) return;
    const scan = await getScan(deps.db, id);
    if (!scan) return fail(res, 404, "scan not found");
    res.json(scan);
  });

  router.get("/:id/events", async (req, res) => {
    const id = scanId(req, res);
    if (!id) return;
    const scan = await getScan(deps.db, id);
    if (!scan) return fail(res, 404, "scan not found");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const send = (entryId: string, event: ScanEvent) => {
      res.write(`id: ${entryId}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const subscriber = deps.createSubscriber();
    let closed = false;
    req.on("close", () => {
      closed = true;
      subscriber.disconnect();
    });

    let lastId = req.header("last-event-id") || "0";
    let sawAny = false;
    try {
      while (!closed) {
        const entries = await readEvents(subscriber, id, lastId, SSE_BLOCK_MS);
        let terminal = false;
        for (const entry of entries) {
          send(entry.id, entry.event);
          lastId = entry.id;
          sawAny = true;
          if (entry.event.type === "status" && isTerminalStatus(entry.event.status)) terminal = true;
        }
        if (terminal) break;
        if (entries.length === 0) {
          // The stream expires a day after the scan; fall back to the stored status.
          const current = await getScan(deps.db, id);
          if (current && isTerminalStatus(current.status) && !sawAny && lastId === "0") {
            send("0-1", { type: "status", status: current.status, at: current.updatedAt, message: current.error ?? undefined });
            break;
          }
          res.write(": keepalive\n\n");
        }
      }
    } catch (err) {
      if (!closed) console.error("[server] event stream failed", err);
    } finally {
      subscriber.disconnect();
      res.end();
    }
  });

  router.get("/:id/artifacts/:key", async (req, res) => {
    const id = scanId(req, res);
    if (!id) return;
    const key = String(req.params.key);
    if (!isValidArtifactKey(key) || !key.startsWith(`scans/${id}/`)) return fail(res, 404, "artifact not found");
    const location = await deps.artifacts.locate(key);
    if (!location) return fail(res, 404, "artifact not found");
    if (location.kind === "redirect") return res.redirect(302, location.url);
    res.setHeader("Content-Type", location.contentType);
    res.setHeader("Content-Length", String(location.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await pipeline(location.stream, res);
  });

  return router;
}
