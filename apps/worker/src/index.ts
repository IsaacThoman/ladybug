import { Worker } from "bullmq";
import { SCAN_QUEUE } from "@ladybug/shared";
import type { ScanJob } from "@ladybug/shared";
import {
  createArtifactStore,
  createDb,
  createRedis,
  migrate,
  publishEvent,
  saveReport,
  setScanStatus,
} from "@ladybug/backend";
import { config } from "./config.ts";
import { runScan } from "./pipeline.ts";
import { createProvider } from "./sandbox/index.ts";
import { pgSimilarityStore } from "./similarity/store.ts";

const JANITOR_INTERVAL_MS = 60_000;

const db = createDb();
const features = await migrate(db);
const similarity = features.vector ? pgSimilarityStore(db) : undefined;
const redis = createRedis();
const artifacts = createArtifactStore();
const provider = createProvider();

const emit = (scanId: string) => async (event: Parameters<typeof publishEvent>[2]) => {
  await publishEvent(redis, scanId, event);
};
const now = () => new Date().toISOString();

const worker = new Worker<ScanJob>(
  SCAN_QUEUE,
  async (job) => {
    const { scanId, url } = job.data;
    console.log(`[worker] ${scanId}: scanning ${url}`);
    try {
      const report = await runScan(scanId, url, {
        provider,
        artifacts,
        emit: emit(scanId),
        onStatus: (status) => setScanStatus(db, scanId, status),
        similarity,
      });
      await saveReport(db, scanId, report);
      await publishEvent(redis, scanId, { type: "status", status: "done", at: now() });
      console.log(`[worker] ${scanId}: ${report.verdict} (${report.score})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] ${scanId}: failed`, err);
      await setScanStatus(db, scanId, "failed", message);
      await publishEvent(redis, scanId, { type: "status", status: "failed", at: now(), message });
    }
  },
  {
    connection: createRedis({ forBullmq: true }),
    concurrency: config.concurrency,
    // Scans run for minutes; don't let BullMQ think the job stalled.
    lockDuration: 2 * 60_000,
  },
);

worker.on("error", (err) => console.error("[worker] queue error", err));

const janitor = setInterval(async () => {
  try {
    const reaped = await provider.reap(config.sandboxMaxAgeMs);
    if (reaped) console.log(`[worker] janitor removed ${reaped} stale sandbox(es)`);
  } catch (err) {
    console.warn("[worker] janitor failed", err);
  }
}, JANITOR_INTERVAL_MS);

console.log(
  `[worker] ready: provider=${provider.name}, concurrency=${config.concurrency}, similarity=${similarity ? "pgvector" : "off"}, llm=${config.llm.apiKey && config.llm.model ? `${config.llm.model} @ ${config.llm.baseUrl}` : "off (set LLM_API_KEY and LLM_MODEL)"}`,
);

const shutdown = async () => {
  clearInterval(janitor);
  await worker.close();
  await db.end();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
