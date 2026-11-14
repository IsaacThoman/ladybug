import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import type { AdminSession } from "@ladybug/shared";
import { logEvent } from "./activity.ts";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

/** The admin session cookie. Only the admin API reads it. */
export const SESSION_COOKIE = "ladybug_admin";
const COOKIE_PATH = "/api/admin";
export const SESSION_MS = 7 * 24 * 60 * 60_000;
/** Wrong passwords allowed per client per window, before logins are refused until it ends. */
export const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_PASSWORD_LENGTH = 1024;

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Sessions are signed with a key derived from ADMIN_PASSWORD, so they survive
// restarts and work on every replica, and changing the password signs
// everyone out.
const signingKey = (password: string) =>
  createHash("sha256").update(`ladybug admin session\0${password}`).digest();
const sign = (password: string, expires: string) =>
  createHmac("sha256", signingKey(password)).update(expires).digest("base64url");

/** `<expiry ms>.<signature>` */
export function createSessionToken(password: string, now = Date.now()) {
  const expires = String(now + SESSION_MS);
  return `${expires}.${sign(password, expires)}`;
}

export function isValidSessionToken(token: string, password: string, now = Date.now()) {
  const [expires, signature, ...rest] = token.split(".");
  if (rest.length > 0 || !signature || !/^\d{1,16}$/.test(expires) || Number(expires) <= now) return false;
  return sameSecret(signature, sign(password, expires));
}

function readCookie(req: Request, name: string) {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The password from an HTTP Basic header (any username), for scripts and curl. */
function basicPassword(req: Request) {
  const [scheme, encoded] = (req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
}

/** Whether this request may use the admin API. Always true without ADMIN_PASSWORD. */
export function isAdmin(req: Request) {
  const password = config.adminPassword;
  if (!password) return true;
  const token = readCookie(req, SESSION_COOKIE);
  if (token && isValidSessionToken(token, password)) return true;
  const basic = basicPassword(req);
  return basic !== null && sameSecret(basic, password);
}

/**
 * Guards /api/admin when ADMIN_PASSWORD is set: the admin UI's login page
 * sets a session cookie, and scripts can send HTTP Basic auth instead.
 * Without ADMIN_PASSWORD, admin stays open, as in local development.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  // No WWW-Authenticate challenge: browsers would pop up their own password
  // prompt over the login page.
  res.status(401).json({ error: "Admin login required" });
}

const cookieOptions = (req: Request): CookieOptions => ({
  httpOnly: true,
  // Secure whenever the browser reached us over HTTPS (req.secure honours
  // X-Forwarded-Proto from the trusted proxies in front).
  secure: req.secure,
  sameSite: "strict",
  path: COOKIE_PATH,
});

type Failures = { count: number; resetAt: number };
const failures = new Map<string, Failures>();

const clientOf = (req: Request) =>
  (config.clientIpHeader && req.header(config.clientIpHeader)?.trim()) || req.ip || "unknown";

/** Wrong-password counts for the current window, dropping ones that have ended. */
function failuresFor(client: string, now: number) {
  if (failures.size > 10_000) {
    for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
  }
  const entry = failures.get(client);
  if (entry && entry.resetAt <= now) {
    failures.delete(client);
    return null;
  }
  return entry ?? null;
}

/** Forget every wrong-password count (for tests). */
export function resetLoginFailures() {
  failures.clear();
}

/** Login, logout and session status. Mounted before requireAdmin. */
export function adminAuthRouter() {
  const router = express.Router();

  router.get("/session", (req, res) => {
    const body: AdminSession = { required: config.adminPassword !== null, authenticated: isAdmin(req) };
    res.json(body);
  });

  router.post("/login", (req, res) => {
    const password = config.adminPassword;
    if (!password) {
      const body: AdminSession = { required: false, authenticated: true };
      res.json(body);
      return;
    }

    const client = clientOf(req);
    const now = Date.now();
    const failed = failuresFor(client, now);
    if (failed && failed.count >= LOGIN_ATTEMPTS) {
      const seconds = Math.ceil((failed.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(seconds));
      const minutes = Math.ceil(seconds / 60);
      throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }

    const attempt: unknown = req.body?.password;
    if (typeof attempt !== "string" || attempt === "") throw new HttpError(400, '"password" is required');
    if (attempt.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, '"password" is too long');

    if (!sameSecret(attempt, password)) {
      const count = (failed?.count ?? 0) + 1;
      failures.set(client, { count, resetAt: failed?.resetAt ?? now + LOGIN_WINDOW_MS });
      logEvent({ type: "admin", message: "Wrong admin password", details: { client, attempt: count } });
      throw new HttpError(401, "That's not the admin password");
    }

    failures.delete(client);
    res.cookie(SESSION_COOKIE, createSessionToken(password, now), { ...cookieOptions(req), maxAge: SESSION_MS });
    logEvent({ type: "admin", message: "Admin signed in", details: { client } });
    const body: AdminSession = { required: true, authenticated: true };
    res.json(body);
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  return router;
}
