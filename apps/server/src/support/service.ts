import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { normalizeUrl } from "../urls.ts";
import { readMessagingConfig, sendMessage, SendError } from "./chert.ts";
import type { MessagingConfig } from "./chert.ts";

const HOUR = 3_600_000, WINDOW = 1_800_000;
const jobs = "support:jobs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const windows = (chat: string) => `support:chat:${hash(chat)}`;
type Job = { id: string; url: string; config: Pick<MessagingConfig, "destination" | "line" | "tenant">; created: number; attempts: number };

/** Atomic reservation and outbox insertion; pending sends survive process restarts. */
const reserve = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], KEYS[2])
return 1`;
const consume = `
if not redis.call('SET', KEYS[2], '1', 'PX', ARGV[4], 'NX') then return false end
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
for _, raw in ipairs(entries) do
 local w = cjson.decode(raw)
 if w.contact == ARGV[1] and tonumber(ARGV[2]) >= w.start and tonumber(ARGV[2]) <= w.finish and tonumber(ARGV[3]) >= w.start and tonumber(ARGV[3]) <= w.finish then
  redis.call('LREM', KEYS[1], 1, raw)
  return w.id
 end
end
return false`;

export class SupportService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private redis: Redis;
  private deliver: (id: string) => boolean;
  private options: { config?: () => MessagingConfig | null; send?: typeof sendMessage; now?: () => number };
  constructor(redis: Redis, deliver: (id: string) => boolean,
    options: SupportService["options"] = {}) { this.redis = redis; this.deliver = deliver; this.options = options; }
  private now() { return (this.options.now ?? Date.now)(); }
  private config() { return (this.options.config ?? readMessagingConfig)(); }
  start() {
    this.timer = setInterval(() => { void this.drain().catch(() => console.error("[support] outbox unavailable")); }, 2000);
    this.timer.unref();
    return this;
  }
  stop() { clearInterval(this.timer); }
  async notify(rawUrl: string) {
    const target = normalizeUrl(rawUrl), config = this.config();
    if (!target.ok || !config) return;
    const job: Job = { id: randomUUID(), url: target.url, config: { destination: config.destination, line: config.line, tenant: config.tenant }, created: this.now(), attempts: 0 };
    await this.redis.eval(reserve, 3, `support:host:${hash(target.host)}`, `support:job:${job.id}`, jobs,
      job.id, JSON.stringify(job), HOUR, this.now());
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const config = this.config();
      if (!config) return;
      for (const key of await this.redis.zrangebyscore(jobs, "-inf", this.now(), "LIMIT", 0, 20)) {
        const lock = `${key}:lock`, token = randomUUID();
        if (!await this.redis.set(lock, token, "PX", 60_000, "NX")) continue;
        try {
          const raw = await this.redis.get(key);
          if (!raw) { await this.redis.zrem(jobs, key); continue; }
          const job = JSON.parse(raw) as Job;
          if (job.config.destination !== config.destination || job.config.line !== config.line || job.config.tenant !== config.tenant) {
            await this.redis.zrem(jobs, key); continue;
          }
          try {
            const chat = await (this.options.send ?? sendMessage)(config, job.id, job.url);
            const start = this.now();
            // Commit the successful send and its support window together.
            const tx = this.redis.multi();
            tx.lpush(windows(chat), JSON.stringify({ id: job.id, contact: config.destination, start, finish: start + WINDOW }));
            tx.ltrim(windows(chat), 0, 999);
            tx.pexpire(windows(chat), HOUR);
            tx.del(key); tx.zrem(jobs, key);
            const result = await tx.exec();
            if (!result || result.some(([error]) => error)) throw new Error("Support state could not be saved");
          } catch (error) {
            if ((error instanceof SendError && !error.transient) || ++job.attempts >= 5 || this.now() - job.created > HOUR - 60_000) {
              await this.redis.zrem(jobs, key);
              console.error("[support] message could not be delivered");
            } else {
              await this.redis.set(key, JSON.stringify(job), "PX", Math.max(1, HOUR - (this.now() - job.created)));
              await this.redis.zadd(jobs, this.now() + Math.min(60_000, 2000 * 2 ** job.attempts), key);
            }
          }
        } finally {
          await this.redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lock, token);
        }
      }
    } finally { this.running = false; }
  }
  async reply(input: unknown, received = this.now()) {
    const config = this.config();
    if (!config || !input || typeof input !== "object") return;
    const event = input as { event_type?: unknown; event_id?: unknown; partner_id?: unknown; data?: {
      chat?: { id?: unknown; is_group?: unknown; handles?: { handle?: unknown; is_me?: unknown }[] };
      message?: { direction?: unknown; sender_handle?: { handle?: unknown; is_me?: unknown }; parts?: { type?: unknown; value?: unknown }[]; sent_at?: unknown };
    } };
    const chat = event.data?.chat, message = event.data?.message;
    if (event.event_type !== "message.received" || typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 256 ||
      (config.tenant && event.partner_id !== config.tenant) || chat?.is_group !== false || typeof chat.id !== "string" ||
      !Array.isArray(chat.handles) || chat.handles.filter((h) => h?.is_me !== true).length !== 1 ||
      !chat.handles.some((h) => h?.is_me === false && h.handle === config.destination) ||
      message?.direction !== "inbound" || message.sender_handle?.handle !== config.destination || message.sender_handle.is_me !== false ||
      !Array.isArray(message.parts) || message.parts.some((p) => !p || p.type !== "text" || typeof p.value !== "string") ||
      message.parts.map((p) => p.value).join("").trim().toLowerCase() !== "support" || typeof message.sent_at !== "string") return;
    const sent = Date.parse(message.sent_at);
    if (!Number.isFinite(sent) || sent > received) return;
    const id = await this.redis.eval(consume, 2, windows(chat.id), `support:event:${hash(event.event_id)}`, config.destination, sent, received, 7 * 24 * HOUR);
    // Consume even when offline: support requests are never replayed on reconnect.
    if (typeof id === "string") this.deliver(id);
  }
}

let service: SupportService | undefined;
export function configureSupport(value: SupportService) { service = value; }
export function notifyUnsafeVisit(url: string) {
  void service?.notify(url).catch(() => console.error("[support] notification unavailable"));
}
