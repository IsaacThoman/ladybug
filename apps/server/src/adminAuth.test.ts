import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  LOGIN_ATTEMPTS,
  SESSION_COOKIE,
  SESSION_MS,
  adminAuthRouter,
  createSessionToken,
  isValidSessionToken,
  requireAdmin,
  resetLoginFailures,
} from "./adminAuth.ts";
import { config } from "./config.ts";
import { errorHandler } from "./http.ts";

const PASSWORD = "s3cret:with-colon";

function run(headers: { authorization?: string; cookie?: string } = {}) {
  const sent: Record<string, string> = {};
  let status = 200;
  let nextCalled = false;
  const req = { header: (name: string) => headers[name as keyof typeof headers] } as Request;
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
  config.adminPassword = null;
  resetLoginFailures();
});

test("admin is open without ADMIN_PASSWORD", () => {
  assert.equal(run().nextCalled, true);
});

test("admin needs a session or Basic auth when ADMIN_PASSWORD is set", () => {
  config.adminPassword = PASSWORD;
  const missing = run();
  assert.equal(missing.status, 401);
  // No challenge, so browsers show the login page rather than their own prompt.
  assert.equal(missing.headers["WWW-Authenticate"], undefined);
  assert.equal(run({ authorization: basic("admin", "wrong") }).nextCalled, false);
  assert.equal(run({ authorization: `Bearer ${PASSWORD}` }).nextCalled, false);
  assert.equal(run({ authorization: basic("anyone", PASSWORD) }).nextCalled, true);
  const token = createSessionToken(PASSWORD);
  assert.equal(run({ cookie: `other=1; ${SESSION_COOKIE}=${token}` }).nextCalled, true);
  assert.equal(run({ cookie: `${SESSION_COOKIE}=${token}x` }).nextCalled, false);
});

test("session tokens expire and are tied to the password", () => {
  const now = Date.now();
  const token = createSessionToken(PASSWORD, now);
  assert.equal(isValidSessionToken(token, PASSWORD, now), true);
  assert.equal(isValidSessionToken(token, PASSWORD, now + SESSION_MS + 1), false);
  assert.equal(isValidSessionToken(token, "another password", now), false);
  const [, signature] = token.split(".");
  assert.equal(isValidSessionToken(`${now + SESSION_MS * 100}.${signature}`, PASSWORD, now), false);
  assert.equal(isValidSessionToken("", PASSWORD, now), false);
  assert.equal(isValidSessionToken(`${token}.extra`, PASSWORD, now), false);
});

let base = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminAuthRouter());
  app.get("/api/admin/secret", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
});

after(() => {
  server.close();
});

const login = (password: string) =>
  fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("the login page's endpoints set and clear a session cookie", async () => {
  config.adminPassword = PASSWORD;
  assert.deepEqual(await (await fetch(`${base}/session`)).json(), { required: true, authenticated: false });
  assert.equal((await fetch(`${base}/secret`)).status, 401);

  const wrong = await login("nope");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const ok = await login(PASSWORD);
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/admin/);
  const cookie = setCookie.split(";")[0];

  assert.deepEqual(await (await fetch(`${base}/session`, { headers: { cookie } })).json(), {
    required: true,
    authenticated: true,
  });
  assert.equal((await fetch(`${base}/secret`, { headers: { cookie } })).status, 200);

  const out = await fetch(`${base}/logout`, { method: "POST", headers: { cookie } });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`^${SESSION_COOKIE}=;`));
});

test("logins are refused for a while after too many wrong passwords", async () => {
  config.adminPassword = PASSWORD;
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((await login(`guess ${i}`)).status, 401);
  const blocked = await login(PASSWORD);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("login reports no login needed without ADMIN_PASSWORD", async () => {
  assert.deepEqual(await (await fetch(`${base}/session`)).json(), { required: false, authenticated: true });
  assert.deepEqual(await (await login("anything")).json(), { required: false, authenticated: true });
});
