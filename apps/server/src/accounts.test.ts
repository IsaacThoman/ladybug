import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readServerSentEvents } from "@ladybug/shared";
import type { AdminAccount, AuthResponse, PetWarning, WarningStreamEvents } from "@ladybug/shared";
import type { AccountStore, Db, UserRecord } from "@ladybug/backend";
import { hashPassword, verifyPassword } from "./accounts.ts";
import { recipientsFor, startAnalysis } from "./analyzer.ts";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import type { ScanDeps } from "./scans.ts";
import { petChannel } from "./sse.ts";

function memoryAccounts(): AccountStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, string>();
  const find = (id: string) => users.get(id) ?? null;
  return {
    async create(username, passwordHash) {
      if ([...users.values()].some((user) => user.username === username)) return null;
      const user: UserRecord = { id: randomUUID(), username, passwordHash, status: "pending", createdAt: new Date().toISOString(), callsEnabled: false };
      users.set(user.id, user);
      return user;
    },
    byUsername: async (username) => [...users.values()].find((user) => user.username === username) ?? null,
    byToken: async (hash) => find(sessions.get(hash) ?? ""),
    addSession: async (hash, userId) => void sessions.set(hash, userId),
    removeSession: async (hash) => void sessions.delete(hash),
    async removeSessions(userId) {
      for (const [hash, owner] of sessions) if (owner === userId) sessions.delete(hash);
    },
    list: async () =>
      [...users.values()].map(
        ({ id, username, status, createdAt, callsEnabled }): AdminAccount => ({ id, username, status, createdAt, callsEnabled, lastSeenAt: null, sessions: 0 }),
      ),
    countPending: async () => [...users.values()].filter((user) => user.status === "pending").length,
    async setStatus(id, status) {
      const user = find(id);
      if (user) user.status = status;
      return user;
    },
    async setCallsEnabled(id, enabled) {
      const user = find(id);
      if (user) user.callsEnabled = enabled;
      return user;
    },
    async remove(id) {
      const user = find(id);
      users.delete(id);
      return user;
    },
  };
}

let server: Server;
let base = "";
let attempts = 0;
const scanQueries: unknown[][] = [];

before(async () => {
  config.adminPassword = "admin-secret";
  const db = {
    query: async (_sql: string, params: unknown[]) => {
      scanQueries.push(params);
      return { rows: [] };
    },
  } as unknown as Db;
  const deps = {
    db,
    accounts: memoryAccounts(),
    apiKeys: [],
    rateLimitPerMinute: 10,
    authLimit: async () => ++attempts <= 30,
  } as unknown as ScanDeps & { authLimit: () => Promise<boolean> };
  server = createApp(deps).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  config.adminPassword = null;
});

const call = (method: string, path: string, options: { token?: string; body?: unknown; admin?: string } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.admin ? { Authorization: `Basic ${Buffer.from(`admin:${options.admin}`).toString("base64")}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

async function openPetStream(token: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/pet/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  return { res, close: () => controller.abort() };
}

/** Reads a stream's events in order. `next` waits for the next one with that name, skipping others. */
function eventsOf(res: Response) {
  const queue: { event: string; data: unknown }[] = [];
  let wake = () => {};
  void readServerSentEvents(res.body!, (event, data) => {
    queue.push({ event, data: JSON.parse(data) });
    wake();
  }).catch(() => {});
  return {
    async next<T>(name: string): Promise<T> {
      for (;;) {
        const index = queue.findIndex((item) => item.event === name);
        if (index >= 0) return queue.splice(0, index + 1).at(-1)!.data as T;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

async function approvedUser(username: string) {
  const signup = await call("POST", "/api/auth/signup", { body: { username, password: "longenough" } });
  const { token, account } = (await signup.json()) as AuthResponse;
  await call("POST", `/api/admin/users/${account.id}/approve`, { admin: "admin-secret" });
  return token;
}

test("passwords hash with a salt and verify", async () => {
  const hash = await hashPassword("correct horse");
  assert.notEqual(hash, await hashPassword("correct horse"));
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("wrong horse", hash), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("a new account waits for an admin before it can use the API", async () => {
  const signup = await call("POST", "/api/auth/signup", { body: { username: "Alice", password: "hunter2hunter2", client: "extension" } });
  assert.equal(signup.status, 201);
  const { token, account } = (await signup.json()) as AuthResponse;
  assert.equal(account.username, "alice");
  assert.equal(account.status, "pending");

  const check = await call("POST", "/api/check", { token, body: { url: "https://example.org/" } });
  assert.equal(check.status, 403);
  assert.deepEqual(await check.json(), { error: "Your account is waiting for an admin to approve it", code: "pending" });
  assert.equal((await openPetStream(token)).res.status, 403);
  assert.equal((await call("GET", "/api/scans", { token })).status, 403);

  // Approving needs the admin password.
  assert.equal((await call("POST", `/api/admin/users/${account.id}/approve`)).status, 401);
  const approve = await call("POST", `/api/admin/users/${account.id}/approve`, { admin: "admin-secret" });
  assert.equal(approve.status, 200);

  const me = await call("GET", "/api/auth/me", { token });
  assert.equal(((await me.json()) as { account: { status: string } }).account.status, "approved");
  // Past the account check; Typesense isn't running in tests.
  assert.equal((await call("POST", "/api/check", { token, body: { url: "https://example.org/" } })).status, 503);

  const scans = await call("GET", "/api/scans", { token });
  assert.equal(scans.status, 200);
  assert.deepEqual(scanQueries.at(-1), [account.id, 20], "lists only this user's scans");

  const stream = await openPetStream(token);
  assert.equal(stream.res.status, 200);
  assert.equal(petChannel.sizeOf(account.id), 1);
  stream.close();
});

test("sign-in rules", async () => {
  assert.equal((await call("POST", "/api/auth/signup", { body: { username: "bob", password: "short" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/signup", { body: { username: "no spaces", password: "longenough" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/signup", { body: { username: "bob", password: "longenough" } })).status, 201);
  assert.equal((await call("POST", "/api/auth/signup", { body: { username: "BOB", password: "longenough" } })).status, 409);

  assert.equal((await call("POST", "/api/auth/login", { body: { username: "bob", password: "wrongwrong" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "nobody", password: "longenough" } })).status, 401);
  const login = await call("POST", "/api/auth/login", { body: { username: "Bob", password: "longenough" } });
  assert.equal(login.status, 200);
  const { token } = (await login.json()) as AuthResponse;

  assert.equal((await call("GET", "/api/auth/me", { token })).status, 200);
  assert.equal((await call("POST", "/api/auth/logout", { token })).status, 204);
  const after = await call("GET", "/api/auth/me", { token });
  assert.equal(after.status, 401);
  assert.equal(((await after.json()) as { code: string }).code, "signed_out");
  assert.equal((await call("GET", "/api/auth/me", { token: "made-up" })).status, 401);
});

test("turning an account down cuts off its pets and its sign-ins", async () => {
  const signup = await call("POST", "/api/auth/signup", { body: { username: "carol", password: "longenough" } });
  const { token, account } = (await signup.json()) as AuthResponse;
  await call("POST", `/api/admin/users/${account.id}/approve`, { admin: "admin-secret" });
  const stream = await openPetStream(token);
  assert.equal(petChannel.sizeOf(account.id), 1);

  const reject = await call("POST", `/api/admin/users/${account.id}/reject`, { admin: "admin-secret" });
  assert.equal(reject.status, 200);
  assert.equal(petChannel.sizeOf(account.id), 0);
  // The server ended the stream.
  await stream.res.text();
  stream.close();

  const check = await call("POST", "/api/check", { token, body: { url: "https://example.org/" } });
  assert.equal(check.status, 403);
  assert.equal(((await check.json()) as { code: string }).code, "rejected");
  const login = await call("POST", "/api/auth/login", { body: { username: "carol", password: "longenough" } });
  assert.equal(login.status, 403);

  const users = await call("GET", "/api/admin/users", { admin: "admin-secret" });
  const { accounts } = (await users.json()) as { accounts: AdminAccount[] };
  assert.ok(accounts.some((user) => user.username === "carol" && user.status === "rejected"));
  assert.ok(accounts.every((user) => !("passwordHash" in user)));

  assert.equal((await call("DELETE", `/api/admin/users/${account.id}`, { admin: "admin-secret" })).status, 204);
  assert.equal((await call("GET", "/api/auth/me", { token })).status, 401);
  assert.equal((await call("POST", `/api/admin/users/${account.id}/approve`, { admin: "admin-secret" })).status, 404);
});

test("support calls use the account session and stay off until an admin turns them on", async () => {
  const signup = await call("POST", "/api/auth/signup", { body: { username: "dana", password: "longenough" } });
  const { token, account } = (await signup.json()) as AuthResponse;
  assert.equal((await call("GET", "/api/calls/state", { token })).status, 403, "pending accounts can't call");
  await call("POST", `/api/admin/users/${account.id}/approve`, { admin: "admin-secret" });
  const off = await call("GET", "/api/calls/state", { token });
  assert.equal(off.status, 403);
  assert.deepEqual(await off.json(), { error: "An admin hasn't turned on calls for this account" });

  const toggle = (enabled: unknown, admin?: string) => call("PUT", `/api/admin/users/${account.id}/calls`, { admin, body: { enabled } });
  assert.equal((await toggle(true)).status, 401, "needs the admin password");
  assert.equal((await toggle("yes", "admin-secret")).status, 400);
  assert.equal((await call("PUT", `/api/admin/users/${randomUUID()}/calls`, { admin: "admin-secret", body: { enabled: true } })).status, 404);
  assert.equal((await toggle(true, "admin-secret")).status, 200);
  const users = (await (await call("GET", "/api/admin/users", { admin: "admin-secret" })).json()) as { accounts: AdminAccount[] };
  assert.equal(users.accounts.find((user) => user.id === account.id)?.callsEnabled, true);
  assert.equal((await call("GET", "/api/calls/state", { token })).status, 200);
  assert.equal((await call("GET", "/api/calls/state")).status, 401);

  assert.equal((await toggle(false, "admin-secret")).status, 200);
  assert.equal((await call("GET", "/api/calls/state", { token })).status, 403);
});

test("sign-ins are rate limited", async () => {
  attempts = 1000;
  const res = await call("POST", "/api/auth/login", { body: { username: "bob", password: "longenough" } });
  assert.equal(res.status, 429);
  attempts = 0;
});

test("everyone who visits a URL during its analysis hears the result", () => {
  config.analyzer = "placeholder";
  config.analysisDelayMs = 0;
  const url = "https://shared.example/";
  const alice = { userId: "a", username: "alice" };
  const bob = { userId: "b", username: "bob" };

  const first = startAnalysis(url, "shared.example", alice);
  assert.equal(first.joined, true);
  assert.equal(startAnalysis(url, "shared.example", alice).joined, false, "a repeat visit doesn't re-alert");
  const second = startAnalysis(url, "shared.example", bob);
  assert.equal(second.joined, true);
  assert.equal(second.analysis, first.analysis, "one analysis per URL");
  assert.deepEqual(recipientsFor(url), [alice, bob]);

  startAnalysis(url, "shared.example", "everyone");
  assert.deepEqual(recipientsFor(url), ["everyone"], "an admin check covers every pet once");
});

test("a blocked page keeps the user's pets posted, and takes the choice made on a pet", async () => {
  const token = await approvedUser("erin");
  const other = await approvedUser("frank");
  const blocked = { url: "https://bad.example/login", host: "bad.example", reason: "Phishing page", late: false };

  // A page blocked while no pet is listening is told so, and hears when one connects.
  const lonely = new AbortController();
  const early = await fetch(`${base}/api/pet/warnings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(blocked),
    signal: lonely.signal,
  });
  assert.equal(early.status, 200);
  const earlyEvents = eventsOf(early);
  assert.equal((await earlyEvents.next<WarningStreamEvents["ready"]>("ready")).pets, 0);

  const pet = await openPetStream(token);
  const petEvents = eventsOf(pet.res);
  assert.deepEqual(
    (await petEvents.next<PetWarning[]>("warnings")).map((warning) => warning.url),
    [blocked.url],
    "a pet that connects hears about pages already blocked",
  );
  assert.equal((await earlyEvents.next<WarningStreamEvents["pets"]>("pets")).pets, 1);
  lonely.abort();
  assert.deepEqual(await petEvents.next<PetWarning[]>("warnings"), [], "closing the page lets the pet calm down");

  const open = (body: unknown) =>
    fetch(`${base}/api/pet/warnings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  const controller = new AbortController();
  assert.equal((await open({ ...blocked, late: "yes" })).status, 400);
  assert.equal((await open({ url: blocked.url })).status, 400);

  const page = await open({ ...blocked, late: true });
  const pageEvents = eventsOf(page);
  const { id, pets } = await pageEvents.next<WarningStreamEvents["ready"]>("ready");
  assert.equal(pets, 1);
  const [warning] = await petEvents.next<PetWarning[]>("warnings");
  assert.equal(warning?.id, id);
  assert.equal(warning?.reason, "Phishing page");
  assert.equal(warning?.late, true);

  const choose = (choice: unknown, as = token) => call("POST", `/api/pet/warnings/${id}/choice`, { token: as, body: { choice } });
  assert.equal((await choose("leave")).status, 400);
  assert.equal((await choose("exit", other)).status, 404, "only the user's own pets can answer");
  assert.equal((await choose("exit")).status, 204);
  assert.deepEqual(await pageEvents.next<WarningStreamEvents["choice"]>("choice"), { choice: "exit" });
  assert.deepEqual(
    await petEvents.next<PetWarning[]>("warnings"),
    [],
    "the pet lets go of the page once its choice is on the way, without waiting for the page to close",
  );
  assert.equal((await choose("continue")).status, 404, "the page isn't blocked anymore");

  controller.abort();
  pet.close();
});
