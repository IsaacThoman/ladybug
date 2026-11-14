import { Redis } from "ioredis";
import { SCAN_STREAM_TTL_SECONDS, scanStreamKey } from "@ladybug/shared";
import type { ScanEvent } from "@ladybug/shared";

export const redisUrl = () => process.env.REDIS_URL ?? "redis://localhost:6379";

/** BullMQ needs `maxRetriesPerRequest: null` on its connections. */
export function createRedis(opts: { forBullmq?: boolean } = {}) {
  return new Redis(redisUrl(), {
    maxRetriesPerRequest: opts.forBullmq ? null : 3,
    // Managed Valkey (rediss://) on Vultr uses a cert we don't pin.
    tls: redisUrl().startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  });
}

export async function publishEvent(redis: Redis, scanId: string, event: ScanEvent) {
  const key = scanStreamKey(scanId);
  await redis.multi().xadd(key, "*", "event", JSON.stringify(event)).expire(key, SCAN_STREAM_TTL_SECONDS).exec();
}

export type StreamEntry = { id: string; event: ScanEvent };

/**
 * Reads entries after `afterId` ("0" = from the start), blocking up to
 * `blockMs` for new ones. Needs a dedicated connection while blocking.
 */
export async function readEvents(
  redis: Redis,
  scanId: string,
  afterId: string,
  blockMs: number,
): Promise<StreamEntry[]> {
  const res = await redis.xread("COUNT", 100, "BLOCK", blockMs, "STREAMS", scanStreamKey(scanId), afterId);
  if (!res) return [];
  const entries: StreamEntry[] = [];
  for (const [, items] of res) {
    for (const [id, fields] of items) {
      const idx = fields.indexOf("event");
      if (idx === -1) continue;
      try {
        entries.push({ id, event: JSON.parse(fields[idx + 1]) as ScanEvent });
      } catch {
        // Skip malformed entries.
      }
    }
  }
  return entries;
}
