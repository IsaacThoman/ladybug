import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AdminSession } from "@ladybug/shared";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

/**
 * Admin sign-in. With ADMIN_PASSWORD set, the admin UI shows a sign-in page
 * and the API wants a session cookie. The cookie is a signed expiry time, keyed
 * on the password, so changing the password signs everyone out. Without
 * ADMIN_PASSWORD, admin stays open, as in local development.
 */

export const SESSION_COOKIE = "ladybug_admin";
const SESSION_MS = 7 * 24 * 60 * 60_000;
/** Failed sign-ins allowed per client in each window. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const signingKey = (password: string) => createHash("sha256").update(`ladybug-admin-session\0${password}`).digest();
const sign = (expires: string, password: string) =>
  createHmac("sha256", signingKey(password)).update(expires).digest("base64url");

export function createSessionToken(password: string, now = Date.now()) {
  const expires = String(now + SESSION_MS);
  return `${expires}.${sign(expires, password)}`;
}

export function isValidSessionToken(token: string, password: string, now = Date.now()) {
  const [expires, signature, ...rest] = token.split(".");
  if (!expires || !signature || rest.length > 0 || !/^\d+$/.test(expires)) return false;
  if (Number(expires) <= now) return false;
  return sameSecret(signature, sign(expires, password));
}

function readCookie(req: Request, name: string) {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function isAuthenticated(req: Request, password: string) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && isValidSessionToken(token, password)) return true;
  // HTTP Basic still works for scripts (curl -u :password); any username.
  const [scheme, encoded] = (req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() === "basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    return sameSecret(decoded.slice(decoded.indexOf(":") + 1), password);
  }
  return false;
}

/** Guards the admin API. No WWW-Authenticate, so browsers don't pop up their own prompt. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminPassword || isAuthenticated(req, config.adminPassword)) return next();
  res.status(401).json({ error: "Sign in to the admin first" });
}

const failures = new Map<string, { count: number; resetAt: number }>();

function tooManyFailures(client: string, now: number) {
  const entry = failures.get(client);
  if (entry && entry.resetAt <= now) failures.delete(client);
  return (failures.get(client)?.count ?? 0) >= MAX_FAILURES;
}

function recordFailure(client: string, now: number) {
  const entry = failures.get(client);
  if (entry && entry.resetAt > now) entry.count += 1;
  else failures.set(client, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  // Keep the map small under a spray of addresses.
  if (failures.size > 10_000) {
    for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
  }
}

const cookieOptions = (req: Request) => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: req.secure,
  path: "/",
});

/** Mounted before requireAdmin: the sign-in page needs these while signed out. */
export function adminAuthRouter() {
  const router = express.Router();

  router.get("/session", (req, res) => {
    const password = config.adminPassword;
    const body: AdminSession = {
      required: password !== null,
      authenticated: password === null || isAuthenticated(req, password),
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });

  router.post("/login", (req, res) => {
    const password = config.adminPassword;
    if (!password) {
      res.status(204).end();
      return;
    }
    const client = (config.clientIpHeader && req.header(config.clientIpHeader)?.trim()) || req.ip || "unknown";
    const now = Date.now();
    if (tooManyFailures(client, now)) {
      throw new HttpError(429, "Too many wrong passwords. Wait a few minutes, then try again.");
    }
    const attempt: unknown = req.body?.password;
    if (typeof attempt !== "string" || attempt === "" || attempt.length > 1024) {
      throw new HttpError(400, "Enter the admin password.");
    }
    if (!sameSecret(attempt, password)) {
      recordFailure(client, now);
      throw new HttpError(401, "That password isn't right.");
    }
    failures.delete(client);
    res.cookie(SESSION_COOKIE, createSessionToken(password, now), { ...cookieOptions(req), maxAge: SESSION_MS });
    res.status(204).end();
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  return router;
}

/** For tests. */
export function resetLoginFailures() {
  failures.clear();
}
