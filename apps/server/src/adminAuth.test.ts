import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  SESSION_COOKIE,
  SESSION_MS,
  adminAuthRouter,
  createSessionToken,
  isValidSessionToken,
  requireAdmin,
  resetLoginAttempts,
} from "./adminAuth.ts";
import { config } from "./config.ts";
import { errorHandler } from "./http.ts";

const PASSWORD = "s3cret:with-colon";

function run(headers: Record<string, string> = {}) {
  const sent: Record<string, string> = {};
  let status = 200;
  let nextCalled = false;
  const req = { header: (name: string) => headers[name.toLowerCase()] } as Request;
  const res = {
    setHeader: (name: string, value: string) => (sent[name] = value),
    status(code: number) {
      status = code;
      return this;
    },
    json: () => undefined,
  } as unknown as Response;
  requireAdmin(req, res, (() => (nextCalled = true)) as NextFunction);
  return { status, nextCalled, headers: sent };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

beforeEach(() => {
  config.adminPassword = PASSWORD;
  resetLoginAttempts();
});

after(() => {
  config.adminPassword = null;
});

test("admin is open without ADMIN_PASSWORD", () => {
  config.adminPassword = null;
  assert.equal(run().nextCalled, true);
});

test("admin needs a session or the password, and never triggers the browser prompt", () => {
  const missing = run();
  assert.equal(missing.status, 401);
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.headers["WWW-Authenticate"], undefined);
  assert.equal(run({ authorization: basic("admin", "wrong") }).nextCalled, false);
  assert.equal(run({ authorization: `Bearer ${PASSWORD}` }).nextCalled, false);
  assert.equal(run({ authorization: basic("anyone", PASSWORD) }).nextCalled, true);
  assert.equal(run({ cookie: `other=1; ${SESSION_COOKIE}=${createSessionToken(PASSWORD)}` }).nextCalled, true);
  assert.equal(run({ cookie: `${SESSION_COOKIE}=nonsense` }).nextCalled, false);
});

test("session tokens expire and are tied to the password", () => {
  const now = Date.now();
  const token = createSessionToken(PASSWORD, now);
  assert.equal(isValidSessionToken(token, PASSWORD, now + 1000), true);
  assert.equal(isValidSessionToken(token, PASSWORD, now + SESSION_MS + 1), false);
  assert.equal(isValidSessionToken(token, "a new password", now), false);
  const [expires, signature] = token.split(".");
  assert.equal(isValidSessionToken(`${Number(expires) + 1000}.${signature}`, PASSWORD, now), false);
  assert.equal(isValidSessionToken(`${expires}.${signature.slice(1)}x`, PASSWORD, now), false);
  assert.equal(isValidSessionToken(undefined, PASSWORD, now), false);
});

let base = "";
let close = () => {};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminAuthRouter());
  app.get("/api/admin/secret", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
  close = () => server.close();
});

after(() => close());

const login = (password: unknown) =>
  fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("logging in sets a session cookie that opens the admin API", async () => {
  assert.deepEqual(await (await fetch(`${base}/session`)).json(), { required: true, signedIn: false });
  assert.equal((await fetch(`${base}/secret`)).status, 401);

  const wrong = await login("nope");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal((await login("")).status, 400);

  const ok = await login(PASSWORD);
  assert.equal(ok.status, 204);
  const cookie = ok.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const headers = { cookie: cookie.split(";")[0] };
  assert.deepEqual(await (await fetch(`${base}/session`, { headers })).json(), { required: true, signedIn: true });
  assert.equal((await fetch(`${base}/secret`, { headers })).status, 200);

  const out = await fetch(`${base}/logout`, { method: "POST", headers });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`^${SESSION_COOKIE}=;`));
});

test("too many wrong passwords lock the client out for a while", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login(`guess ${i}`)).status, 401);
  const locked = await login(PASSWORD);
  assert.equal(locked.status, 429);
  assert.match(((await locked.json()) as { error: string }).error, /Try again in 5 minutes/);
});

test("the session reports admin as open without ADMIN_PASSWORD", async () => {
  config.adminPassword = null;
  assert.deepEqual(await (await fetch(`${base}/session`)).json(), { required: false, signedIn: true });
});
