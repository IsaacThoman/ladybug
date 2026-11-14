import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import {
  SESSION_COOKIE,
  adminAuthRouter,
  createSessionToken,
  isValidSessionToken,
  requireAdmin,
  resetLoginFailures,
} from "./adminAuth.ts";
import { config } from "./config.ts";
import { errorHandler } from "./http.ts";

const PASSWORD = "s3cret:with-colon";
let base = "";
let close = () => {};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminAuthRouter());
  app.get("/api/admin/summary", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => close());

beforeEach(() => {
  config.adminPassword = PASSWORD;
  resetLoginFailures();
});

const login = (password: string) =>
  fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

const sessionCookie = (res: Response) => {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
};

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("admin is open without ADMIN_PASSWORD", async () => {
  config.adminPassword = null;
  assert.equal((await fetch(`${base}/api/admin/summary`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/admin/session`)).json(), { required: false, authenticated: true });
});

test("the admin API wants a session, without a browser password prompt", async () => {
  const res = await fetch(`${base}/api/admin/summary`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.deepEqual(await (await fetch(`${base}/api/admin/session`)).json(), { required: true, authenticated: false });
});

test("signing in sets a cookie that opens the API", async () => {
  assert.equal((await login("wrong")).status, 401);
  const res = await login(PASSWORD);
  assert.equal(res.status, 204);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const cookie = sessionCookie(res);
  assert.equal((await fetch(`${base}/api/admin/summary`, { headers: { cookie } })).status, 200);
  const session = await (await fetch(`${base}/api/admin/session`, { headers: { cookie } })).json();
  assert.deepEqual(session, { required: true, authenticated: true });

  // A new password signs everyone out.
  config.adminPassword = "rotated";
  assert.equal((await fetch(`${base}/api/admin/summary`, { headers: { cookie } })).status, 401);
});

test("sign out clears the cookie", async () => {
  const res = await fetch(`${base}/api/admin/logout`, { method: "POST" });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`^${SESSION_COOKIE}=;`));
});

test("HTTP Basic still works for scripts", async () => {
  const get = (authorization: string) => fetch(`${base}/api/admin/summary`, { headers: { authorization } });
  assert.equal((await get(basic("admin", "wrong"))).status, 401);
  assert.equal((await get(`Bearer ${PASSWORD}`)).status, 401);
  assert.equal((await get(basic("anyone", PASSWORD))).status, 200);
});

test("too many wrong passwords are refused for a while", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login("nope")).status, 401);
  assert.equal((await login(PASSWORD)).status, 429);
});

test("session tokens expire and can't be forged", () => {
  const now = Date.now();
  const token = createSessionToken(PASSWORD, now);
  assert.equal(isValidSessionToken(token, PASSWORD, now), true);
  assert.equal(isValidSessionToken(token, "other", now), false);
  assert.equal(isValidSessionToken(token, PASSWORD, now + 8 * 24 * 60 * 60_000), false);
  const [, signature] = token.split(".");
  assert.equal(isValidSessionToken(`${now + 10 ** 12}.${signature}`, PASSWORD, now), false);
  assert.equal(isValidSessionToken("garbage", PASSWORD, now), false);
});
