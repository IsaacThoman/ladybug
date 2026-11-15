import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { Redis } from "ioredis";
import { SupportService, configureSupport } from "./service.ts";
import type { MessagingConfig, SharedMessage } from "./chert.ts";
import { SendError } from "./chert.ts";
import { publishEvent } from "@ladybug/backend";
import { scansRouter } from "../scans.ts";
import { checkVisit } from "../checker.ts";
import { configureAnalyzer, isAnalysisRunning, recipientsFor } from "../analyzer.ts";
import { config as analyzerConfig } from "../config.ts";
import { typesense } from "../typesense.ts";
import type { ScanDeps } from "../scans.ts";

const visitor = { userId: "browser-user", username: "alice" };
const visit = (request: Parameters<typeof checkVisit>[0], origin: Parameters<typeof checkVisit>[1]) =>
  checkVisit(request, origin, origin === "admin" ? "everyone" : visitor);

const config: MessagingConfig = { key: "message-key", line: "line", destination: "+15551234567", project: "project" };
const event = (at: number, id = randomUUID()): SharedMessage => ({
  id, line_id: "line", direction: "inbound", state: "received", masked_recipient: config.destination,
  text: " SuPpOrT \n", created_at: new Date(at).toISOString(),
});

test("Redis support integration (dedicated TEST_REDIS_URL; database is cleared)", { skip: !process.env.TEST_REDIS_URL }, async (t) => {
  const redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
  t.after(() => redis.disconnect());
  const fixture = async () => {
    await redis.flushdb();
    let now = Date.now();
    const sends: { id: string; url: string }[] = [], delivered: string[] = [];
    let online = true, fail = false;
    const options = { config: () => config, now: () => now, send: async (_config: typeof config, id: string, url: string) => {
      sends.push({ id, url }); if (fail) throw new SendError(true); return { id: `message-${id}`, state: "sent" };
    } };
    const create = () => new SupportService(redis, (id) => { if (online) delivered.push(id); return online; }, options);
    const service = create();
    now += 1;
    return { service, create, sends, delivered, now: () => now, advance: (ms: number) => { now += ms; }, fail: (value: boolean) => { fail = value; }, offline: () => { online = false; } };
  };
  await t.test("concurrent pages reserve once per normalized host and cooldown survives a new service", async () => {
    const f = await fixture();
    await Promise.all([f.service.notify("https://user:secret@BAD.example./one#fragment"), f.service.notify("http://bad.example/two"), f.service.notify("https://bad.example/three")]);
    await Promise.all([f.service.drain(), f.create().drain()]);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].url, "https://bad.example./one");
    const cooldown = await redis.pttl((await redis.keys("support:host:*"))[0]);
    assert.ok(cooldown > 110_000 && cooldown <= 120_000);
    await f.create().notify("https://bad.example/four"); await f.create().drain(); assert.equal(f.sends.length, 1);
    await f.service.notify("https://sub.bad.example/"); await f.service.drain(); assert.equal(f.sends.length, 2);
    // Expire the cooldown in Redis, simulating the two-minute boundary without sleeping.
    for (const key of await redis.keys("support:host:*")) await redis.del(key);
    f.advance(120_001); await f.create().notify("https://bad.example/five"); await f.create().drain();
    assert.equal(f.sends.length, 3);
  });
  await t.test("durable retries reuse the original idempotency key and open no window before success", async () => {
    const f = await fixture(); f.fail(true);
    await f.service.notify("https://bad.example/"); await f.service.drain();
    await f.service.reply(event(f.now())); assert.equal(f.delivered.length, 0);
    f.fail(false); f.advance(10_000); await f.create().drain();
    assert.equal(f.sends.length, 2); assert.equal(f.sends[0].id, f.sends[1].id);
    await f.service.reply(event(f.now())); assert.equal(f.delivered.length, 1);
  });
  await t.test("wrong sender/line, outbound, extra content, old/future/expired timestamps cannot start calls", async () => {
    const f = await fixture(); await f.service.notify("https://bad.example"); await f.service.drain();
    const invalid = [
      (e: ReturnType<typeof event>) => { e.line_id = "wrong"; },
      (e: ReturnType<typeof event>) => { e.masked_recipient = "+15550000000"; },
      (e: ReturnType<typeof event>) => { e.direction = "outbound"; },
      (e: ReturnType<typeof event>) => { e.text = "please support"; },
      (e: ReturnType<typeof event>) => { e.created_at = new Date(f.now() - 1).toISOString(); },
      (e: ReturnType<typeof event>) => { e.created_at = new Date(f.now() + 1).toISOString(); },
    ];
    for (const mutate of invalid) { const e = event(f.now()); mutate(e); await f.service.reply(e); }
    assert.equal(f.delivered.length, 0);
    const valid = event(f.now()); await Promise.all([f.service.reply(valid), f.service.reply(valid), f.service.reply(event(f.now()))]);
    assert.equal(f.delivered.length, 1);
    await f.service.notify("https://other.example"); await f.service.drain();
    f.advance(1_800_001); await f.service.reply(event(f.now())); await f.service.reply(event(f.now() - 1_800_001));
    assert.equal(f.delivered.length, 1);
  });
  await t.test("offline replies consume windows and are never replayed", async () => {
    const f = await fixture(); await f.service.notify("https://bad.example"); await f.service.drain();
    f.offline(); await f.service.reply(event(f.now()));
    const delivered: string[] = [];
    const online = new SupportService(redis, (id) => { delivered.push(id); return true; }, { config: () => config, now: f.now });
    await online.reply(event(f.now())); assert.equal(delivered.length, 0);
  });
  await t.test("registered masked SUPPORT replies match the emergency contact by last four digits", async () => {
    const f = await fixture(); await f.service.notify("https://bad.example"); await f.service.drain();
    await f.service.reply({ ...event(f.now()), masked_recipient: "•••0000" });
    await f.service.reply({ ...event(f.now()), masked_recipient: "arbitrary4567" });
    await f.service.reply({ ...event(f.now()), masked_recipient: "+15550004567" });
    assert.equal(f.delivered.length, 0);
    const masked = { ...event(f.now()), masked_recipient: "•••4567" };
    await f.service.reply(masked); await f.service.reply(masked);
    await f.service.reply(event(f.now())); assert.equal(f.delivered.length, 1);
  });
  await t.test("polling deduplicates the newest-50 window and discards pre-start history", async () => {
    const f = await fixture(); await f.service.notify("https://bad.example"); await f.service.drain();
    const rows = [event(f.now()), event(f.now() - 1000)];
    const polled = new SupportService(redis, (id) => { f.delivered.push(id); return true; }, { config: () => config, now: f.now, read: async () => rows });
    f.advance(1); rows[0].created_at = new Date(f.now()).toISOString();
    await polled.poll(); await polled.poll(); assert.equal(f.delivered.length, 1);
    await f.service.notify("https://other.example"); await f.service.drain();
    const restarted = new SupportService(redis, (id) => { f.delivered.push(id); return true; }, { config: () => config, now: f.now, read: async () => rows });
    await restarted.poll(); assert.equal(f.delivered.length, 1);
  });
  await t.test("pending sends are observed by id across restarts without another POST", async () => {
    const f = await fixture();
    let posts = 0, state = "pending";
    const options = { config: () => config, now: f.now,
      send: async () => { posts++; return { id: "pending-message", state: "pending" }; },
      read: async () => [{ ...event(f.now()), id: "pending-message", direction: "outbound" as const, state }],
    };
    const service = new SupportService(redis, (id) => { f.delivered.push(id); return true; }, options);
    await service.notify("https://pending.example"); await service.drain();
    f.advance(1); await service.reply(event(f.now())); assert.equal(f.delivered.length, 0);
    f.advance(10_000); await service.drain(); assert.equal(posts, 1);
    state = "sent"; f.advance(10_000);
    const restarted = new SupportService(redis, (id) => { f.delivered.push(id); return true; }, options);
    await restarted.drain(); f.advance(1); await restarted.reply(event(f.now()));
    assert.equal(posts, 1); assert.equal(f.delivered.length, 1);
  });
  await t.test("browser provenance survives joining admin analysis; safe, failed and admin work do not notify", async (st) => {
    const f = await fixture(); configureSupport(f.service);
    const original = { ...analyzerConfig }; analyzerConfig.analyzer = "placeholder"; analyzerConfig.analysisDelayMs = 5;
    st.after(() => Object.assign(analyzerConfig, original));
    let knownUnsafe = true;
    st.mock.method(typesense, "upsert", async () => ({}));
    // The lookup needs its deterministic candidate ID.
    st.mock.method(typesense, "search", async (_collection: string, options: { filter_by: string }) => ({ hits: knownUnsafe ? [{ document: { id: options.filter_by.slice(4, -1).split(",")[0], verdict: "unsafe", scope: "url", source: "manual", reason: "test" } }] : [] }));
    await visit({ url: "https://known.example/" }, "admin"); await f.service.drain(); assert.equal(f.sends.length, 0);
    await visit({ url: "https://known.example/" }, "extension"); await new Promise((r) => setImmediate(r)); await f.service.drain(); assert.equal(f.sends.length, 1);
    knownUnsafe = false;
    const wait = async (url: string) => { while (isAnalysisRunning(url)) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setImmediate(r)); };
    await visit({ url: "https://phish.example/" }, "admin");
    await visit({ url: "https://phish.example/" }, "extension");
    assert.deepEqual(recipientsFor("https://phish.example/"), ["everyone"]);
    await wait("https://phish.example/"); await f.service.drain(); assert.equal(f.sends.length, 2);
    await visit({ url: "https://safe.example/" }, "extension"); await wait("https://safe.example/");
    await visit({ url: "https://malware-admin.example/" }, "admin"); await wait("https://malware-admin.example/");
    await f.service.drain(); assert.equal(f.sends.length, 2);
    st.mock.method(typesense, "upsert", async () => { throw new Error("analysis store failure"); });
    await visit({ url: "https://phish-failed.example/" }, "extension"); await wait("https://phish-failed.example/");
    await f.service.drain(); assert.equal(f.sends.length, 2);
  });
  await t.test("sandbox suspicious/malicious results notify browser visits; benign/failed and manual scans do not", async (st) => {
    const f = await fixture(); configureSupport(f.service);
    const original = { ...analyzerConfig }; analyzerConfig.analyzer = "scan";
    st.after(() => Object.assign(analyzerConfig, original));
    st.mock.method(typesense, "search", async () => ({ hits: [] }));
    st.mock.method(typesense, "upsert", async () => ({}));
    let verdict = "suspicious", failed = false;
    const rows = new Map<string, unknown>();
    const deps = {
      redis, apiKeys: ["manual-test-key"], rateLimitPerMinute: 100,
      createSubscriber: () => new Redis(process.env.TEST_REDIS_URL!),
      db: { query: async (sql: string, args: string[]) => {
        if (sql.startsWith("INSERT")) rows.set(args[0], { id: args[0], input_url: args[1], status: failed ? "failed" : "done", error: failed ? "scan failed" : null, created_at: new Date(), updated_at: new Date(), report: failed ? null : { verdict, score: 80, summary: "test" } });
        return { rows: [rows.get(args[0])] };
      } },
      queue: { add: async (_name: string, job: { scanId: string }) => {
        await publishEvent(redis, job.scanId, { type: "status", status: failed ? "failed" : "done", at: new Date().toISOString() });
      } },
    } as unknown as ScanDeps;
    configureAnalyzer(deps);
    const wait = async (url: string) => {
      while (isAnalysisRunning(url)) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setImmediate(r)); await f.service.drain();
    };
    for (const result of ["suspicious", "malicious", "benign", "failed"]) {
      verdict = result; failed = result === "failed";
      const url = `https://${result}.example/`;
      await visit({ url }, "extension"); await wait(url);
    }
    assert.equal(f.sends.length, 2);
    failed = false; verdict = "malicious";
    const app = express(); app.use(express.json()); app.use("/scans", scansRouter(deps));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/scans`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "manual-test-key" }, body: JSON.stringify({ url: "https://manual.example/" }) });
      assert.equal(response.status, 202); await f.service.drain(); assert.equal(f.sends.length, 2);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

});
