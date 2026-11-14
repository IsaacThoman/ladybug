import { setTimeout as sleep } from "node:timers/promises";
import { Queue } from "bullmq";
import { SCAN_QUEUE } from "@ladybug/shared";
import type { ScanJob } from "@ladybug/shared";
import { createAccountStore, createArtifactStore, createDb, createRedis, migrate } from "@ladybug/backend";
import { configureAnalyzer } from "./analyzer.ts";
import { configureChecks } from "./checks.ts";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { AUTH_ATTEMPTS_PER_MINUTE, redisLimiter } from "./routes/auth.ts";
import type { ScanDeps } from "./scans.ts";
import { seedUrls } from "./seed.ts";
import { initStore } from "./store.ts";
import { callsRouter } from "./calls/router.ts";

const RETRY_MS = 3_000;

// Postgres for scan rows (and, with TimescaleDB, visit history), Valkey for
// the queue and event streams.
const db = createDb();
const features = await migrate(db);
configureChecks(db, features);
const redis = createRedis();
const queue = new Queue<ScanJob>(SCAN_QUEUE, { connection: createRedis({ forBullmq: true }) });
const deps: ScanDeps = {
  db,
  redis,
  queue,
  artifacts: createArtifactStore(),
  accounts: createAccountStore(db),
  createSubscriber: () => createRedis(),
  apiKeys: config.apiKeys,
  rateLimitPerMinute: config.rateLimitPerMinute,
  clientIpHeader: config.clientIpHeader,
};
configureAnalyzer(deps);

const server = createApp({ ...deps, authLimit: redisLimiter(redis, AUTH_ATTEMPTS_PER_MINUTE) }).listen(config.port, () => {
  console.log(
    `[server] listening on http://localhost:${config.port} (analyzer: ${config.analyzer}, timescaledb: ${features.timescale ? "on" : "off"})`,
  );
  if (!config.adminPassword) console.warn("[server] ADMIN_PASSWORD is not set: anyone can open the admin UI and approve accounts");
});

// Typesense may still be starting (e.g. under docker compose), so keep trying.
async function connectStore() {
  for (let attempt = 1; ; attempt++) {
    try {
      await initStore();
      await seedUrls();
      console.log(`[server] connected to Typesense at ${config.typesenseUrl}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === 1 || attempt % 10 === 0) {
        console.warn(
          `[server] Typesense not ready at ${config.typesenseUrl} (${reason}); retrying every ${RETRY_MS / 1000}s`,
        );
      }
      await sleep(RETRY_MS);
    }
  }
}

void connectStore();

const shutdown = async () => {
  server.close();
  await callsRouter.shutdown();
  await Promise.allSettled([queue.close(), db.end()]);
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
