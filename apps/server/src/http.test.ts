import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { requireAdmin } from "./http.ts";

function run(authorization?: string) {
  const headers: Record<string, string> = {};
  let status = 200;
  let nextCalled = false;
  const req = { header: (name: string) => (name === "authorization" ? authorization : undefined) } as Request;
  const res = {
    setHeader: (name: string, value: string) => (headers[name] = value),
    status(code: number) {
      status = code;
      return this;
    },
    json: () => undefined,
  } as unknown as Response;
  requireAdmin(req, res, (() => (nextCalled = true)) as NextFunction);
  return { status, nextCalled, headers };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("admin is open without ADMIN_PASSWORD", () => {
  config.adminPassword = null;
  assert.equal(run().nextCalled, true);
});

test("admin requires the password when ADMIN_PASSWORD is set", () => {
  config.adminPassword = "s3cret:with-colon";
  const missing = run();
  assert.equal(missing.status, 401);
  assert.match(missing.headers["WWW-Authenticate"], /^Basic /);
  assert.equal(run(basic("admin", "wrong")).nextCalled, false);
  assert.equal(run("Bearer s3cret:with-colon").nextCalled, false);
  assert.equal(run(basic("anyone", "s3cret:with-colon")).nextCalled, true);
  config.adminPassword = null;
});
