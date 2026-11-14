import { Queue } from "bullmq";
import { DEFAULT_SERVER_PORT, SCAN_QUEUE } from "@ladybug/shared";
import type { ScanJob } from "@ladybug/shared";
import { createArtifactStore, createDb, createRedis, migrate } from "@ladybug/backend";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
const apiKeys = (process.env.API_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const db = createDb();
await migrate(db);
const redis = createRedis();
const queue = new Queue<ScanJob>(SCAN_QUEUE, { connection: createRedis({ forBullmq: true }) });

const app = createApp({
  db,
  redis,
  queue,
  artifacts: createArtifactStore(),
  createSubscriber: () => createRedis(),
  apiKeys,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 10),
});

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  if (apiKeys.length === 0) console.warn("[server] API_KEYS is not set: anyone can start scans");
});

const shutdown = async () => {
  server.close();
  await Promise.allSettled([queue.close(), db.end()]);
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
