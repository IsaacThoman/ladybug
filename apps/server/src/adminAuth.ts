import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import type { AdminSession } from "@ladybug/shared";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

/**
 * Admin sign-in. With ADMIN_PASSWORD set, the admin UI's login page posts the
 * password to /api/admin/login and gets an HttpOnly session cookie back.
 * Scripts can still send it with HTTP Basic auth (any username). Without
 * ADMIN_PASSWORD, admin stays open, as in local development.
 */

export const SESSION_COOKIE = "ladybug_admin";
export const SESSION_MS = 7 * 24 * 60 * 60_000;
/** Failed logins allowed per client in each window before it has to wait. */
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 5 * 60_000;

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The token is its expiry plus an HMAC keyed by the admin password: nothing to
 * store, it works across server replicas, and changing the password signs
 * every session out.
 */
const signature = (expires: number, password: string) =>
  createHmac("sha256", password).update(`ladybug-admin-session:${expires}`).digest("base64url");

export function createSessionToken(password: string, now = Date.now()) {
  const expires = now + SESSION_MS;
  return `${expires}.${signature(expires, password)}`;
}

export function isValidSessionToken(token: string | undefined, password: string, now = Date.now()) {
  if (!token) return false;
  const dot = token.indexOf(".");
  const expires = Number(token.slice(0, dot));
  if (dot < 1 || !Number.isSafeInteger(expires) || expires <= now) return false;
  return sameSecret(token.slice(dot + 1), signature(expires, password));
}

function readCookie(req: Request, name: string) {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function hasBasicPassword(req: Request, password: string) {
  const [scheme, encoded] = (req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return sameSecret(decoded.slice(decoded.indexOf(":") + 1), password);
}

export function isAdmin(req: Request) {
  const password = config.adminPassword;
  if (!password) return true;
  return isValidSessionToken(readCookie(req, SESSION_COOKIE), password) || hasBasicPassword(req, password);
}

/**
 * Guards the admin API. Answers 401 without a WWW-Authenticate challenge, so
 * browsers show the login page instead of their own password prompt.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "Sign in to the admin UI first" });
}

const failures = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request) {
  return (config.clientIpHeader && req.header(config.clientIpHeader)?.trim()) || req.ip || "unknown";
}

/** Throws 429 once a client has used up its failed attempts for this window. */
function checkAttempts(key: string, now: number) {
  const entry = failures.get(key);
  if (entry && entry.resetAt <= now) failures.delete(key);
  else if (entry && entry.count >= LOGIN_ATTEMPTS) {
    const minutes = Math.ceil((entry.resetAt - now) / 60_000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}

function recordFailure(key: string, now: number) {
  if (failures.size > 10_000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  }
  const entry = failures.get(key);
  if (entry) entry.count += 1;
  else failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
}

/** Forget failed attempts, between tests. */
export function resetLoginAttempts() {
  failures.clear();
}

const cookieOptions = (req: Request): CookieOptions => ({
  httpOnly: true,
  sameSite: "strict",
  secure: req.secure,
  path: "/",
});

/** /api/admin/session, /login and /logout: reachable before signing in. */
export function adminAuthRouter() {
  const router = express.Router();

  router.get("/session", (req, res) => {
    const body: AdminSession = { required: config.adminPassword !== null, signedIn: isAdmin(req) };
    res.json(body);
  });

  router.post("/login", (req, res) => {
    const password = config.adminPassword;
    if (!password) {
      res.status(204).end();
      return;
    }
    const attempt: unknown = req.body?.password;
    if (typeof attempt !== "string" || attempt === "") throw new HttpError(400, "Enter the admin password");
    const key = clientKey(req);
    const now = Date.now();
    checkAttempts(key, now);
    if (!sameSecret(attempt, password)) {
      recordFailure(key, now);
      throw new HttpError(401, "That's not the admin password");
    }
    failures.delete(key);
    res.cookie(SESSION_COOKIE, createSessionToken(password, now), { ...cookieOptions(req), maxAge: SESSION_MS });
    res.status(204).end();
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  return router;
}
