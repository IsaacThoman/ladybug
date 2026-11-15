import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AccountStatus, CommunityTally, ScanReport } from "@ladybug/shared";
import type { AccountStore, Db, NotarisedScan, ReportStore, SiteReport, UserRecord } from "@ladybug/backend";
import { hashToken } from "./accounts.ts";
import { createApp } from "./app.ts";
import { adminReports, needsReview, notariseScan } from "./reports.ts";
import type { ReportChain } from "./solana/chain.ts";
import type { SiteState } from "./solana/codec.ts";

function memoryReports(): ReportStore & { rows: Map<string, SiteReport>; scans: NotarisedScan[] } {
  const rows = new Map<string, SiteReport>();
  const scans: NotarisedScan[] = [];
  const key = (userId: string, host: string) => `${userId} ${host}`;
  const ofHost = (host: string) => [...rows.values()].filter((row) => row.host === host);
  return {
    rows,
    scans,
    async upsert(report) {
      const now = new Date().toISOString();
      const previous = rows.get(key(report.userId, report.host));
      const row: SiteReport = { ...report, signature: null, createdAt: previous?.createdAt ?? now, updatedAt: now };
      rows.set(key(report.userId, report.host), row);
      return row;
    },
    async setChainStatus(userId, host, verdict, status, signature) {
      const row = rows.get(key(userId, host));
      if (row?.verdict === verdict) Object.assign(row, { chainStatus: status, signature });
    },
    async counts(host) {
      const all = ofHost(host);
      return {
        safe: all.filter((r) => r.verdict === "safe").length,
        unsafe: all.filter((r) => r.verdict === "unsafe").length,
        pending: all.filter((r) => r.chainStatus === "pending").length,
      };
    },
    mine: async (userId, host) => rows.get(key(userId, host)) ?? null,
    async sites(limit) {
      const hosts = [...new Set([...rows.values()].map((row) => row.host))];
      return hosts.slice(0, limit).map((host) => ({
        host,
        safe: ofHost(host).filter((r) => r.verdict === "safe").length,
        unsafe: ofHost(host).filter((r) => r.verdict === "unsafe").length,
        lastReportAt: ofHost(host).map((r) => r.updatedAt).sort().at(-1)!,
      }));
    },
    saveScan: async (scan) => void scans.push(scan),
    latestScan: async (host) => scans.filter((scan) => scan.host === host).at(-1) ?? null,
  };
}

/** Each token signs in a different user. */
function accountsFor(users: Record<string, AccountStatus>) {
  const byHash = new Map(
    Object.entries(users).map(([token, status]): [string, UserRecord] => [
      hashToken(token),
      { id: randomUUID(), username: token, passwordHash: "", createdAt: new Date(0).toISOString(), status, callsEnabled: false },
    ]),
  );
  const idOf = (token: string) => byHash.get(hashToken(token))!.id;
  return { idOf, accounts: { byToken: async (hash: string) => byHash.get(hash) ?? null } as unknown as AccountStore };
}

/** A chain that confirms writes when told to. */
function fakeChain() {
  let site: SiteState | null = null;
  let failReads = false;
  const waiting: { resolve: (signature: string) => void; reject: (err: Error) => void }[] = [];
  const submitted: { accountId: string; host: string; verdict: string; urlHash: string }[] = [];
  const scans: { host: string; verdict: string; score: number; reportHash: string }[] = [];
  const chain: ReportChain = {
    siteInfo: (host) => ({
      cluster: "devnet",
      programId: "Prog111",
      siteAddress: `site-of-${host}`,
      explorerUrl: `https://explorer.solana.com/address/site-of-${host}?cluster=devnet`,
    }),
    txUrl: (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    readSite: async () => {
      if (failReads) throw new Error("rpc down");
      return site;
    },
    submitReport: (report) => {
      submitted.push({ ...report, urlHash: Buffer.from(report.urlHash).toString("hex") });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    recordScan: async (scan) => {
      scans.push({ ...scan, reportHash: Buffer.from(scan.reportHash).toString("hex") });
      return "scan-sig";
    },
  };
  return {
    chain,
    submitted,
    scans,
    setSite: (value: SiteState | null) => void (site = value),
    failReads: (value: boolean) => void (failReads = value),
    confirm: (signature: string) => waiting.shift()!.resolve(signature),
    fail: () => waiting.shift()!.reject(new Error("rpc down")),
  };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

async function fixture(options: { chain?: ReturnType<typeof fakeChain>; limit?: () => boolean } = {}) {
  const reports = memoryReports();
  const { accounts, idOf } = accountsFor({ alice: "approved", bob: "approved", waiting: "pending" });
  const app = createApp({
    db: {} as Db,
    accounts,
    apiKeys: [],
    rateLimitPerMinute: 10,
    authLimit: async () => true,
    reports,
    chain: options.chain?.chain ?? null,
    reportLimit: async () => options.limit?.() ?? true,
  } as unknown as Parameters<typeof createApp>[0]);
  app.locals.support.stop();
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as CommunityTally & { error?: string } };
  };
  const tally = (url: string, token?: string) => call("GET", `/api/reports?url=${encodeURIComponent(url)}`, token);
  const report = (url: string, verdict: unknown, token = "alice") => call("POST", "/api/reports", token, { url, verdict });
  return { reports, idOf, call, tally, report };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("without Solana, reports are Postgres only", async () => {
  const f = await fixture();
  const empty = await f.tally("https://Example.com/a");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { host: "example.com", safe: 0, unsafe: 0, chain: null, lastScan: null });
  assert.ok(!("mine" in empty.body), "signed out: no mine");

  assert.equal((await f.tally("https://example.com/", "alice")).body.mine, null, "signed in, no vote yet");
  assert.ok(!("mine" in (await f.tally("https://example.com/", "nobody")).body), "a bad token is just signed out");
  assert.ok(!("mine" in (await f.tally("https://example.com/", "waiting")).body), "pending accounts don't vote");

  const posted = await f.report("https://example.com/login?x=1#frag", "unsafe");
  assert.equal(posted.status, 200);
  assert.equal(posted.body.unsafe, 1);
  assert.equal(posted.body.mine?.verdict, "unsafe");
  assert.equal(posted.body.mine?.chainStatus, "off");
  assert.equal(posted.body.mine?.explorerUrl, null);
  assert.equal(f.reports.rows.get(`${f.idOf("alice")} example.com`)?.url, "https://example.com/login?x=1");

  await f.report("https://example.com/", "safe", "bob");
  const changed = await f.report("https://example.com/", "safe");
  assert.deepEqual([changed.body.safe, changed.body.unsafe], [2, 0], "changing a vote moves it");
  const again = await f.report("https://example.com/other", "safe");
  assert.equal(again.status, 200, "voting the same way again is fine");
  assert.deepEqual([again.body.safe, again.body.unsafe], [2, 0]);
});

test("report validation and access", async () => {
  const f = await fixture();
  assert.equal((await f.tally("not a url")).status, 400);
  assert.equal((await f.tally("ftp://example.com/")).status, 400);
  assert.equal((await f.tally("http://localhost:3000/")).status, 400);
  assert.equal((await f.call("GET", "/api/reports")).status, 400);
  assert.equal((await f.report("https://example.com/", "maybe")).status, 400);
  assert.equal((await f.report("https://example.com/", undefined)).status, 400);
  const longHost = Array.from({ length: 5 }, (_, i) => String.fromCharCode(97 + i).repeat(60)).join(".");
  assert.equal((await f.report(`https://${longHost}.com/`, "safe")).status, 400, "hosts over 253 bytes");
  assert.equal((await f.report("https://example.com/", "safe", "nobody")).status, 401);
  assert.equal((await f.report("https://example.com/", "safe", "waiting")).status, 403);
  assert.equal(f.reports.rows.size, 0);
});

test("reports are rate limited per account", async () => {
  const f = await fixture({ limit: () => false });
  const res = await f.report("https://example.com/", "safe");
  assert.equal(res.status, 429);
  assert.equal(f.reports.rows.size, 0);
});

test("with Solana, votes go on-chain in the background", async () => {
  const fake = fakeChain();
  const f = await fixture({ chain: fake });
  const posted = await f.report("https://scam.example/login", "unsafe");
  assert.equal(posted.body.mine?.chainStatus, "pending");
  assert.equal(posted.body.chain?.siteAddress, "site-of-scam.example");
  assert.equal(posted.body.unsafe, 1, "pending votes count from Postgres");
  assert.deepEqual(fake.submitted, [
    {
      accountId: f.idOf("alice"),
      host: "scam.example",
      verdict: "unsafe",
      urlHash: createHash("sha256").update("https://scam.example/login").digest("hex"),
    },
  ]);

  fake.confirm("sig-1");
  await tick();
  // Once nothing is pending, the on-chain tally wins.
  fake.setSite({ host: "scam.example", safeReports: 0, unsafeReports: 5, scan: null });
  const confirmed = await f.tally("https://scam.example/", "alice");
  assert.equal(confirmed.body.mine?.chainStatus, "confirmed");
  assert.equal(confirmed.body.mine?.signature, "sig-1");
  assert.equal(confirmed.body.mine?.explorerUrl, "https://explorer.solana.com/tx/sig-1?cluster=devnet");
  assert.equal(confirmed.body.unsafe, 5);

  // RPC down: Postgres counts.
  fake.failReads(true);
  assert.equal((await f.tally("https://scam.example/")).body.unsafe, 1);
  fake.failReads(false);

  await f.report("https://scam.example/", "safe", "bob");
  fake.fail();
  await tick();
  const failed = await f.tally("https://scam.example/", "bob");
  assert.equal(failed.body.mine?.chainStatus, "failed");
  assert.equal(failed.body.mine?.signature, null);
});

test("on-chain scan verdicts show as the last scan, with the signature we recorded", async () => {
  const fake = fakeChain();
  const f = await fixture({ chain: fake });
  const report = { scanId: randomUUID(), verdict: "malicious", score: 91.6 } as unknown as ScanReport;
  notariseScan(fake.chain, f.reports, "bad.example", report.scanId, report);
  await tick();
  await tick();
  const [sent] = fake.scans;
  assert.equal(sent?.score, 92);
  assert.equal(f.reports.scans[0]?.signature, "scan-sig");

  fake.setSite({
    host: "bad.example",
    safeReports: 0,
    unsafeReports: 0,
    scan: { verdict: "malicious", score: 92, reportHash: sent!.reportHash, scannedAt: "2026-11-14T00:00:00.000Z" },
  });
  const { body } = await f.tally("https://bad.example/");
  assert.deepEqual(body.lastScan, {
    verdict: "malicious",
    score: 92,
    reportHash: sent!.reportHash,
    scannedAt: "2026-11-14T00:00:00.000Z",
    signature: "scan-sig",
    explorerUrl: "https://explorer.solana.com/tx/scan-sig?cluster=devnet",
  });
});

test("the admin list flags hosts where the community disagrees", async () => {
  assert.equal(needsReview(0, 1, null), true);
  assert.equal(needsReview(3, 0, null), false);
  assert.equal(needsReview(1, 3, "safe"), true);
  assert.equal(needsReview(3, 1, "unsafe"), true);
  assert.equal(needsReview(2, 2, "safe"), false, "a tie isn't a majority");
  assert.equal(needsReview(0, 4, "unsafe"), false);

  const reports = memoryReports();
  await reports.upsert({ userId: "a", host: "one.example", url: "https://one.example/", verdict: "unsafe", chainStatus: "off" });
  await reports.upsert({ userId: "a", host: "two.example", url: "https://two.example/", verdict: "safe", chainStatus: "off" });
  const asked: string[][] = [];
  const list = adminReports(reports, async (hosts) => {
    asked.push(hosts);
    return new Map([["one.example", "safe" as const]]);
  });
  const { sites } = await list(50);
  assert.deepEqual(asked, [["one.example", "two.example"]]);
  assert.deepEqual(
    sites.map(({ host, verdict, needsReview }) => ({ host, verdict, needsReview })),
    [
      { host: "one.example", verdict: "safe", needsReview: true },
      { host: "two.example", verdict: null, needsReview: false },
    ],
  );
});
